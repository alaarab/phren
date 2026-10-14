import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import type { Computer } from "./contract.js";
import { linkComputer } from "./keys.js";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEp8VWGvSO7U7OMdQo3CQgkVv41Gw2cztUk5uiefMuhg";
const calls = vi.hoisted(() => ({ close: vi.fn(), verify: vi.fn() }));
vi.mock("./hosts.js", async original => ({ ...await original<typeof import("./hosts.js")>(), closeMasters: calls.close }));
vi.mock("./hook-client.js", () => ({ hookRequest: calls.verify }));
vi.mock("node:child_process", async original => ({
  ...await original<typeof import("node:child_process")>(),
  execFile(command: string, args: string[], _opts: unknown, callback?: (error: null, result: { stdout: string; stderr: string }) => void) {
    if (callback) {
      queueMicrotask(() => callback(null, { stdout: command === "ssh-keygen" ? KEY : "hostname box\nuser me\nport 22\n", stderr: "" }));
      return;
    }
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    child.stdin.once("finish", () => queueMicrotask(() => { child.stdout.emit("data", Buffer.from(`HOSTKEY ${KEY}\n`)); child.emit("close", 0); }));
    return child;
  },
}));
let dir: string;
const previous = process.env.PHREN_BRIDGE_HOME;
afterEach(async () => { if (previous === undefined) delete process.env.PHREN_BRIDGE_HOME; else process.env.PHREN_BRIDGE_HOME = previous; await rm(dir, { recursive: true, force: true }); vi.clearAllMocks(); });

it("closes the old and current masters before verifying a relink", async () => {
  await mkdir(".scratch", { recursive: true });
  dir = await mkdtemp(path.resolve(".scratch/relink-"));
  process.env.PHREN_BRIDGE_HOME = dir;
  await writeFile(path.join(dir, "id_ed25519_desktop"), "unused fake private key");
  await writeFile(path.join(dir, "desktop.yaml"), `version: 1\ncomputers:\n  - name: Desk\n    address: old-box\n    username: old-user\n    hostKey: ssh-ed25519 AAAAOLDPIN\n    server: default\n`);
  calls.close.mockResolvedValue(undefined);
  calls.verify.mockImplementation(async (computer: Computer) => {
    expect(calls.close).toHaveBeenCalledWith(expect.objectContaining({ name: "Desk", address: "old-box", hostKey: "ssh-ed25519 AAAAOLDPIN" }));
    expect(calls.close).toHaveBeenCalledWith(computer);
    return { status: 200, headers: {}, body: Buffer.from('{"product":"phren-hook"}') };
  });
  expect(await linkComputer("me@box", { name: "Desk", server: "tmux-work" })).toMatchObject({ address: "box", server: "tmux-work" });
  expect(calls.verify).toHaveBeenCalledTimes(1);
});
