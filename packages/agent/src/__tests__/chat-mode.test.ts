import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { AgentToolDef, LlmMessage, StreamDelta } from "../providers/types.js";
import type { AgentConfig } from "../agent-loop.js";
import { parseArgs } from "../config.js";
import { livePreview, PREVIEW_WRITE_MS } from "../session/preview.js";

/**
 * Quick chat (`--mode chat`): no tools offered, read-only memory in the
 * system prompt, the owner's provider resolved exactly as for the agent, and
 * /promote continuing the same conversation with tools.
 */

interface Call { system: string; messages: LlmMessage[]; tools: AgentToolDef[]; preview?: unknown }
const calls: Call[] = [];
const resolved: unknown[][] = [];
let previewFile: string | undefined;

vi.mock("../providers/resolve.js", () => ({
  resolveProvider: (...args: unknown[]) => {
    resolved.push(args);
    return {
      name: "openai-codex",
      model: "gpt-5.4",
      contextWindow: 200_000,
      async chat() { throw new Error("chat mode streams"); },
      async *chatStream(system: string, messages: LlmMessage[], tools: AgentToolDef[]): AsyncIterable<StreamDelta> {
        const call: Call = { system, messages: structuredClone(messages), tools };
        calls.push(call);
        yield { type: "text_delta", text: "Forty" };
        // The loop has handled the first delta before asking for the next one.
        if (previewFile && fs.existsSync(previewFile)) call.preview = JSON.parse(fs.readFileSync(previewFile, "utf8"));
        yield { type: "text_delta", text: "-two." };
        yield { type: "done", stop_reason: "end_turn" };
      },
    };
  },
}));

let captured: AgentConfig | undefined;
vi.mock("../repl.js", () => ({
  startRepl: async (config: AgentConfig) => {
    captured = config;
    return { messages: [], toolCalls: 0, antiPatterns: { flushAntiPatterns: async () => {} } };
  },
}));

vi.mock("../herdr-hooks.js", () => ({ emitHerdrHook: () => {}, setHerdrHookSession: () => {} }));
vi.mock("../checkpoint.js", () => ({ createCheckpoint: () => null }));

describe("quick chat", () => {
  let home: string, store: string, source: string;
  const saved = { ...process.env };
  let stdout: string;

  beforeEach(() => {
    calls.length = 0; resolved.length = 0; captured = undefined; previewFile = undefined; stdout = "";
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "phren-chat-home-")));
    store = path.join(home, ".phren");
    source = path.join(home, "app");
    fs.mkdirSync(path.join(store, "global"), { recursive: true });
    fs.mkdirSync(path.join(store, "app"), { recursive: true });
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(store, "phren.root.yaml"), "version: 1\ninstallMode: shared\nsyncMode: managed-git\n");
    fs.writeFileSync(path.join(store, "global", "truths.md"), "# Truths\n\n- The owner prefers short answers.\n");
    fs.writeFileSync(path.join(store, "app", "phren.project.yaml"), `sourcePath: ${source}\n`);
    fs.writeFileSync(path.join(store, "app", "truths.md"), "# Truths\n\n- Deploys go through the release train.\n");
    fs.writeFileSync(path.join(store, "app", "summary.md"), "# app\n\n**What:** The billing app\n\n<!-- phren:knows:start -->\n## What phren knows\n\n- 3 active findings.\n<!-- phren:knows:end -->\n");
    fs.writeFileSync(path.join(store, "app", "FINDINGS.md"), "# app Findings\n\n## Billing\n\n- Invoices round half-even, never half-up.\n");
    for (const key of Object.keys(process.env)) if (key.startsWith("PHREN_")) delete process.env[key];
    process.env.HOME = home;
    process.env.PHREN_PATH = store;
    process.env.PHREN_INTRO = "off";
    process.env.PHREN_AGENT_USER_RULES = "off";
    vi.spyOn(process, "cwd").mockReturnValue(source);
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, "write").mockImplementation((() => true) as typeof process.stderr.write);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...saved };
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("parses --mode, refusing anything but agent or chat", () => {
    expect(parseArgs([]).mode).toBe("agent");
    expect(parseArgs(["--mode", "chat", "-i"]).mode).toBe("chat");
    expect(() => parseArgs(["--mode", "turbo"])).toThrow(/Unknown --mode/);
  });

  it("offers no tools, puts phren memory in the system prompt, and resolves the provider as the agent does", async () => {
    const { runAgentCli } = await import("../index.js");
    const flags = ["--provider", "openai-codex", "--model", "openai-codex/gpt-5.4", "--reasoning", "high", "--output-format", "stream-json"];
    await runAgentCli(["--mode", "chat", ...flags, "What is 6 x 7?"]);

    expect(calls).toHaveLength(1);
    expect(calls[0].tools).toEqual([]);
    const system = calls[0].system;
    expect(system).toContain("quick chat");
    expect(system).toContain("You have no tools");
    expect(system).toContain("The owner prefers short answers.");
    expect(system).toContain("Deploys go through the release train.");
    expect(system).toContain("**What:** The billing app");
    expect(system).toContain("Invoices round half-even");
    expect(system).not.toContain("phren:knows");
    // No search index, rule files or tool workflow in a chat prompt.
    expect(system).not.toContain("## Workflow");
    expect(JSON.parse(stdout.split("\n")[0])).toMatchObject({ type: "system", subtype: "init", provider: "openai-codex", tools: [] });
    expect(stdout).toContain("Forty-two.");

    // The same flags in agent mode resolve the provider identically.
    await runAgentCli(["--no-subagents", ...flags, "What is 6 x 7?"]);
    expect(resolved[1]).toEqual(resolved[0]);
    expect(resolved[0]).toEqual(["openai-codex", "openai-codex/gpt-5.4", undefined, "high", { baseUrl: undefined }]);
    expect(calls[1].tools.length).toBeGreaterThan(0);
    expect(calls[1].system).not.toContain("You have no tools");
  });

  it("streams the reply to the sidecar, and /promote continues the same conversation with tools", async () => {
    const { runAgentCli } = await import("../index.js");
    const { createSession, runTurn } = await import("../agent-loop.js");
    await runAgentCli(["--mode", "chat", "-i"]);
    const config = captured!;
    expect(config.mode).toBe("chat");
    expect(config.registry.toolNames()).toEqual([]);
    expect(config.livePreview).toBeDefined();

    const session = createSession(200_000, { log: config.sessionLog });
    const sessionId = session.log.header.sessionId;
    previewFile = path.join(store, ".sessions", `session-${sessionId}.events.jsonl.preview.json`);
    const hooks = { onTextDelta: () => {}, onStatus: () => {} };
    await runTurn("What is 6 x 7?", session, config, hooks);
    const prompt = session.log.all.find((event) => event.type === "user/message")!;
    expect(calls[0].preview).toEqual({ turnStartedAt: prompt.time, text: "Forty" });
    expect(fs.existsSync(previewFile)).toBe(false);
    expect(fs.readFileSync(previewFile.replace(/\.preview\.json$/, ""), "utf8")).toContain("Forty-two.");

    expect(await config.promote!()).toMatch(/Promoted to a phren agent/);
    expect(config.mode).toBe("agent");
    expect(config.registry.toolNames()).toContain("read_file");
    expect(config.systemPrompt).not.toContain("You have no tools");
    expect(await config.promote!()).toBe("Already an agent session.");

    await runTurn("Now check the invoices file.", session, config, hooks);
    expect(calls[1].tools.length).toBeGreaterThan(0);
    expect(calls[1].messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(JSON.stringify(calls[1].messages[1])).toContain("Forty-two.");
  });
});

describe("live preview sidecar", () => {
  it("writes the first delta at once, then at most every PREVIEW_WRITE_MS, and removes the file on clear", async () => {
    vi.useFakeTimers();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phren-preview-"));
    try {
      const file = path.join(dir, "session-x.events.jsonl.preview.json");
      let now = 1_000;
      const preview = livePreview(file, () => now);
      const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
      preview.append("ignored before start");
      expect(fs.existsSync(file)).toBe(false);
      preview.start("2026-10-01T12:00:00.000Z");
      preview.append("Hel");
      expect(read()).toEqual({ turnStartedAt: "2026-10-01T12:00:00.000Z", text: "Hel" });
      now += 10; preview.append("lo");
      expect(read().text).toBe("Hel");
      now += PREVIEW_WRITE_MS; await vi.advanceTimersByTimeAsync(PREVIEW_WRITE_MS);
      expect(read().text).toBe("Hello");
      preview.append(" world");
      preview.clear();
      await vi.advanceTimersByTimeAsync(PREVIEW_WRITE_MS * 2);
      expect(fs.existsSync(file)).toBe(false);
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally {
      vi.useRealTimers();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
