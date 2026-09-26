import { describe, expect, it } from "vitest";
import type { LlmMessage, AgentToolDef } from "../providers/types.js";
import { toResponsesInput, toResponsesTools, parseResponsesOutput } from "../providers/codex.js";

describe("toResponsesTools", () => {
  it("produces Responses API tool format", () => {
    const tools: AgentToolDef[] = [
      { name: "read_file", description: "Read a file", input_schema: { type: "object" } },
    ];
    expect(toResponsesTools(tools)).toEqual([
      { type: "function", name: "read_file", description: "Read a file", parameters: { type: "object" } },
    ]);
  });
});

describe("toResponsesInput", () => {
  it("converts string user message to input_text", () => {
    const input = toResponsesInput([{ role: "user", content: "hello" }]);
    expect(input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
    ]);
  });

  it("converts string assistant message to output_text", () => {
    const input = toResponsesInput([{ role: "assistant", content: "response" }]);
    expect(input).toEqual([
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "response" }] },
    ]);
  });

  it("converts tool_result blocks to function_call_output", () => {
    const messages: LlmMessage[] = [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "result" }] },
    ];
    expect(toResponsesInput(messages)).toEqual([
      { type: "function_call_output", call_id: "call_1", output: "result" },
    ]);
  });

  it("converts assistant tool_use to function_call", () => {
    const messages: LlmMessage[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "call_2", name: "grep", input: { pattern: "x" } }] },
    ];
    expect(toResponsesInput(messages)).toEqual([
      { type: "function_call", call_id: "call_2", name: "grep", arguments: '{"pattern":"x"}' },
    ]);
  });

  it("re-emits own reasoning with encrypted payload before the sibling function_call", () => {
    const messages: LlmMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "thinking about it",
            provider: "openai-codex",
            id: "rs_1",
            encrypted_content: "ENCRYPTED",
          },
          { type: "tool_use", id: "call_3", name: "read_file", input: { path: "a.ts" } },
        ],
      },
    ];
    const input = toResponsesInput(messages);
    expect(input).toEqual([
      { type: "reasoning", id: "rs_1", encrypted_content: "ENCRYPTED", summary: [] },
      { type: "function_call", call_id: "call_3", name: "read_file", arguments: '{"path":"a.ts"}' },
    ]);
  });

  it("skips own reasoning that lacks an encrypted payload", () => {
    const messages: LlmMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "summary only", provider: "openai-codex", id: "rs_2" },
          { type: "text", text: "done" },
        ],
      },
    ];
    expect(toResponsesInput(messages)).toEqual([
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
    ]);
  });

  it("strips reasoning from other providers and untagged reasoning", () => {
    const messages: LlmMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "anthropic thinking", provider: "anthropic", signature: "sig" },
          { type: "reasoning", text: "untagged legacy" },
          { type: "text", text: "answer" },
        ],
      },
    ];
    expect(toResponsesInput(messages)).toEqual([
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
    ]);
  });
});

describe("parseResponsesOutput", () => {
  it("parses text output", () => {
    const result = parseResponsesOutput({
      output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }],
      status: "completed",
    });
    expect(result.content).toEqual([{ type: "text", text: "hi" }]);
    expect(result.stop_reason).toBe("end_turn");
  });

  it("parses function calls and sets tool_use stop reason", () => {
    const result = parseResponsesOutput({
      output: [{ type: "function_call", call_id: "c1", name: "grep", arguments: '{"q":1}' }],
    });
    expect(result.content).toEqual([{ type: "tool_use", id: "c1", name: "grep", input: { q: 1 } }]);
    expect(result.stop_reason).toBe("tool_use");
  });

  it("captures reasoning items with id, encrypted payload, and summary text", () => {
    const result = parseResponsesOutput({
      output: [
        {
          type: "reasoning",
          id: "rs_9",
          encrypted_content: "SECRET",
          summary: [{ type: "summary_text", text: "step one" }, { type: "summary_text", text: "step two" }],
        },
        { type: "message", content: [{ type: "output_text", text: "answer" }] },
      ],
    });
    expect(result.content).toEqual([
      {
        type: "reasoning",
        text: "step one\nstep two",
        provider: "openai-codex",
        id: "rs_9",
        encrypted_content: "SECRET",
      },
      { type: "text", text: "answer" },
    ]);
  });

  it("round-trips a captured reasoning item back into request input", () => {
    const parsed = parseResponsesOutput({
      output: [
        { type: "reasoning", id: "rs_rt", encrypted_content: "PAYLOAD", summary: [] },
        { type: "function_call", call_id: "c2", name: "shell", arguments: "{}" },
      ],
    });
    const input = toResponsesInput([{ role: "assistant", content: parsed.content }]);
    expect(input[0]).toEqual({ type: "reasoning", id: "rs_rt", encrypted_content: "PAYLOAD", summary: [] });
    expect(input[1]).toMatchObject({ type: "function_call", call_id: "c2" });
  });

  it("maps incomplete status to max_tokens", () => {
    const result = parseResponsesOutput({ output: [], status: "incomplete" });
    expect(result.stop_reason).toBe("max_tokens");
  });

  it("handles response nested under a response key", () => {
    const result = parseResponsesOutput({
      response: { output: [{ type: "message", content: [{ type: "output_text", text: "nested" }] }] },
    });
    expect(result.content).toEqual([{ type: "text", text: "nested" }]);
  });

  it("reads usage tokens", () => {
    const result = parseResponsesOutput({
      output: [],
      usage: { input_tokens: 10, output_tokens: 20 },
    });
    expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 20 });
  });
});
