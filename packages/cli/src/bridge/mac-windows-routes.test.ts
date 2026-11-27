import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_MODULES } from "../modules/registry.js";
import { OWNER_PROOF_HEADER } from "./owner-proof.js";
import { resetMacWindowsState, setMacWindowsDeps, setMacWindowsEnabled } from "./mac-windows.js";
import type { Json } from "./protocol.js";

/** The real route handler: every Mac window route is owner-only, peer or MCP origin or not. */

const { capabilitiesForModules, createRouteHandler } = await import("./server-routes.js");

const modules = { has: () => true, modules: BUILTIN_MODULES };
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "phren-mac-windows-routes-"));
  vi.stubEnv("PHREN_BRIDGE_HOME", root);
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

/** A paired-phone key and the signed envelope the Hook verifies. */
const phone = generateKeyPairSync("ed25519");
const phoneRaw = phone.publicKey.export({ format: "der", type: "spki" }).subarray(12);
const PHONE_WIRE = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), phoneRaw]);
const AUTHORIZED_KEYS = `restrict,pty,command="sh ~/.local/share/phren/bridge/dispatch" ssh-ed25519 ${PHONE_WIRE.toString("base64")} phren-iphone\n`;
function proofHeader(method: string, pathname: string, body: string): string {
  const payload = Buffer.from(JSON.stringify({
    domain: "phren-owner-request-v1", nonce: randomUUID(), at: new Date().toISOString(),
    method, path: pathname, body: createHash("sha256").update(body).digest("hex"),
  }));
  return Buffer.from(JSON.stringify({ payload: payload.toString("base64"), signature: sign(null, payload, phone.privateKey).toString("base64"),
    publicKey: phoneRaw.toString("base64") })).toString("base64url");
}

async function request(method: string, url: string, body?: Json, headers: Record<string, string> = {}): Promise<{ status: number; body: Json }> {
  const handler = createRouteHandler({ modules, info: { computer: { id: "00000000-0000-4000-8000-0000000000aa", name: "self" }, capabilities: capabilitiesForModules(modules as never) },
    accountUsage: { read: async () => ({ accounts: [] }) }, streams: {} } as never);
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []) as IncomingMessage;
  req.method = method; req.url = url; req.headers = headers;
  let payload = "";
  const res = { statusCode: 200, setHeader() {}, end(value: string) { payload = value; } };
  await handler(req, res as unknown as ServerResponse);
  return { status: res.statusCode, body: payload ? JSON.parse(payload) as Json : {} };
}

describe("mac window routes refuse agents and peers", () => {
  const cases: { method: string; url: string; body?: Json; headers: Record<string, string> }[] = [
    { method: "GET", url: "/v1/mac/windows", headers: { "x-phren-origin": "peer" } },
    { method: "GET", url: "/v1/mac/windows", headers: { "x-phren-origin": "agent" } },
    { method: "GET", url: "/v1/mac/windows/snapshot?id=7", headers: { "x-phren-origin": "peer" } },
    { method: "GET", url: "/v1/mac/windows/snapshot?id=7", headers: { "x-phren-origin": "agent" } },
    { method: "POST", url: "/v1/mac/windows/action", body: { id: 7, action: "raise" }, headers: { "x-phren-origin": "peer" } },
    { method: "POST", url: "/v1/mac/windows/action", body: { id: 7, action: "raise", origin: { pane: "1" } }, headers: {} },
    { method: "POST", url: "/v1/mac/windows/permissions", body: { permission: "accessibility" }, headers: { "x-phren-origin": "peer" } },
    { method: "POST", url: "/v1/mac/windows/permissions", body: { permission: "accessibility", origin: { pane: "1" } }, headers: {} },
  ];
  it.each(cases)("$method $url with $headers", async ({ method, url, body, headers }) => {
    const answer = await request(method, url, body, headers);
    expect(answer.status).toBe(403);
    expect(answer.body).toMatchObject({ code: "mac-windows-owner-only" });
  });
});

describe("signed Mac window requests", () => {
  let home: string;
  const restores: (() => void)[] = [];
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "phren-mac-windows-home-"));
    vi.stubEnv("HOME", home);
    await mkdir(path.join(home, ".ssh"), { recursive: true });
    await writeFile(path.join(home, ".ssh", "authorized_keys"), AUTHORIZED_KEYS);
    resetMacWindowsState();
    restores.push(setMacWindowsDeps({
      platform: () => "darwin",
      release: () => "23.6.0",
      pollMs: () => 3_600_000,
      run: async () => ({ stdout: Buffer.alloc(0), stderr: "", code: 0 }),
      spawnBadge: async () => ({ ready: Promise.resolve(), kill() {}, onExit() {} }),
    }));
  });
  afterEach(async () => {
    while (restores.length) restores.pop()?.();
    resetMacWindowsState();
    await rm(home, { recursive: true, force: true });
  });

  it("accepts a correctly signed GET and refuses an unsigned one", async () => {
    const unsigned = await request("GET", "/v1/mac/windows");
    expect(unsigned.status).toBe(403);
    expect(unsigned.body).toMatchObject({ code: "owner-proof-required" });
    const signed = await request("GET", "/v1/mac/windows", undefined, { [OWNER_PROOF_HEADER]: proofHeader("GET", "/v1/mac/windows", "") });
    expect(signed.status).toBe(200);
    expect(signed.body).toMatchObject({ enabled: false, windows: [] });
  });

  it("refuses the action with 503 when the admission row cannot be written", async () => {
    await setMacWindowsEnabled(true);
    await writeFile(path.join(root, "mac-windows"), "not a folder");
    const body = { id: 7, action: "raise" };
    const answer = await request("POST", "/v1/mac/windows/action", body,
      { [OWNER_PROOF_HEADER]: proofHeader("POST", "/v1/mac/windows/action", JSON.stringify(body)) });
    expect(answer.status).toBe(503);
    expect(answer.body).toMatchObject({ code: "mac-windows-audit" });
  });

  it("keeps success when the completion row cannot be written after the input ran", async () => {
    await setMacWindowsEnabled(true);
    // The helper breaks the log folder between the admission row and the completion row.
    restores.push(setMacWindowsDeps({ run: async call => {
      if (call.args[0] === "raise") {
        await rm(path.join(root, "mac-windows"), { recursive: true, force: true });
        await writeFile(path.join(root, "mac-windows"), "");
      }
      return { stdout: Buffer.alloc(0), stderr: "", code: 0 };
    } }));
    const body = { id: 7, action: "raise" };
    const answer = await request("POST", "/v1/mac/windows/action", body,
      { [OWNER_PROOF_HEADER]: proofHeader("POST", "/v1/mac/windows/action", JSON.stringify(body)) });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ ok: true });
  });
});
