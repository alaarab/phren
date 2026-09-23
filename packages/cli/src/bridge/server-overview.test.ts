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
});
