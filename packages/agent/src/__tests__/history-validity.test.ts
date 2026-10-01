import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContentBlock, LlmMessage, LlmProvider, LlmResponse, StreamDelta } from "../providers/types.js";
import { IncompleteStreamError } from "../providers/types.js";
import type { AgentConfig } from "../agent-loop.js";
import { ToolRegistry } from "../tools/registry.js";
import { planPrune } from "../context/pruner.js";
import { compactWithLlm } from "../context/compactor.js";
import { parseOpenAiStream } from "../providers/openai-compat.js";
import { AnthropicProvider } from "../providers/anthropic.js";

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

function config(provider: LlmProvider, executed: string[] = []): AgentConfig {
  const registry = new ToolRegistry();
  registry.setPermissions({ mode: "full-auto", projectRoot: process.cwd(), allowedPaths: [] });
  registry.register({
    name: "echo",
    description: "echo",
    input_schema: { type: "object", properties: {} },
    async execute(input) {
      executed.push(JSON.stringify(input));
      return { output: `echo ${JSON.stringify(input)}` };
    },
  });
  return { provider, registry, systemPrompt: "sys", maxTurns: 10, verbose: false };
}

/** Every tool_use is answered in the next message, and every tool_result answers the call just before it. */
function assertPaired(messages: LlmMessage[]): void {
  messages.forEach((m, i) => {
    if (typeof m.content === "string") return;
    if (m.role === "assistant") {
      const ids = m.content.filter((b) => b.type === "tool_use").map((b) => (b as { id: string }).id);
      if (ids.length === 0) return;
      const next = messages[i + 1];
      expect(next, `tool_use at ${i} has no following message`).toBeDefined();
      const answered = new Set((next.content as ContentBlock[]).filter((b) => b.type === "tool_result").map((b) => (b as { tool_use_id: string }).tool_use_id));
      for (const id of ids) expect(answered.has(id), `tool_use ${id} unanswered`).toBe(true);
    } else {
      const results = m.content.filter((b) => b.type === "tool_result").map((b) => (b as { tool_use_id: string }).tool_use_id);
      if (results.length === 0) return;
      const prev = messages[i - 1];
      const calls = new Set(
        prev && prev.role === "assistant" && Array.isArray(prev.content)
          ? prev.content.filter((b) => b.type === "tool_use").map((b) => (b as { id: string }).id)
          : [],
      );
      for (const id of results) expect(calls.has(id), `tool_result ${id} at ${i} has no call`).toBe(true);
    }
  });
}

function sse(text: string): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  }));
}

async function drain(stream: AsyncIterable<StreamDelta>): Promise<StreamDelta[]> {
  const out: StreamDelta[] = [];
  for await (const d of stream) out.push(d);
  return out;
}

afterEach(() => vi.unstubAllGlobals());

describe("max_tokens with complete tool calls", () => {
  it("answers the calls without running them before asking for a continuation", async () => {
    const replies: LlmResponse[] = [
      {
        content: [
          { type: "text", text: "Running two things" },
          { type: "tool_use", id: "a", name: "echo", input: { n: 1 } },
          { type: "tool_use", id: "b", name: "echo", input: { n: 2 } },
        ],
        stop_reason: "max_tokens",
      },
      { content: [{ type: "text", text: "Continuing. Done." }], stop_reason: "end_turn" },
    ];
    const seen: LlmMessage[][] = [];
    const provider: LlmProvider = {
      name: "mock",
      async chat(_s, messages): Promise<LlmResponse> {
        seen.push(structuredClone(messages));
        return replies.shift()!;
      },
    };
    const executed: string[] = [];
    const session = createSession();
    const result = await runTurn("go", session, config(provider, executed), quiet);
    expect(result.stopReason).toBe("end_turn");
    expect(executed).toEqual([]);
    assertPaired(seen[1]);
    assertPaired(session.messages);
    const results = seen[1][2].content as ContentBlock[];
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ type: "tool_result", tool_use_id: "a", is_error: true });
    expect(String((results[0] as { content: string }).content)).toMatch(/truncated at max_tokens/);
    expect(seen[1][3]).toMatchObject({ role: "user", content: expect.stringMatching(/truncated due to length/) });
  });
});

describe("planPrune boundaries", () => {
  it("never starts the kept tail on a user message that mixes tool results and text", () => {
    // The lint/test follow-up shape: tool results plus a text block in one message.
    const messages: LlmMessage[] = [{ role: "user", content: "task" }];
    for (let i = 0; i < 12; i++) {
      messages.push({ role: "assistant", content: [{ type: "tool_use", id: `c${i}`, name: "edit_file", input: {} }] });
      messages.push({
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: `c${i}`, content: "ok" },
          { type: "text", text: `Post-edit check failed (npm test) ${i}` },
        ],
      });
    }
    for (const keepRecentTurns of [1, 2, 3, 4, 5]) {
      const plan = planPrune(messages, { keepRecentTurns });
      expect(plan).not.toBeNull();
      const after = [...messages.slice(0, plan!.startIndex), plan!.summaryMessage, ...messages.slice(plan!.endIndex + 1)];
      assertPaired(after);
      expect(after.length).toBeLessThan(messages.length);
    }
  });

  it("still splits on a plain user text message", () => {
    const messages: LlmMessage[] = [{ role: "user", content: "task" }];
    for (let i = 0; i < 10; i++) {
      messages.push({ role: "assistant", content: [{ type: "tool_use", id: `c${i}`, name: "echo", input: {} }] });
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `c${i}`, content: "r" }] });
      messages.push({ role: "assistant", content: [{ type: "text", text: "done" }] });
      messages.push({ role: "user", content: `next ${i}` });
    }
    const plan = planPrune(messages, { keepRecentTurns: 3 });
    expect(messages[plan!.endIndex + 1]).toMatchObject({ role: "user", content: expect.stringMatching(/^next/) });
  });
});

describe("compaction call cancellation", () => {
  it("aborts the summary request when the compaction times out", async () => {
    let requestSignal: AbortSignal | undefined;
    const provider: LlmProvider = {
      name: "mock",
      chat(_s, _m, _t, signal) {
        requestSignal = signal;
        return new Promise<LlmResponse>(() => {});
      },
    };
    const messages: LlmMessage[] = [{ role: "user", content: "task" }];
    for (let i = 0; i < 20; i++) {
      messages.push({ role: "assistant", content: [{ type: "tool_use", id: `c${i}`, name: "echo", input: {} }] });
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `c${i}`, content: "x".repeat(4000) }] });
    }
    const result = await compactWithLlm(provider, "sys", messages, {
      config: { timeoutMs: 20, minPrunedTokens: 0, extractKnowledge: false },
      pruneConfig: { contextLimit: 10_000, keepRecentTurns: 2 },
    });
    expect(result?.usedLlm).toBe(false);
    expect(requestSignal?.aborted).toBe(true);
  });
});

describe("incomplete streams fail instead of reporting success", () => {
  it("OpenAI-compatible: partial text with no finish_reason and no [DONE] throws", async () => {
    const res = sse(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial ans" } }] })}\n\n`);
    await expect(drain(parseOpenAiStream(res))).rejects.toBeInstanceOf(IncompleteStreamError);
  });

  it("OpenAI-compatible: DeepSeek's aborted finish_reason throws", async () => {
    const res = sse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "half" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "aborted" }] })}`,
      "data: [DONE]",
      "",
    ].join("\n"));
    await expect(drain(parseOpenAiStream(res))).rejects.toThrow(/aborted/);
  });

  it("OpenAI-compatible: a finish_reason without [DONE] completes, and a final unterminated event is read", async () => {
    const res = sse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "all" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 1 } })}`,
    ].join("\n"));
    const deltas = await drain(parseOpenAiStream(res));
    expect(deltas.at(-1)).toEqual({ type: "done", stop_reason: "end_turn", usage: { input_tokens: 4, output_tokens: 1 } });
  });

  it("an incomplete stream makes runTurn fail, not end_turn", async () => {
    const provider: LlmProvider = {
      name: "mock",
      async chat(): Promise<LlmResponse> { throw new Error("unused"); },
      async *chatStream(): AsyncIterable<StreamDelta> {
        yield* parseOpenAiStream(sse(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n`));
      },
    };
    await expect(runTurn("go", createSession(), config(provider), quiet)).rejects.toBeInstanceOf(IncompleteStreamError);
  });

  it("Anthropic: a stream without message_stop throws, and an error event throws", async () => {
    const events = (list: Array<[string, unknown]>) => sse(list.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(""));
    const p = new AnthropicProvider("key", "claude-sonnet-5", 1024);

    vi.stubGlobal("fetch", vi.fn(async () => events([
      ["message_start", { message: { usage: { input_tokens: 3 } } }],
      ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "cut" } }],
    ])));
    await expect(drain(p.chatStream("s", [{ role: "user", content: "x" }], []))).rejects.toBeInstanceOf(IncompleteStreamError);

    vi.stubGlobal("fetch", vi.fn(async () => events([
      ["message_start", { message: { usage: { input_tokens: 3 } } }],
      ["error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }],
    ])));
    await expect(drain(p.chatStream("s", [{ role: "user", content: "x" }], []))).rejects.toThrow(/overloaded_error/);

    vi.stubGlobal("fetch", vi.fn(async () => events([
      ["message_start", { message: { usage: { input_tokens: 3 } } }],
      ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "whole" } }],
      ["message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
      ["message_stop", {}],
    ])));
    const ok = await drain(p.chatStream("s", [{ role: "user", content: "x" }], []));
    expect(ok.at(-1)).toMatchObject({ type: "done", stop_reason: "end_turn" });
  });
});
