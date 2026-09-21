import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { enrollComputer, publicComputerKey } from "./computers.js";
import { DispatchConnections, openPeerStream, type DispatchStream } from "./dispatch-connections.js";
import type { HookPeer } from "./peers.js";

const peer = (name: string): HookPeer => ({ name, address: "desk.example", username: "sam", port: 22,
  hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFIXTUREFIXTUREFIXTUREFIXTUREFIXTUREFIX", server: "default" });

describe("dispatch report connection pool", () => {
  afterEach(() => vi.useRealTimers());

  it("caps streams at eight per peer and sixteen total, then admits queued work", async () => {
    const controls: Array<() => void> = [];
    const factory = vi.fn(async (): Promise<DispatchStream> => {
      let finish!: () => void;
      const closed = new Promise<Error | undefined>(resolve => { finish = () => resolve(undefined); });
      controls.push(finish); return { closed, close: finish };
    });
    const pool = new DispatchConnections(factory, 8, 16, 90_000);
    const opened = [...Array.from({ length: 10 }, () => pool.open(peer("Desk"), "/v1/status", () => {})),
      ...Array.from({ length: 10 }, () => pool.open(peer("Linuxbox"), "/v1/status", () => {}))];
    await vi.waitFor(() => expect(pool.counts).toEqual({ total: 16, queued: 4, peers: { Desk: 8, Linuxbox: 8 } }));
    controls[0](); controls[8]();
    await vi.waitFor(() => expect(pool.counts.queued).toBe(2));
    expect(Math.max(...Object.values(pool.counts.peers))).toBe(8);
    pool.close(); await Promise.allSettled(opened);
  });

  it("closes an idle stream and releases its slot", async () => {
    vi.useFakeTimers();
    let closed = false;
    const pool = new DispatchConnections(async () => {
      let finish!: () => void;
      const done = new Promise<Error | undefined>(resolve => { finish = () => { closed = true; resolve(undefined); }; });
      return { closed: done, close: finish };
    }, 8, 16, 1000);
    await pool.open(peer("Desk"), "/v1/transcripts", () => {});
    await vi.advanceTimersByTimeAsync(1001);
    expect(closed).toBe(true);
    await vi.waitFor(() => expect(pool.counts.total).toBe(0));
    pool.close();
  });

  it("rejects and closes an in-flight socket when the pool closes", async () => {
    let finishOpen!: (stream: DispatchStream) => void, closed = false;
    const factory = () => new Promise<DispatchStream>(resolve => { finishOpen = resolve; });
    const pool = new DispatchConnections(factory);
    const opening = pool.open(peer("Desk"), "/v1/status", () => {});
    await vi.waitFor(() => expect(finishOpen).toBeTypeOf("function"));
    pool.close();
    finishOpen({ closed: Promise.resolve(undefined), close: () => { closed = true; } });
    await expect(opening).rejects.toThrow("closed");
    expect(closed).toBe(true); expect(pool.counts.total).toBe(0);
  });
});

const sshFixture = process.env.PHREN_CONDUCTOR_SSH_FIXTURE;
describe.runIf(Boolean(sshFixture))("real pinned SSH refusal gate", () => {
  let root = "";
  afterEach(async () => { vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); });

  it("refuses both a wrong host pin and an unenrolled dispatch key", async () => {
    const fixture = JSON.parse(sshFixture!) as { address: string; username: string; port: number; hostKey: string };
    root = await mkdtemp(path.join(tmpdir(), "phren-report-ssh-")); vi.stubEnv("PHREN_BRIDGE_HOME", root);
    const line = await enrollComputer("Desk", root), wrongHostKey = publicComputerKey(line.slice(line.indexOf("ssh-ed25519")));
    const base = { name: "Linuxbox", address: fixture.address, username: fixture.username, port: fixture.port,
      server: "default", hostKey: fixture.hostKey } satisfies HookPeer;
    await expect(openPeerStream({ ...base, hostKey: wrongHostKey }, "/v1/status", () => {})).rejects.toThrow("host key");
    await expect(openPeerStream(base, "/v1/status", () => {})).rejects.toThrow("enrolled");
  }, 30_000);
});
