import { request as httpRequest, type IncomingMessage } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { HookRequest, HookWebSocket, MergedOverview, OverviewHub } from "./contract.js";
import { startServer, writeAllowed } from "./server.js";

const TOKEN = "fixed-test-token";

function fakeReq(method: string, headers: Record<string, string>): IncomingMessage {
  return { method, headers } as unknown as IncomingMessage;
}

interface RawResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** node:http, because fetch overwrites Host. */
function rawRequest(opts: {
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<RawResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port: opts.port, path: opts.path, method: opts.method ?? "GET", headers: opts.headers },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

interface Harness {
  port: number;
  calls: Array<{ method: string; path: string; body: unknown }>;
  close(): Promise<void>;
}

const running: Harness[] = [];

async function startHarness(): Promise<Harness> {
  const calls: Harness["calls"] = [];
  const hookRequest: HookRequest = async (_c, method, path, body) => {
    calls.push({ method, path, body });
    return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from("{}") };
  };
  const hookWebSocket: HookWebSocket = async () => {
    throw new Error("hook websocket unavailable");
  };
  const hub: OverviewHub = {
    start() {},
    stop() {},
    current: (): MergedOverview => ({ computers: [] }),
    on() {},
  };
  const server = await startServer({
    port: 0,
    token: TOKEN,
    computers: [{ name: "This computer", local: true, server: "default" }],
    hub,
    hookRequest,
    hookWebSocket,
    attachTerminal: () => {
      throw new Error("no terminal in tests");
    },
  });
  const harness: Harness = { port: Number(new URL(server.url).port), calls, close: server.close };
  running.push(harness);
  return harness;
}

function cookieHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Cookie: `phren_desktop=${TOKEN}`, ...extra };
}

afterEach(async () => {
  while (running.length) await running.pop()!.close();
});

describe("server host and auth", () => {
  it("rejects a foreign Host with 421 and serves a loopback Host", async () => {
    const h = await startHarness();
    const bad = await rawRequest({
      port: h.port,
      path: "/api/computers",
      headers: { Host: "evil.example", Cookie: `phren_desktop=${TOKEN}` },
    });
    expect(bad.status).toBe(421);

    const good = await fetch(`http://127.0.0.1:${h.port}/api/computers`, { headers: cookieHeaders() });
    expect(good.status).toBe(200);
  });

  it("sets the session cookie only on localhost, never on 127.0.0.1 where previews live", async () => {
    const h = await startHarness();
    const viaIp = await rawRequest({ port: h.port, path: `/?token=${TOKEN}`, headers: { Host: `127.0.0.1:${h.port}` } });
    expect(viaIp.status).toBe(302);
    expect(viaIp.headers["set-cookie"]).toBeUndefined();
    expect(viaIp.headers.location).toBe(`http://localhost:${h.port}/?token=${TOKEN}`);
    const viaName = await rawRequest({ port: h.port, path: `/?token=${TOKEN}`, headers: { Host: `localhost:${h.port}` } });
    expect(String(viaName.headers["set-cookie"])).toContain("phren_desktop=");
  });

  it("refuses a cross-origin text/plain POST before it reaches the Hook", async () => {
    const h = await startHarness();
    const res = await fetch(`http://127.0.0.1:${h.port}/hosts/This%20computer/v1/prompt`, {
      method: "POST",
      headers: cookieHeaders({ "Content-Type": "text/plain" }),
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(h.calls).toHaveLength(0);
  });

  it("requires the X-Phren-Desktop header", async () => {
    const h = await startHarness();
    const res = await fetch(`http://127.0.0.1:${h.port}/hosts/This%20computer/v1/prompt`, {
      method: "POST",
      headers: cookieHeaders({ "Content-Type": "application/json" }),
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(h.calls).toHaveLength(0);
  });

  it("refuses a foreign Origin", async () => {
    const h = await startHarness();
    const res = await fetch(`http://127.0.0.1:${h.port}/hosts/This%20computer/v1/prompt`, {
      method: "POST",
      headers: cookieHeaders({
        "Content-Type": "application/json",
        "X-Phren-Desktop": "1",
        Origin: "http://localhost:3000",
      }),
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(h.calls).toHaveLength(0);
  });

  it("allows an app-origin JSON write and proxies it once", async () => {
    const h = await startHarness();
    const res = await fetch(`http://127.0.0.1:${h.port}/hosts/This%20computer/v1/prompt`, {
      method: "POST",
      headers: cookieHeaders({
        "Content-Type": "application/json",
        "X-Phren-Desktop": "1",
        Origin: `http://localhost:${h.port}`,
      }),
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(200);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].path).toBe("/v1/prompt");
  });

  it("echoes a public-route Origin only when it matches", async () => {
    const h = await startHarness();
    const matching = await fetch(`http://127.0.0.1:${h.port}/editor-host/x`, {
      headers: { Origin: `http://abc.localhost:${h.port}` },
    });
    expect(matching.headers.get("access-control-allow-origin")).toBe(`http://abc.localhost:${h.port}`);
    expect(matching.headers.get("vary")).toContain("Origin");

    const foreign = await fetch(`http://127.0.0.1:${h.port}/editor-host/x`, {
      headers: { Origin: "http://evil.example" },
    });
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("writeAllowed", () => {
  const port = 5000;
  const json = { "content-type": "application/json", "x-phren-desktop": "1" };

  it("allows GET and HEAD", () => {
    expect(writeAllowed(fakeReq("GET", {}), port)).toBe(true);
    expect(writeAllowed(fakeReq("HEAD", {}), port)).toBe(true);
  });

  it("accepts Sec-Fetch-Site same-origin and rejects cross-site", () => {
    expect(writeAllowed(fakeReq("POST", { ...json, "sec-fetch-site": "same-origin" }), port)).toBe(true);
    expect(writeAllowed(fakeReq("POST", { ...json, "sec-fetch-site": "cross-site" }), port)).toBe(false);
  });

  it("accepts a matching Origin and refuses when both hints are absent", () => {
    expect(writeAllowed(fakeReq("POST", { ...json, origin: `http://localhost:${port}` }), port)).toBe(true);
    expect(writeAllowed(fakeReq("POST", { ...json, origin: `http://127.0.0.1:${port}` }), port)).toBe(true);
    expect(writeAllowed(fakeReq("POST", { ...json }), port)).toBe(false);
  });

  it("requires JSON Content-Type and the desktop header", () => {
    expect(writeAllowed(fakeReq("POST", { "content-type": "text/plain", "x-phren-desktop": "1", origin: `http://localhost:${port}` }), port)).toBe(false);
    expect(writeAllowed(fakeReq("POST", { "content-type": "application/json", origin: `http://localhost:${port}` }), port)).toBe(false);
  });

  it("allows a bodyless DELETE without a Content-Type", () => {
    expect(writeAllowed(fakeReq("DELETE", { "x-phren-desktop": "1", origin: `http://localhost:${port}` }), port)).toBe(true);
    expect(writeAllowed(fakeReq("DELETE", { "content-type": "text/plain", "x-phren-desktop": "1", origin: `http://localhost:${port}` }), port)).toBe(false);
  });
});
