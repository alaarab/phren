import { describe, expect, it } from "vitest";
import { estimateTokens, estimateMessageTokens } from "../context/token-counter.js";
import type { LlmMessage } from "../providers/types.js";

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("estimates ~4 chars per token", () => {
    // 100 chars = 25 tokens
    const text = "a".repeat(100);
    expect(estimateTokens(text)).toBe(25);
  });

  it("rounds up", () => {
    // 5 chars = ceil(5/4) = 2
    expect(estimateTokens("hello")).toBe(2);
  });

  it("handles single character", () => {
    expect(estimateTokens("x")).toBe(1);
  });

  it("handles long text", () => {
    const text = "x".repeat(4000);
    expect(estimateTokens(text)).toBe(1000);
  });
});

describe("estimateMessageTokens", () => {
  it("returns 0 for empty messages", () => {
    expect(estimateMessageTokens([])).toBe(0);
  });

  it("adds per-message overhead of 4", () => {
    const msgs: LlmMessage[] = [{ role: "user", content: "" }];
    // 4 overhead + 0 content
    expect(estimateMessageTokens(msgs)).toBe(4);
  });

  it("estimates string content messages", () => {
    const msgs: LlmMessage[] = [{ role: "user", content: "a".repeat(100) }];
    // 4 overhead + 25 tokens
    expect(estimateMessageTokens(msgs)).toBe(29);
  });

  it("estimates text block content", () => {
    const msgs: LlmMessage[] = [{
      role: "assistant",
      content: [{ type: "text", text: "a".repeat(40) }],
    }];
    // 4 overhead + 10 tokens
    expect(estimateMessageTokens(msgs)).toBe(14);
  });

  it("estimates tool_result block content", () => {
    const msgs: LlmMessage[] = [{
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "x", content: "a".repeat(80) }],
    }];
    // 4 overhead + 20 tokens
    expect(estimateMessageTokens(msgs)).toBe(24);
  });

  it("estimates tool_use block content", () => {
    const input = { path: "/tmp/file.ts" };
    const msgs: LlmMessage[] = [{
      role: "assistant",
      content: [{ type: "tool_use", id: "x", name: "read_file", input }],
    }];
    // 4 overhead + tokens from JSON.stringify(input)
    const inputStr = JSON.stringify(input);
    const expectedTokens = 4 + Math.ceil(inputStr.length / 4);
    expect(estimateMessageTokens(msgs)).toBe(expectedTokens);
  });

  it("sums multiple messages", () => {
    const msgs: LlmMessage[] = [
      { role: "user", content: "a".repeat(40) },
      { role: "assistant", content: "b".repeat(40) },
    ];
    // (4 + 10) + (4 + 10) = 28
    expect(estimateMessageTokens(msgs)).toBe(28);
  });
});
