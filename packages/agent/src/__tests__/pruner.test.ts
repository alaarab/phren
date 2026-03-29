import { describe, expect, it } from "vitest";
import { shouldPrune, pruneMessages } from "../context/pruner.js";
import type { LlmMessage } from "../providers/types.js";

describe("shouldPrune", () => {
  it("returns false for small conversations", () => {
    const msgs: LlmMessage[] = [{ role: "user", content: "hello" }];
    expect(shouldPrune("system prompt", msgs)).toBe(false);
  });

  it("returns true when tokens exceed 75% of context limit", () => {
    // With default limit 200_000 -> threshold is 150_000 tokens
    // Each char ~ 0.25 tokens, so need ~600_000 chars
    const bigContent = "x".repeat(600_000);
    const msgs: LlmMessage[] = [{ role: "user", content: bigContent }];
    expect(shouldPrune("system", msgs)).toBe(true);
  });

  it("respects custom context limit", () => {
    // 1000 token limit -> 750 threshold -> need 3000+ chars
    const msgs: LlmMessage[] = [{ role: "user", content: "x".repeat(4000) }];
    expect(shouldPrune("sys", msgs, { contextLimit: 1000 })).toBe(true);
  });

  it("includes system prompt in token count", () => {
    const bigSystem = "x".repeat(3000);
    const msgs: LlmMessage[] = [{ role: "user", content: "x".repeat(100) }];
    expect(shouldPrune(bigSystem, msgs, { contextLimit: 1000 })).toBe(true);
  });
});

describe("pruneMessages", () => {
  function makeConversation(turns: number): LlmMessage[] {
    const msgs: LlmMessage[] = [];
    for (let i = 0; i < turns; i++) {
      msgs.push({ role: "user", content: `user message ${i}` });
      msgs.push({ role: "assistant", content: `assistant message ${i}` });
    }
    return msgs;
  }

  it("returns messages unchanged when too few to prune", () => {
    const msgs = makeConversation(3); // 6 messages
    const result = pruneMessages(msgs, { keepRecentTurns: 6 });
    expect(result).toEqual(msgs);
  });

  it("preserves first message (original task)", () => {
    const msgs = makeConversation(20); // 40 messages
    const result = pruneMessages(msgs, { keepRecentTurns: 3 });
    expect(result[0]).toEqual(msgs[0]);
  });

  it("preserves last N turn pairs", () => {
    const msgs = makeConversation(20);
    const result = pruneMessages(msgs, { keepRecentTurns: 3 });
    // Last 6 messages (3 turns * 2)
    const tail = msgs.slice(-6);
    expect(result.slice(-6)).toEqual(tail);
  });

  it("inserts summary message in place of pruned middle", () => {
    const msgs = makeConversation(20);
    const result = pruneMessages(msgs, { keepRecentTurns: 3 });
    // [first, summary, ...last6]
    expect(result).toHaveLength(8); // 1 + 1 + 6
    expect(result[1].role).toBe("user");
    expect(typeof result[1].content).toBe("string");
    expect(result[1].content as string).toContain("Context compacted");
  });

  it("summary includes tool names from pruned messages", () => {
    const msgs: LlmMessage[] = [
      { role: "user", content: "original task" },
      { role: "assistant", content: [{ type: "tool_use", id: "1", name: "read_file", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "..." }] },
      { role: "assistant", content: [{ type: "tool_use", id: "2", name: "shell", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "2", content: "..." }] },
      // Recent turns
      ...Array.from({ length: 12 }, (_, i) => ({
        role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        content: `recent ${i}`,
      })),
    ];
    const result = pruneMessages(msgs, { keepRecentTurns: 6 });
    const summary = result[1].content as string;
    expect(summary).toContain("read_file");
    expect(summary).toContain("shell");
  });

  it("uses default keepRecentTurns of 6", () => {
    const msgs = makeConversation(20);
    const result = pruneMessages(msgs);
    // 1 + 1 + 12 = 14
    expect(result).toHaveLength(14);
  });
});
