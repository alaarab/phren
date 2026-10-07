import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_MODULES } from "../modules/registry.js";
import { scopedGatewayScript } from "./install.js";
import { acceptScopedKey, scopedKeyLine } from "./pair.js";
import { admitScopedRequest, type GatewayScope, scopedDispatch } from "./scoped-gateway.js";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEWhFCx/BoeHGP4KuXTnSU1szj0tNbYHo3BHMBe4YQ+h";
const head = (line: string, headers: string[] = ["Host: phren.local"]) => `${line}\r\n${headers.map(h => `${h}\r\n`).join("")}\r\n`;
const admit = (line: string, headers?: string[], rest = "", scope: GatewayScope = "gitboy-read") =>
  admitScopedRequest(scope, head(line, headers), Buffer.from(rest));
const forwarded = (line: string, headers?: string[], rest = "", scope: GatewayScope = "gitboy-read") => {
  const result = admit(line, headers, rest, scope);
  if (!result.ok) throw new Error(`refused ${line}: ${result.error}`);
  return result.request;
};
const post = (body: string, headers: string[] = [], scope: GatewayScope = "gitboy-write") =>
  admit("POST /v1/projects/app/findings HTTP/1.1", ["Host: x", "Content-Type: application/json", `Content-Length: ${Buffer.byteLength(body)}`, ...headers], body, scope);

const READ_ROUTES = [
  "GET /v1/projects/my-app/memory HTTP/1.1",
  "GET /v1/projects/my-app/memory/files?path=src/a.ts HTTP/1.1",
  "GET /v1/projects/my-app/memory/search?q=boom HTTP/1.1",
  "GET /v1/projects/my-app/tasks?branch=main HTTP/1.1",
];

describe("gitboy-read scope admission", () => {
  it("admits the four read routes and rebuilds each request", () => {
    expect(forwarded("GET /v1/projects/my-app/memory HTTP/1.0", [])).toBe("GET /v1/projects/my-app/memory HTTP/1.1\r\nHost: phren.local\r\nConnection: close\r\n\r\n");
    expect(forwarded("GET /v1/projects/app/memory/files?path=src%2Fa.ts&path=docs/read+me.md HTTP/1.1", ["Host: evil", "Cookie: x"]))
      .toBe("GET /v1/projects/app/memory/files?path=src%2Fa.ts&path=docs%2Fread+me.md HTTP/1.1\r\nHost: phren.local\r\nConnection: close\r\n\r\n");
    expect(forwarded("GET /v1/projects/app/memory/search?q=TypeError%3A%20x%20is%20undefined%0Aat%20foo&limit=20 HTTP/1.1"))
      .toMatch(/^GET \/v1\/projects\/app\/memory\/search\?q=TypeError%3A\+x\+is\+undefined%0Aat\+foo&limit=20 HTTP/);
    expect(forwarded("GET /v1/projects/app/memory/search?q=boom HTTP/1.1")).toContain("?q=boom&limit=5 ");
    expect(forwarded("GET /v1/projects/app/tasks?branch=fix%2F123-login HTTP/1.1")).toContain("?branch=fix%2F123-login ");
  });

  it("accepts 500 paths and refuses 501", () => {
    const query = (n: number) => Array.from({ length: n }, (_, i) => `path=src/module-${i}/index.ts`).join("&");
    expect(admit(`GET /v1/projects/app/memory/files?${query(500)} HTTP/1.1`)).toMatchObject({ ok: true });
    expect(admit(`GET /v1/projects/app/memory/files?${query(501)} HTTP/1.1`)).toMatchObject({ ok: false, status: 400 });
  });

  it("refuses every registered Hook route, on any method, under both scopes", () => {
    const routes = BUILTIN_MODULES.flatMap(module => module.hookRoutes);
    expect(routes.length).toBeGreaterThan(50);
    for (const scope of ["gitboy-read", "gitboy-write"] as const) {
      for (const route of routes) {
        for (const method of ["GET", "POST", "DELETE", "PUT"]) {
          const result = admit(`${method} ${route.path} HTTP/1.1`, route.method === "WS" ? ["Host: phren.local", "Upgrade: websocket", "Connection: Upgrade"] : undefined, "", scope);
          expect(result, `${scope} ${method} ${route.path}`).toMatchObject({ ok: false });
        }
      }
    }
  });

  it("refuses dispatch, store writes, sudo, files and other unregistered routes", () => {
    for (const line of [
      "POST /v1/dispatch HTTP/1.1", "POST /v1/store/file HTTP/1.1", "POST /v1/store/delete HTTP/1.1", "POST /v1/sudo/answer HTTP/1.1",
      "POST /v1/prompt HTTP/1.1", "POST /v1/tasks/update HTTP/1.1", "GET /v1/files?path=/etc/passwd HTTP/1.1", "GET /v1/health HTTP/1.1",
      "GET /v1/projects/files HTTP/1.1", "POST /v1/projects/add HTTP/1.1", "GET / HTTP/1.1", "POST /v1/notify HTTP/1.1",
      "POST /v1/projects/app/findings HTTP/1.1", "GET /v1/projects/app/findings HTTP/1.1",
    ]) expect(admit(line, ["Content-Length: 0"]), line).toMatchObject({ ok: false, status: 403 });
  });

  it("refuses look-alike paths, other methods and request forms", () => {
    for (const line of [
      "POST /v1/projects/app/memory HTTP/1.1", "HEAD /v1/projects/app/memory HTTP/1.1", "DELETE /v1/projects/app/memory HTTP/1.1",
      "get /v1/projects/app/memory HTTP/1.1", "GET /v1/projects/app/memory/ HTTP/1.1", "GET /v1/projects/app/memory#x HTTP/1.1",
      "GET /v1/projects/../dispatch/memory HTTP/1.1", "GET /v1/projects/%2e%2e/memory HTTP/1.1", "GET /v1/projects/a/b/memory HTTP/1.1",
      "GET //v1/projects/app/memory HTTP/1.1", "GET http://phren.local/v1/projects/app/memory HTTP/1.1", "GET /v1/projects/App/memory HTTP/1.1",
      "GET /v1/projects/app/memory HTTP/2.0", "GET /v1/projects/app/memory", "GET /v1/projects/app/memory/files/x?path=a HTTP/1.1",
      "POST /v1/projects/app/memory/search?q=x HTTP/1.1", "GET /v1/projects/app/tasks/extra?branch=main HTTP/1.1",
    ]) expect(admit(line), line).toMatchObject({ ok: false });
  });

  it("holds each read route to its query grammar", () => {
    for (const target of [
      "/v1/projects/app/memory?x=1", "/v1/projects/app/memory?", "/v1/projects/app/memory/files", "/v1/projects/app/memory/files?",
      "/v1/projects/app/memory/files?path=", "/v1/projects/app/memory/files?path=../etc/passwd", "/v1/projects/app/memory/files?path=/etc/passwd",
      "/v1/projects/app/memory/files?path=a/./b", "/v1/projects/app/memory/files?path=a//b", "/v1/projects/app/memory/files?path=a%5Cb",
      "/v1/projects/app/memory/files?path=a%00b", "/v1/projects/app/memory/files?path=a&other=b", "/v1/projects/app/memory/files?Path=a",
      "/v1/projects/app/memory/files?path=a%ZZ", "/v1/projects/app/memory/files?path=a&&path=b",
      "/v1/projects/app/memory/search", "/v1/projects/app/memory/search?q=", "/v1/projects/app/memory/search?q=%20%20",
      `/v1/projects/app/memory/search?q=${"a".repeat(1001)}`, "/v1/projects/app/memory/search?q=a&q=b", "/v1/projects/app/memory/search?q=a&limit=21",
      "/v1/projects/app/memory/search?q=a&limit=0", "/v1/projects/app/memory/search?q=a&limit=05", "/v1/projects/app/memory/search?q=a&limit=1&limit=2",
      "/v1/projects/app/memory/search?q=a%1Bb", "/v1/projects/app/memory/search?q=a&project=other",
      "/v1/projects/app/tasks", "/v1/projects/app/tasks?branch=", "/v1/projects/app/tasks?branch=-x", "/v1/projects/app/tasks?branch=a..b",
      "/v1/projects/app/tasks?branch=a%20b", "/v1/projects/app/tasks?branch=main&branch=dev", "/v1/projects/app/tasks?branch=x.lock",
      "/v1/projects/app/tasks?branch=main&q=x",
    ]) expect(admit(`GET ${target} HTTP/1.1`), target).toMatchObject({ ok: false, status: 400 });
    // A raw space ends the request target, so the request line itself is malformed.
    expect(admit("GET /v1/projects/app/memory/files?path=a b HTTP/1.1")).toMatchObject({ ok: false, status: 400 });
    expect(admit(`GET /v1/projects/app/memory/search?q=${"a".repeat(1000)} HTTP/1.1`)).toMatchObject({ ok: true });
  });

  it("refuses bodies, chunking, upgrades and pipelined requests on read routes", () => {
    for (const line of READ_ROUTES) {
      expect(admit(line, ["Content-Length: 5"], "hello"), line).toMatchObject({ ok: false, status: 400 });
      expect(admit(line, ["Content-Length: 0"]), line).toMatchObject({ ok: true });
      expect(admit(line, ["Transfer-Encoding: chunked"]), line).toMatchObject({ ok: false });
      expect(admit(line, ["Upgrade: websocket"]), line).toMatchObject({ ok: false });
      expect(admit(line, ["Expect: 100-continue"]), line).toMatchObject({ ok: false });
      expect(admit(line, ["Bad Header"]), line).toMatchObject({ ok: false });
      expect(admit(line, ["Content-Length: 1", "Content-Length: 1"], "x"), line).toMatchObject({ ok: false });
      expect(admit(line, undefined, "GET /v1/dispatch HTTP/1.1\r\n\r\n"), line).toMatchObject({ ok: false, status: 400 });
    }
    expect(admitScopedRequest("gitboy-read", "GET /v1/projects/app/memory HTTP/1.1\nHost: x\n\n")).toMatchObject({ ok: false });
  });
});

describe("gitboy-write scope admission", () => {
  it("admits one validated finding and forwards only the validated fields", () => {
    const result = post(JSON.stringify({ text: "Retry  the\nupload on 502", type: "pitfall", citation: { file: "src/up.ts", line: 12, commit: "abc1234", name: "upload()" } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [headPart, body] = result.request.split("\r\n\r\n");
    expect(headPart).toBe(`POST /v1/projects/app/findings HTTP/1.1\r\nHost: phren.local\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close`);
    expect(JSON.parse(body)).toEqual({ text: "Retry the upload on 502", type: "pitfall", citation: { file: "src/up.ts", line: 12, commit: "abc1234", name: "upload()" } });
  });

  it("refuses bad bodies before the Hook sees them", () => {
    expect(post(JSON.stringify({ text: "x", extra: true }))).toMatchObject({ ok: false, status: 400 });
    expect(post(JSON.stringify({ text: "x", type: "workaround" }))).toMatchObject({ ok: false, status: 400 });
    expect(post(JSON.stringify({ text: "x", citation: { file: "../etc/passwd" } }))).toMatchObject({ ok: false, status: 400 });
    expect(post(JSON.stringify({ text: "x", citation: { repo: "/home/me" } }))).toMatchObject({ ok: false, status: 400 });
    expect(post(JSON.stringify({ text: "x", citation: { commit: "zzz" } }))).toMatchObject({ ok: false, status: 400 });
    expect(post(JSON.stringify({ text: "   " }))).toMatchObject({ ok: false, status: 400 });
    expect(post(JSON.stringify({ text: "a\u0007b" }))).toMatchObject({ ok: false, status: 400 });
    expect(post(JSON.stringify(["x"]))).toMatchObject({ ok: false, status: 400 });
    expect(post("{not json")).toMatchObject({ ok: false, status: 400 });
    expect(post(JSON.stringify({ text: "x".repeat(9000) }))).toMatchObject({ ok: false, status: 413 });
    const body = JSON.stringify({ text: "x" });
    expect(admit("POST /v1/projects/app/findings HTTP/1.1", ["Content-Type: text/plain", `Content-Length: ${body.length}`], body, "gitboy-write")).toMatchObject({ ok: false, status: 415 });
    expect(admit("POST /v1/projects/app/findings HTTP/1.1", ["Content-Type: application/json"], body, "gitboy-write")).toMatchObject({ ok: false, status: 413 });
    expect(admit("POST /v1/projects/app/findings HTTP/1.1", ["Content-Type: application/json", `Content-Length: ${body.length}`], body + "GET / HTTP/1.1\r\n\r\n", "gitboy-write")).toMatchObject({ ok: false, status: 400 });
    expect(admit("POST /v1/projects/app/findings HTTP/1.1", ["Content-Type: application/json", "Transfer-Encoding: chunked"], body, "gitboy-write")).toMatchObject({ ok: false });
    expect(admit("POST /v1/projects/app/findings?x=1 HTTP/1.1", ["Content-Type: application/json", `Content-Length: ${body.length}`], body, "gitboy-write")).toMatchObject({ ok: false, status: 400 });
  });

  it("a read key can never write and a write key can never read", () => {
    expect(post(JSON.stringify({ text: "x" }), [], "gitboy-read")).toMatchObject({ ok: false, status: 403 });
    for (const line of READ_ROUTES) expect(admit(line, undefined, "", "gitboy-write"), line).toMatchObject({ ok: false, status: 403 });
  });
});

describe("scoped SSH session", () => {
  let dir: string, socket: string, server: Server, received: string[];
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "scoped-gw-"));
    socket = path.join(dir, "hook.sock"); received = [];
    server = createServer(connection => {
      let data = "";
      connection.on("data", chunk => {
        data += chunk;
        const end = data.indexOf("\r\n\r\n");
        if (end === -1) return;
        const length = Number(/content-length: (\d+)/i.exec(data.slice(0, end))?.[1] ?? 0);
        if (data.length < end + 4 + length) return;
        received.push(data);
        connection.end("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: 2\r\n\r\n{}");
      });
    });
    await new Promise<void>(resolve => server.listen(socket, resolve));
  });
  afterEach(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });

  async function session(command: string, chunks: string[], hook = socket, scope = "gitboy-read"): Promise<string> {
    const input = new PassThrough(), output = new PassThrough();
    let text = ""; output.on("data", chunk => { text += chunk; });
    const done = scopedDispatch(scope, command, { input, output, socket: hook });
    for (const chunk of chunks) { input.write(chunk); await new Promise(resolve => setImmediate(resolve)); }
    await done;
    return text;
  }

  it("forwards an admitted request as a request it builds itself", async () => {
    const reply = await session("phren-hook v1 pipe", [head("GET /v1/projects/app/memory HTTP/1.1", ["Host: evil", "Cookie: x", "X-Phren-Origin: phone"])]);
    expect(reply).toMatch(/^HTTP\/1\.1 200 OK/);
    expect(received).toEqual(["GET /v1/projects/app/memory HTTP/1.1\r\nHost: phren.local\r\nConnection: close\r\n\r\n"]);
  });

  it("waits for a split write body and forwards the rebuilt one", async () => {
    const body = JSON.stringify({ text: "Save this fix" });
    const reply = await session("phren-hook v1 pipe", [
      head("POST /v1/projects/app/findings HTTP/1.1", ["Content-Type: application/json", `Content-Length: ${body.length}`]), body.slice(0, 5), body.slice(5),
    ], socket, "gitboy-write");
    expect(reply).toMatch(/^HTTP\/1\.1 200 OK/);
    expect(received).toHaveLength(1);
    expect(received[0].endsWith('\r\n\r\n{"text":"Save this fix"}')).toBe(true);
  });

  it("answers refused requests itself and never opens the Hook socket", async () => {
    const reply = await session("phren-hook v1 pipe", [head("POST /v1/dispatch HTTP/1.1", ["Content-Length: 0"])]);
    expect(reply).toMatch(/^HTTP\/1\.1 403 Forbidden/);
    expect(reply).toContain('"code":"scope-refused"');
    const smuggled = await session("phren-hook v1 pipe", [head("GET /v1/projects/app/memory HTTP/1.1") + head("POST /v1/dispatch HTTP/1.1")]);
    expect(smuggled).toMatch(/^HTTP\/1\.1 400/);
    const oversized = await session("phren-hook v1 pipe", [head("POST /v1/projects/app/findings HTTP/1.1", ["Content-Type: application/json", "Content-Length: 9000"])], socket, "gitboy-write");
    expect(oversized).toMatch(/^HTTP\/1\.1 413/);
    expect(received).toEqual([]);
  });

  it("refuses every SSH command but the pipe, and unknown scopes", async () => {
    for (const scope of ["gitboy-read", "gitboy-write"]) {
      for (const command of ["", "phren-hook v1 web 127.0.0.1 3000", "phren-hook v1 shell L3RtcA", "phren-hook v1 terminal main",
        "phren-hook v1 pipe ", "sh", "phren bridge add-peer", "phren-hook v1 pipe; sh"]) {
        await expect(scopedDispatch(scope, command, { input: new PassThrough(), output: new PassThrough(), socket })).rejects.toMatchObject({ status: 403 });
      }
    }
    for (const scope of ["full", "gitboy-notify", "", "gitboy-read gitboy-write"]) {
      await expect(scopedDispatch(scope, "phren-hook v1 pipe", { input: new PassThrough(), output: new PassThrough(), socket })).rejects.toMatchObject({ status: 403 });
    }
    expect(received).toEqual([]);
  });

  it("reports a stopped Hook as 503", async () => {
    const reply = await session("phren-hook v1 pipe", [head("GET /v1/projects/app/memory HTTP/1.1")], path.join(dir, "missing.sock"));
    expect(reply).toMatch(/^HTTP\/1\.1 503 Service Unavailable/);
    expect(reply).toContain('"code":"hook-unavailable"');
  });
});

describe("scoped key authorization", () => {
  it("writes a no-PTY line forced to the scoped gateway, rebuilding supplied options", async () => {
    const ssh = await mkdtemp(path.join(tmpdir(), "scoped-ssh-"));
    try {
      const line = await acceptScopedKey("gitboy-read", `pty,command="sh" ${KEY} gitboy@server\n`, ssh);
      expect(line).toBe(`restrict,command="sh ~/.local/share/phren/bridge/dispatch-scoped gitboy-read" ${KEY} phren-gitboy`);
      expect(line).toBe(scopedKeyLine("gitboy-read", KEY));
      expect(await readFile(path.join(ssh, "authorized_keys"), "utf8")).toBe(`${line}\n`);
      await expect(acceptScopedKey("gitboy-read", KEY, ssh)).resolves.toBe(line);
      await expect(acceptScopedKey("gitboy-read", `${KEY}\n${KEY}`, ssh)).rejects.toMatchObject({ status: 400 });
      // One key holds one scope: the write scope needs its own key.
      await expect(acceptScopedKey("gitboy-write", KEY, ssh)).rejects.toMatchObject({ status: 409 });
    } finally { await rm(ssh, { recursive: true, force: true }); }
  });

  it("names the write scope in its own forced command and comment", () => {
    expect(scopedKeyLine("gitboy-write", KEY)).toBe(`restrict,command="sh ~/.local/share/phren/bridge/dispatch-scoped gitboy-write" ${KEY} phren-gitboy-write`);
  });

  it("gateway script always runs the node gateway with the key's scope", () => {
    const script = scopedGatewayScript({ root: "/r", herdr: "/h", store: "/s", profile: "default", node: "/n", bundle: "/b.mjs" });
    expect(script).toContain(`exec '/n' '/b.mjs' ssh-scoped "$1"`);
    expect(script).not.toMatch(/socat|nc -U|SSH_ORIGINAL_COMMAND/);
  });
});
