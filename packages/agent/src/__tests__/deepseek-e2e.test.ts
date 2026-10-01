/**
 * DeepSeek V4.1 Flash, end to end and keyless: the real agent loop and
 * provider against a fake chat-completions endpoint as strict as DeepSeek's
 * documented API (thinking mode with tools, tool-call pairing, the effort
 * values it takes), across tool turns, plain answers, a resume from the
 * persisted log, a compaction and a dropped stream, priced from the catalog.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../agent-loop.js";
import { ToolRegistry } from "../tools/registry.js";
import { OpenAiProvider } from "../providers/openrouter.js";
import { SessionLog, type SessionEvent, type SessionLogHeader } from "../session/log.js";
import { compactWithLlm } from "../context/compactor.js";
import { createCostTracker, resolvePricing } from "../cost.js";

vi.mock("../spinner.js", () => ({
  createSpinner: () => ({ start: vi.fn(), update: vi.fn(), stop: vi.fn() }),
  formatTurnHeader: () => "",
  formatToolCall: () => "",
}));
vi.mock("../memory/error-recovery.js", () => ({ searchErrorRecovery: vi.fn().mockResolvedValue("") }));
vi.mock("../memory/auto-capture.js", () => ({
  createCaptureState: () => ({ captured: 0, hashes: new Set(), lastCaptureTime: 0 }),
  analyzeAndCapture: vi.fn().mockResolvedValue(0),
}));
vi.mock("../checkpoint.js", () => ({ createCheckpoint: vi.fn().mockReturnValue(null) }));
vi.mock("../tools/lint-test.js", () => ({ detectLintCommand: () => null, detectTestCommand: () => null }));

const { runTurn, createSession } = await import("../agent-loop/index.js");

const quiet = { onStatus: () => {}, onTextDelta: () => {}, onTextBlock: () => {} };
const BASE = "https://fake-deepseek.test/v1";

type Wire = Record<string, unknown>;

/** Why DeepSeek would reject this request, or null. */
function violation(body: Wire): string | null {
  const messages = body.messages as Wire[];
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const effort = body.reasoning_effort;
  if (effort !== undefined && !["none", "low", "high", "max"].includes(String(effort))) {
    return `reasoning_effort ${String(effort)} is not accepted`;
  }
  let pending = new Set<string>();
  for (const [i, m] of messages.entries()) {
    if (m.role === "tool") {
      if (!pending.delete(String(m.tool_call_id))) return `message ${i}: tool result answers no pending tool call`;
      continue;
    }
    if (pending.size > 0) return `message ${i}: tool calls ${[...pending].join(", ")} were not answered`;
    if (m.role === "assistant") {
      if (typeof m.content !== "string") return `message ${i}: assistant content must be a string`;
      if (hasTools && typeof m.reasoning_content !== "string") {
        return `message ${i}: the reasoning_content in the thinking mode must be passed back to the API`;
      }
      const calls = (m.tool_calls as Array<{ id: string }> | undefined) ?? [];
      pending = new Set(calls.map((c) => c.id));
    }
  }
  if (pending.size > 0) return "the last assistant's tool calls were not answered";
  return null;
}

type Reply =
  | { kind: "tool"; id: string; reasoning: string }
  | { kind: "text"; text: string; reasoning: string }
  | { kind: "drop"; reasoning: string };

/** DeepSeek's usage block: 90% of the prompt served from cache. */
const USAGE = { prompt_tokens: 10_000, completion_tokens: 500, prompt_cache_hit_tokens: 9_000, prompt_cache_miss_tokens: 1_000 };

function streamBody(reply: Reply): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const chunks: Wire[] = [{ choices: [{ delta: { reasoning_content: reply.reasoning } }] }];
  if (reply.kind === "tool") {
    chunks.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: reply.id, function: { name: "echo", arguments: "{\"x\":1}" } }] } }] });
    chunks.push({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
  } else if (reply.kind === "text") {
    chunks.push({ choices: [{ delta: { content: reply.text } }] });
    chunks.push({ choices: [{ delta: {}, finish_reason: "stop" }] });
  } else {
    chunks.push({ choices: [{ delta: { content: "half an ans" } }] });
  }
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(`data: ${JSON.stringify(c)}\n\n`));
      if (reply.kind === "drop") {
        // The connection dies before finish_reason, usage or [DONE].
        controller.error(Object.assign(new TypeError("terminated"), { cause: { code: "ECONNRESET" } }));
        return;
      }
      controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [], usage: USAGE })}\n\n`));
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

function fakeDeepSeek(script: Reply[]) {
  const requests: Wire[] = [];
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Wire;
    requests.push(body);
    const problem = violation(body);
    if (problem) return new Response(JSON.stringify({ error: { message: problem } }), { status: 400 });
    if (body.stream !== true) {
      // The compaction call: a plain completion.
      const summary = "## Checkpoint Summary\nRan echo twice for the user and answered; nothing is pending, the next step is whatever the user asks.\n\n## Knowledge\n```json\n{\"items\":[]}\n```";
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: summary, reasoning_content: "summarize" }, finish_reason: "stop" }],
        usage: USAGE,
      }), { status: 200 });
    }
    const next = script.shift();
    if (!next) throw new Error("fake DeepSeek ran out of scripted replies");
    return new Response(streamBody(next), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  });
  return { fetchMock, requests };
}

function config(provider: OpenAiProvider, costTracker: AgentConfig["costTracker"]): AgentConfig {
  const registry = new ToolRegistry();
  registry.setPermissions({ mode: "full-auto", projectRoot: process.cwd(), allowedPaths: [] });
  registry.register({
    name: "echo",
    description: "echo",
    input_schema: { type: "object", properties: { x: { type: "number" } } },
    async execute(input) { return { output: `echo ${JSON.stringify(input)}` }; },
  });
  return { provider, registry, systemPrompt: "sys", maxTurns: 10, verbose: false, costTracker, compaction: { minPrunedTokens: 0, extractKnowledge: false } };
}

afterEach(() => vi.unstubAllGlobals());

describe("DeepSeek V4.1 Flash end to end", () => {
  for (const [label, name, model] of [
    ["DeepSeek API", "deepseek", "deepseek-flash"],
    ["OpenCode Go route", "openai-compat", "deepseek-v4.1-flash"],
  ] as const) {
    it(`tool turns, plain answers, resume, compaction and a dropped stream stay valid (${label})`, async () => {
      const { fetchMock, requests } = fakeDeepSeek([
        { kind: "tool", id: "call_1", reasoning: "r1: need echo" },
        { kind: "text", text: "Echoed.", reasoning: "r2: done" },
        { kind: "text", text: "Plain answer.", reasoning: "r3: no tool" },
        { kind: "tool", id: "call_2", reasoning: "r4: echo again" },
        { kind: "drop", reasoning: "r5: about to answer" },
        { kind: "text", text: "Echoed again.", reasoning: "r5b: retried" },
        { kind: "text", text: "After compaction.", reasoning: "r6" },
      ]);
      vi.stubGlobal("fetch", fetchMock);

      const provider = new OpenAiProvider("sk", model, BASE, undefined, "high").withName(name);
      expect(provider.contextWindow).toBeGreaterThanOrEqual(1_000_000);
      const tracker = createCostTracker(model, null, name, BASE);
      const cfg = config(provider, tracker);

      // A session whose log is persisted line by line, as the CLI's file sink does.
      const lines: string[] = [];
      const log = new SessionLog({ sessionId: "ds", cwd: process.cwd(), createdAt: new Date().toISOString() }, (l) => lines.push(l));
      const session = createSession(provider.contextWindow, { log });

      // Turn 1: a tool call, then an answer. Turn 2: a plain answer.
      expect((await runTurn("run echo", session, cfg, quiet)).text).toContain("Echoed.");
      expect((await runTurn("thanks, anything else?", session, cfg, quiet)).text).toContain("Plain answer.");

      // Resume from the persisted lines in a fresh session.
      const [header, ...events] = lines.map((l) => JSON.parse(l));
      const resumed = createSession(provider.contextWindow, {
        log: SessionLog.restore(header as SessionLogHeader, events as SessionEvent[]),
      });
      // Turn 3 on the resumed session: a tool call whose answer stream drops once.
      expect((await runTurn("echo once more", resumed, cfg, quiet)).text).toContain("Echoed again.");

      // Compact, then keep going.
      const compaction = await compactWithLlm(provider, cfg.systemPrompt, resumed.messages, {
        config: cfg.compaction,
        costTracker: tracker,
        pruneConfig: { contextLimit: provider.contextWindow, keepRecentTurns: 1 },
        tools: cfg.registry.getDefinitions(),
      });
      expect(compaction?.usedLlm).toBe(true);
      resumed.log.replaceMessageRange(compaction!.plan.startIndex, compaction!.plan.endIndex, compaction!.plan.summaryMessage);
      expect((await runTurn("and now?", resumed, cfg, quiet)).text).toContain("After compaction.");

      // Every request DeepSeek would have taken; none was refused.
      expect(requests.map(violation)).toEqual(requests.map(() => null));
      for (const body of requests) {
        if (body.stream === true) expect(body.reasoning_effort).toBe("high");
      }

      // Reasoning replayed: the plain answer's reasoning rides along after the resume.
      const afterResume = requests[3].messages as Wire[];
      expect(afterResume.find((m) => m.content === "Plain answer.")).toMatchObject({ reasoning_content: "r3: no tool" });
      expect(afterResume.find((m) => Array.isArray(m.tool_calls))).toMatchObject({ reasoning_content: "r1: need echo" });

      // The dropped stream was asked again, and its half answer never reached the history.
      const streamed = requests.filter((b) => b.stream === true);
      expect(streamed).toHaveLength(7);
      expect(JSON.stringify(resumed.messages)).not.toContain("half an ans");

      // Cost from the catalog's own prices: misses at the input price, hits at the cache price.
      const { pricing, metered } = resolvePricing(model, name, BASE);
      expect(metered).toBe(true);
      expect(pricing.cacheReadPer1M).toBeLessThan(pricing.inputPer1M / 10);
      const calls = requests.length - 1; // every completed request reported USAGE; the dropped one reported none
      const perCall = (1_000 * pricing.inputPer1M + 9_000 * pricing.cacheReadPer1M! + 500 * pricing.outputPer1M) / 1e6;
      expect(tracker.totalCacheReadTokens).toBe(9_000 * calls);
      expect(tracker.totalCost).toBeCloseTo(perCall * calls, 10);
    }, 20_000);
  }

  it("the strict fake refuses what DeepSeek refuses (guards the test itself)", () => {
    const tools = [{ type: "function", function: { name: "echo" } }];
    expect(violation({ tools, messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "Hello." }, { role: "user", content: "x" }] }))
      .toMatch(/reasoning_content/);
    expect(violation({ messages: [{ role: "assistant", content: "", tool_calls: [{ id: "a" }] }, { role: "user", content: "x" }] }))
      .toMatch(/not answered/);
    expect(violation({ messages: [{ role: "tool", tool_call_id: "zzz", content: "x" }] })).toMatch(/no pending/);
    expect(violation({ reasoning_effort: "medium", messages: [] })).toMatch(/not accepted/);
  });
});
