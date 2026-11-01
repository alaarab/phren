import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { AgentHooks } from "./agent-hooks.js";
import { validateTarget } from "./herdr.js";
import { logger } from "../logger.js";
import type { ModuleSnapshot } from "../modules/runtime.js";
import { type Json, MAX_FRAME } from "./protocol.js";
import type { CodexQuestions } from "./questions.js";
import type { HookInfo } from "./server-routes.js";
import { transcriptStreams, type StreamContext, type TranscriptStreams } from "./server-stream.js";
import type { SideQuestions } from "./side-questions.js";

type Page = { entries: { line: number; raw: Json }[]; totalLines: number; startLine: number; hasMore: boolean; reset: boolean };

const transcript = vi.hoisted(() => ({ found: true, pages: [] as Page[], reads: [] as number[] }));

vi.mock("./transcripts.js", async importOriginal => {
  const original = await importOriginal<typeof import("./transcripts.js")>();
  const { BridgeError } = await import("./protocol.js");
  return {
    ...original,
    targetTranscriptPath: async () => {
      if (!transcript.found) throw new BridgeError(404, "The transcript is not available for this conversation.");
      return "/fake/session.jsonl";
    },
    refreshTranscript: async () => undefined,
    TranscriptReader: class {
      async read(before?: number) {
        transcript.reads.push(before ?? -1);
        return transcript.pages.shift() ?? { entries: [], totalLines: 0, startLine: 0, hasMore: false, reset: true };
      }
      async readAfter() {
        return transcript.pages.shift() ?? { entries: [], totalLines: 0, startLine: 0, hasMore: false, reset: true };
      }
    },
    childAgent: () => undefined,
    childAgentTree: async () => [],
  };
});

vi.mock("./herdr.js", async importOriginal => ({
  ...await importOriginal<typeof import("./herdr.js")>(),
  validateTarget: vi.fn(),
  trustedDirectory: vi.fn(async () => { throw new Error("no project folder"); }),
}));

class FakeClient extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: string[] = [];
  closed?: { code?: number; reason?: string };
  send(data: string) { this.sent.push(data); }
  frames(): Json[] { return this.sent.map(data => JSON.parse(data) as Json); }
  close(code?: number, reason?: string) {
    if (this.readyState === WebSocket.CLOSED) return;
    this.closed = { code, reason };
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }
}

const pane = { agent_status: "idle", terminal_id: "term-1", cwd: "/tmp/project" };
const target = { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1", source: "copilot" as const, session: "aaaaaaaa-1111-4111-8111-111111111111" };

function harness(options: { found?: boolean; capabilities?: Json } = {}) {
  const unwatch = vi.fn();
  const side = { rows: [] as Json[] };
  const deliveries = { rows: [] as Json[] };
  const sideQuestions = { list: vi.fn(() => side.rows) };
  const hooks = {
    approval: vi.fn(() => undefined),
    servedQuestion: vi.fn(() => undefined),
    passwordPrompt: vi.fn(() => false),
    compacting: vi.fn(() => false),
    terminalPrompt: vi.fn(() => undefined),
    syncTerminalDialog: vi.fn(async () => undefined),
    watch: vi.fn(() => unwatch),
    deliveries: { forPane: vi.fn(() => deliveries.rows) },
    changes: { view: vi.fn(() => undefined) },
  };
  const ctx: StreamContext = {
    modules: { store: "store-x", profile: "profile-x", modules: [], generation: "gen-1", has: () => false } as ModuleSnapshot,
    agentHooks: hooks as unknown as AgentHooks,
    codexQuestions: { pending: vi.fn(async () => []), availableFor: vi.fn(() => false) } as unknown as CodexQuestions,
    sideQuestions: sideQuestions as unknown as SideQuestions,
    info: { modules: {}, store: "store-x", profile: "profile-x", generation: "gen-1" } as unknown as HookInfo,
    activeCapabilities: options.capabilities ?? {},
  };
  transcript.found = options.found ?? true;
  transcript.pages.length = 0; transcript.reads.length = 0;
  return { ctx, hooks, unwatch, side, deliveries, sideQuestions, streams: transcriptStreams(ctx) };
}

async function open(streams: TranscriptStreams, client: FakeClient, query: Record<string, string>, path = "/v1/status") {
  await streams.stream(client, new URL(`http://phren.local${path}?${new URLSearchParams(query)}`));
}

async function tickBy(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  // The interval callback starts its tick without awaiting it.
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(validateTarget).mockReset().mockResolvedValue(pane as never);
  vi.mocked(validateTarget).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(validateTarget).mockReset();
});

describe("status stream", () => {
  it("streams the pane's status on open, then re-reads the pane on the 1.5s status clock", async () => {
    const h = harness(), client = new FakeClient();
    await open(h.streams, client, target);
    expect(client.frames()).toHaveLength(1);
    expect(client.frames()[0]).toMatchObject({
      agentStatus: { source: "copilot", session: target.session, status: "idle", compacting: false,
        modules: {}, store: "store-x", profile: "profile-x", generation: "gen-1", capabilities: { asyncQuestions: false } },
    });
    expect(vi.mocked(validateTarget)).toHaveBeenCalledTimes(1);

    // No transcript means the slower clock: nothing at 1s, a fresh read at 1.5s.
    await tickBy(1_000);
    expect(client.frames()).toHaveLength(1);
    await tickBy(500);
    expect(client.frames()).toHaveLength(2);
    expect(client.frames()[1]).toMatchObject({ agentStatus: { status: "idle" } });
    expect(vi.mocked(validateTarget)).toHaveBeenCalledTimes(2);
    client.close(1000);
  });

  it("stops the clock and releases the pane watch when the phone disconnects", async () => {
    const h = harness(), client = new FakeClient();
    await open(h.streams, client, target);
    expect(h.hooks.watch).toHaveBeenCalledTimes(1);
    expect(client.frames()).toHaveLength(1);

    client.close(1000, "bye");
    expect(h.unwatch).toHaveBeenCalledTimes(1);
    const reads = vi.mocked(validateTarget).mock.calls.length;
    await tickBy(10_000);
    expect(client.frames()).toHaveLength(1);
    expect(vi.mocked(validateTarget).mock.calls.length).toBe(reads);
  });

  it("closes 1009 without sending when the client is backed up or the frame is over MAX_FRAME", async () => {
    const backedUp = new FakeClient();
    backedUp.bufferedAmount = MAX_FRAME + 1;
    await open(harness().streams, backedUp, target);
    expect(backedUp.sent).toEqual([]);
    expect(backedUp.closed).toEqual({ code: 1009, reason: "Reconnect to resume the conversation" });

    const oversized = new FakeClient();
    await open(harness({ capabilities: { big: "x".repeat(MAX_FRAME) } }).streams, oversized, target);
    expect(oversized.sent).toEqual([]);
    expect(oversized.closed).toEqual({ code: 1009, reason: "Reconnect to resume the conversation" });
  });

  it("closes 1011 with the bounded stream reason when a later pane read fails", async () => {
    const h = harness(), client = new FakeClient();
    // The failure is logged; keep the logger off the owner's real store.
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      vi.mocked(validateTarget).mockResolvedValueOnce(pane as never)
        .mockRejectedValueOnce(Object.assign(new Error("open /Users/sam/.claude/projects/p/session.jsonl failed"), { code: "EACCES" }));
      await open(h.streams, client, target);
      expect(client.frames()).toHaveLength(1);

      await tickBy(1_500);
      expect(client.closed).toEqual({ code: 1011, reason: "Stream failed: EACCES open session.jsonl failed" });
      expect(h.unwatch).toHaveBeenCalled();
      await tickBy(10_000);
      expect(client.frames()).toHaveLength(1);
    } finally { warn.mockRestore(); }
  });
});

describe("transcript stream requests", () => {
  it("refuses a malformed history request with 1008 and stops the stream", async () => {
    const h = harness(), client = new FakeClient();
    await open(h.streams, client, target, "/v1/transcripts");
    expect(client.frames()).toHaveLength(1);

    client.emit("message", Buffer.from("not json"));
    expect(client.closed).toEqual({ code: 1008, reason: "Invalid history request" });
    await tickBy(10_000);
    expect(client.frames()).toHaveLength(1);
  });

  it("does not let a history request made before the transcript exists stall the stream", async () => {
    const h = harness({ found: false }), client = new FakeClient();
    await open(h.streams, client, target, "/v1/transcripts");
    expect(client.frames()).toHaveLength(1);

    client.emit("message", Buffer.from(JSON.stringify({ type: "older", beforeLine: 1 })));
    // The agent writes its first turn while the request is still queued.
    transcript.found = true;
    transcript.pages.push({ entries: [{ line: 0, raw: { type: "message", role: "assistant", text: "hello" } }],
      totalLines: 1, startLine: 0, hasMore: false, reset: true });
    // Past the two-second lookup throttle, the queued request must not block the retry.
    for (let step = 0; step < 4; step += 1) await tickBy(500);
    expect(client.closed).toBeUndefined();
    expect(client.frames()).toHaveLength(2);
    expect(client.frames()[1]).toMatchObject({ type: "backlog", entries: [{ line: 0 }], totalLines: 1 });
    client.close(1000);
  });

  it("caps queued history requests at eight and refuses the next with 1008", async () => {
    const h = harness(), client = new FakeClient();
    await open(h.streams, client, target, "/v1/transcripts");
    // The first history request is in flight; later ones collect in the queue.
    vi.mocked(validateTarget).mockImplementation(() => new Promise<Json>(() => undefined));
    for (let beforeLine = 1; beforeLine <= 10; beforeLine += 1) {
      client.emit("message", Buffer.from(JSON.stringify({ type: "older", beforeLine })));
    }
    expect(client.closed).toEqual({ code: 1008, reason: "Invalid history request" });
    expect(transcript.reads).toEqual([-1]);
  });
});

describe("opt-in transcript frames", () => {
  it("sends side answers and delivery updates only to a stream that asked, and only when they change", async () => {
    const h = harness({ found: false }), asked = new FakeClient();
    h.side.rows.push({ id: "side-1", question: "why", state: "answer", answer: "because", revision: 1 });
    h.deliveries.rows.push({ deliveryId: "delivery-1", state: "delivered", landed: { line: 4 } });
    await open(h.streams, asked, { ...target, sideAnswers: "1", deliveries: "1" }, "/v1/transcripts");
    expect(asked.frames().map(frame => frame.type)).toEqual(["backlog", "side-answer", "delivery"]);
    expect(asked.frames()[0]).toMatchObject({ type: "backlog", entries: [], totalLines: 0, source: "copilot", session: target.session });
    expect(asked.frames()[1]).toEqual({ type: "side-answer", source: "copilot", session: target.session,
      id: "side-1", question: "why", state: "answer", answer: "because" });
    expect(asked.frames()[2]).toEqual({ type: "delivery", source: "copilot", session: target.session,
      deliveryId: "delivery-1", state: "delivered", landed: { line: 4 } });

    // Unchanged revision and landed row: the ticks add nothing.
    await tickBy(500);
    expect(asked.frames()).toHaveLength(3);

    // A changed revision and a changed landed row each produce exactly one new frame, in order.
    h.side.rows[0] = { ...h.side.rows[0], revision: 2 };
    h.deliveries.rows[0] = { deliveryId: "delivery-1", state: "delivered", landed: { line: 5 } };
    await tickBy(500);
    expect(asked.frames().map(frame => frame.type)).toEqual(["backlog", "side-answer", "delivery", "side-answer", "delivery"]);
    expect(asked.frames()[3]).toMatchObject({ type: "side-answer", id: "side-1", answer: "because" });
    expect(asked.frames()[4]).toMatchObject({ type: "delivery", deliveryId: "delivery-1", landed: { line: 5 } });

    // An ordinary phone never sees either frame, and the Hook never looks them up.
    const listCalls = h.sideQuestions.list.mock.calls.length, deliveryCalls = h.hooks.deliveries.forPane.mock.calls.length;
    const unasked = new FakeClient();
    await open(h.streams, unasked, target, "/v1/transcripts");
    expect(unasked.frames().map(frame => frame.type)).toEqual(["backlog"]);
    expect(h.sideQuestions.list.mock.calls.length).toBe(listCalls);
    expect(h.hooks.deliveries.forPane.mock.calls.length).toBe(deliveryCalls);
    asked.close(1000); unasked.close(1000);
  });
});
