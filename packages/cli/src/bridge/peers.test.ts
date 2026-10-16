import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { peerRequest } from "./peers.js";
let root: string;
afterEach(async () => { vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); });
it("carries long paths and opaque protocol tokens unchanged through pinned peer transport", async () => {
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
});
