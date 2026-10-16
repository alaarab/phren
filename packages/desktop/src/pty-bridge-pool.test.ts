import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node-pty";
import { MAX_CHANNELS, MAX_SLOTS, SIDE_CHANNEL_BUDGET, channelPool, sideChannelPool, type AcquiredChannel } from "./channel-pool.js";
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
let writes: string[] = [];
const kill = vi.fn();
const inUse = () => channelPool.stats(key).slots.reduce((a, b) => a + b, 0);
const holdAll = async (pool: { acquire: typeof channelPool.acquire }, n: number) => {
  for (let i = 0; i < n; i++) held.push(await pool.acquire(key));
};

beforeEach(() => {
  exits = [];
  writes = [];
  kill.mockReset();
  mocks.sshArgs.mockReset().mockImplementation((_c, _cmd, opts) => ["slot", String(opts?.slot ?? 0)]);
  vi.mocked(spawn).mockReset().mockImplementation((() => ({
    onData: vi.fn(), onExit: (l: (e: { exitCode: number }) => void) => { exits.push(l); }, write: (d: string) => writes.push(d), resize: vi.fn(), kill,
  })) as never);
});
afterEach(() => {
  vi.useRealTimers();
  for (const channel of held.splice(0)) channel.release();
});

describe("remote terminal channel pool", () => {
  it("passes the pooled slot to ssh and releases once on exit", async () => {
    await holdAll(channelPool, MAX_CHANNELS);
    const onExit = vi.fn();
    const session = attachTerminal(REMOTE, "herdr1", 80, 24);
    session.onExit(onExit);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    expect(mocks.sshArgs).toHaveBeenCalledWith(REMOTE, "phren-hook v1 terminal herdr1", { tty: true, slot: 1 });
    expect(spawn).toHaveBeenCalledWith("ssh", ["slot", "1"], expect.any(Object));
    expect(channelPool.stats(key).slots).toEqual([MAX_CHANNELS, 1, 0, 0]);
    exits[0]({ exitCode: 3 });
    exits[0]({ exitCode: 3 });
    expect(channelPool.stats(key).slots).toEqual([MAX_CHANNELS, 0, 0, 0]);
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith(3);
  });

  it("releases on kill and once even if the pty then exits", async () => {
    const session = attachShell(REMOTE, "/work", 80, 24);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    expect(inUse()).toBe(1);
    session.kill();
    expect(kill).toHaveBeenCalled();
    expect(inUse()).toBe(0);
    exits[0]({ exitCode: 0 });
    expect(inUse()).toBe(0);
  });

  it("takes no slot when killed while waiting for a channel", async () => {
    await holdAll(channelPool, MAX_SLOTS * MAX_CHANNELS);
    const onExit = vi.fn();
    const session = attachTerminal(REMOTE, "herdr1", 80, 24);
    session.onExit(onExit);
    await vi.waitFor(() => expect(channelPool.stats(key).waiting).toBe(1));
    session.kill();
    expect(channelPool.stats(key).waiting).toBe(0);
    held.pop()!.release();
    expect(spawn).not.toHaveBeenCalled();
    expect(inUse()).toBe(MAX_SLOTS * MAX_CHANNELS - 1);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("releases when the pty cannot be spawned", async () => {
    vi.mocked(spawn).mockImplementation(() => { throw new Error("no pty"); });
    const onExit = vi.fn();
    attachTerminal(REMOTE, "herdr1", 80, 24).onExit(onExit);
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith(1));
    expect(inUse()).toBe(0);
  });

  it("leaves chats headroom while terminals sit at their budget", async () => {
    await holdAll(sideChannelPool, SIDE_CHANNEL_BUDGET);
    const session = attachTerminal(REMOTE, "herdr1", 80, 24);
    session.onExit(() => undefined);
    // Over budget: queued in the terminal budget, not in the shared pool.
    await Promise.resolve();
    expect(spawn).not.toHaveBeenCalled();
    expect(channelPool.stats(key).waiting).toBe(0);
    const chat = await channelPool.acquire(key, { timeoutMs: 1 });
    held.push(chat);
    expect(inUse()).toBe(SIDE_CHANNEL_BUDGET + 1);
    session.kill();
  });

  it("says so after 2 s of queueing and when no channel comes", async () => {
    vi.useFakeTimers();
    await holdAll(sideChannelPool, SIDE_CHANNEL_BUDGET);
    const output: string[] = [];
    const onExit = vi.fn();
    const session = attachTerminal(REMOTE, "herdr1", 80, 24);
    session.onData((data) => output.push(data));
    session.onExit(onExit);
    await vi.advanceTimersByTimeAsync(1_900);
    expect(output).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(output.join("")).toContain("Waiting for a free SSH channel to Pool terminal…");
    expect(onExit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(output.join("")).toContain("No free SSH channel to Pool terminal; close a terminal or preview.");
    expect(onExit).toHaveBeenCalledWith(1);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("caps the input held before the terminal starts", async () => {
    await holdAll(sideChannelPool, SIDE_CHANNEL_BUDGET);
    const output: string[] = [];
    const session = attachTerminal(REMOTE, "herdr1", 80, 24);
    session.onData((data) => output.push(data));
    session.write("a".repeat(1024 * 1024));
    session.write("dropped");
    held.pop()!.release();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    expect(writes).toEqual(["a".repeat(1024 * 1024)]);
    expect(output.join("")).toContain("was too large and was dropped");
    session.kill();
  });
});
