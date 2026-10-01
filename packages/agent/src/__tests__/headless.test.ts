import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildHeadlessResult, createHeadlessHooks, headlessExitCode } from "../headless.js";
import { parseArgs } from "../config.js";
import { createCostTracker } from "../cost.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "fixtures", "replay-shell-session.events.jsonl");
const AGENT_BIN = path.resolve(here, "../../dist/bin.js");

describe("headless flags", () => {
  it("-p defaults to text output", () => {
    const args = parseArgs(["-p", "do it"]);
    expect(args.print).toBe(true);
    expect(args.outputFormat).toBe("text");
    expect(args.task).toBe("do it");
  });

  it("--output-format implies -p", () => {
    const args = parseArgs(["--output-format", "stream-json", "task"]);
    expect(args.print).toBe(true);
    expect(args.outputFormat).toBe("stream-json");
  });

  it("rejects an unknown output format", () => {
    expect(() => parseArgs(["--output-format", "yaml", "x"])).toThrow(/Unknown --output-format/);
  });

  it("parses session and endpoint flags", () => {
    const args = parseArgs(["--session", "abc123", "--base-url", "https://example.test/v1", "-c", "go"]);
    expect(args.resume).toBe(true);
    expect(args.resumeId).toBe("abc123");
    expect(args.baseUrl).toBe("https://example.test/v1");
    expect(parseArgs(["--list-sessions"]).listSessions).toBe(true);
  });
});

describe("headless result", () => {
  it("maps stop reasons to subtypes and exit codes", () => {
    const base = { text: "t", turns: 1, toolCalls: 0, startedAt: Date.now(), sessionId: null, provider: "p", model: "m", permissionDenials: 0 };
    const success = buildHeadlessResult({ ...base, stopReason: "end_turn" });
    expect(success).toMatchObject({ type: "result", subtype: "success", is_error: false, result: "t" });
    expect(headlessExitCode(success)).toBe(0);
    expect(headlessExitCode(buildHeadlessResult({ ...base, stopReason: "max_turns" }))).toBe(1);
    expect(buildHeadlessResult({ ...base, stopReason: "budget" }).subtype).toBe("error_budget");
    expect(headlessExitCode(buildHeadlessResult({ ...base, stopReason: "aborted" }))).toBe(130);
    const failed = buildHeadlessResult({ ...base, stopReason: "error", error: "boom" });
    expect(failed).toMatchObject({ subtype: "error_during_execution", is_error: true, error: "boom" });
  });

  it("reports usage, and cost only for metered providers", () => {
    const metered = createCostTracker("claude-sonnet-5", null, "anthropic");
    metered.recordUsage(1_000_000, 0);
    const r = buildHeadlessResult({
      text: "", stopReason: "end_turn", turns: 1, toolCalls: 0, startedAt: Date.now(), sessionId: "s",
      provider: "anthropic", model: "claude-sonnet-5", costTracker: metered, permissionDenials: 2,
    });
    expect(r.usage.input_tokens).toBe(1_000_000);
    expect(r.total_cost_usd).toBe(3);
    expect(r.permission_denials).toBe(2);
    const flat = createCostTracker("gpt-5.4", null, "openai-codex");
    expect(buildHeadlessResult({
      text: "", stopReason: "end_turn", turns: 1, toolCalls: 0, startedAt: Date.now(), sessionId: null,
      provider: "openai-codex", model: "gpt-5.4", costTracker: flat, permissionDenials: 0,
    }).total_cost_usd).toBeNull();
  });
});

describe("headless hooks", () => {
  it("emits NDJSON events for stream-json and nothing else to stdout", () => {
    const lines: string[] = [];
    const hooks = createHeadlessHooks({ format: "stream-json", verbose: false, write: (l) => lines.push(l), stderr: () => {} });
    hooks.onTextDelta?.("partial");
    hooks.onAssistantMessage?.([
      { type: "text", text: "Looking." },
      { type: "tool_use", id: "t1", name: "shell", input: { command: "ls" } },
    ], "tool_use");
    hooks.onToolResults?.([{ type: "tool_result", tool_use_id: "t1", content: "a\nb", is_error: false }]);
    const events = lines.map((l) => JSON.parse(l));
    expect(events.map((e) => e.type)).toEqual(["assistant", "tool_use", "tool_result"]);
    expect(events[2]).toMatchObject({ name: "shell", tool_use_id: "t1", output: "a\nb" });
  });

  it("text and json formats stream nothing and refuse plan approval", async () => {
    const lines: string[] = [];
    const hooks = createHeadlessHooks({ format: "json", verbose: false, write: (l) => lines.push(l), stderr: () => {} });
    hooks.onAssistantMessage?.([{ type: "text", text: "x" }], "end_turn");
    expect(lines).toEqual([]);
    expect(await hooks.onPlanApproval?.()).toEqual({ approved: false });
  });
});

// ── The real binary, keyless, against the recorded replay fixture ────────────

function run(args: string[], cwd: string, env: Record<string, string>, input?: string) {
  return new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
    const child = execFile(process.execPath, [AGENT_BIN, ...args], {
      cwd,
      timeout: 60_000,
      env: {
        ...process.env,
        PHREN_AGENT_REPLAY: FIXTURE,
        OPENAI_API_KEY: "",
        OPENROUTER_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        DEEPSEEK_API_KEY: "",
        PHREN_OLLAMA_URL: "off",
        NO_COLOR: "1",
        ...env,
      },
    }, (err, stdout, stderr) => {
      if (err && (err as { killed?: boolean }).killed) reject(err);
      else resolve({ stdout: String(stdout), stderr: String(stderr), code: err ? Number((err as { code?: number }).code ?? 1) : 0 });
    });
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });
}

describe.skipIf(!fs.existsSync(AGENT_BIN))("headless binary (replay)", () => {
  let storeDir: string;
  let workDir: string;
  beforeEach(() => {
    storeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "phren-headless-store-")));
    workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "phren-headless-work-")));
    fs.writeFileSync(path.join(storeDir, "phren.root.yaml"), "version: 1\n");
  });
  afterEach(() => {
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("--output-format json prints exactly one result object on stdout", async () => {
    const { stdout, code } = await run(
      ["--yolo", "--no-subagents", "--output-format", "json", "Run echo replay-fixture-7 and report the marker."],
      workDir,
      { PHREN_PATH: storeDir },
    );
    expect(code).toBe(0);
    const lines = stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    const result = JSON.parse(lines[0]);
    expect(result).toMatchObject({ type: "result", subtype: "success", is_error: false, provider: "replay", tool_calls: 1 });
    expect(result.result).toContain("replay-fixture-7");
    expect(stdout).not.toContain("\x07");
  }, 90_000);

  it("stream-json emits init, tool events and the result, reading the task from stdin", async () => {
    const { stdout, code } = await run(
      ["--yolo", "--no-subagents", "--output-format", "stream-json"],
      workDir,
      { PHREN_PATH: storeDir },
      "Run echo replay-fixture-7 and report the marker.",
    );
    expect(code).toBe(0);
    const types = stdout.trim().split("\n").map((l) => JSON.parse(l).type);
    expect(types[0]).toBe("system");
    expect(types).toContain("tool_use");
    expect(types).toContain("tool_result");
    expect(types[types.length - 1]).toBe("result");
  }, 90_000);

  it("denies tool approvals instead of hanging when nobody can answer", async () => {
    const { stdout, stderr, code } = await run(
      ["-p", "--output-format", "json", "--no-subagents", "Run echo replay-fixture-7 and report the marker."],
      workDir,
      { PHREN_PATH: storeDir },
    );
    const result = JSON.parse(stdout.trim());
    expect(result.permission_denials).toBe(1);
    expect(stderr).toContain("No one is present to approve");
    expect(code).toBe(0); // the scripted model still finishes its answer
  }, 90_000);

  it("keeps a resumable session in ~/.phren-agent without a phren store", async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "phren-headless-home-")));
    const noStore = path.join(home, "no-store");
    const env = { HOME: home, USERPROFILE: home, PHREN_PATH: noStore };
    try {
      const task = "Run echo replay-fixture-7 and report the marker.";
      const first = await run(["--yolo", "--no-subagents", "--output-format", "json", task], workDir, env);
      expect(first.code).toBe(0);
      const id = JSON.parse(first.stdout.trim()).session_id as string;
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      const sessions = path.join(home, ".phren-agent", ".sessions");
      expect(fs.existsSync(path.join(sessions, `session-${id}.events.jsonl`))).toBe(true);

      const listed = await run(["--list-sessions", "--output-format", "json"], workDir, env);
      expect(JSON.parse(listed.stdout).map((s: { sessionId: string }) => s.sessionId)).toContain(id);

      const second = await run(["--yolo", "--no-subagents", "--output-format", "json", "--session", id.slice(0, 8), task], workDir, env);
      expect(second.code).toBe(0);
      const secondId = JSON.parse(second.stdout.trim()).session_id as string;
      expect(secondId).not.toBe(id);
      // The resumed run's log is a fork that starts with the first run's history.
      const forked = fs.readFileSync(path.join(sessions, `session-${secondId}.events.jsonl`), "utf-8");
      expect(forked).toContain(id);
      expect(forked.split(task).length - 1).toBeGreaterThanOrEqual(2);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 90_000);

  it("--input-format stream-json runs one turn per user message on one session", async () => {
    const fixture = path.join(workDir, "two-answers.events.jsonl");
    const lines = [
      { type: "header", version: 1, sessionId: "two-answers", cwd: "/tmp", createdAt: "2026-10-01T00:00:00.000Z" },
      { seq: 0, time: "2026-10-01T00:00:01.000Z", type: "user/message", data: { message: { role: "user", content: "one" }, source: "user", turn: 0 } },
      { seq: 1, time: "2026-10-01T00:00:02.000Z", type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: "first answer" }] }, stop_reason: "end_turn", turn: 0 } },
      { seq: 2, time: "2026-10-01T00:00:03.000Z", type: "user/message", data: { message: { role: "user", content: "two" }, source: "user", turn: 1 } },
      { seq: 3, time: "2026-10-01T00:00:04.000Z", type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: "second answer" }] }, stop_reason: "end_turn", turn: 1 } },
    ];
    fs.writeFileSync(fixture, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const input = [
      JSON.stringify({ type: "user", message: { role: "user", content: "one" } }),
      "not json",
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "two" }] } }),
    ].join("\n");
    const { stdout, stderr, code } = await run(
      ["--yolo", "--no-subagents", "--input-format", "stream-json", "--output-format", "stream-json"],
      workDir,
      { PHREN_PATH: storeDir, PHREN_AGENT_REPLAY: fixture },
      input,
    );
    expect(code).toBe(0);
    const events = stdout.trim().split("\n").map((l) => JSON.parse(l));
    const results = events.filter((e) => e.type === "result");
    expect(results.map((r) => [r.subtype, r.result])).toEqual([["success", "first answer"], ["success", "second answer"]]);
    expect(new Set(results.map((r) => r.session_id)).size).toBe(1);
    expect(stderr).toContain("skipped an input line: not JSON");
  }, 90_000);

  it("--input-format stream-json needs stream-json output", async () => {
    const { stderr, code } = await run(["--input-format", "stream-json", "--output-format", "json"], workDir, { PHREN_PATH: storeDir }, "");
    expect(code).toBe(1);
    expect(stderr).toContain("needs --output-format stream-json");
  }, 30_000);

  it("every stream-json line matches docs/agent-stream-json.schema.json", async () => {
    const schema = JSON.parse(fs.readFileSync(path.join(here, "..", "..", "..", "..", "docs", "agent-stream-json.schema.json"), "utf-8"));
    const { stdout, code } = await run(
      ["--yolo", "--no-subagents", "--output-format", "stream-json", "Run echo replay-fixture-7 and report the marker."],
      workDir,
      { PHREN_PATH: storeDir },
    );
    expect(code).toBe(0);
    const events = stdout.trim().split("\n").map((l) => JSON.parse(l));
    expect(new Set(events.map((e) => e.type))).toEqual(new Set(["system", "assistant", "tool_use", "tool_result", "result"]));
    for (const event of events) expect(schemaErrors(schema, event), JSON.stringify(event)).toEqual([]);
    // The documented input shape, both content forms.
    const input = { $ref: "#/$defs/InputMessage" };
    expect(schemaErrors(schema, { type: "user", message: { role: "user", content: "hi" } }, input)).toEqual([]);
    expect(schemaErrors(schema, { type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } }, input)).toEqual([]);
  }, 90_000);
});

type Schema = Record<string, unknown>;

/**
 * The JSON Schema subset the stream-json schema uses ($ref, oneOf, const,
 * enum, type, required, properties, items), strict about undocumented keys so
 * the schema can't fall behind what the agent prints.
 */
function schemaErrors(root: Schema, value: unknown, node: Schema = root, at = "$"): string[] {
  if (typeof node.$ref === "string") {
    const target = (node.$ref as string).replace("#/", "").split("/").reduce<unknown>((o, k) => (o as Schema)[k], root) as Schema;
    return schemaErrors(root, value, target, at);
  }
  if (Array.isArray(node.oneOf)) {
    const matches = (node.oneOf as Schema[]).filter((s) => schemaErrors(root, value, s, at).length === 0);
    return matches.length === 1 ? [] : [`${at}: matches ${matches.length} of oneOf`];
  }
  const errors: string[] = [];
  if ("const" in node && value !== node.const) errors.push(`${at}: expected ${JSON.stringify(node.const)}`);
  if (Array.isArray(node.enum) && !node.enum.includes(value)) errors.push(`${at}: ${JSON.stringify(value)} not in enum`);
  if (node.type !== undefined) {
    const types = Array.isArray(node.type) ? node.type as string[] : [node.type as string];
    const actual = value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;
    if (!types.some((t) => t === actual || (t === "number" && actual === "integer"))) errors.push(`${at}: ${actual} is not ${types.join("|")}`);
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of (node.required as string[] | undefined) ?? []) if (!(key in obj)) errors.push(`${at}.${key}: missing`);
    const props = node.properties as Record<string, Schema> | undefined;
    if (props) {
      for (const [key, v] of Object.entries(obj)) {
        if (!props[key]) errors.push(`${at}.${key}: not in the schema`);
        else errors.push(...schemaErrors(root, v, props[key], `${at}.${key}`));
      }
    }
  }
  if (Array.isArray(value) && node.items) value.forEach((v, i) => errors.push(...schemaErrors(root, v, node.items as Schema, `${at}[${i}]`)));
  return errors;
}
