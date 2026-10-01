import { describe, expect, it } from "vitest";
import { parseOpenAiResponse, parseOpenAiStream, parseOpenAiUsage } from "../providers/openai-compat.js";
import { consumeStream } from "../agent-loop/stream.js";
import { createCostTracker } from "../cost.js";
import { buildHeadlessResult } from "../headless.js";

function sse(chunks: unknown[]): Response {
  return new Response(`${chunks.map((c) => `data: ${JSON.stringify(c)}`).join("\n\n")}\n\ndata: [DONE]\n\n`);
}

describe("cached prompt tokens", () => {
  it("reads DeepSeek's prompt_cache_hit_tokens and OpenAI's prompt_tokens_details.cached_tokens", () => {
    expect(parseOpenAiUsage({ prompt_tokens: 1000, completion_tokens: 50, prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 100 }))
      .toEqual({ input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 900 });
    expect(parseOpenAiUsage({ prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 768 } }))
      .toEqual({ input_tokens: 232, output_tokens: 50, cache_read_input_tokens: 768 });
    expect(parseOpenAiUsage({ prompt_tokens: 10, completion_tokens: 2 })).toEqual({ input_tokens: 10, output_tokens: 2 });
  });

  it("carries cache hits through the batch and stream parsers", async () => {
    const usage = { prompt_tokens: 1000, completion_tokens: 50, prompt_cache_hit_tokens: 900 };
    const batch = parseOpenAiResponse({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }], usage });
    expect(batch.usage).toEqual({ input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 900 });

    const tracker = createCostTracker("deepseek-flash", null, "deepseek");
    await consumeStream(
      parseOpenAiStream(sse([
        { choices: [{ delta: { content: "hi" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }], usage },
      ])),
      tracker,
      () => {},
    );
    expect(tracker.totalInputTokens).toBe(100);
    expect(tracker.totalCacheReadTokens).toBe(900);
    expect(tracker.totalOutputTokens).toBe(50);
  });

  it("prices cache hits at the cache rate", () => {
    const tracker = createCostTracker("deepseek-flash", null, "deepseek");
    tracker.recordUsage(1_000_000, 1_000_000, 9_000_000);
    // $0.15 miss + $0.60 out + 9 × $0.003 hit
    expect(tracker.totalCost).toBeCloseTo(0.777, 6);
    expect(tracker.formatTurnCost(0, 0, 1_000_000)).toBe("$0.0030");
    expect(tracker.formatCost()).toMatch(/11000000 tokens, 9000000 cached/);
  });

  it("bills hits as ordinary input when the model has no cache price", () => {
    const tracker = createCostTracker("gpt-4o", null, "openai");
    tracker.recordUsage(0, 0, 1_000_000);
    expect(tracker.totalCost).toBeCloseTo(2.5, 6);
  });

  it("reports cache_read_input_tokens in the headless result", () => {
    const tracker = createCostTracker("deepseek-flash", null, "deepseek");
    tracker.recordUsage(100_000, 50_000, 900_000);
    const r = buildHeadlessResult({
      text: "", stopReason: "end_turn", turns: 1, toolCalls: 0, startedAt: Date.now(), sessionId: null,
      provider: "deepseek", model: "deepseek-flash", costTracker: tracker, permissionDenials: 0,
    });
    expect(r.usage).toEqual({ input_tokens: 100_000, output_tokens: 50_000, cache_read_input_tokens: 900_000, cache_creation_input_tokens: 0 });
    expect(r.total_cost_usd).toBeCloseTo(0.015 + 0.03 + 0.0027, 6);
  });
});

describe("child agent cache tokens", () => {
  it("aggregateChildCost carries a child's cache reads and writes into the parent", async () => {
    const { AgentSpawner } = await import("../multi/spawner.js");
    const parent = createCostTracker("claude-sonnet-5", null, "anthropic");
    const spawner = new AgentSpawner({ costTracker: parent });
    (spawner as unknown as { handleChildMessage(msg: unknown): void }).handleChildMessage({
      type: "done",
      agentId: "agent-1",
      result: { finalText: "", turns: 1, toolCalls: 0, inputTokens: 10, outputTokens: 5, cacheReadTokens: 900, cacheWriteTokens: 80, costUsd: 0.5 },
    });
    expect(parent.totalInputTokens).toBe(10);
    expect(parent.totalOutputTokens).toBe(5);
    expect(parent.totalCacheReadTokens).toBe(900);
    expect(parent.totalCacheWriteTokens).toBe(80);
    expect(parent.totalCost).toBeCloseTo(0.5, 6);
    expect(parent.formatCost()).toMatch(/995 tokens, 900 cached/);
  });

  it("a child that only read from the cache still counts", async () => {
    const { AgentSpawner } = await import("../multi/spawner.js");
    const parent = createCostTracker("claude-sonnet-5", null, "anthropic");
    const spawner = new AgentSpawner({ costTracker: parent });
    (spawner as unknown as { handleChildMessage(msg: unknown): void }).handleChildMessage({
      type: "done",
      agentId: "agent-1",
      result: { finalText: "", turns: 1, toolCalls: 0, cacheReadTokens: 400 },
    });
    expect(parent.totalCacheReadTokens).toBe(400);
  });
});
