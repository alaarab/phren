import { describe, expect, it } from "vitest";
import type { LlmMessage, StreamDelta } from "../providers/types.js";
import { stripForeignReasoning } from "../providers/history.js";
import { AnthropicProvider, toWireBlock, parseWireContent } from "../providers/anthropic.js";
import { toOpenAiMessages, parseOpenAiResponse, parseOpenAiStream } from "../providers/openai-compat.js";
import { consumeStream } from "../agent-loop/stream.js";

/** Wrap SSE lines in a fetch Response for parseOpenAiStream. */
function sseResponse(lines: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(lines.join("\n") + "\n"));
      controller.close();
    },
  });
  return new Response(body);
}

describe("stripForeignReasoning", () => {
  const history: LlmMessage[] = [
    { role: "user", content: "question" },
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "mine", provider: "anthropic", signature: "s" },
        { type: "reasoning", text: "foreign", provider: "openai-codex", encrypted_content: "e" },
        { type: "reasoning", text: "untagged" },
        { type: "text", text: "answer" },
      ],
    },
  ];

  it("keeps only the named provider's reasoning", () => {
    const out = stripForeignReasoning(history, "anthropic");
    expect(out[1].content).toEqual([
      { type: "reasoning", text: "mine", provider: "anthropic", signature: "s" },
      { type: "text", text: "answer" },
    ]);
  });

  it("strips everything when no provider is given", () => {
    const out = stripForeignReasoning(history, undefined);
    expect(out[1].content).toEqual([{ type: "text", text: "answer" }]);
  });

  it("leaves string content and reasoning-free messages untouched (same reference)", () => {
    const out = stripForeignReasoning(history, "anthropic");
    expect(out[0]).toBe(history[0]);
  });
});

describe("Anthropic wire mapping", () => {
  it("serializes reasoning to a thinking block with signature", () => {
    expect(
      toWireBlock({ type: "reasoning", text: "hmm", provider: "anthropic", signature: "SIG" }),
    ).toEqual({ type: "thinking", thinking: "hmm", signature: "SIG" });
  });

  it("serializes redacted reasoning to redacted_thinking", () => {
    expect(
      toWireBlock({ type: "reasoning", text: "", provider: "anthropic", redacted: true, data: "OPAQUE" }),
    ).toEqual({ type: "redacted_thinking", data: "OPAQUE" });
  });

  it("parses thinking and redacted_thinking wire blocks into tagged reasoning", () => {
    expect(
      parseWireContent([
        { type: "thinking", thinking: "let me see", signature: "SIG" },
        { type: "redacted_thinking", data: "OPAQUE" },
        { type: "text", text: "answer" },
        { type: "server_tool_use", id: "x" }, // unknown wire type is dropped
      ]),
    ).toEqual([
      { type: "reasoning", text: "let me see", provider: "anthropic", signature: "SIG" },
      { type: "reasoning", text: "", provider: "anthropic", redacted: true, data: "OPAQUE" },
      { type: "text", text: "answer" },
    ]);
  });

  it("round-trips thinking through parse and serialize", () => {
    const wire = { type: "thinking", thinking: "chain", signature: "S2" };
    const [block] = parseWireContent([wire]);
    expect(toWireBlock(block)).toEqual(wire);
  });
});

describe("Anthropic thinking budget", () => {
  it("maps effort to a budget clamped under half of max_tokens", () => {
    const p = new AnthropicProvider("key", "claude-sonnet-4-20250514", 16384, true, "high");
    expect(p.thinkingBudget()).toBe(8192); // min(16384, 16384/2)
  });

  it("returns null with no reasoning effort", () => {
    const p = new AnthropicProvider("key", "claude-sonnet-4-20250514", 16384, true);
    expect(p.thinkingBudget()).toBeNull();
  });

  it("returns null when the clamp falls below the API minimum", () => {
    const p = new AnthropicProvider("key", "claude-sonnet-4-20250514", 2000, true, "high");
    expect(p.thinkingBudget()).toBeNull(); // floor(2000/2) = 1000 < 1024
  });
});

describe("OpenAI-compat reasoning passback", () => {
  it("sends reasoning_content only on tool-call turns", () => {
    const withTool: LlmMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "why", provider: "openai" },
          { type: "tool_use", id: "c", name: "t", input: {} },
        ],
      },
    ];
    const out = toOpenAiMessages("sys", withTool, "openai");
    expect(out[1]).toMatchObject({ role: "assistant", content: "", reasoning_content: "why" });

    const noTool: LlmMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "why", provider: "openai" },
          { type: "text", text: "answer" },
        ],
      },
    ];
    const plain = toOpenAiMessages("sys", noTool, "openai");
    expect(plain[1]).toEqual({ role: "assistant", content: "answer" });
  });

  it("always sends string content, never null, even on reasoning-only turns", () => {
    const out = toOpenAiMessages(
      "sys",
      [{ role: "assistant", content: [{ type: "reasoning", text: "only", provider: "openai" }] }],
      "openai",
    );
    expect(out[1]).toEqual({ role: "assistant", content: "" });
  });

  it("parses reasoning_content and reasoning response fields into a tagged block", () => {
    const a = parseOpenAiResponse(
      { choices: [{ message: { reasoning_content: "deep", content: "hi" }, finish_reason: "stop" }] },
      "openai",
    );
    expect(a.content[0]).toEqual({ type: "reasoning", text: "deep", provider: "openai" });
    expect(a.content[1]).toEqual({ type: "text", text: "hi" });

    const b = parseOpenAiResponse(
      { choices: [{ message: { reasoning: "unified", content: "yo" }, finish_reason: "stop" }] },
      "openrouter",
    );
    expect(b.content[0]).toEqual({ type: "reasoning", text: "unified", provider: "openrouter" });
  });
});

describe("parseOpenAiStream", () => {
  it("yields reasoning deltas from reasoning_content and reasoning fields", async () => {
    const res = sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "deep " } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning: "unified" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "answer" } }] })}`,
      "data: [DONE]",
    ]);
    const deltas: StreamDelta[] = [];
    for await (const d of parseOpenAiStream(res)) deltas.push(d);
    expect(deltas).toEqual([
      { type: "reasoning_delta", text: "deep " },
      { type: "reasoning_delta", text: "unified" },
      { type: "text_delta", text: "answer" },
      { type: "done", stop_reason: "end_turn", usage: undefined },
    ]);
  });

  it("streams tool calls with ids and closes them at DONE", async () => {
    const res = sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "grep", arguments: "" } }] } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":1}' } }] }, finish_reason: "tool_calls" }] })}`,
      "data: [DONE]",
    ]);
    const deltas: StreamDelta[] = [];
    for await (const d of parseOpenAiStream(res)) deltas.push(d);
    expect(deltas).toEqual([
      { type: "tool_use_start", id: "c1", name: "grep" },
      { type: "tool_use_delta", id: "c1", json: '{"q":1}' },
      { type: "tool_use_end", id: "c1" },
      { type: "done", stop_reason: "tool_use", usage: undefined },
    ]);
  });
});

describe("consumeStream reasoning assembly", () => {
  async function* deltas(items: StreamDelta[]): AsyncIterable<StreamDelta> {
    for (const d of items) yield d;
  }

  it("assembles reasoning before text, stamped with the provider", async () => {
    const seen: string[] = [];
    const result = await consumeStream(
      deltas([
        { type: "reasoning_delta", text: "think " },
        { type: "reasoning_delta", text: "hard" },
        { type: "reasoning_end", signature: "SIG" },
        { type: "text_delta", text: "answer" },
        { type: "done", stop_reason: "end_turn" },
      ]),
      null,
      { onTextDelta: () => {}, onReasoningDelta: (t) => seen.push(t), providerName: "anthropic" },
    );
    expect(seen).toEqual(["think ", "hard"]);
    expect(result.content).toEqual([
      { type: "reasoning", text: "think hard", provider: "anthropic", signature: "SIG" },
      { type: "text", text: "answer" },
    ]);
  });

  it("flushes deltas-only reasoning before a tool call (no reasoning_end)", async () => {
    const result = await consumeStream(
      deltas([
        { type: "reasoning_delta", text: "planning" },
        { type: "tool_use_start", id: "t1", name: "grep" },
        { type: "tool_use_delta", id: "t1", json: "{}" },
        { type: "tool_use_end", id: "t1" },
        { type: "done", stop_reason: "tool_use" },
      ]),
      null,
      { onTextDelta: () => {}, providerName: "openai" },
    );
    expect(result.content).toEqual([
      { type: "reasoning", text: "planning", provider: "openai" },
      { type: "tool_use", id: "t1", name: "grep", input: {} },
    ]);
    expect(result.stop_reason).toBe("tool_use");
  });

  it("keeps an encrypted-only reasoning block with empty text", async () => {
    const result = await consumeStream(
      deltas([
        { type: "reasoning_end", id: "rs_1", encrypted_content: "E" },
        { type: "text_delta", text: "ok" },
        { type: "done", stop_reason: "end_turn" },
      ]),
      null,
      { onTextDelta: () => {}, providerName: "openai-codex" },
    );
    expect(result.content[0]).toEqual({
      type: "reasoning",
      text: "",
      provider: "openai-codex",
      id: "rs_1",
      encrypted_content: "E",
    });
  });

  it("closes a text segment when reasoning starts after it", async () => {
    const result = await consumeStream(
      deltas([
        { type: "text_delta", text: "first" },
        { type: "reasoning_delta", text: "later thought" },
        { type: "reasoning_end" },
        { type: "text_delta", text: "second" },
        { type: "done", stop_reason: "end_turn" },
      ]),
      null,
      { onTextDelta: () => {}, providerName: "p" },
    );
    expect(result.content).toEqual([
      { type: "text", text: "first" },
      { type: "reasoning", text: "later thought", provider: "p" },
      { type: "text", text: "second" },
    ]);
  });
});
