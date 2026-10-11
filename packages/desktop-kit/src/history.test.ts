import { describe, expect, it } from "vitest";
import { AgentChatHistory, ChatScrollMetrics } from "./history.js";
import { type TranscriptFrame, readTranscriptFrame } from "./transcript.js";

function assistantRows(lines: Iterable<number>): { line: number; raw: unknown }[] {
  return [...lines].map(line => ({ line, raw: { type: "response_item", payload: { type: "message", role: "assistant", content: `Message ${line}` } } }));
}
function range(first: number, last: number): number[] {
  const out: number[] = [];
  for (let i = first; i <= last; i++) out.push(i);
  return out;
}
function page(lines: number[], kind: string, total: number, extra: Record<string, unknown> = {}): TranscriptFrame {
  return readTranscriptFrame({ type: kind, source: "codex", entries: assistantRows(lines),
    startLine: lines.length > 0 ? lines[0] : 0, totalLines: total, hasMore: lines.length > 0 ? lines[0] > 0 : false, ...extra }, "codex");
}

describe("ChatScrollMetrics", () => {
  it("chat scroll repins only for content growth", () => {
    const old = new ChatScrollMetrics(900, 500, 400);
    const grown = new ChatScrollMetrics(980, 500, 400);
    expect(ChatScrollMetrics.shouldRepin(old, grown, false)).toBe(480);
    const keyboard = new ChatScrollMetrics(900, 300, 400);
    expect(ChatScrollMetrics.shouldRepin(old, keyboard, false)).toBeNull();
    expect(keyboard.bottomOffset).toBe(600);
    const keyboardOvershoot = new ChatScrollMetrics(900, 300, 750);
    expect(ChatScrollMetrics.shouldRepin(old, keyboardOvershoot, false)).toBe(600);
    expect(ChatScrollMetrics.shouldRepin(old, grown, true)).toBeNull();
    const shortOld = new ChatScrollMetrics(200, 500, 0);
    const shortNew = new ChatScrollMetrics(260, 500, 0);
    expect(ChatScrollMetrics.shouldRepin(shortOld, shortNew, false)).toBeNull();
    expect(shortNew.bottomOffset).toBe(0);
  });

  it("talk reading reveals the start of new text instead of the end", () => {
    const old = new ChatScrollMetrics(1_000, 500, 500);
    const small = new ChatScrollMetrics(1_080, 500, 500);
    expect(ChatScrollMetrics.revealTarget(old, small, false)).toBe(580);
    const long = new ChatScrollMetrics(2_000, 500, 500);
    expect(ChatScrollMetrics.revealTarget(old, long, false)).toBe(800);
    expect(ChatScrollMetrics.shouldRepin(old, long, false)).toBe(1_500);
    expect(ChatScrollMetrics.revealTarget(old, long, true)).toBeNull();
    const past = new ChatScrollMetrics(900, 500, 600);
    expect(ChatScrollMetrics.revealTarget(old, past, false)).toBe(400);
    const further = new ChatScrollMetrics(3_000, 500, 900);
    expect(ChatScrollMetrics.revealTarget(old, further, false)).toBe(900);
  });
});

describe("AgentChatTests history", () => {
  it("stream merges older pages and reconnects without duplicates", () => {
    const makePage = (kind: string, lines: number[], total = 12) => page(lines, kind, total);
    const history = new AgentChatHistory();
    history.receive(makePage("backlog", [8, 9]));
    history.receive(makePage("append", [10, 11]));
    history.receive(makePage("older", [0, 1, 2, 3]));
    history.receive(makePage("backlog", [8, 9, 10, 11]));
    expect(history.messages.map(m => m.line)).toEqual([0, 1, 2, 3, 8, 9, 10, 11]);
    expect(history.startLine).toBe(0);
    expect(history.hasMore).toBe(false);
    const unchanged = history.copy();
    history.receive(makePage("backlog", [8, 9, 10, 11]));
    expect(history.equals(unchanged)).toBe(true);
    history.receive(makePage("backlog", [0, 1], 2));
    expect(history.equals(unchanged)).toBe(true);
  });

  it("an older page marked reset prepends instead of replacing", () => {
    const makePage = (kind: string, lines: number[], total: number, reset: boolean) => page(lines, kind, total, { reset });
    const history = new AgentChatHistory();
    history.receive(makePage("backlog", range(8, 11), 12, false));
    history.receive(makePage("older", range(4, 7), 12, true));
    expect(history.messages.map(m => m.line)).toEqual(range(4, 11));
    history.receive(makePage("older", range(0, 3), 12, false));
    expect(history.messages.map(m => m.line)).toEqual(range(0, 11));
    history.receive(makePage("backlog", range(0, 2), 3, true));
    expect(history.messages.map(m => m.line)).toEqual([0, 1, 2]);
  });

  it("an older page with big total lines never moves the resume cursor", () => {
    const makePage = (kind: string, lines: number[], total: number, reset: boolean) => page(lines, kind, total, { reset });
    const history = new AgentChatHistory();
    history.receive(makePage("backlog", range(8, 11), 12, false));
    history.receive(makePage("older", range(4, 7), 5_000, true));
    expect(history.messages.map(m => m.line)).toEqual(range(4, 11));
    expect(history.totalLines).toBe(12);
    history.receive(makePage("backlog", range(0, 2), 3, true));
    expect(history.messages.map(m => m.line)).toEqual([0, 1, 2]);
    expect(history.totalLines).toBe(3);
  });

  it("reconnect backlogs cannot roll history back and merge new lines", () => {
    const makePage = (lines: number[], total: number) => page(lines, "backlog", total);
    const history = new AgentChatHistory();
    history.receive(makePage([8, 9, 10, 11], 12));
    history.receive(makePage([8, 9], 10));
    expect(history.messages.map(m => m.line)).toEqual([8, 9, 10, 11]);
    expect(history.totalLines).toBe(12);
    history.receive(makePage([12, 13], 14));
    expect(history.messages.map(m => m.line)).toEqual([8, 9, 10, 11, 12, 13]);
    expect(history.totalLines).toBe(14);
  });

  it("fake stream idle reconnect never shrinks then catch up and replace", () => {
    const makeFrame = (kind: string, lines: number[] | null, total: number, reset = false) => readTranscriptFrame({
      type: kind, source: "codex", entries: lines === null ? [] : assistantRows(lines),
      startLine: lines === null ? 0 : lines[0], totalLines: total, hasMore: (lines?.[0] ?? 0) > 0, reset,
    }, "codex");
    const history = new AgentChatHistory();
    history.receive(makeFrame("backlog", range(0, 9), 10));
    history.receive(makeFrame("append", range(10, 14), 15));
    expect(history.messages.map(m => m.line)).toEqual(range(0, 14));
    history.receive(makeFrame("backlog", range(0, 4), 5));
    expect(history.messages.map(m => m.line)).toEqual(range(0, 14));
    expect(history.totalLines).toBe(15);
    history.receive(makeFrame("append", range(15, 19), 20));
    expect(history.messages.map(m => m.line)).toEqual(range(0, 19));
    history.receive(makeFrame("backlog", null, 0, true));
    expect(history.messages.map(m => m.line)).toEqual(range(0, 19));
    expect(!history.hasMore || history.startLine !== null).toBe(true);
    history.receive(makeFrame("backlog", range(0, 2), 3, true));
    expect(history.messages.map(m => m.line)).toEqual([0, 1, 2]);
    expect(history.totalLines).toBe(3);
    expect(history.hasMore).toBe(false);
  });

  it("empty final history page closes pagination without losing messages", () => {
    const history = new AgentChatHistory();
    history.receive(readTranscriptFrame(JSON.parse("{\"type\":\"backlog\",\"source\":\"codex\",\"startLine\":8,\"totalLines\":9,\"hasMore\":true,\"entries\":[{\"line\":8,\"raw\":{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":\"Recent message\"}}}]}"), "codex"));
    history.receive(readTranscriptFrame(JSON.parse("{\"type\":\"older\",\"source\":\"codex\",\"totalLines\":9,\"hasMore\":false,\"entries\":[]}"), "codex"));
    expect(history.hasMore).toBe(false);
    expect(history.messages.map(m => m.text)).toEqual(["Recent message"]);
  });

  it("history window keeps paging past its memory limit during live updates", () => {
    const makePage = (lines: number[], kind = "backlog", total = 5_000) => page(lines, kind, total);
    const history = new AgentChatHistory();
    for (let start = 0; start < 5_000; start += 1_000) history.receive(makePage(range(start, start + 999)));
    expect(history.messages.length).toBe(4_000);
    expect(history.hasMore).toBe(true);
    expect(history.hasNewer).toBe(false);
    history.receive(makePage(range(500, 999), "older"));
    expect(history.messages[0].line).toBe(500);
    expect(history.messages[history.messages.length - 1].line).toBe(4_499);
    expect(history.hasMore).toBe(true);
    expect(history.hasNewer).toBe(true);
    history.receive(makePage(range(5_000, 5_009), "append", 5_010));
    history.receive(makePage(range(4_900, 5_009), "backlog", 5_010));
    expect(history.messages[0].line).toBe(500);
    expect(history.messages[history.messages.length - 1].line).toBe(4_499);
    history.receive(makePage(range(0, 499), "older", 5_010));
    expect(history.messages[0].line).toBe(0);
    expect(history.messages.length).toBe(4_000);
    expect(history.hasMore).toBe(false);
    expect(history.hasNewer).toBe(true);
    history.receive(makePage(range(0, 1), "backlog", 2));
    expect(history.hasNewer).toBe(true);
    expect(history.messages.length).toBe(4_000);
  });

  it("long transcript reconnect scroll back down and latest have no gap", () => {
    const makePage = (lines: number[], kind: string, total: number, reset = false) => page(lines, kind, total, { reset });
    const history = new AgentChatHistory();
    history.receive(makePage(range(0, 1_020), "backlog", 1_021));
    history.receive(makePage(range(2_264, 2_708), "backlog", 2_709));
    expect(history.startLine).toBe(2_264);
    expect(history.hasMore).toBe(true);
    expect(history.messages.map(m => m.line)).toEqual(range(2_264, 2_708));
    while ((history.startLine ?? 0) > 0) {
      const before = history.startLine!;
      history.receive(makePage(range(Math.max(0, before - 200), before - 1), "older", 2_709));
    }
    expect(history.messages.map(m => m.line)).toEqual(range(0, 2_708));
    history.receive(makePage(range(2_709, 2_729), "append", 2_730));
    expect(history.messages.map(m => m.line)).toEqual(range(0, 2_729));

    const latest = new AgentChatHistory();
    latest.receive(makePage(range(2_670, 2_729), "backlog", 2_730, true));
    expect(latest.startLine).toBe(2_670);
    while ((latest.startLine ?? 0) > 0) {
      const before = latest.startLine!;
      latest.receive(makePage(range(Math.max(0, before - 200), before - 1), "older", 2_730));
    }
    expect(latest.messages.map(m => m.line)).toEqual(range(0, 2_729));
  });

  it("append after unsent invisible rows keeps the open chat", () => {
    const makePage = (lines: number[], kind: string, start: number, total: number) => page(lines, kind, total, { startLine: start });
    const history = new AgentChatHistory();
    history.receive(makePage(range(2_540, 2_595), "backlog", 2_448, 2_596));
    history.receive(makePage([2_606, 2_607], "append", 2_605, 2_608));
    expect(history.messages[0].line).toBe(2_540);
    expect(history.messages.length).toBe(58);
    expect(history.startLine).toBe(2_448);
  });
});
