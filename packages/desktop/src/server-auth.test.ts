import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
      {
        host: "127.0.0.1",
        port: opts.port,
        path: opts.path,
        method: opts.method ?? "GET",
        // Node does not chunk DELETE bodies, so frame every body explicitly.
        headers: opts.body === undefined ? opts.headers : { ...opts.headers, "Content-Length": String(Buffer.byteLength(opts.body)) },
      },
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

async function startHarness(track = true, proxy?: HookRequest): Promise<Harness> {
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
    hookRequest: proxy ?? hookRequest,
    hookWebSocket,
    attachTerminal: () => {
      throw new Error("no terminal in tests");
    },
  });
  const harness: Harness = { port: Number(new URL(server.url).port), calls, close: server.close };
  if (track) running.push(harness);
  return harness;
}

function cookieHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Cookie: `phren_desktop=${TOKEN}`, ...extra };
}

/** A raw WebSocket upgrade; resolves 101 on accept, else the refusal status. */
function rawUpgrade(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      path,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        ...headers,
      },
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
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

// The full auth matrix: Host (DNS rebinding) is checked first, then the token
// cookie, then the write gate (desktop header plus a same-origin hint). The
// WebSocket upgrade checks Host, then Origin, then the token.
describe("auth matrix", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness(false);
  });
  afterAll(async () => {
    await h.close();
  });

  type Token = "valid" | "absent" | "wrong";
  type HostKind = "localhost" | "loopback-ip" | "foreign" | "rebound" | "other-port" | "subdomain";
  type OriginKind = "same" | "same-ip" | "foreign" | "absent" | "preview" | "null";

  const tokens: Token[] = ["valid", "absent", "wrong"];
  const hosts: HostKind[] = ["localhost", "loopback-ip", "foreign", "rebound", "other-port", "subdomain"];
  const origins: OriginKind[] = ["same", "same-ip", "foreign", "absent", "preview", "null"];
  const goodHost = (host: HostKind) => host === "localhost" || host === "loopback-ip";
  const sameOrigin = (origin: OriginKind) => origin === "same" || origin === "same-ip";

  const hostHeader = (host: HostKind, port: number): string =>
    ({
      localhost: `localhost:${port}`,
      "loopback-ip": `127.0.0.1:${port}`,
      foreign: `evil.example:${port}`,
      // A rebinding attacker's name resolves to 127.0.0.1 but still names itself.
      rebound: `rebind.evil.example:${port}`,
      "other-port": `localhost:${port + 1}`,
      subdomain: `abc.localhost:${port}`,
    })[host];

  const originHeader = (origin: OriginKind, port: number): string | undefined =>
    ({
      same: `http://localhost:${port}`,
      "same-ip": `http://127.0.0.1:${port}`,
      foreign: "http://evil.example",
      absent: undefined,
      // A web preview relay on another 127.0.0.1 port is a different origin.
      preview: `http://127.0.0.1:${port + 1}`,
      null: "null",
    })[origin];

  const headersFor = (token: Token, host: HostKind, origin: OriginKind, port: number): Record<string, string> => {
    const headers: Record<string, string> = { Host: hostHeader(host, port) };
    if (token === "valid") headers.Cookie = `phren_desktop=${TOKEN}`;
    if (token === "wrong") headers.Cookie = "phren_desktop=not-the-token";
    const value = originHeader(origin, port);
    if (value !== undefined) headers.Origin = value;
    return headers;
  };

  const httpExpected = (method: "GET" | "POST", token: Token, host: HostKind, origin: OriginKind): number => {
    if (!goodHost(host)) return 421;
    if (token !== "valid") return 401;
    if (method === "GET") return 200;
    return sameOrigin(origin) ? 200 : 403;
  };

  const wsExpected = (token: Token, host: HostKind, origin: OriginKind): number => {
    if (!goodHost(host)) return 421;
    if (!sameOrigin(origin)) return 403;
    if (token !== "valid") return 401;
    return 101;
  };

  const httpCases = (["GET", "POST"] as const).flatMap((method) =>
    tokens.flatMap((token) => hosts.flatMap((host) => origins.map((origin) => ({ method, token, host, origin })))),
  );

  it.each(httpCases)("$method token=$token host=$host origin=$origin", async ({ method, token, host, origin }) => {
    const before = h.calls.length;
    const headers = headersFor(token, host, origin, h.port);
    if (method === "POST") Object.assign(headers, { "Content-Type": "application/json", "X-Phren-Desktop": "1" });
    const res = await rawRequest({
      port: h.port,
      path: "/hosts/This%20computer/v1/prompt",
      method,
      headers,
      body: method === "POST" ? JSON.stringify({ text: "hi" }) : undefined,
    });
    const expected = httpExpected(method, token, host, origin);
    expect(res.status).toBe(expected);
    // Nothing refused may reach the Hook; anything allowed reaches it once.
    expect(h.calls.length - before).toBe(expected === 200 ? 1 : 0);
  });

  const wsCases = tokens.flatMap((token) => hosts.flatMap((host) => origins.map((origin) => ({ token, host, origin }))));

  it.each(wsCases)("WebSocket token=$token host=$host origin=$origin", async ({ token, host, origin }) => {
    const status = await rawUpgrade(h.port, "/api/overview", headersFor(token, host, origin, h.port));
    expect(status).toBe(wsExpected(token, host, origin));
  });

  it("refuses a same-origin write without the desktop header", async () => {
    const res = await rawRequest({
      port: h.port,
      path: "/hosts/This%20computer/v1/prompt",
      method: "POST",
      headers: { ...headersFor("valid", "localhost", "same", h.port), "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });

  it("accepts Sec-Fetch-Site same-origin in place of an Origin and refuses cross-site", async () => {
    const base = { ...headersFor("valid", "localhost", "absent", h.port), "Content-Type": "application/json", "X-Phren-Desktop": "1" };
    const path = "/hosts/This%20computer/v1/prompt";
    const same = await rawRequest({ port: h.port, path, method: "POST", headers: { ...base, "Sec-Fetch-Site": "same-origin" }, body: "{}" });
    expect(same.status).toBe(200);
    const cross = await rawRequest({ port: h.port, path, method: "POST", headers: { ...base, "Sec-Fetch-Site": "cross-site" }, body: "{}" });
    expect(cross.status).toBe(403);
  });

  it.each(["PUT", "PATCH", "DELETE"])("gates %s like POST", async (method) => {
    const before = h.calls.length;
    const path = "/hosts/This%20computer/v1/prompt";
    const json = { "Content-Type": "application/json", "X-Phren-Desktop": "1" };
    const foreign = await rawRequest({ port: h.port, path, method, headers: { ...headersFor("valid", "localhost", "foreign", h.port), ...json }, body: "{}" });
    expect(foreign.status).toBe(403);
    const noHeader = await rawRequest({
      port: h.port,
      path,
      method,
      headers: { ...headersFor("valid", "localhost", "same", h.port), "Content-Type": "application/json" },
      body: "{}",
    });
    expect(noHeader.status).toBe(403);
    expect(h.calls.length).toBe(before);
    const allowed = await rawRequest({ port: h.port, path, method, headers: { ...headersFor("valid", "localhost", "same", h.port), ...json }, body: "{}" });
    expect(allowed.status).toBe(200);
    expect(h.calls.length).toBe(before + 1);
  });

  it("trades a valid query token for a cookie redirect and never authenticates with it", async () => {
    const path = "/hosts/This%20computer/v1/prompt";
    const good = await rawRequest({ port: h.port, path: `${path}?token=${TOKEN}`, headers: { Host: `localhost:${h.port}` } });
    expect(good.status).toBe(302);
    expect(good.headers.location).toBe("/");
    const wrong = await rawRequest({ port: h.port, path: `${path}?token=nope`, headers: { Host: `localhost:${h.port}` } });
    expect(wrong.status).toBe(401);
    expect(wrong.headers["set-cookie"]).toBeUndefined();
    const foreign = await rawRequest({ port: h.port, path: `/?token=${TOKEN}`, headers: { Host: `evil.example:${h.port}` } });
    expect(foreign.status).toBe(421);
    expect(foreign.headers["set-cookie"]).toBeUndefined();
  });

  it("refuses the token as a WebSocket query parameter", async () => {
    const status = await rawUpgrade(h.port, `/api/overview?token=${TOKEN}`, headersFor("absent", "localhost", "same", h.port));
    expect(status).toBe(401);
  });
});

describe("hardening", () => {
  it("survives a malformed computer name on a WebSocket path", async () => {
    const h = await startHarness();
    const headers = { Host: `localhost:${h.port}`, Origin: `http://localhost:${h.port}`, Cookie: `phren_desktop=${TOKEN}` };
    const status = await rawUpgrade(h.port, "/hosts/%ZZ/v1/overview", headers);
    expect(status).toBe(101);
    await new Promise((done) => setTimeout(done, 50));
    const after = await rawRequest({ port: h.port, path: "/api/computers", headers: { Host: headers.Host, Cookie: headers.Cookie } });
    expect(after.status).toBe(200);
  });

  it("sandboxes every proxied Hook response", async () => {
    const h = await startHarness();
    const res = await rawRequest({ port: h.port, path: "/hosts/This%20computer/v1/files/range", headers: { Host: `localhost:${h.port}`, Cookie: `phren_desktop=${TOKEN}` } });
    expect(res.status).toBe(200);
    expect(res.headers["content-security-policy"]).toBe("sandbox");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("drops a WebSocket that sends a bad frame and keeps serving", async () => {
    const h = await startHarness();
    const headers = { Host: `localhost:${h.port}`, Origin: `http://localhost:${h.port}`, Cookie: `phren_desktop=${TOKEN}` };
    const closed = await new Promise<boolean>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: h.port, path: "/api/overview", headers: {
        Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", ...headers,
      } });
      req.on("upgrade", (_res, socket) => {
        socket.on("error", () => undefined);
        socket.on("close", () => resolve(true));
        socket.resume();
        // A masked frame with the reserved opcode 3: the receiver rejects it.
        socket.write(Buffer.from([0x83, 0x80, 0, 0, 0, 0]));
      });
      req.on("response", () => reject(new Error("upgrade refused")));
      req.on("error", reject);
      req.end();
    });
    expect(closed).toBe(true);
    const after = await rawRequest({ port: h.port, path: "/api/computers", headers: { Host: headers.Host, Cookie: headers.Cookie } });
    expect(after.status).toBe(200);
  });

  it("sandboxes extension HTML and SVG served on the app origin", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "desktop-ext-"));
    const previous = process.env.PHREN_DESKTOP_EXTENSIONS;
    process.env.PHREN_DESKTOP_EXTENSIONS = dir;
    try {
      const root = path.join(dir, "pub.ext", "extension");
      await mkdir(root, { recursive: true });
      await writeFile(path.join(root, "page.html"), "<script>1</script>");
      await writeFile(path.join(root, "icon.svg"), "<svg/>");
      await writeFile(path.join(root, "main.js"), "1");
      const h = await startHarness();
      const get = (file: string) => rawRequest({ port: h.port, path: `/extension-files/pub.ext/${file}`, headers: { Host: `localhost:${h.port}` } });
      for (const file of ["page.html", "icon.svg"]) {
        const res = await get(file);
        expect(res.status).toBe(200);
        expect(res.headers["content-security-policy"]).toBe("sandbox");
        expect(res.headers["x-content-type-options"]).toBe("nosniff");
      }
      const script = await get("main.js");
      expect(script.status).toBe(200);
      expect(script.headers["content-security-policy"]).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.PHREN_DESKTOP_EXTENSIONS;
      else process.env.PHREN_DESKTOP_EXTENSIONS = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });
});


describe("durable desktop quota settings", () => {
  it("retains merged settings and chat choices across daemon ports and bounds saved crossings", async () => {
    const config = await mkdtemp(path.join(tmpdir(), "quota-settings-"));
    vi.stubEnv("XDG_CONFIG_HOME", config);
    try {
      const first = await startHarness();
      const route = "/api/settings/quota-warning";
      const send = (port: number, body: unknown) => rawRequest({ port, path: route, method: "POST", body: JSON.stringify(body),
        headers: cookieHeaders({ "Content-Type": "application/json", "X-Phren-Desktop": "1", Origin: `http://127.0.0.1:${port}` }) });
      const updates = await Promise.all([
        send(first.port, { settings: { on: false, threshold: 95, backOn: false } }),
        send(first.port, { suppress: "chat-id" }), send(first.port, { markSeen: "crossing" }),
      ]);
      expect(updates.map((r) => r.status)).toEqual([200, 200, 200]);
      const second = await startHarness();
      expect(second.port).not.toBe(first.port);
      const read = await rawRequest({ port: second.port, path: route, headers: cookieHeaders() });
      expect(JSON.parse(read.body)).toEqual({ settings: { on: false, threshold: 95, backOn: false }, suppressed: ["chat-id"], seen: ["crossing"] });
      const tokens = Array.from({ length: 512 }, (_, i) => `old-${i}`);
      await writeFile(path.join(config, "phren", "desktop-quota.json"), JSON.stringify({ settings: { on: false, threshold: 95 }, suppressed: ["chat-id"], seen: tokens }));
      const defaults = await rawRequest({ port: second.port, path: route, headers: cookieHeaders() });
      expect(JSON.parse(defaults.body).settings.backOn).toBe(true);
      const capped = await send(second.port, { markSeen: "new-crossing" });
      expect(JSON.parse(capped.body).seen).toEqual([...tokens.slice(1), "new-crossing"]);
      const interrupted = await send(second.port, { unmarkSeen: "new-crossing" });
      expect(JSON.parse(interrupted.body).seen).not.toContain("new-crossing");
      expect((await send(second.port, { settings: { threshold: 100 } })).status).toBe(400);
      expect((await send(second.port, { settings: { backOn: "false" } })).status).toBe(400);
    } finally { vi.unstubAllEnvs(); await rm(config, { recursive: true, force: true }); }
  });
});


describe("Hook proxy cancellation", () => {
  it("keeps a completed browser GET alive until disconnect, then aborts its Hook request", async () => {
    let signal: AbortSignal | undefined;
    let started = false;
    let finish = () => {};
    const h = await startHarness(true, async (_c, _method, _path, _body, incoming) => {
      started = true;
      signal = incoming;
      return new Promise((resolve, reject) => {
        finish = () => resolve({ status: 200, headers: {}, body: Buffer.from("{}") });
        incoming?.addEventListener("abort", () => reject(incoming.reason), { once: true });
      });
    });
    const browser = new AbortController();
    const answer = fetch(`http://127.0.0.1:${h.port}/hosts/This%20computer/v1/projects/phren/memory/search?q=token`, {
      headers: cookieHeaders(), signal: browser.signal,
    }).catch((err: Error) => err);
    try {
      await vi.waitFor(() => expect(started).toBe(true));
      expect(signal).toBeDefined();
      // IncomingMessage's normal close after a complete GET must not abort it.
      expect(signal!.aborted).toBe(false);
      browser.abort();
      await answer;
      await vi.waitFor(() => expect(signal!.aborted).toBe(true));
    } finally {
      browser.abort();
      finish();
      await answer;
    }
  });

  it("holds four slots across browser aborts until Hook requests settle, across subsequent queries", async () => {
    const pending: Array<{ signal: AbortSignal; finish: () => void }> = [];
    let active = 0, peak = 0;
    const h = await startHarness(true, async (_c, _method, route, _body, signal) => {
      if (route === "/v1/probe") return { status: 200, headers: {}, body: Buffer.from("{}") };
      peak = Math.max(peak, ++active);
      return new Promise((resolve) => pending.push({ signal: signal!, finish: () => {
        active--;
        resolve({ status: 200, headers: {}, body: Buffer.from("{}") });
      } }));
    });
    const get = (i: number, signal?: AbortSignal) => fetch(`http://127.0.0.1:${h.port}/hosts/This%20computer/v1/projects/p${i}/memory/search`, {
      headers: cookieHeaders(), signal,
    }).then((res) => res.text()).catch(() => undefined);
    const old = new AbortController();
    const requests = Array.from({ length: 4 }, (_, i) => get(i, old.signal));
    try {
      await vi.waitFor(() => expect(pending).toHaveLength(4));
      old.abort();
      await vi.waitFor(() => expect(pending.every((read) => read.signal.aborted)).toBe(true));
      requests.push(...Array.from({ length: 4 }, (_, i) => get(i + 5)));
      // A later ordinary proxy read stays usable while memory waits for slots.
      const probe = await fetch(`http://127.0.0.1:${h.port}/hosts/This%20computer/v1/probe`, { headers: cookieHeaders() });
      await probe.text();
      expect(pending).toHaveLength(4);
      pending[0].finish();
      await vi.waitFor(() => expect(pending).toHaveLength(5));
      expect(peak).toBe(4);
      pending.slice(1, 4).forEach((read) => read.finish());
      await vi.waitFor(() => expect(pending).toHaveLength(8));
      expect(peak).toBe(4);
      pending.slice(4).forEach((read) => read.finish());
      await Promise.all(requests);
    } finally { old.abort(); }
  });
});
