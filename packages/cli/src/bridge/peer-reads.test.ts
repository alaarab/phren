import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { peerRead, refreshPeerReads } from "./peer-reads.js";
import { PEER_RETRY_FIRST_MS } from "./peer-reach.js";
import { peerRequest, type HookPeer } from "./peers.js";

// A fake `ssh` on PATH stands in for the login: it records each start and behaves as the `mode` file says.
// The peer's SSH port is a real local port, open or closed, so the reachability check is the real one.
const FAKE_SSH = `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
const root = path.dirname(__dirname);
fs.appendFileSync(path.join(root, "logins"), "x");
const mode = fs.readFileSync(path.join(root, "mode"), "utf8").trim();
if (mode === "off") { process.stderr.write("ssh: connect to host peer port 22: Operation timed out\\n"); process.exit(255); }
process.stdin.on("data", () => {
  if (mode === "hang") return;
  const status = mode === "404" ? "404 Not Found" : "200 OK";
  const body = JSON.stringify(mode === "404" ? { error: "No such route." } : { ok: true, at: fs.readFileSync(path.join(root, "logins"), "utf8").length });
  setTimeout(() => { process.stdout.end("HTTP/1.1 " + status + "\\r\\nContent-Type: application/json\\r\\nContent-Length: " + Buffer.byteLength(body) + "\\r\\nConnection: close\\r\\n\\r\\n" + body); process.stdin.destroy(); }, 100);
});
if (mode === "hang") setTimeout(() => {}, 60_000);
`;

let root: string, peer: HookPeer, listener: Server | undefined;
const logins = async () => (await readFile(path.join(root, "logins"), "utf8").catch(() => "")).length;
const mode = (value: "ok" | "off" | "hang" | "404") => writeFile(path.join(root, "mode"), value);
const listen = (port: number) => new Promise<Server>((resolve, reject) => {
  const server = createServer(socket => socket.destroy());
  server.once("error", reject).listen(port, "127.0.0.1", () => resolve(server));
});
const close = async () => { if (listener) await new Promise(resolve => listener!.close(resolve)); listener = undefined; };
const failure = (read: Promise<unknown>) => read.then(() => undefined, (error: { status?: number; details?: { code?: string } }) => ({ status: error.status, code: error.details?.code }));

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "phren-peer-reads-"));
  await mkdir(path.join(root, "bin"));
  await writeFile(path.join(root, "bin", "ssh"), FAKE_SSH); await chmod(path.join(root, "bin", "ssh"), 0o700);
  await writeFile(path.join(root, "id_ed25519_dispatch"), "fixture", { mode: 0o600 });
  vi.stubEnv("PHREN_BRIDGE_HOME", root); vi.stubEnv("PATH", `${path.join(root, "bin")}:${process.env.PATH}`);
  // A port of this test's own, closed until the test opens it.
  listener = await listen(0);
  const port = (listener.address() as { port: number }).port;
  await close();
  peer = { name: "remote", address: "127.0.0.1", username: "owner", port, server: "default", hostKey: "ssh-ed25519 fixture" };
});
afterEach(async () => {
  vi.useRealTimers(); vi.unstubAllEnvs(); refreshPeerReads(); await close();
  await rm(root, { recursive: true, force: true });
});

const skipOnWindows = it.skipIf(process.platform === "win32");

skipOnWindows("answers for a peer that is off from memory, checks again after a doubling wait, and dials once it is back", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  await mode("off");
  expect(await failure(peerRead(peer, "/v1/health"))).toEqual({ status: 503, code: "peer-offline" });
  expect(await logins()).toBe(1);
  // Inside the wait: the same answer, no login.
  expect(await failure(peerRead(peer, "/v1/health"))).toEqual({ status: 503, code: "peer-offline" });
  expect(await failure(peerRead(peer, "/v1/conductor"))).toEqual({ status: 503, code: "peer-offline" });
  expect(await logins()).toBe(1);
  // The wait is over and its SSH port is still closed: no login, and the next wait is twice as long.
  vi.setSystemTime(Date.now() + PEER_RETRY_FIRST_MS + 100);
  expect(await failure(peerRead(peer, "/v1/health"))).toEqual({ status: 503, code: "peer-offline" });
  await mode("ok"); listener = await listen(peer.port);
  vi.setSystemTime(Date.now() + PEER_RETRY_FIRST_MS + 100);
  expect(await failure(peerRead(peer, "/v1/health"))).toEqual({ status: 503, code: "peer-offline" });
  expect(await logins()).toBe(1);
  // The doubled wait is over and the port answers: the read dials.
  vi.setSystemTime(Date.now() + PEER_RETRY_FIRST_MS);
  expect(await peerRead(peer, "/v1/health")).toMatchObject({ ok: true });
  expect(await logins()).toBe(2);
});

skipOnWindows("still dials a peer remembered as off for peerRequest and for a refresh, and an answer clears the memory", async () => {
  await mode("off");
  await failure(peerRead(peer, "/v1/health"));
  expect(await failure(peerRequest(peer, "/v1/health"))).toEqual({ status: 503, code: "peer-offline" });
  expect(await logins()).toBe(2);
  refreshPeerReads();
  await failure(peerRead(peer, "/v1/health"));
  expect(await logins()).toBe(3);
  await mode("ok");
  expect(await peerRequest(peer, "/v1/prompt", { text: "go" })).toMatchObject({ ok: true });
  // No wait left: the next read dials at once.
  expect(await peerRead(peer, "/v1/health")).toMatchObject({ ok: true });
  expect(await logins()).toBe(5);
});

skipOnWindows("shares one login among reads of a route, reuses an answer only for a read that allows it", async () => {
  await mode("ok");
  const answers = await Promise.all([1, 2, 3, 4].map(() => peerRead(peer, "/v1/health", { ttl: 60_000 })));
  expect(answers).toEqual([{ ok: true, at: 1 }, { ok: true, at: 1 }, { ok: true, at: 1 }, { ok: true, at: 1 }]);
  expect(await logins()).toBe(1);
  // Another route is another login; the kept answer serves a read with a ttl and not one without.
  await peerRead(peer, "/v1/conductor", { ttl: 60_000 });
  expect(await peerRead(peer, "/v1/health", { ttl: 60_000 })).toEqual({ ok: true, at: 1 });
  expect(await logins()).toBe(2);
  expect(await peerRead(peer, "/v1/health")).toEqual({ ok: true, at: 3 });
  refreshPeerReads();
  expect(await peerRead(peer, "/v1/conductor", { ttl: 60_000 })).toEqual({ ok: true, at: 4 });
  // An error from the peer's Hook is kept only when the read says so, and does not mark the peer off.
  await mode("404");
  expect(await failure(peerRead(peer, "/v1/computers", { failTtl: 60_000 }))).toEqual({ status: 404, code: undefined });
  expect(await failure(peerRead(peer, "/v1/computers", { failTtl: 60_000 }))).toEqual({ status: 404, code: undefined });
  expect(await logins()).toBe(5);
  expect(await failure(peerRead(peer, "/v1/computers"))).toEqual({ status: 404, code: undefined });
  expect(await logins()).toBe(6);
});

skipOnWindows("marks a peer off after a timeout only when its SSH port does not answer", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  await mode("hang");
  const timedOutRead = async (started: number) => {
    // Freeze the deadline until the fake SSH has actually started. A loaded
    // runner can take longer to start Node than the old 200 ms timeout.
    const read = failure(peerRead(peer, "/v1/usage", { timeout: 60_000 }));
    await vi.waitFor(async () => expect(await logins()).toBe(started), { timeout: 10_000 });
    await vi.advanceTimersToNextTimerAsync();
    const error = await read;
    // The timeout starts a real TCP check in the background. Its timer is
    // cleared when the socket answers or refuses, before the next read.
    await vi.waitUntil(() => vi.getTimerCount() === 0);
    return error;
  };
  // Port open: a slow Hook. Every read dials.
  listener = await listen(peer.port);
  expect(await timedOutRead(1)).toEqual({ status: 504, code: "peer-timeout" });
  expect(await timedOutRead(2)).toEqual({ status: 504, code: "peer-timeout" });
  expect(await logins()).toBe(2);
  // Port closed: the peer is off, and the next read says so without a login.
  await close();
  expect(await timedOutRead(3)).toEqual({ status: 504, code: "peer-timeout" });
  expect(await failure(peerRead(peer, "/v1/health", { timeout: 200 }))).toEqual({ status: 503, code: "peer-offline" });
  expect(await logins()).toBe(3);
});
