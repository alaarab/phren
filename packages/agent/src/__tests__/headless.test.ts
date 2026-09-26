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
});
