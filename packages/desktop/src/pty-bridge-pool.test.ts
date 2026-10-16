import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node-pty";
import { channelPool, type AcquiredChannel } from "./channel-pool.js";
import type { Computer } from "./contract.js";
import { attachShell, attachTerminal } from "./pty-bridge.js";

const mocks = vi.hoisted(() => ({ sshArgs: vi.fn() }));
vi.mock("node-pty", () => ({ spawn: vi.fn() }));
vi.mock("node:fs", async (original) => ({ ...await original<object>(), existsSync: () => false }));
vi.mock("./hosts.js", () => ({ masterKey: (c: Computer) => `key-${c.name}`, sshArgs: mocks.sshArgs }));

const REMOTE: Computer = { name: "Pool terminal", local: false, server: "default" };
const key = "key-Pool terminal";
const held: AcquiredChannel[] = [];
let exits: Array<(e: { exitCode: number }) => void> = [];
const kill = vi.fn();
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
const inUse = () => channelPool.stats(key).slots.reduce((a, b) => a + b, 0);

beforeEach(() => {
  exits = [];
  kill.mockReset();
  mocks.sshArgs.mockReset().mockImplementation((_c, _cmd, opts) => ["slot", String(opts?.slot ?? 0)]);
  vi.mocked(spawn).mockReset().mockImplementation((() => ({
    onData: vi.fn(), onExit: (l: (e: { exitCode: number }) => void) => { exits.push(l); }, write: vi.fn(), resize: vi.fn(), kill,
  })) as never);
});
afterEach(() => { for (const channel of held.splice(0)) channel.release(); });

describe("remote terminal channel pool", () => {
  it("passes the pooled slot to ssh and releases once on exit", async () => {
    for (let i = 0; i < 8; i++) held.push(await channelPool.acquire(key));
    const onExit = vi.fn();
    const session = attachTerminal(REMOTE, "herdr1", 80, 24);
    session.onExit(onExit);
    await settle();
    expect(mocks.sshArgs).toHaveBeenCalledWith(REMOTE, "phren-hook v1 terminal herdr1", { tty: true, slot: 1 });
    expect(spawn).toHaveBeenCalledWith("ssh", ["slot", "1"], expect.any(Object));
    expect(channelPool.stats(key).slots).toEqual([8, 1, 0, 0]);
    exits[0]({ exitCode: 3 });
    exits[0]({ exitCode: 3 });
    expect(channelPool.stats(key).slots).toEqual([8, 0, 0, 0]);
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith(3);
  });

  it("releases on kill and once even if the pty then exits", async () => {
    const session = attachShell(REMOTE, "/work", 80, 24);
    await settle();
    expect(inUse()).toBe(1);
    session.kill();
    expect(kill).toHaveBeenCalled();
    expect(inUse()).toBe(0);
    exits[0]({ exitCode: 0 });
    expect(inUse()).toBe(0);
  });

  it("takes no slot when killed while waiting for a channel", async () => {
    for (let i = 0; i < 32; i++) held.push(await channelPool.acquire(key));
    const onExit = vi.fn();
    const session = attachTerminal(REMOTE, "herdr1", 80, 24);
    session.onExit(onExit);
    await settle();
    expect(channelPool.stats(key).waiting).toBe(1);
    session.kill();
    await settle();
    expect(channelPool.stats(key).waiting).toBe(0);
    held.pop()!.release();
    await settle();
    expect(spawn).not.toHaveBeenCalled();
    expect(inUse()).toBe(31);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("releases when the pty cannot be spawned", async () => {
    vi.mocked(spawn).mockImplementation(() => { throw new Error("no pty"); });
    const onExit = vi.fn();
    attachTerminal(REMOTE, "herdr1", 80, 24).onExit(onExit);
    await settle();
    expect(inUse()).toBe(0);
    expect(onExit).toHaveBeenCalledWith(1);
  });
});
