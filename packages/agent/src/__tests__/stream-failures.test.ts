import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamDelta } from "../providers/types.js";
import { IncompleteStreamError, RetryableProviderError } from "../providers/types.js";
import { AnthropicProvider } from "../providers/anthropic.js";
import { OllamaProvider } from "../providers/ollama.js";
import { parseOpenAiStream } from "../providers/openai-compat.js";
import { consumeStream } from "../agent-loop/stream.js";
import { createCostTracker } from "../cost.js";
import { withRetry } from "../providers/retry.js";

afterEach(() => { vi.unstubAllGlobals(); });

/** A response body that sends `text` and then either ends or fails like a dropped socket. */
function body(text: string, drop = false): Response {
  let sent = false;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode(text)); return; }
      if (drop) controller.error(Object.assign(new TypeError("terminated"), { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) }));
      else controller.close();
    },
  }));
}

const anthropicEvents = (list: Array<[string, unknown]>) =>
  body(list.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(""));

async function drain(stream: AsyncIterable<StreamDelta>): Promise<StreamDelta[]> {
  const out: StreamDelta[] = [];
  for await (const d of stream) out.push(d);
  return out;
}

const user = [{ role: "user" as const, content: "x" }];

describe("Anthropic mid-stream error events", () => {
  for (const type of ["overloaded_error", "api_error"]) {
    it(`${type} is retryable, and withRetry retries it`, async () => {
      const p = new AnthropicProvider("key", "claude-sonnet-5", 1024);
      let calls = 0;
      vi.stubGlobal("fetch", vi.fn(async () => {
        calls++;
        return calls === 1
          ? anthropicEvents([
            ["message_start", { message: { usage: { input_tokens: 3 } } }],
            ["error", { type: "error", error: { type, message: "try later" } }],
          ])
          : anthropicEvents([
            ["message_start", { message: { usage: { input_tokens: 3 } } }],
            ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } }],
            ["message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
            ["message_stop", {}],
          ]);
      }));
      await expect(drain(p.chatStream("s", user, []))).rejects.toBeInstanceOf(RetryableProviderError);
      calls = 0;
      const deltas = await withRetry(() => drain(p.chatStream("s", user, [])), { baseDelayMs: 1, maxDelayMs: 1 });
      expect(calls).toBe(2);
      expect(deltas.at(-1)).toMatchObject({ type: "done", stop_reason: "end_turn" });
    });
  }

  it("other error types are not retried", async () => {
    const p = new AnthropicProvider("key", "claude-sonnet-5", 1024);
    vi.stubGlobal("fetch", vi.fn(async () => anthropicEvents([
      ["error", { type: "error", error: { type: "invalid_request_error", message: "bad" } }],
    ])));
    const err = await drain(p.chatStream("s", user, [])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RetryableProviderError);
  });

  it("a stream without message_stop is an IncompleteStreamError carrying the billed input", async () => {
    const p = new AnthropicProvider("key", "claude-sonnet-5", 1024);
    vi.stubGlobal("fetch", vi.fn(async () => anthropicEvents([
      ["message_start", { message: { usage: { input_tokens: 300, cache_read_input_tokens: 5000 } } }],
      ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "cut" } }],
    ])));
    const tracker = createCostTracker("claude-sonnet-5", null, "anthropic");
    await expect(consumeStream(p.chatStream("s", user, []), tracker, () => {})).rejects.toBeInstanceOf(IncompleteStreamError);
    // The failed attempt's tokens count toward --budget.
    expect(tracker.totalInputTokens).toBe(300);
    expect(tracker.totalCacheReadTokens).toBe(5000);
  });
});

describe("Anthropic cache tokens", () => {
  it("the stream reports cache reads and writes, and writes bill at 1.25x input", async () => {
    const p = new AnthropicProvider("key", "claude-sonnet-5", 1024);
    vi.stubGlobal("fetch", vi.fn(async () => anthropicEvents([
      ["message_start", { message: { usage: { input_tokens: 1_000_000, cache_read_input_tokens: 2_000_000, cache_creation_input_tokens: 1_000_000, output_tokens: 1 } } }],
      ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "hi" } }],
      ["message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1_000_000 } }],
      ["message_stop", {}],
    ])));
    const deltas = await drain(p.chatStream("s", user, []));
    expect(deltas.at(-1)).toEqual({
      type: "done",
      stop_reason: "end_turn",
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 2_000_000, cache_creation_input_tokens: 1_000_000 },
    });

    const tracker = createCostTracker("claude-sonnet-5", null, "anthropic");
    const done = deltas.at(-1) as Extract<StreamDelta, { type: "done" }>;
    tracker.recordUsage(done.usage!.input_tokens, done.usage!.output_tokens, done.usage!.cache_read_input_tokens, done.usage!.cache_creation_input_tokens);
    // $3 in + $15 out + 2 × $3 (no cache price in the catalog: hits bill as input) + 1.25 × $3 written
    expect(tracker.totalCost).toBeCloseTo(3 + 15 + 6 + 3.75, 6);
    expect(tracker.totalCacheWriteTokens).toBe(1_000_000);
  });

  it("the batch path reports them too", async () => {
    const p = new AnthropicProvider("key", "claude-sonnet-5", 1024);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 700, cache_creation_input_tokens: 90 },
    }))));
    const res = await p.chat("s", user, []);
    expect(res.usage).toEqual({ input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 700, cache_creation_input_tokens: 90 });
  });
});

describe("Ollama", () => {
  it("a stream without done is an IncompleteStreamError", async () => {
    const p = new OllamaProvider("llama3", "http://127.0.0.1:1");
    vi.stubGlobal("fetch", vi.fn(async () => body(`${JSON.stringify({ message: { content: "cut" }, done: false })}\n`)));
    await expect(drain(p.chatStream("s", user, []))).rejects.toBeInstanceOf(IncompleteStreamError);
  });
});

describe("OpenAI-compatible socket drops", () => {
  it("a drop after finish_reason is done, not a failure", async () => {
    const res = body([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "complete" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`,
      "",
    ].join("\n"), true);
    const deltas = await drain(parseOpenAiStream(res));
    expect(deltas).toEqual([
      { type: "text_delta", text: "complete" },
      { type: "done", stop_reason: "end_turn", usage: undefined },
    ]);
  });

  it("a drop before finish_reason still fails (retryable), with the usage seen so far", async () => {
    const res = body([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "par" } }], usage: { prompt_tokens: 40, completion_tokens: 1 } })}`,
      "",
    ].join("\n"), true);
    const tracker = createCostTracker("deepseek-flash", null, "deepseek");
    const err = await consumeStream(parseOpenAiStream(res), tracker, () => {}).catch((e: unknown) => e);
    expect((err as Error).message).toBe("terminated");
    expect(tracker.totalInputTokens).toBe(40);
  });
});
