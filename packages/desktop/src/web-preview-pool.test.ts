import { EventEmitter } from "node:events";
import { connect, type Socket } from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { channelPool, type AcquiredChannel } from "./channel-pool.js";
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

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const inUse = () => channelPool.stats(key).slots.reduce((a, b) => a + b, 0);

function client(localPort: number): Socket {
  const socket = connect({ host: "127.0.0.1", port: localPort });
  socket.on("error", () => undefined);
  sockets.push(socket);
  socket.on("connect", () => socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${localPort}\r\n\r\n`));
  return socket;
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
  closeAllPreviews();
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const channel of held.splice(0)) channel.release();
});

describe("remote web preview channel pool", () => {
  it("passes the pooled slot to ssh and releases once when ssh exits", async () => {
    // Fill slot 0 so the next channel is granted slot 1.
    for (let i = 0; i < 8; i++) held.push(await channelPool.acquire(key));
    const preview = await openPreview(REMOTE, 8080);
    client(preview.localPort);
    await settle();
    expect(mocks.sshArgs).toHaveBeenCalledWith(REMOTE, "phren-hook v1 web 127.0.0.1 8080", { slot: 1 });
    expect(channelPool.stats(key).slots).toEqual([8, 1, 0, 0]);
    children[0].emit("exit", 0);
    children[0].emit("exit", 0);
    expect(channelPool.stats(key).slots).toEqual([8, 0, 0, 0]);
  });

  it("releases when the browser connection is destroyed, killing ssh", async () => {
    const preview = await openPreview(REMOTE, 8080);
    const socket = client(preview.localPort);
    await settle();
    expect(inUse()).toBe(1);
    socket.destroy();
    await settle();
    expect(mocks.kill).toHaveBeenCalled();
    expect(inUse()).toBe(0);
    children[0].emit("exit", null);
    expect(inUse()).toBe(0);
  });

  it("releases when ssh cannot be spawned", async () => {
    mocks.spawn.mockImplementation(() => { throw new Error("spawn failed"); });
    const preview = await openPreview(REMOTE, 8080);
    client(preview.localPort);
    await settle();
    expect(inUse()).toBe(0);
  });

  it("takes no slot when the connection closes while waiting for a channel", async () => {
    for (let i = 0; i < 32; i++) held.push(await channelPool.acquire(key));
    const preview = await openPreview(REMOTE, 8080);
    const socket = client(preview.localPort);
    await settle();
    expect(channelPool.stats(key).waiting).toBe(1);
    socket.destroy();
    await settle();
    expect(channelPool.stats(key).waiting).toBe(0);
    held.pop()!.release();
    await settle();
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(inUse()).toBe(31);
  });
});
