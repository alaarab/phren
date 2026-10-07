import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_MODULES } from "../modules/registry.js";
import { scopedGatewayScript } from "./install.js";
import { acceptScopedKey, scopedKeyLine } from "./pair.js";
import { admitScopedRequest, scopedDispatch } from "./scoped-gateway.js";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEWhFCx/BoeHGP4KuXTnSU1szj0tNbYHo3BHMBe4YQ+h";
const head = (line: string, headers: string[] = ["Host: phren.local"]) => `${line}\r\n${headers.map(h => `${h}\r\n`).join("")}\r\n`;
const admit = (line: string, headers?: string[], trailing = 0) => admitScopedRequest("gitboy-read", head(line, headers), trailing);

describe("gitboy-read scope admission", () => {
  it("admits only GET /v1/projects/<project>/memory", () => {
    expect(admit("GET /v1/projects/my-app/memory HTTP/1.1")).toEqual({ ok: true, path: "/v1/projects/my-app/memory" });
    expect(admit("GET /v1/projects/my-app/memory HTTP/1.0", [])).toMatchObject({ ok: true });
  });

  it("refuses every other registered Hook route, on any method", () => {
    const routes = BUILTIN_MODULES.flatMap(module => module.hookRoutes);
    expect(routes.length).toBeGreaterThan(50);
    for (const route of routes) {
      for (const method of new Set([route.method === "WS" ? "GET" : route.method, "GET", "POST", "DELETE"])) {
        const result = admit(`${method} ${route.path} HTTP/1.1`, route.method === "WS" ? ["Host: phren.local", "Upgrade: websocket", "Connection: Upgrade"] : undefined);
        expect(result, `${method} ${route.path}`).toMatchObject({ ok: false });
      }
    }
  });

  it("refuses dispatch, store writes, sudo, files and other unregistered routes", () => {
    for (const line of [
      "POST /v1/dispatch HTTP/1.1", "POST /v1/store/file HTTP/1.1", "POST /v1/store/delete HTTP/1.1", "POST /v1/sudo/answer HTTP/1.1",
      "POST /v1/prompt HTTP/1.1", "POST /v1/tasks/update HTTP/1.1", "GET /v1/files?path=/etc/passwd HTTP/1.1", "GET /v1/health HTTP/1.1",
      "GET /v1/projects/files HTTP/1.1", "POST /v1/projects/add HTTP/1.1", "GET / HTTP/1.1",
    ]) expect(admit(line), line).toMatchObject({ ok: false, status: 403 });
  });

  it("refuses look-alike paths, other methods and request forms", () => {
    for (const line of [
      "POST /v1/projects/app/memory HTTP/1.1", "HEAD /v1/projects/app/memory HTTP/1.1", "DELETE /v1/projects/app/memory HTTP/1.1",
      "get /v1/projects/app/memory HTTP/1.1", "GET /v1/projects/app/memory?x=1 HTTP/1.1", "GET /v1/projects/app/memory/ HTTP/1.1",
      "GET /v1/projects/app/memory#x HTTP/1.1", "GET /v1/projects/../dispatch/memory HTTP/1.1", "GET /v1/projects/%2e%2e/memory HTTP/1.1",
      "GET /v1/projects/a/b/memory HTTP/1.1", "GET //v1/projects/app/memory HTTP/1.1", "GET http://phren.local/v1/projects/app/memory HTTP/1.1",
      "GET /v1/projects/App/memory HTTP/1.1", "GET /v1/projects/app/memory HTTP/2.0", "GET /v1/projects/app/memory",
    ]) expect(admit(line), line).toMatchObject({ ok: false });
  });

  it("refuses bodies, chunking, upgrades and pipelined requests", () => {
    const line = "GET /v1/projects/app/memory HTTP/1.1";
    expect(admit(line, ["Content-Length: 5"])).toMatchObject({ ok: false, status: 400 });
    expect(admit(line, ["Content-Length: 0"])).toMatchObject({ ok: true });
    expect(admit(line, ["Transfer-Encoding: chunked"])).toMatchObject({ ok: false });
    expect(admit(line, ["Upgrade: websocket"])).toMatchObject({ ok: false });
    expect(admit(line, ["Expect: 100-continue"])).toMatchObject({ ok: false });
    expect(admit(line, ["Bad Header"])).toMatchObject({ ok: false });
    expect(admit(line, undefined, 30)).toMatchObject({ ok: false, status: 400 });
    expect(admitScopedRequest("gitboy-read", `${line}\nHost: x\n\n`)).toMatchObject({ ok: false });
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
        if (!data.includes("\r\n\r\n")) return;
        received.push(data);
        connection.end("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: 2\r\n\r\n{}");
      });
    });
    await new Promise<void>(resolve => server.listen(socket, resolve));
  });
  afterEach(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });

  async function session(command: string, request: string, hook = socket): Promise<string> {
    const input = new PassThrough(), output = new PassThrough();
    let text = ""; output.on("data", chunk => { text += chunk; });
    const done = scopedDispatch("gitboy-read", command, { input, output, socket: hook });
    input.write(request);
    await done;
    return text;
  }

  it("forwards an admitted request as a request it builds itself", async () => {
    const reply = await session("phren-hook v1 pipe", head("GET /v1/projects/app/memory HTTP/1.1", ["Host: evil", "Cookie: x", "X-Phren-Origin: phone"]));
    expect(reply).toMatch(/^HTTP\/1\.1 200 OK/);
    expect(reply.endsWith("{}")).toBe(true);
    expect(received).toEqual(["GET /v1/projects/app/memory HTTP/1.1\r\nHost: phren.local\r\nConnection: close\r\n\r\n"]);
  });

  it("answers refused requests itself and never opens the Hook socket", async () => {
    const reply = await session("phren-hook v1 pipe", head("POST /v1/dispatch HTTP/1.1", ["Content-Length: 0"]));
    expect(reply).toMatch(/^HTTP\/1\.1 403 Forbidden/);
    expect(reply).toContain('"code":"scope-refused"');
    const smuggled = await session("phren-hook v1 pipe", head("GET /v1/projects/app/memory HTTP/1.1") + head("POST /v1/dispatch HTTP/1.1"));
    expect(smuggled).toMatch(/^HTTP\/1\.1 400/);
    expect(received).toEqual([]);
  });

  it("refuses every SSH command but the pipe, and unknown scopes", async () => {
    for (const command of ["", "phren-hook v1 web 127.0.0.1 3000", "phren-hook v1 shell L3RtcA", "phren-hook v1 terminal main",
      "phren-hook v1 pipe ", "sh", "phren bridge add-peer", "phren-hook v1 pipe; sh"]) {
      await expect(scopedDispatch("gitboy-read", command, { input: new PassThrough(), output: new PassThrough(), socket })).rejects.toMatchObject({ status: 403 });
    }
    await expect(scopedDispatch("full", "phren-hook v1 pipe", { input: new PassThrough(), output: new PassThrough(), socket })).rejects.toMatchObject({ status: 403 });
    expect(received).toEqual([]);
  });

  it("reports a stopped Hook as 503", async () => {
    const reply = await session("phren-hook v1 pipe", head("GET /v1/projects/app/memory HTTP/1.1"), path.join(dir, "missing.sock"));
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
    } finally { await rm(ssh, { recursive: true, force: true }); }
  });

  it("gateway script always runs the node gateway with the key's scope", () => {
    const script = scopedGatewayScript({ root: "/r", herdr: "/h", store: "/s", profile: "default", node: "/n", bundle: "/b.mjs" });
    expect(script).toContain(`exec '/n' '/b.mjs' ssh-scoped "$1"`);
    expect(script).not.toMatch(/socat|nc -U|SSH_ORIGINAL_COMMAND/);
  });
});
