import { EventEmitter } from "node:events";
import { connect, type Socket } from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_CHANNELS, MAX_SLOTS, SIDE_CHANNEL_BUDGET, channelPool, sideChannelPool, type AcquiredChannel } from "./channel-pool.js";
import type { Computer } from "./contract.js";
import { closeAllPreviews, openPreview } from "./web-preview.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), sshArgs: vi.fn(), kill: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({ ...await importOriginal<typeof import("node:child_process")>(), spawn: mocks.spawn }));
vi.mock("./hosts.js", () => ({ masterKey: (c: Computer) => `key-${c.name}`, sshArgs: mocks.sshArgs }));

const REMOTE: Computer = { name: "Pool preview", local: false, server: "default" };
const key = "key-Pool preview";
const held: AcquiredChannel[] = [];
const sockets: Socket[] = [];
let children: EventEmitter[] = [];

const inUse = () => channelPool.stats(key).slots.reduce((a, b) => a + b, 0);

function client(localPort: number): { socket: Socket; received: () => string; closed: () => boolean } {
  const socket = connect({ host: "127.0.0.1", port: localPort });
  let received = "";
  let closed = false;
  socket.setEncoding("utf8");
  socket.on("error", () => undefined);
  socket.on("data", (chunk: string) => { received += chunk; });
  socket.on("close", () => { closed = true; });
  sockets.push(socket);
  socket.on("connect", () => socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${localPort}\r\n\r\n`));
  return { socket, received: () => received, closed: () => closed };
}

beforeEach(() => {
  children = [];
  mocks.kill.mockReset();
  mocks.sshArgs.mockReset().mockImplementation((_c, _cmd, opts) => ["slot", String(opts?.slot ?? 0)]);
  mocks.spawn.mockReset().mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: mocks.kill });
    children.push(child);
    return child;
  });
});

afterEach(() => {
  vi.useRealTimers();
  closeAllPreviews();
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const channel of held.splice(0)) channel.release();
});

describe("remote web preview channel pool", () => {
  it("passes the pooled slot to ssh and releases once when ssh exits", async () => {
    // Fill slot 0 so the next channel is granted slot 1.
    for (let i = 0; i < MAX_CHANNELS; i++) held.push(await channelPool.acquire(key));
    const preview = await openPreview(REMOTE, 8080);
    client(preview.localPort);
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
    expect(mocks.sshArgs).toHaveBeenCalledWith(REMOTE, "phren-hook v1 web 127.0.0.1 8080", { slot: 1 });
    expect(channelPool.stats(key).slots).toEqual([MAX_CHANNELS, 1, 0, 0]);
    children[0].emit("exit", 0);
    children[0].emit("exit", 0);
    expect(channelPool.stats(key).slots).toEqual([MAX_CHANNELS, 0, 0, 0]);
  });

  it("releases when the browser connection is destroyed, killing ssh", async () => {
    const preview = await openPreview(REMOTE, 8080);
    const { socket } = client(preview.localPort);
    await vi.waitFor(() => expect(inUse()).toBe(1));
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
    socket.destroy();
    await vi.waitFor(() => expect(inUse()).toBe(0));
    expect(mocks.kill).toHaveBeenCalled();
    children[0].emit("exit", null);
    expect(inUse()).toBe(0);
  });

  it("releases when ssh cannot be spawned", async () => {
    mocks.spawn.mockImplementation(() => { throw new Error("spawn failed"); });
    const preview = await openPreview(REMOTE, 8080);
    client(preview.localPort);
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
    await vi.waitFor(() => expect(inUse()).toBe(0));
  });

  it("takes no slot when the connection closes while waiting for a channel", async () => {
    for (let i = 0; i < MAX_SLOTS * MAX_CHANNELS; i++) held.push(await channelPool.acquire(key));
    const preview = await openPreview(REMOTE, 8080);
    const { socket } = client(preview.localPort);
    await vi.waitFor(() => expect(channelPool.stats(key).waiting).toBe(1));
    socket.destroy();
    await vi.waitFor(() => expect(channelPool.stats(key).waiting).toBe(0));
    held.pop()!.release();
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(inUse()).toBe(MAX_SLOTS * MAX_CHANNELS - 1);
  });

  it("leaves chats headroom while previews sit at their budget", async () => {
    const preview = await openPreview(REMOTE, 8080);
    for (let i = 0; i < SIDE_CHANNEL_BUDGET; i++) client(preview.localPort);
    await vi.waitFor(() => expect(sideChannelPool.held(key)).toBe(SIDE_CHANNEL_BUDGET));
    const extra = client(preview.localPort);
    await vi.waitFor(() => expect(extra.socket.connecting).toBe(false));
    // The extra connection queues in the budget, so the shared pool keeps room.
    expect(channelPool.stats(key).waiting).toBe(0);
    for (let i = 0; i < MAX_SLOTS * MAX_CHANNELS - SIDE_CHANNEL_BUDGET; i++) held.push(await channelPool.acquire(key, { timeoutMs: 1 }));
    expect(inUse()).toBe(MAX_SLOTS * MAX_CHANNELS);
  });

  it("answers 503 when no channel comes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    for (let i = 0; i < SIDE_CHANNEL_BUDGET; i++) held.push(await sideChannelPool.acquire(key));
    const preview = await openPreview(REMOTE, 8080);
    const browser = client(preview.localPort);
    // Let the connection and its Host check reach the relay (real I/O, not timers).
    await vi.waitFor(() => expect(browser.socket.connecting).toBe(false), { interval: 1 });
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(60_000);
    vi.useRealTimers();
    await vi.waitFor(() => expect(browser.received()).toContain("503 Service Unavailable"));
    expect(browser.received()).toContain("No free SSH channel to Pool preview; close a terminal or preview.");
    await vi.waitFor(() => expect(browser.closed()).toBe(true));
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
