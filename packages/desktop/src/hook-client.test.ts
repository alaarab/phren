import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { channelPool, type AcquiredChannel } from "./channel-pool.js";
import type { Computer } from "./contract.js";
import { hookRequest } from "./hook-client.js";
import { masterKey } from "./hosts.js";

const ssh = vi.hoisted(() => ({ kill: vi.fn(), spawn: vi.fn() }));
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: ssh.spawn,
}));
let dir: string;
let computer: Computer;
const held: AcquiredChannel[] = [];
const previous = process.env.PHREN_BRIDGE_HOME;
beforeEach(async () => {
  await mkdir(".scratch", { recursive: true });
  dir = await mkdtemp(path.resolve(".scratch/request-"));
  process.env.PHREN_BRIDGE_HOME = dir;
  const keyFile = path.join(dir, "key");
  await writeFile(keyFile, "private test key");
  computer = { name: "Remote", local: false, server: "default", address: "box", username: "me", keyFile, hostKey: "ssh-ed25519 AAAAPIN" };
  ssh.kill.mockReset();
  ssh.spawn.mockReset().mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: ssh.kill });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  vi.useFakeTimers();
  for (let i = 0; i < 32; i++) held.push(await channelPool.acquire(masterKey(computer)));
});
afterEach(async () => {
  for (const channel of held.splice(0)) channel.release();
  vi.useRealTimers();
  if (previous === undefined) delete process.env.PHREN_BRIDGE_HOME; else process.env.PHREN_BRIDGE_HOME = previous;
  await rm(dir, { recursive: true, force: true });
});

describe("Hook request deadline", () => {
  it("fails a saturated channel pool within the request deadline", async () => {
    const pending = hookRequest(computer, "GET", "/v1/health");
    const rejected = expect(pending).rejects.toThrow(/timed out.*channel/i);
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    expect(channelPool.stats(masterKey(computer)).waiting).toBe(0);
    expect(ssh.spawn).not.toHaveBeenCalled();
  });

  it("counts acquisition time inside the HTTP deadline", async () => {
    const pending = hookRequest(computer, "GET", "/v1/health");
    const rejected = expect(pending).rejects.toThrow(/Hook request timed out/);
    await vi.advanceTimersByTimeAsync(59_000);
    held[0].release();
    await vi.advanceTimersByTimeAsync(0);
    expect(ssh.spawn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(ssh.kill).toHaveBeenCalled();
  });
});
