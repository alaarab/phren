import { describe, expect, it, vi } from "vitest";
import { parseOpenAiResponse, parseOpenAiStream } from "../providers/openai-compat.js";
import { withRetry } from "../providers/retry.js";
import { runToolsConcurrently } from "../agent-loop/stream.js";
import { ToolRegistry } from "../tools/registry.js";
import type { StreamDelta } from "../providers/types.js";

function stream(...chunks: unknown[]): Response {
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n");
}
async function collect(response: Response): Promise<StreamDelta[]> {
  const result: StreamDelta[] = [];
  for await (const delta of parseOpenAiStream(response)) result.push(delta);
  return result;
}
const unavailable = { error: { code: 503, message: "No provider available" } };

describe("OpenAI-compatible provider errors", () => {
  it("rejects HTTP 200 error bodies in non-streaming responses", () => {
    expect(() => parseOpenAiResponse(unavailable)).toThrow("API error 503: No provider available");
  });
  it("rejects an SSE error before yielding a successful completion", async () => {
    const response = stream(unavailable);
    await expect(collect(response)).rejects.toThrow("API error 503: No provider available");
    expect(response.body?.locked).toBe(false);
  });
  it("preserves the status for retries before the first delta", async () => {
    let calls = 0;
    const attempt = vi.fn(async () => {
      const response = ++calls === 1 ? stream(unavailable)
        : stream({ choices: [{ delta: { content: "Recovered" }, finish_reason: "stop" }] });
      const iterator = parseOpenAiStream(response)[Symbol.asyncIterator]();
      try { return await iterator.next(); } finally { await iterator.return?.(); }
    });
    const first = await withRetry(attempt, { baseDelayMs: 1, maxDelayMs: 1 });
    expect(first.value).toEqual({ type: "text_delta", text: "Recovered" });
    expect(attempt).toHaveBeenCalledTimes(2);
  });
  it("fails after partial output without producing tool completion or done events", async () => {
    const seen: StreamDelta[] = [];
    const response = stream(
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call1", function: { name: "write_file", arguments: '{}' } }] } }] },
      { ...unavailable, choices: [{ delta: { content: "" }, finish_reason: "error" }] },
    );
    await expect((async () => {
      for await (const delta of parseOpenAiStream(response)) seen.push(delta);
    })()).rejects.toThrow("API error 503");
    expect(seen.map((delta) => delta.type)).toEqual(["tool_use_start", "tool_use_delta"]);
  });
  it("rejects an error finish reason even when error details are missing", async () => {
    await expect(collect(stream({ choices: [{ finish_reason: "error" }] }))).rejects.toThrow("generation error");
    expect(() => parseOpenAiResponse({ choices: [{ finish_reason: "error" }] })).toThrow("generation error");
  });
  it("cancels and unlocks the response body on a stream failure", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(unavailable)}\n\n`)); },
      cancel,
    }));
    await expect(collect(response)).rejects.toThrow("API error 503");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body?.locked).toBe(false);
  });
});

describe("permission prompts after cancellation", () => {
  it.each(["cancel", "timeout"])("does not execute after late approval following %s", async (reason) => {
    const registry = new ToolRegistry();
    let approve!: (allowed: boolean) => void;
    let prompted!: () => void;
    const awaitingPrompt = new Promise<void>((resolve) => { prompted = resolve; });
    registry.askUser = () => {
      prompted();
      return new Promise<boolean>((resolve) => { approve = resolve; });
    };
    const execute = vi.fn().mockResolvedValue({ output: "mutated" });
    registry.register({ name: "mutate", description: "mutates", input_schema: {}, timeoutMs: 30, execute });
    const controller = new AbortController();
    const result = runToolsConcurrently([{ type: "tool_use", id: "late", name: "mutate", input: {} }], registry, controller.signal);
    await awaitingPrompt;
    if (reason === "cancel") controller.abort();
    expect((await result)[0].is_error).toBe(true);
    approve(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(execute).not.toHaveBeenCalled();
  });
  it("does not ask permission or execute with an already aborted signal", async () => {
    const registry = new ToolRegistry();
    const execute = vi.fn().mockResolvedValue({ output: "mutated" });
    registry.register({ name: "mutate", description: "mutates", input_schema: {}, execute });
    registry.askUser = vi.fn().mockResolvedValue(true);
    const controller = new AbortController();
    controller.abort();
    expect(await registry.execute("mutate", {}, controller.signal)).toEqual({ output: "Cancelled by user.", is_error: true });
    expect(registry.askUser).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
