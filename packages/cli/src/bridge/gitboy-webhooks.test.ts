import { createHmac } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GitboyWebhooks } from "./gitboy-webhooks.js";

let root: string;
let receiver: GitboyWebhooks;
let port: number;
const pull = vi.fn(() => true);
const transport = vi.hoisted(() => ({ send: vi.fn(async () => ({})) }));
vi.mock("./peers.js", () => ({
  optionalHookPeers: async () => ({ peers: [{ name: "peer-a" }, { name: "peer-b" }] }),
  peerRequest: transport.send,
}));
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "gitboy-webhooks-"));
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  receiver = new GitboyWebhooks(root, pull);
});
afterEach(async () => { receiver.stop(); vi.clearAllMocks(); await rm(root, { recursive: true, force: true }); });
const stores = [{ storeId: "1234abcd", owner: "alice", name: "memory", branch: "main", secret: "private-secret" }];
async function configure(entries = stores) {
  await writeFile(path.join(root, "gitboy-webhooks.json"), JSON.stringify({ listenPort: port, stores: entries }), { mode: 0o600 });
  await receiver.start();
  expect(receiver.status).toMatchObject({ configured: true, listening: true, listenPort: port });
}
function push(repo = "alice/memory", branch = "main") {
  return Buffer.from(JSON.stringify({ repository: { full_name: repo }, updates: [{ ref: `refs/heads/${branch}`, old: "a".repeat(40), new: "b".repeat(40) }] }));
}
function send(body: Buffer, signature: string | null = sign(body), delivery = "delivery-1", url = "/gitboy/push", method = "POST"): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: url, method, headers: {
      "Content-Length": body.length, "X-Gitboy-Event": "push", "X-Gitboy-Delivery": delivery,
      ...(signature === null ? {} : { "X-Hub-Signature-256": signature }),
    } }, res => { res.resume(); res.once("end", () => resolve(res.statusCode!)); });
    req.on("error", reject);
    // An oversized declared length is refused before the server reads bytes.
    if (body.length > 1024 * 1024) req.flushHeaders();
    else req.end(body);
  });
}
function sign(body: Buffer, secret = "private-secret") { return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`; }

it("opens nothing without private config and refuses unsafe config without leaking it", async () => {
  await receiver.start();
  expect(receiver.status).toEqual({ configured: false, listening: false });
  await expect(send(push())).rejects.toMatchObject({ code: "ECONNREFUSED" });
  await writeFile(path.join(root, "gitboy-webhooks.json"), JSON.stringify({ listenPort: port, stores }), { mode: 0o600 });
  await chmod(path.join(root, "gitboy-webhooks.json"), 0o644);
  await receiver.start();
  expect(receiver.status).toMatchObject({ configured: true, listening: false, problem: expect.any(String) });
  expect(JSON.stringify(receiver.status)).not.toContain("private-secret");
});

it("accepts a signed push quickly, pulls once, deduplicates retries and nudges peers", async () => {
  await configure();
  let release!: () => void;
  transport.send.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  expect(await send(push())).toBe(202);
  await vi.waitFor(() => expect(transport.send).toHaveBeenCalledWith({ name: "peer-b" }, "/v1/store/pull-now", { storeId: "1234abcd" }, 15_000));
  expect(pull).toHaveBeenCalledExactlyOnceWith("1234abcd");
  expect(transport.send).toHaveBeenCalledTimes(2);
  expect(await send(push())).toBe(200);
  expect(pull).toHaveBeenCalledTimes(1);
  expect(receiver.status).toMatchObject({ lastOutcome: "duplicate", lastDeliveryAt: expect.any(String) });
  release();
});

it.each(["bad", "missing"])("refuses %s signatures without pulling or consuming the delivery id", async kind => {
  await configure();
  // Explicitly use an absent header (send's default is the valid signature).
  const signature = kind === "bad" ? sign(push(), "wrong-secret") : null;
  expect(await send(push(), signature)).toBe(401);
  expect(pull).not.toHaveBeenCalled();
  expect(transport.send).not.toHaveBeenCalled();
  expect(await send(push())).toBe(202);
});

it("returns 404 for unknown repositories and 200 for a non-matching branch", async () => {
  await configure();
  expect(await send(push("other/memory"))).toBe(404);
  expect(await send(push("alice/memory", "other"))).toBe(200);
  expect(receiver.status.lastOutcome).toBe("non-matching");
  expect(pull).not.toHaveBeenCalled(); expect(transport.send).not.toHaveBeenCalled();
});

it("checks all secrets for a shared repository and pulls only verified matching stores", async () => {
  await configure([...stores, { ...stores[0], storeId: "abcd1234", secret: "other-secret" }]);
  expect(await send(push(), sign(push(), "other-secret"))).toBe(202);
  await vi.waitFor(() => expect(pull).toHaveBeenCalledExactlyOnceWith("abcd1234"));
});

it("rejects malformed, oversized and wrong-route requests", async () => {
  await configure();
  expect(await send(Buffer.from("{"))).toBe(400);
  expect(await send(Buffer.alloc(1024 * 1024 + 1))).toBe(413);
  expect(await send(push(), sign(push()), "d", "/elsewhere")).toBe(404);
  expect(await send(push(), sign(push()), "d", "/gitboy/push", "GET")).toBe(404);
  expect(pull).not.toHaveBeenCalled();
});

const externalAddress = Object.values(networkInterfaces()).flat().find(info => info?.family === "IPv4" && !info.internal)?.address;
it.skipIf(!externalAddress)("binds loopback only, leaving the port available on the computer's LAN address", async () => {
  await configure();
  const other = createServer();
  await new Promise<void>((resolve, reject) => { other.once("error", reject); other.listen(port, externalAddress!, resolve); });
  await new Promise<void>(resolve => other.close(() => resolve()));
});

it("loads a private secret file relative to the bridge directory", async () => {
  await writeFile(path.join(root, "memory.secret"), "file-secret\n", { mode: 0o600 });
  const { secret: _secret, ...store } = stores[0];
  await writeFile(path.join(root, "gitboy-webhooks.json"), JSON.stringify({ listenPort: port, stores: [{ ...store, secretFile: "memory.secret" }] }), { mode: 0o600 });
  await receiver.start();
  expect(await send(push(), sign(push(), "file-secret"))).toBe(202);
  await vi.waitFor(() => expect(pull).toHaveBeenCalledWith("1234abcd"));
});

it("ends a stalled body read after the short deadline", async () => {
  await configure();
  const status = await new Promise<number>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/gitboy/push", method: "POST", headers: { "Content-Length": 100 } }, res => {
      res.resume(); res.once("end", () => resolve(res.statusCode!));
    });
    req.on("error", reject); req.write("{");
  });
  expect(status).toBe(408); expect(pull).not.toHaveBeenCalled();
});
