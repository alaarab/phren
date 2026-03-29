import { describe, expect, it } from "vitest";
import { toOpenAiTools, toOpenAiMessages, parseOpenAiResponse } from "../providers/openai-compat.js";
import type { LlmMessage, AgentToolDef } from "../providers/types.js";

describe("toOpenAiTools", () => {
  it("converts empty array", () => {
    expect(toOpenAiTools([])).toEqual([]);
  });

  it("converts tool defs to OpenAI function format", () => {
    const tools: AgentToolDef[] = [
      { name: "read_file", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string" } } } },
      { name: "shell", description: "Run command", input_schema: { type: "object", properties: { command: { type: "string" } } } },
    ];
    const result = toOpenAiTools(tools);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      type: "function",
      function: { name: "read_file", description: "Read a file", parameters: tools[0].input_schema },
    });
    expect(result[1].function.name).toBe("shell");
  });
});

describe("toOpenAiMessages", () => {
  it("adds system message as first entry", () => {
    const result = toOpenAiMessages("You are helpful.", []);
    expect(result).toEqual([{ role: "system", content: "You are helpful." }]);
  });

  it("converts string user message", () => {
    const msgs: LlmMessage[] = [{ role: "user", content: "hello" }];
    const result = toOpenAiMessages("sys", msgs);
    expect(result).toHaveLength(2);
    expect(result[1]).toEqual({ role: "user", content: "hello" });
  });

  it("converts string assistant message", () => {
    const msgs: LlmMessage[] = [{ role: "assistant", content: "world" }];
    const result = toOpenAiMessages("sys", msgs);
    expect(result[1]).toEqual({ role: "assistant", content: "world" });
  });

  it("converts assistant message with text blocks", () => {
    const msgs: LlmMessage[] = [{
      role: "assistant",
      content: [{ type: "text", text: "thinking..." }, { type: "text", text: "done" }],
    }];
    const result = toOpenAiMessages("sys", msgs);
    expect(result[1]).toEqual({ role: "assistant", content: "thinking...\ndone" });
  });

  it("converts assistant message with tool_use blocks", () => {
    const msgs: LlmMessage[] = [{
      role: "assistant",
      content: [
        { type: "tool_use", id: "call_1", name: "read_file", input: { path: "/tmp/x" } },
      ],
    }];
    const result = toOpenAiMessages("sys", msgs);
    expect(result[1]).toEqual({
      role: "assistant",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"/tmp/x"}' } },
      ],
    });
  });

  it("converts assistant message with mixed text and tool_use", () => {
    const msgs: LlmMessage[] = [{
      role: "assistant",
      content: [
        { type: "text", text: "Let me read that." },
        { type: "tool_use", id: "call_2", name: "shell", input: { command: "ls" } },
      ],
    }];
    const result = toOpenAiMessages("sys", msgs);
    expect(result[1].content).toBe("Let me read that.");
    expect((result[1].tool_calls as unknown[])).toHaveLength(1);
  });

  it("converts user message with tool_result blocks", () => {
    const msgs: LlmMessage[] = [{
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: "file contents here" },
      ],
    }];
    const result = toOpenAiMessages("sys", msgs);
    expect(result[1]).toEqual({ role: "tool", tool_call_id: "call_1", content: "file contents here" });
  });

  it("converts user message with text blocks", () => {
    const msgs: LlmMessage[] = [{
      role: "user",
      content: [{ type: "text", text: "follow-up question" }],
    }];
    const result = toOpenAiMessages("sys", msgs);
    expect(result[1]).toEqual({ role: "user", content: "follow-up question" });
  });

  it("handles multiple tool_result blocks from user", () => {
    const msgs: LlmMessage[] = [{
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: "result 1" },
        { type: "tool_result", tool_use_id: "call_2", content: "result 2" },
      ],
    }];
    const result = toOpenAiMessages("sys", msgs);
    expect(result).toHaveLength(3); // system + 2 tool results
    expect(result[1].role).toBe("tool");
    expect(result[2].role).toBe("tool");
  });
});

describe("parseOpenAiResponse", () => {
  it("parses text-only response", () => {
    const data = {
      choices: [{ message: { content: "Hello!" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    const result = parseOpenAiResponse(data);
    expect(result.content).toEqual([{ type: "text", text: "Hello!" }]);
    expect(result.stop_reason).toBe("end_turn");
    expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  it("parses response with tool calls", () => {
    const data = {
      choices: [{
        message: {
          tool_calls: [
            { id: "tc_1", function: { name: "read_file", arguments: '{"path":"/tmp/a"}' } },
          ],
        },
        finish_reason: "tool_calls",
      }],
    };
    const result = parseOpenAiResponse(data);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({
      type: "tool_use",
      id: "tc_1",
      name: "read_file",
      input: { path: "/tmp/a" },
    });
    expect(result.stop_reason).toBe("tool_use");
  });

  it("parses response with both text and tool calls", () => {
    const data = {
      choices: [{
        message: {
          content: "Let me check.",
          tool_calls: [{ id: "tc_2", function: { name: "shell", arguments: '{"command":"ls"}' } }],
        },
        finish_reason: "tool_calls",
      }],
    };
    const result = parseOpenAiResponse(data);
    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toEqual({ type: "text", text: "Let me check." });
    expect(result.content[1].type).toBe("tool_use");
  });

  it("maps finish_reason 'length' to 'max_tokens'", () => {
    const data = { choices: [{ message: { content: "trunc" }, finish_reason: "length" }] };
    expect(parseOpenAiResponse(data).stop_reason).toBe("max_tokens");
  });

  it("defaults stop_reason to 'end_turn' for unknown finish_reason", () => {
    const data = { choices: [{ message: { content: "done" }, finish_reason: "whatever" }] };
    expect(parseOpenAiResponse(data).stop_reason).toBe("end_turn");
  });

  it("handles empty choices", () => {
    const data = { choices: [] };
    const result = parseOpenAiResponse(data);
    expect(result.content).toEqual([]);
    expect(result.stop_reason).toBe("end_turn");
  });

  it("handles missing usage", () => {
    const data = { choices: [{ message: { content: "hi" }, finish_reason: "stop" }] };
    expect(parseOpenAiResponse(data).usage).toBeUndefined();
  });
});
