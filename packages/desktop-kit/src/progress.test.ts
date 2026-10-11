// Ports of the Android kit's AgentChatProgressParityWave2Test.kt, one `it` per
// `@Test`, over the same raw Hook frames. Times are ISO strings and durations
// milliseconds, so Instant assertions become Date.parse comparisons.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readTranscriptFrame, type ChatSource } from "./transcript.js";
import {
  AgentChatProgress, AgentTokenUsage, readProgressFrame,
  type ProgressFrame,
} from "./progress.js";

const sec = (n: number): string => new Date(n * 1000).toISOString();
const plus = (iso: string, seconds: number): string => new Date(Date.parse(iso) + seconds * 1000).toISOString();
const ms = (iso: string): number => Date.parse(iso);

function row(line: number, type: string, fields: Record<string, unknown> = {}): { line: number; raw: unknown } {
  return { line, raw: { type: "event_msg", payload: { ...fields, type } } };
}

function frame(kind: string, rows: Array<{ line: number; raw: unknown }>, total: number, source: ChatSource = "codex", reset = false): ProgressFrame {
  return readProgressFrame({ type: kind, source, entries: rows, totalLines: total, reset }, source);
}

describe("AgentChatProgressParityWave2Test", () => {
  it("sharedHookLifecycleAndUsageContract", () => {
    const fixtures = JSON.parse(readFileSync(new URL("../../cli/fixtures/conformance/hook-events.json", import.meta.url), "utf8")) as Array<{
      source: ChatSource; events: unknown[]; input: number; output: number; phase: string | null;
    }>;
    for (const fixture of fixtures) {
      const events = fixture.events.map((raw, index) => ({ line: index, raw }));
      const progress = new AgentChatProgress();
      progress.receive(frame("backlog", events, events.length, fixture.source));
      expect(progress.usage?.input).toBe(fixture.input);
      expect(progress.usage?.output).toBe(fixture.output);
      expect(progress.phase).toBe(fixture.phase);
    }
  });

  it("newConversationCanHaveAnEmptyBacklogWithoutEntries", () => {
    const empty = readTranscriptFrame(JSON.parse('{"source":"codex","type":"backlog","totalLines":1}') as unknown, "codex");
    expect(empty.messages.length).toBe(0);
    expect(empty.progressEvents.length).toBe(0);
    for (const entries of ["null", "true", "{}"]) {
      expect(() => readTranscriptFrame(JSON.parse(`{"source":"codex","type":"backlog","entries":${entries}}`) as unknown, "codex")).toThrow();
    }
  });

  it("codexPublishesTurnStateAndActualUsageWithoutExposingReasoning", () => {
    const transcript = readTranscriptFrame({
      type: "backlog", source: "codex", totalLines: 5, entries: [
        row(2, "task_started", { started_at: 1_700_000_000 }),
        row(3, "agent_reasoning", { text: "private reasoning" }),
        row(4, "token_count", { info: { last_token_usage: { input_tokens: 1500, cached_input_tokens: 1200, output_tokens: 83 } } }),
      ],
    } as unknown, "codex");
    expect(transcript.messages.length).toBe(0);
    const progress = new AgentChatProgress();
    progress.receive(frame("backlog", [
      row(2, "task_started", { started_at: 1_700_000_000 }),
      row(3, "agent_reasoning", { text: "private reasoning" }),
      row(4, "token_count", { info: { last_token_usage: { input_tokens: 1500, cached_input_tokens: 1200, output_tokens: 83 } } }),
    ], 5));
    expect(progress.phase).toBe(AgentChatProgress.Phase.WORKING);
    expect(progress.startedAt).toBe(sec(1_700_000_000));
    expect(progress.usage?.input).toBe(1500);
    expect(progress.usage?.output).toBe(83);
    expect(progress.usage?.cachedInput).toBe(1200);
    progress.receive(frame("append", [row(5, "task_complete", { completed_at: 1_700_000_020 })], 6));
    expect(progress.phase).toBe(AgentChatProgress.Phase.FINISHED);
    expect(progress.finishedAt).toBe(sec(1_700_000_020));
  });

  it("olderAndRepeatedFramesDoNotReplayProgressAndTruncationClearsIt", () => {
    const progress = new AgentChatProgress();
    progress.receive(frame("backlog", [
      row(8, "task_started", { started_at: 1000 }),
      row(9, "token_count", { info: { last_token_usage: { input_tokens: 30, output_tokens: 12 } } }),
    ], 10));
    progress.receive(frame("append", [row(10, "turn_aborted")], 11));
    progress.receive(frame("backlog", [row(8, "task_started", { started_at: 1000 })], 11));
    progress.receive(frame("older", [row(2, "task_started")], 11));
    expect(progress.phase).toBe(AgentChatProgress.Phase.STOPPED);
    progress.receive(frame("append", [row(11, "task_started", { started_at: 2000 })], 12));
    expect(progress.usage).toBeNull();
    expect(progress.startedAt).toBe(sec(2000));
    progress.receive(frame("backlog", [], 1, "codex", true));
    expect(progress.phase).toBeNull();
    expect(progress.usage).toBeNull();
    expect(progress.startedAt).toBeNull();
  });

  it("reconnectKeepsProgressUntilAnExplicitReplacement", () => {
    const progress = new AgentChatProgress();
    progress.receive(frame("append", [row(19, "task_started", { started_at: 2000 })], 20));
    progress.receive(frame("backlog", [row(2, "task_complete")], 3));
    expect(progress.phase).toBe(AgentChatProgress.Phase.WORKING);
    expect(progress.startedAt).toBe(sec(2000));
    progress.receive(frame("backlog", [], 0, "codex", true));
    expect(progress.phase).toBe(AgentChatProgress.Phase.WORKING);
    progress.receive(frame("backlog", [row(0, "task_complete")], 20, "codex", true));
    expect(progress.phase).toBe(AgentChatProgress.Phase.FINISHED);
    expect(progress.startedAt).toBeNull();
  });

  it("codexCachedInputIsIncludedAndCompletionAliasFinishes", () => {
    const progress = new AgentChatProgress();
    progress.receive(frame("backlog", [
      row(0, "task_started"),
      row(1, "token_count", { info: {
        last_token_usage: { input_tokens: 227163, cached_input_tokens: 224640, output_tokens: 231, reasoning_output_tokens: 37 },
        total_token_usage: { input_tokens: 900000, output_tokens: 8000 },
      } }),
      row(2, "task_completed"),
    ], 3));
    expect(progress.usage?.uncachedInput).toBe(2523);
    expect(progress.usage?.output).toBe(231);
    expect(progress.usage?.reasoningOutput).toBe(37);
    expect(progress.phase).toBe(AgentChatProgress.Phase.FINISHED);
    expect(AgentTokenUsage.read(JSON.parse('{"input_tokens":10,"cached_input_tokens":20,"output_tokens":2}'))).toBeNull();
  });

  it("claudeUsageSkipsSidechainsAndMalformedCounters", () => {
    const claude = (line: number, usage: Record<string, unknown>, sidechain = false): { line: number; raw: unknown } => ({
      line, raw: { type: "assistant", isSidechain: sidechain, message: { role: "assistant", content: [], usage } },
    });
    const valid = { input_tokens: 40, cache_read_input_tokens: 25, cache_creation_input_tokens: 15, output_tokens: 9 };
    const transcript = frame("backlog", [
      claude(0, valid), claude(1, valid, true), claude(2, { input_tokens: -1, output_tokens: 9 }),
      claude(3, { input_tokens: true, output_tokens: 2 }), claude(4, { input_tokens: 1.5, output_tokens: 9 }),
    ], 5, "claude");
    expect(transcript.progressEvents.length).toBe(1);
    const progress = new AgentChatProgress();
    progress.receive(transcript);
    expect(progress.usage?.output).toBe(9);
    expect(progress.usage?.cachedInput).toBe(25);
    expect(progress.usage?.input).toBe(80);
    expect(progress.usage?.uncachedInput).toBe(55);
    expect(progress.phase).toBeNull();
  });

  it("elapsedUsesSourceStartAndFreezesOnFinishOrStop", () => {
    const start = "2023-11-14T22:13:20.375Z";
    const progress = new AgentChatProgress();
    expect(progress.elapsed(start)).toBeNull();
    progress.receive(frame("append", [row(0, "task_started", { started_at: ms(start) / 1000 })], 1));
    expect(progress.elapsed(plus(start, 27))).toBe(27_000);
    expect(progress.elapsed(plus(start, -1))).toBe(0);
    progress.receive(frame("append", [row(1, "task_complete", { completed_at: ms(plus(start, 72)) / 1000 })], 2));
    expect(progress.elapsed(plus(start, 900))).toBe(72_000);
    const first = progress.turns[0];
    expect(AgentChatProgress.elapsed(first.startedAt, first.finishedAt, first.phase, plus(start, 900))).toBe(72_000);
    const stopped = { line: 3, raw: { type: "event_msg", timestamp: plus(start, 112), payload: { type: "turn_aborted" } } };
    const rows = [row(2, "task_started", { started_at: ms(plus(start, 100)) / 1000 }), stopped];
    progress.receive(frame("append", rows, 4));
    expect(progress.phase).toBe(AgentChatProgress.Phase.STOPPED);
    expect(progress.elapsed(plus(start, 900))).toBe(12_000);
    const reopened = new AgentChatProgress();
    reopened.receive(frame("backlog", rows, 4));
    expect(reopened.elapsed(plus(start, 900))).toBe(12_000);
    expect(reopened.finishedAt).toBe(plus(start, 112));
    expect(progress.turns.length).toBe(2);
  });

  it("missingStartOrEndNeverInventsAnElapsedDuration", () => {
    for (const ending of ["task_complete", "turn_aborted"]) {
      const progress = new AgentChatProgress();
      progress.receive(frame("backlog", [row(0, "task_started"), row(1, ending, { completed_at: 1000 })], 2));
      expect(progress.elapsed()).toBeNull();
      const first = progress.turns[0];
      expect(AgentChatProgress.elapsed(first.startedAt, first.finishedAt, first.phase, new Date().toISOString())).toBeNull();
    }
    const progress = new AgentChatProgress();
    progress.receive(frame("backlog", [row(0, "task_started", { started_at: 1000 }), row(1, "turn_aborted")], 2));
    expect(progress.elapsed()).toBeNull();
  });

  it("claudeFinalUsageAndLifecycleAreBothRetained", () => {
    const rows = [
      { line: 0, raw: { type: "user", timestamp: "2026-09-22T10:00:00Z", message: { role: "user", content: "Hello" } } },
      { line: 1, raw: { type: "assistant", timestamp: "2026-09-22T10:00:27Z", message: { role: "assistant", content: "Hello back", stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } } } },
    ];
    const progress = new AgentChatProgress();
    progress.receive(frame("backlog", rows, 2, "claude"));
    expect(progress.phase).toBe(AgentChatProgress.Phase.FINISHED);
    expect(progress.elapsed()).toBe(27_000);
    expect(progress.usage?.output).toBe(5);
  });

  // Not ported: liveStatusIncludesActivityAndModelOnlyForChosenConversation
  // needs AgentChatTarget and AgentInteractionStatus, which live outside this
  // package's scope (see the final note).
});
