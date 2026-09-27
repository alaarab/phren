import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { Json } from "./protocol.js";
import { overviewStream, type OverviewClient } from "./server-overview.js";

class FakeClient extends EventEmitter implements OverviewClient {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  frames: Json[] = [];
  closed?: { code?: number; reason?: string };
  send(data: string) { this.frames.push(JSON.parse(data)); }
  close(code?: number, reason?: string) { this.closed = { code, reason }; this.readyState = WebSocket.CLOSED; this.emit("close"); }
}

function harness(options: { refreshMs?: number; heartbeatMs?: number } = {}) {
  let now = 1_000_000;
  let panes: Json[] = [{ pane_id: "w1:p1", agent_status: "working" }];
  let branch = "main";
  const snapshots: number[] = [];
  const reads: Json[] = [];
  const renewed: string[] = [];
  const stream = overviewStream({
    snapshot: async (_server, maxAgeMs) => { snapshots.push(maxAgeMs); return { panes: panes.map(pane => ({ ...pane })) }; },
    read: async (_server, s, watchApprovals) => {
      reads.push(s);
      return { groups: [{ id: "w1", children: [{ id: "w1:t1", status: (s.panes as Json[])[0].agent_status, branch }] }], watchApprovals,
        phren: { load: { average: Math.random(), cpus: 8 } } };
    },
    info: () => ({ load: { average: 1, cpus: 8 } }),
    renew: server => renewed.push(server),
    now: () => now,
    tickMs: 60_000, // ticks are driven by the test
    refreshMs: options.refreshMs ?? 10_000,
    heartbeatMs: options.heartbeatMs ?? 20_000,
  });
  return {
    stream, snapshots, reads, renewed,
    advance(ms: number) { now += ms; },
    setStatus(status: string) { panes = [{ pane_id: "w1:p1", agent_status: status }]; },
    setBranch(value: string) { branch = value; },
  };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

describe("overview stream", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("isolates a failed mux stream from another source on the same computer", async () => {
    const stream = overviewStream({ info: () => ({}), renew: () => {}, tickMs: 60_000,
      snapshot: async server => { if (server === "broken") throw new Error("source unavailable"); return { panes: [] }; },
      read: async server => ({ kind: "tmux", mux: { id: `tmux:${server}`, kind: "tmux", session: server }, groups: [{ id: "s1" }] }) });
    const bad = new FakeClient(), good = new FakeClient();
    const a = stream(bad, "broken", false), b = stream(good, "tmux", false, false, true);
    await settle();
    expect(bad.closed?.code).toBe(1011);
    expect(good.closed).toBeUndefined();
    expect(good.frames[0]).toMatchObject({ type: "overview", kind: "tmux", mux: { id: "tmux:tmux" }, groups: [{ id: "s1" }] });
    await b.tick(); expect(good.closed).toBeUndefined();
    a.stop(); b.stop();
  });

  it("keeps legacy tmux overview envelopes readable while typed clients get the real kind", async () => {
    const stream = overviewStream({ info: () => ({}), renew: () => {}, tickMs: 60_000,
      snapshot: async () => ({ panes: [] }),
      read: async () => ({ kind: "tmux", mux: { id: "tmux:tmux", kind: "tmux", session: "tmux" }, groups: [{ id: "s1" }] }) });
    const legacy = new FakeClient(), typed = new FakeClient();
    const a = stream(legacy, "tmux", false), b = stream(typed, "tmux", false, false, true);
    try {
      await settle();
      expect(legacy.frames[0]).toMatchObject({ type: "overview", kind: "herdr", mux: { kind: "tmux" }, groups: [{ id: "s1" }] });
      expect(typed.frames[0]).toMatchObject({ type: "overview", kind: "tmux", mux: { kind: "tmux" }, groups: [{ id: "s1" }] });
    } finally { a.stop(); b.stop(); }
  });

  it("sends the overview first, then only what changed", async () => {
    const h = harness(), client = new FakeClient();
    const { tick, stop } = h.stream(client, "default", true);
    await settle();
    expect(client.frames).toHaveLength(1);
    expect(client.frames[0]).toMatchObject({ type: "overview", watchApprovals: true });
    // The first frame reads a fresh snapshot; later ticks reuse the shared one.
    expect(h.snapshots[0]).toBe(0);

    // Nothing changed: no frame, no rebuild, the approval lease renewed.
    h.advance(2_500); await tick();
    expect(client.frames).toHaveLength(1);
    expect(h.reads).toHaveLength(1);
    expect(h.renewed).toEqual(["default"]);
    expect(h.snapshots[1]).toBe(60_000);

    // A status change in the snapshot rebuilds and sends at once.
    h.setStatus("idle"); h.advance(2_500); await tick();
    expect(client.frames).toHaveLength(2);
    expect(client.frames[1]).toMatchObject({ type: "overview", groups: [{ children: [{ status: "idle" }] }] });
    stop();
  });

  it("rebuilds on the refresh floor for what lives outside the snapshot", async () => {
    const h = harness({ refreshMs: 10_000 }), client = new FakeClient();
    const { tick, stop } = h.stream(client, "default", false);
    await settle();
    h.setBranch("feature"); h.advance(5_000); await tick();
    expect(client.frames).toHaveLength(1);
    h.advance(5_000); await tick();
    expect(h.reads).toHaveLength(2);
    expect(client.frames).toHaveLength(2);
    expect(client.frames[1]).toMatchObject({ groups: [{ children: [{ branch: "feature" }] }] });
    // Hook info alone (its load) is not a change worth a frame.
    h.advance(10_000); await tick();
    expect(h.reads).toHaveLength(3);
    expect(client.frames).toHaveLength(2);
    expect(h.renewed).toEqual([]);
    stop();
  });

  it("sends a heartbeat when nothing changed for a while", async () => {
    const h = harness({ heartbeatMs: 20_000, refreshMs: 120_000 }), client = new FakeClient();
    const { tick, stop } = h.stream(client, "default", false);
    await settle();
    h.advance(10_000); await tick();
    expect(client.frames).toHaveLength(1);
    h.advance(10_000); await tick();
    expect(client.frames).toHaveLength(2);
    expect(client.frames[1]).toEqual({ type: "heartbeat", phren: { load: { average: 1, cpus: 8 } } });
    h.advance(5_000); await tick();
    expect(client.frames).toHaveLength(2);
    stop();
  });

  it("stops ticking when the client closes and closes on a failed read", async () => {
    const h = harness(), client = new FakeClient();
    const { tick } = h.stream(client, "default", false);
    await settle();
    client.close(1000);
    h.setStatus("idle"); h.advance(2_500); await tick();
    expect(client.frames).toHaveLength(1);

    const failing = overviewStream({
      snapshot: async () => { throw new Error("Herdr is not running"); },
      read: async () => ({}), info: () => ({}), renew: () => {}, tickMs: 60_000,
    });
    const broken = new FakeClient();
    failing(broken, "default", false);
    await settle();
    expect(broken.closed?.code).toBe(1011);
    expect(broken.closed?.reason).toContain("Herdr is not running");
  });

  it("sends resources frames on their own clock only to phones that ask", async () => {
    let now = 0, reads = 0;
    const stream = overviewStream({
      snapshot: async () => ({ panes: [] }),
      read: async () => ({ groups: [], phren: {} }),
      info: () => ({}), renew: () => {},
      resources: async () => ({ level: "ok", read: ++reads }),
      now: () => now, tickMs: 60_000, resourcesMs: 12_000,
    });
    const asked = new FakeClient(), older = new FakeClient();
    const a = stream(asked, "default", false, true), b = stream(older, "default", false);
    await settle();
    expect(asked.frames.map(frame => frame.type)).toEqual(["overview", "resources"]);
    expect(asked.frames[1]).toEqual({ type: "resources", resources: { level: "ok", read: 1 } });
    expect(older.frames.map(frame => frame.type)).toEqual(["overview"]);
    now = 11_999; await a.tick();
    expect(asked.frames.filter(frame => frame.type === "resources")).toHaveLength(1);
    now = 12_000; await a.tick(); await b.tick(); await settle();
    expect(asked.frames.filter(frame => frame.type === "resources")).toHaveLength(2);
    expect(older.frames.some(frame => frame.type === "resources")).toBe(false);
    a.stop(); b.stop();
  });

  it("sends the first overview while a resources read is still pending, without overlapping reads", async () => {
    let now = 0, reads = 0;
    let resolveResources!: (value: unknown) => void;
    const pending = new Promise<unknown>(resolve => { resolveResources = resolve; });
    const stream = overviewStream({
      snapshot: async () => ({ panes: [] }),
      read: async () => ({ groups: [], phren: {} }),
      info: () => ({}), renew: () => {},
      resources: () => { reads++; return pending; },
      now: () => now, tickMs: 60_000, resourcesMs: 12_000,
    });
    const client = new FakeClient(), connection = stream(client, "default", false, true);
    await settle();
    expect(client.frames.map(frame => frame.type)).toEqual(["overview"]);
    expect(reads).toBe(1);
    now = 12_000; await connection.tick();
    expect(reads).toBe(1);
    resolveResources({ level: "ok" });
    await settle();
    expect(client.frames.map(frame => frame.type)).toEqual(["overview", "resources"]);
    connection.stop();
  });
});
