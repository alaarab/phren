import { describe, expect, it } from "vitest";
import { shouldPrune, pruneMessages, extractFacts } from "../context/pruner.js";
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

  it("summary includes files modified from edit_file/write_file tool calls", () => {
    const msgs: LlmMessage[] = [
      { role: "user", content: "original task" },
      { role: "assistant", content: [
        { type: "tool_use", id: "1", name: "edit_file", input: { file_path: "src/index.ts" } },
      ]},
      { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "ok" }] },
      { role: "assistant", content: [
        { type: "tool_use", id: "2", name: "write_file", input: { file_path: "src/auth.ts" } },
      ]},
      { role: "user", content: [{ type: "tool_result", tool_use_id: "2", content: "ok" }] },
      ...Array.from({ length: 12 }, (_, i) => ({
        role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        content: `recent ${i}`,
      })),
    ];
    const result = pruneMessages(msgs, { keepRecentTurns: 6 });
    const summary = result[1].content as string;
    expect(summary).toContain("Files modified: src/index.ts, src/auth.ts");
  });

  it("summary includes errors from tool results with is_error", () => {
    const msgs: LlmMessage[] = [
      { role: "user", content: "original task" },
      { role: "assistant", content: [
        { type: "tool_use", id: "1", name: "shell", input: { command: "cat missing.txt" } },
      ]},
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "1", content: "ENOENT: no such file 'missing.txt'\nstack trace...", is_error: true },
      ]},
      ...Array.from({ length: 12 }, (_, i) => ({
        role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        content: `recent ${i}`,
      })),
    ];
    const result = pruneMessages(msgs, { keepRecentTurns: 6 });
    const summary = result[1].content as string;
    expect(summary).toContain("Errors encountered:");
    expect(summary).toContain("ENOENT: no such file 'missing.txt'");
  });

  it("summary includes search queries from phren_search", () => {
    const msgs: LlmMessage[] = [
      { role: "user", content: "original task" },
      { role: "assistant", content: [
        { type: "tool_use", id: "1", name: "phren_search", input: { query: "auth token refresh" } },
      ]},
      { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "results..." }] },
      ...Array.from({ length: 12 }, (_, i) => ({
        role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        content: `recent ${i}`,
      })),
    ];
    const result = pruneMessages(msgs, { keepRecentTurns: 6 });
    const summary = result[1].content as string;
    expect(summary).toContain('Searches: "auth token refresh"');
  });

  it("summary includes key actions from assistant text", () => {
    const msgs: LlmMessage[] = [
      { role: "user", content: "original task" },
      { role: "assistant", content: "I'll fix the auth validation logic" },
      { role: "user", content: "ok" },
      { role: "assistant", content: "Changed the token expiry check" },
      { role: "user", content: "good" },
      ...Array.from({ length: 12 }, (_, i) => ({
        role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        content: `recent ${i}`,
      })),
    ];
    const result = pruneMessages(msgs, { keepRecentTurns: 6 });
    const summary = result[1].content as string;
    expect(summary).toContain("Key actions:");
    expect(summary).toContain("auth validation");
    expect(summary).toContain("token expiry");
  });
});

describe("extractFacts", () => {
  it("returns empty collections for plain text messages", () => {
    const msgs: LlmMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ];
    const facts = extractFacts(msgs);
    expect(facts.filesModified).toEqual([]);
    expect(facts.errors).toEqual([]);
    expect(facts.keyActions).toEqual([]);
    expect(facts.searches).toEqual([]);
  });

  it("deduplicates file paths", () => {
    const msgs: LlmMessage[] = [
      { role: "assistant", content: [
        { type: "tool_use", id: "1", name: "edit_file", input: { file_path: "src/a.ts" } },
      ]},
      { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "ok" }] },
      { role: "assistant", content: [
        { type: "tool_use", id: "2", name: "edit_file", input: { file_path: "src/a.ts" } },
      ]},
      { role: "user", content: [{ type: "tool_result", tool_use_id: "2", content: "ok" }] },
    ];
    const facts = extractFacts(msgs);
    expect(facts.filesModified).toEqual(["src/a.ts"]);
  });

  it("caps key actions at 5", () => {
    const msgs: LlmMessage[] = Array.from({ length: 10 }, (_, i) => ({
      role: "assistant" as const,
      content: `I'll do thing number ${i}`,
    }));
    const facts = extractFacts(msgs);
    expect(facts.keyActions.length).toBeLessThanOrEqual(5);
  });

  it("truncates long error messages", () => {
    const longError = "E".repeat(200);
    const msgs: LlmMessage[] = [
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "1", content: longError, is_error: true },
      ]},
    ];
    const facts = extractFacts(msgs);
    expect(facts.errors[0].length).toBeLessThanOrEqual(123); // 120 + "..."
    expect(facts.errors[0]).toMatch(/\.\.\.$/);
  });

  it("extracts decisions from content block arrays", () => {
    const msgs: LlmMessage[] = [
      { role: "assistant", content: [
        { type: "text", text: "Let's refactor the database layer" },
        { type: "tool_use", id: "1", name: "edit_file", input: { file_path: "src/db.ts" } },
      ]},
    ];
    const facts = extractFacts(msgs);
    expect(facts.keyActions).toContain("Let's refactor the database layer");
    expect(facts.filesModified).toContain("src/db.ts");
  });
});
