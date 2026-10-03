// RC regression source only. UNRUN; scripted streams make no provider calls.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSession, runTurn } from "../agent-loop/index.js";
import { ToolRegistry } from "../tools/registry.js";
import type { LlmMessage, LlmProvider, StreamDelta } from "../providers/types.js";

vi.mock("../spinner.js", () => ({ createSpinner: () => ({ start: vi.fn(), stop: vi.fn(), update: vi.fn() }), formatTurnHeader: () => "", formatToolCall: () => "" }));
vi.mock("../checkpoint.js", () => ({ createCheckpoint: () => null }));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("live steering ownership", () => {
  it("continues a stalled stream immediately, preserves all steering text, and suppresses late actions", async () => {
    vi.useFakeTimers();
    let release!: () => void, started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    const paused = new Promise<void>(resolve => { release = resolve; });
    const seen: LlmMessage[][] = [], displayed: string[] = [], mutate = vi.fn();
    let attempts = 0, steer: string | null = null;
    const provider: LlmProvider = { name: "replay", chat: vi.fn(), async *chatStream(_system, messages): AsyncIterable<StreamDelta> {
      seen.push(structuredClone(messages)); attempts++;
      if (attempts === 1) {
        yield { type: "text_delta", text: "abandoned" }; started(); await paused; // Deliberately ignores AbortSignal.
        yield { type: "tool_use_start", id: "late", name: "mutate" };
        yield { type: "tool_use_delta", id: "late", json: "{}" };
        yield { type: "tool_use_end", id: "late" };
        yield { type: "done", stop_reason: "tool_use" };
      } else { yield { type: "text_delta", text: "corrected" }; yield { type: "done", stop_reason: "end_turn" }; }
    } };
    const registry = new ToolRegistry(); registry.setPermissions({ mode: "full-auto", projectRoot: process.cwd(), allowedPaths: [] });
    registry.register({ name: "mutate", description: "mutation", input_schema: {}, execute: async () => { mutate(); return { output: "done" }; } });
    const session = createSession();
    try {
      const result = runTurn("original", session, { provider, registry, systemPrompt: "sys", maxTurns: 3, verbose: false }, {
        onStatus: () => {}, onTextDelta: text => displayed.push(text), onStreamRetry: () => {},
        getSteeringInput: () => { const input = steer; steer = null; return input; },
      });
      await waiting; steer = "Keep permissions.\n\nPreserve the resume context.";
      await vi.advanceTimersByTimeAsync(50);
      expect((await result).text).toBe("corrected");
      expect(seen[1].map(message => message.content)).toEqual(["original", "Keep permissions.\n\nPreserve the resume context."]);
      release(); await vi.advanceTimersByTimeAsync(1);
      expect(mutate).not.toHaveBeenCalled();
      expect(JSON.stringify(session.messages)).not.toContain('"id":"late"');
      expect(displayed.join("")).toBe("abandonedcorrected\n");
      session.log.assertReconstructs();
    } finally { release(); registry.close(); }
  });
  it("cancels a provider that ignores abort without inventing a completed assistant message", async () => {
    let started!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; }), paused = new Promise<void>(resolve => { release = resolve; });
    const provider: LlmProvider = { name: "replay", chat: vi.fn(), async *chatStream() { started(); await paused; yield { type: "done", stop_reason: "end_turn" } as StreamDelta; } };
    const registry = new ToolRegistry(), session = createSession(), abort = new AbortController();
    try {
      const result = runTurn("task", session, { provider, registry, systemPrompt: "sys", maxTurns: 2, verbose: false }, { signal: abort.signal, onStatus: () => {}, onTextDelta: () => {} });
      await waiting; abort.abort();
      expect((await result).stopReason).toBe("aborted");
      expect(session.messages).toHaveLength(1); session.log.assertReconstructs();
    } finally { release(); registry.close(); }
  });
});
