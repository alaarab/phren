import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_MODULES } from "../modules/registry.js";
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
