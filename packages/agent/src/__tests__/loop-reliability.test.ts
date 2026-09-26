import { describe, it, expect, vi } from "vitest";
import type { LlmProvider, LlmResponse, LlmMessage, ContentBlock, StreamDelta } from "../providers/types.js";
import type { AgentConfig } from "../agent-loop.js";
import { ToolRegistry } from "../tools/registry.js";
import { planPrune } from "../context/pruner.js";
import { isContextOverflowError } from "../providers/retry.js";

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

const { runTurn, createSession, closeDanglingToolUses } = await import("../agent-loop/index.js");

function config(provider: LlmProvider, overrides: Partial<AgentConfig> = {}): AgentConfig {
  const registry = new ToolRegistry();
  registry.setPermissions({ mode: "full-auto", projectRoot: process.cwd(), allowedPaths: [] });
  registry.register({
    name: "echo",
    description: "echo",
    input_schema: { type: "object", properties: {} },
    async execute(input) { return { output: `echo ${JSON.stringify(input)}` }; },
  });
  return { provider, registry, systemPrompt: "sys", maxTurns: 10, verbose: false, ...overrides };
}

const quiet = { onStatus: () => {}, onTextDelta: () => {}, onTextBlock: () => {} };

/** Every tool_use in the history is answered by a tool_result in the next message. */
function assertPaired(messages: LlmMessage[]): void {
  messages.forEach((m, i) => {
    if (m.role !== "assistant" || typeof m.content === "string") return;
    const ids = m.content.filter((b) => b.type === "tool_use").map((b) => (b as { id: string }).id);
    if (ids.length === 0) return;
    const next = messages[i + 1];
    expect(next, `tool_use at ${i} has no following message`).toBeDefined();
    const answered = new Set((next.content as ContentBlock[]).filter((b) => b.type === "tool_result").map((b) => (b as { tool_use_id: string }).tool_use_id));
    for (const id of ids) expect(answered.has(id), `tool_use ${id} unanswered`).toBe(true);
  });
}

describe("interrupt leaves a valid history", () => {
  it("answers tool calls the model made before the user interrupted", async () => {
    const abort = new AbortController();
    const provider: LlmProvider = {
      name: "mock",
      contextWindow: 200_000,
      async *chatStream(): AsyncIterable<StreamDelta> {
        yield { type: "tool_use_start", id: "t1", name: "echo" };
        yield { type: "tool_use_delta", id: "t1", json: "{}" };
        yield { type: "tool_use_end", id: "t1" };
        abort.abort(); // Esc pressed while the stream is still open
        yield { type: "done", stop_reason: "tool_use" };
      },
      async chat(): Promise<LlmResponse> { throw new Error("unused"); },
    };
    const session = createSession(200_000);
    const result = await runTurn("go", session, config(provider), { ...quiet, signal: abort.signal });
    expect(result.stopReason).toBe("aborted");
    assertPaired(session.messages);
    const last = session.messages[session.messages.length - 1];
    expect(JSON.stringify(last.content)).toContain("Cancelled by user.");
  });

  it("repairs a history that ends in unanswered tool calls before the next prompt", async () => {
    const session = createSession(200_000);
    session.log.append("user/message", { message: { role: "user", content: "hi" }, source: "user", turn: 0 });
    session.log.append("assistant/message", {
      message: { role: "assistant", content: [{ type: "tool_use", id: "x1", name: "echo", input: {} }] },
      stop_reason: "tool_use",
      turn: 0,
    });
    const seen: LlmMessage[][] = [];
    const provider: LlmProvider = {
      name: "mock",
      async chat(_s, messages): Promise<LlmResponse> {
        seen.push(messages);
        return { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" };
      },
    };
    await runTurn("next", session, config(provider), quiet);
    assertPaired(seen[0]);
    expect(closeDanglingToolUses(session)).toBe(0);
  });
});

describe("context overflow recovery", () => {
  it("compacts and retries once when the provider rejects the prompt as too long", async () => {
    const session = createSession(200_000);
    // A long single tool loop: one user task, then only tool results.
    session.log.append("user/message", { message: { role: "user", content: "task" }, source: "user", turn: 0 });
    for (let i = 0; i < 12; i++) {
      session.log.append("assistant/message", {
        message: { role: "assistant", content: [{ type: "tool_use", id: `c${i}`, name: "echo", input: { i } }] },
        stop_reason: "tool_use",
        turn: i,
      });
      session.log.append("tool/results", {
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: `c${i}`, content: "x".repeat(2_000) }] },
        turn: i,
      });
    }
    let calls = 0;
    const sizes: number[] = [];
    const provider: LlmProvider = {
      name: "mock",
      contextWindow: 200_000,
      async chat(_s, messages, tools): Promise<LlmResponse> {
        if (tools.length === 0) throw new Error("no summaries in this test"); // compaction call → regex fallback
        calls++;
        sizes.push(messages.length);
        if (calls === 1) throw new Error("OpenAI API error 400: This model's maximum context length is 128000 tokens");
        return { content: [{ type: "text", text: "recovered" }], stop_reason: "end_turn" };
      },
    };
    const statuses: string[] = [];
    const result = await runTurn("continue", session, config(provider, { compaction: { enabled: false } }), {
      ...quiet,
      onStatus: (m) => statuses.push(m),
    });
    expect(result.text).toBe("recovered");
    expect(result.stopReason).toBe("end_turn");
    expect(sizes[1]).toBeLessThan(sizes[0]);
    expect(statuses.join("")).toContain("context overflow");
    assertPaired(session.messages);
  });

  it("does not loop: a second overflow in the same call is thrown", async () => {
    const session = createSession(200_000);
    const provider: LlmProvider = {
      name: "mock",
      async chat(): Promise<LlmResponse> { throw new Error("prompt is too long: 250000 tokens > 200000 maximum"); },
    };
    await expect(runTurn("x", session, config(provider), quiet)).rejects.toThrow(/too long/);
  });

  it("recognises provider overflow wording and nothing else", () => {
    for (const msg of [
      "Anthropic API error 400: prompt is too long: 210000 tokens > 200000 maximum",
      "OpenAI API error 400: context_length_exceeded",
      "OpenRouter API error 400: This endpoint's maximum context length is 163840 tokens",
      "deepseek API error 400: This model's maximum context length is 1048576 tokens. However, you requested ...",
      "Codex API error 413: request too large",
    ]) expect(isContextOverflowError(new Error(msg)), msg).toBe(true);
    for (const msg of ["OpenAI API error 429: rate limited", "ECONNRESET", "Invalid API key"]) {
      expect(isContextOverflowError(new Error(msg)), msg).toBe(false);
    }
  });
});

describe("quota errors are not retried", () => {
  it("fails fast on a subscription usage limit but still retries a plain 429", async () => {
    const { withRetry } = await import("../providers/retry.js");
    let calls = 0;
    const quota = withRetry(async () => {
      calls++;
      throw new Error('Codex API error 429: {"error":{"type":"usage_limit_reached","resets_in_seconds":34650}}');
    }, { baseDelayMs: 1, maxDelayMs: 1 });
    await expect(quota).rejects.toThrow(/usage_limit_reached/);
    expect(calls).toBe(1);

    let rateCalls = 0;
    const rate = withRetry(async () => {
      rateCalls++;
      if (rateCalls < 2) throw new Error("OpenAI API error 429: rate limited");
      return "ok";
    }, { baseDelayMs: 1, maxDelayMs: 1 });
    await expect(rate).resolves.toBe("ok");
    expect(rateCalls).toBe(2);
  });
});

describe("planPrune on a pure tool loop", () => {
  it("splits before an assistant message when no later user text exists", () => {
    const messages: LlmMessage[] = [{ role: "user", content: "task" }];
    for (let i = 0; i < 20; i++) {
      messages.push({ role: "assistant", content: [{ type: "tool_use", id: `c${i}`, name: "echo", input: {} }] });
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `c${i}`, content: "r" }] });
    }
    const plan = planPrune(messages, { keepRecentTurns: 3 });
    expect(plan).not.toBeNull();
    expect(messages[plan!.endIndex + 1].role).toBe("assistant");
    const after = [...messages.slice(0, plan!.startIndex), plan!.summaryMessage, ...messages.slice(plan!.endIndex + 1)];
    assertPaired(after);
    expect(after.length).toBeLessThan(messages.length);
  });
});

describe("turn stop reasons", () => {
  it("reports max_turns when the cap runs out", async () => {
    const provider: LlmProvider = {
      name: "mock",
      async chat(): Promise<LlmResponse> {
        return { content: [{ type: "tool_use", id: `t${Math.random()}`, name: "echo", input: { n: Math.random() } }], stop_reason: "tool_use" };
      },
    };
    const result = await runTurn("loop", createSession(), config(provider, { maxTurns: 2 }), quiet);
    expect(result.stopReason).toBe("max_turns");
  });

  it("reports end_turn for a normal answer", async () => {
    const provider: LlmProvider = {
      name: "mock",
      async chat(): Promise<LlmResponse> { return { content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" }; },
    };
    const result = await runTurn("hi", createSession(), config(provider), quiet);
    expect(result.stopReason).toBe("end_turn");
  });
});
