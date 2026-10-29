import { chmod, mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { peerRequest, sweepPeerTemps } from "./peers.js";

const peer = { name: "remote", address: "fixture.invalid", username: "owner", port: 22, server: "default", hostKey: "ssh-ed25519 fixture" };
const leftovers = async () => (await readdir(root)).filter(name => name.startsWith("peer-"));
let root: string;
afterEach(async () => { vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); });
it.skipIf(process.platform === "win32")("carries long paths and opaque protocol tokens unchanged through pinned peer transport", async () => {
  root = await mkdtemp(path.join(tmpdir(), "phren-peer-wire-"));
  const bin = path.join(root, "bin"); await mkdir(bin);
  const ssh = path.join(bin, "ssh");
  await writeFile(ssh, `#!${process.execPath}
let bytes = Buffer.alloc(0);
process.stdin.on("data", chunk => {
  bytes = Buffer.concat([bytes, chunk]);
  const at = bytes.indexOf("\\r\\n\\r\\n"); if (at < 0) return;
  const length = Number(/content-length: (\\d+)/i.exec(bytes.subarray(0, at).toString())?.[1] ?? 0);
  if (bytes.length < at + 4 + length) return;
  const body = bytes.subarray(at + 4, at + 4 + length);
  process.stdout.end("HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\nContent-Length: " + body.length + "\\r\\nConnection: close\\r\\n\\r\\n" + body);
  process.stdin.destroy();
});
`);
  await chmod(ssh, 0o700);
  await writeFile(path.join(root, "id_ed25519_dispatch"), "fixture", { mode: 0o600 });
  vi.stubEnv("PHREN_BRIDGE_HOME", root); vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  const body = { cwd: "/workspace/" + "a1/".repeat(40), startingToken: "ab".repeat(32), authority: "owner" };
  expect(await peerRequest({ name: "remote", address: "fixture.invalid", username: "owner", port: 22, server: "default", hostKey: "ssh-ed25519 fixture" }, "/v1/workspaces/launch", body, 5000)).toEqual(body);
  expect(await leftovers()).toEqual([]);
});

// Each request pins the peer's host key in a `peer-*` folder of its own; one left behind per request filled a
// Hook's folder with hundreds of them.
it.skipIf(process.platform === "win32")("removes its known_hosts folder when the peer never answers, and when SSH cannot start", async () => {
  root = await mkdtemp(path.join(tmpdir(), "phren-peer-temp-"));
  const bin = path.join(root, "bin"); await mkdir(bin);
  await writeFile(path.join(bin, "ssh"), `#!${process.execPath}\nprocess.stdin.resume();\nsetTimeout(() => {}, 60_000);\n`);
  await chmod(path.join(bin, "ssh"), 0o700);
  await writeFile(path.join(root, "id_ed25519_dispatch"), "fixture", { mode: 0o600 });
  vi.stubEnv("PHREN_BRIDGE_HOME", root); vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  await expect(peerRequest(peer, "/v1/health", undefined, 300)).rejects.toMatchObject({ status: 504 });
  expect(await leftovers()).toEqual([]);
  // No ssh on PATH at all.
  vi.stubEnv("PATH", path.join(root, "empty"));
  await expect(peerRequest(peer, "/v1/health", undefined, 300)).rejects.toBeDefined();
  expect(await leftovers()).toEqual([]);
});

it("sweeps known_hosts folders a stopped Hook left behind, and only those", async () => {
  root = await mkdtemp(path.join(tmpdir(), "phren-peer-sweep-"));
  const now = Date.now(), old = new Date(now - 60 * 60_000);
  for (const name of ["peer-Ab12Cd", "peer-Ef34Gh", "peer-notours-x", "moves"]) await mkdir(path.join(root, name));
  await writeFile(path.join(root, "peer-Ab12Cd", "known_hosts"), "pin");
  for (const name of ["peer-Ab12Cd", "peer-notours-x", "moves"]) await utimes(path.join(root, name), old, old);
  // Old and ours: gone. Fresh (a request running now), another name, or not ours: kept.
  expect(await sweepPeerTemps(root, now)).toBe(1);
  expect((await readdir(root)).sort()).toEqual(["moves", "peer-Ef34Gh", "peer-notours-x"]);
});
