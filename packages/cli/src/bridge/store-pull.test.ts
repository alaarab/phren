import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerStoreIdentity } from "../store-registry.js";
import { ImmediatePulls } from "../sync/pull-now.js";
import { admitPeerRequest, admitScopedRequest } from "./scoped-gateway.js";
import { createRouteHandler, type RouteContext } from "./server-routes.js";
import { StorePulls } from "./store-pull.js";

let root: string;
let id: string;
let pulls: StorePulls;
const pull = vi.fn(async () => ({ status: "unchanged" as const, detail: "done" }));
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "store-pull-"));
  id = registerStoreIdentity(root); tracking(root);
  pulls = new StorePulls(root, new ImmediatePulls(pull));
});
afterEach(async () => { pulls.stop(); vi.useRealTimers(); vi.clearAllMocks(); await rm(root, { recursive: true, force: true }); });
async function route(headers: Record<string, string>, data: Record<string, unknown>) {
  const handler = createRouteHandler({ storePulls: pulls, modules: { has: () => true }, info: {}, streams: {} } as unknown as RouteContext);
  const req = Readable.from([Buffer.from(JSON.stringify(data))]) as IncomingMessage;
  req.method = "POST"; req.url = "/v1/store/pull-now"; req.headers = headers;
  let payload = "";
  const res = { statusCode: 200, setHeader() {}, end(value: string) { payload = value; } };
  await handler(req, res as unknown as ServerResponse);
  return { status: res.statusCode, body: JSON.parse(payload) };
}
it.each(["peer", "owner"])("admits %s pulls and coalesces repeated route requests", async origin => {
  vi.useFakeTimers();
  const headers = origin === "peer" ? { "x-phren-origin": "peer" } : {};
  expect(await route(headers, { storeId: id, repository: "alice/memory", branch: "main" })).toMatchObject({ status: 200, body: { ok: true } });
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 5; i++) await route(headers, { storeId: id, repository: "alice/memory", branch: "main" });
  await vi.advanceTimersByTimeAsync(9999); expect(pull).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(pull).toHaveBeenCalledTimes(2);
  expect(pull).toHaveBeenCalledWith(root);
});
it("refuses workers before store lookup and hides unknown store details", async () => {
  expect(await route({}, { storeId: id, origin: "agent" })).toMatchObject({ status: 403 });
  expect(await route({ "x-phren-origin": "agent" }, { storeId: id, repository: "alice/memory", branch: "main" })).toMatchObject({ status: 403 });
  expect(await route({ "x-phren-origin": "peer" }, { storeId: "absent", repository: "alice/memory", branch: "main" })).toMatchObject({ status: 404, body: { error: "Not found." } });
  expect(pull).not.toHaveBeenCalled();
});
it("peer SSH gateway admits pull-now and rebuilds origin; scoped keys refuse it", () => {
  const body = JSON.stringify({ storeId: id, repository: "alice/memory", branch: "main" });
  const head = `POST /v1/store/pull-now HTTP/1.1\r\nHost: phren.local\r\nX-Phren-Origin: owner\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
  const result = admitPeerRequest(head, Buffer.from(body));
  expect(result.ok).toBe(true);
  if (result.ok) { expect(result.request).toContain("X-Phren-Origin: peer\r\n"); expect(result.request).not.toContain("X-Phren-Origin: owner"); }
  for (const scope of ["gitboy-read", "gitboy-write"] as const) expect(admitScopedRequest(scope, head, Buffer.from(body))).toMatchObject({ ok: false, status: 403 });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
}
function tracking(store: string, url = "git@gitboy.example:Alice/Memory.git") {
  git(store, "init", "--initial-branch=main");
  git(store, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "initial");
  git(store, "remote", "add", "cloud", url);
  git(store, "config", "branch.main.remote", "cloud"); git(store, "config", "branch.main.merge", "refs/heads/main");
}
it("uses this computer's primary path even when the synced path exists elsewhere", async () => {
  const elsewhere = path.join(root, "elsewhere"); await mkdir(elsewhere);
  await writeFile(path.join(root, "stores.yaml"), JSON.stringify({ version: 1, stores: [{ id, name: "default", role: "primary", sync: "managed-git", path: elsewhere }] }));
  pulls.request(id);
  await vi.waitFor(() => expect(pull).toHaveBeenCalledWith(root));
  expect(pull).not.toHaveBeenCalledWith(elsewhere);
});
it("resolves a portable store identity across different local attachment ids", async () => {
  const attached = path.join(root, "attached"); await mkdir(attached);
  const portable = registerStoreIdentity(attached); tracking(attached);
  await mkdir(path.join(root, ".runtime"), { recursive: true });
  await writeFile(path.join(root, ".runtime", "attached-stores.yaml"), JSON.stringify({ version: 1, stores: [{ id: "aabbccdd", name: "team", path: attached, role: "team", sync: "managed-git" }] }));
  expect(pulls.request("aabbccdd")).toBe(portable);
  expect(await route({ "x-phren-origin": "peer" }, { storeId: portable, repository: "alice/memory", branch: "main" })).toMatchObject({ status: 200 });
  await vi.waitFor(() => expect(pull).toHaveBeenCalledWith(attached));
  expect(await route({ "x-phren-origin": "peer" }, { storeId: portable, repository: "other/memory", branch: "main" })).toMatchObject({ status: 404 });
  expect(await route({ "x-phren-origin": "peer" }, { storeId: portable, repository: "alice/memory", branch: "other" })).toMatchObject({ status: 404 });
});
