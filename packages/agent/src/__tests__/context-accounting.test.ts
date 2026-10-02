import { describe, it, expect, vi } from "vitest";
import type { AgentToolDef, ContentBlock, LlmMessage, LlmProvider, LlmResponse } from "../providers/types.js";
import type { AgentConfig } from "../agent-loop.js";
import { ToolRegistry } from "../tools/registry.js";
import { SessionLog } from "../session/log.js";
import { contextTokens, reportedContext } from "../context/usage.js";
import { planToolResultClearing } from "../context/clear-tool-results.js";
import { compactWithLlm } from "../context/compactor.js";
import { estimateMessageTokens, estimateTokens } from "../context/token-counter.js";

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

function newLog(): SessionLog {
  return new SessionLog({ sessionId: "t", cwd: process.cwd(), createdAt: new Date().toISOString() });
}

/** A task followed by `n` tool calls, each answered with `size` chars of output. */
function toolLoop(log: SessionLog, n: number, size: number): void {
  log.append("user/message", { message: { role: "user", content: "task" }, source: "user", turn: 0 });
  for (let i = 0; i < n; i++) {
    log.append("assistant/message", {
      message: { role: "assistant", content: [{ type: "tool_use", id: `c${i}`, name: "read_file", input: { i } }] },
      stop_reason: "tool_use",
      turn: i,
    });
    log.append("tool/results", {
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: `c${i}`, content: `line one of ${i}\n${"x".repeat(size)}` }] },
      turn: i,
    });
  }
}

describe("context size from the provider's own count", () => {
  it("uses the reported prompt size plus an estimate for what came after", () => {
    const log = newLog();
    log.append("user/message", { message: { role: "user", content: "hi" }, source: "user", turn: 0 });
    log.append("assistant/message", { message: { role: "assistant", content: "hello" }, stop_reason: "end_turn", turn: 0 });
    const reported = reportedContext({ input_tokens: 1_000, cache_read_input_tokens: 9_000, output_tokens: 50 }, log);
    expect(reported?.tokens).toBe(10_050);

    expect(contextTokens("sys", log.getMessages(), log, reported)).toBe(10_050);
    log.append("user/message", { message: { role: "user", content: "x".repeat(400) }, source: "user", turn: 1 });
    const grown = contextTokens("sys", log.getMessages(), log, reported);
    expect(grown).toBe(10_050 + estimateMessageTokens(log.getMessages().slice(2)));
  });

  it("falls back to the estimate without a report, or once history was rewritten", () => {
    const log = newLog();
    toolLoop(log, 3, 100);
    const estimate = estimateTokens("sys") + estimateMessageTokens(log.getMessages());
    expect(contextTokens("sys", log.getMessages(), log, undefined)).toBe(estimate);
    expect(reportedContext({ input_tokens: 0, output_tokens: 0 }, log)).toBeUndefined();

    const reported = reportedContext({ input_tokens: 50_000, output_tokens: 10 }, log);
    expect(contextTokens("sys", log.getMessages(), log, reported)).toBe(50_010);
    log.replaceMessageRange(1, 2, { role: "user", content: "[summary]" });
    expect(contextTokens("sys", log.getMessages(), log, reported))
      .toBe(estimateTokens("sys") + estimateMessageTokens(log.getMessages()));
  });
});

describe("clearing old tool output", () => {
  it("clears bulky results outside the newest few and keeps small ones", () => {
    const log = newLog();
    toolLoop(log, 12, 3_000);
    log.append("assistant/message", {
      message: { role: "assistant", content: [{ type: "tool_use", id: "small", name: "glob", input: {} }] },
      stop_reason: "tool_use",
      turn: 12,
    });
    log.append("tool/results", { message: { role: "user", content: [{ type: "tool_result", tool_use_id: "small", content: "a.ts" }] }, turn: 12 });

    const messages = log.getMessages();
    const cleared = planToolResultClearing(messages, { keepRecent: 8 });
    // 13 results: the newest 8 stay (the small one among them), the oldest 5 are cleared.
    expect(cleared).toHaveLength(5);
    const text = JSON.stringify(cleared[0].message.content);
    expect(text).toContain("Earlier output cleared");
    expect(text).toContain("read_file returned");
    expect(text).toContain("line one of 0");
    // Tool ids and pairing are untouched.
    expect((cleared[0].message.content as ContentBlock[])[0]).toMatchObject({ type: "tool_result", tool_use_id: "c0" });

    for (const { index, message } of cleared) log.replaceMessageRange(index, index, message);
    expect(planToolResultClearing(log.getMessages(), { keepRecent: 8 })).toEqual([]);
    expect(estimateMessageTokens(log.getMessages())).toBeLessThan(estimateMessageTokens(messages) * 0.7);
  });

  it("clears an old image result whatever its text length", () => {
    const messages: LlmMessage[] = [
      { role: "user", content: "look" },
      { role: "assistant", content: [{ type: "tool_use", id: "img", name: "read_image", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "img", content: [
        { type: "text", text: "shot.png" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(40_000) } },
      ] }] },
    ];
    const cleared = planToolResultClearing(messages, { keepRecent: 0 });
    expect(cleared).toHaveLength(1);
    expect(JSON.stringify(cleared[0].message)).not.toContain("AAAA");
  });
});

describe("the loop compacts on the reported size", () => {
  function provider(replies: LlmResponse[], requests: LlmMessage[][]): LlmProvider {
    return {
      name: "mock",
      contextWindow: 200_000,
      async chat(_s, messages): Promise<LlmResponse> {
        requests.push(structuredClone(messages));
        return replies.shift()!;
      },
    };
  }

  function config(p: LlmProvider): AgentConfig {
    const registry = new ToolRegistry();
    registry.setPermissions({ mode: "full-auto", projectRoot: process.cwd(), allowedPaths: [] });
    registry.register({
      name: "read_file",
      description: "read",
      input_schema: { type: "object", properties: {} },
      async execute() { return { output: "contents" }; },
    });
    return { provider: p, registry, systemPrompt: "sys", maxTurns: 10, verbose: false, compaction: { enabled: false } };
  }

  it("clears old tool output when the provider says the window is 80% full, though chars/4 says 20%", async () => {
    const session = createSession(200_000);
    toolLoop(session.log, 14, 3_000);
    const before = estimateMessageTokens(session.messages);
    expect(before).toBeLessThan(200_000 * 0.75);

    const requests: LlmMessage[][] = [];
    const statuses: string[] = [];
    const p = provider([
      // The provider counts this prompt at 160k of the 200k window.
      { content: [{ type: "tool_use", id: "next", name: "read_file", input: {} }], stop_reason: "tool_use", usage: { input_tokens: 160_000, output_tokens: 20 } },
      { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" },
    ], requests);
    const result = await runTurn("continue", session, config(p), { ...quiet, onStatus: (m) => statuses.push(m) });

    expect(result.text).toBe("done");
    expect(requests).toHaveLength(2);
    // First request: untouched. Second: the oldest results were cleared, nothing summarized.
    expect(JSON.stringify(requests[0])).not.toContain("Earlier output cleared");
    expect(JSON.stringify(requests[1])).toContain("Earlier output cleared");
    expect(JSON.stringify(requests[1])).not.toContain("Context compacted");
    expect(requests[1].length).toBe(requests[0].length + 2);
    expect(statuses.join("")).toContain("cleared old tool output");
  });

  it("does nothing while the reported size is under the threshold", async () => {
    const session = createSession(200_000);
    toolLoop(session.log, 14, 3_000);
    const requests: LlmMessage[][] = [];
    const p = provider([
      { content: [{ type: "tool_use", id: "next", name: "read_file", input: {} }], stop_reason: "tool_use", usage: { input_tokens: 20_000, output_tokens: 20 } },
      { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" },
    ], requests);
    await runTurn("continue", session, config(p), quiet);
    expect(JSON.stringify(requests[1])).not.toContain("Earlier output cleared");
  });
});

describe("the compaction request", () => {
  it("carries the session's tools and the /compact focus", async () => {
    const log = newLog();
    toolLoop(log, 12, 3_000);
    let seenTools: AgentToolDef[] | undefined;
    let instruction = "";
    const p: LlmProvider = {
      name: "mock",
      async chat(_s, messages, tools): Promise<LlmResponse> {
        seenTools = tools;
        instruction = String(messages.at(-1)!.content);
        return { content: [{ type: "text", text: "## Checkpoint Summary\nWorked on the auth bug in login.ts, next step is the test.\n\n## Knowledge\n```json\n{\"items\":[]}\n```" }], stop_reason: "end_turn" };
      },
    };
    const tools: AgentToolDef[] = [{ name: "read_file", description: "read", input_schema: { type: "object" } }];
    const result = await compactWithLlm(p, "sys", log.getMessages(), {
      tools,
      focus: "the auth bug",
      config: { minPrunedTokens: 0 },
      pruneConfig: { keepRecentTurns: 2 },
    });
    expect(result?.usedLlm).toBe(true);
    expect(seenTools).toEqual(tools);
    expect(instruction).toContain("focus on: the auth bug");
  });
});
