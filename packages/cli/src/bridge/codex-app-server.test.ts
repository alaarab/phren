import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { AppServerRpcError, connectAppServer, spawnAppServer, type AppServerClient, type AppServerEvent, type Json } from "./codex-app-server.js";

/** Answers the client's requests the way `codex app-server` does, and lets a
 * test push server requests and notifications at it. */
class FakeAppServer {
  readonly http = createServer();
  readonly wss = new WebSocketServer({ server: this.http });
  readonly sockets: WebSocket[] = [];
  readonly received: Json[] = [];
  readonly silence = new Set<string>();
  readonly fail = new Map<string, { code: number; message: string }>();
  socketPath = "";
  extensions?: string;
  private turns = 0;

  constructor() {
    this.wss.on("connection", (socket, request) => {
      this.sockets.push(socket);
      this.extensions = request.headers["sec-websocket-extensions"] as string | undefined;
      socket.on("message", raw => {
        let message: Json;
        try { message = JSON.parse(String(raw)) as Json; } catch { return; }
        this.received.push(message);
        this.answer(socket, message);
      });
    });
  }

  listen(socketPath: string): Promise<void> {
    this.socketPath = socketPath;
    return new Promise((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(socketPath, () => resolve());
    });
  }

  sendRequest(id: number, method: string, params: Json): void {
    for (const socket of this.sockets) socket.send(JSON.stringify({ id, method, params }));
  }

  notify(method: string, params: Json): void {
    for (const socket of this.sockets) socket.send(JSON.stringify({ method, params }));
  }

  sent(predicate: (message: Json) => boolean): Json | undefined { return this.received.find(predicate); }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.terminate();
    await new Promise<void>(resolve => this.wss.close(() => resolve()));
    await new Promise<void>(resolve => this.http.close(() => resolve()));
  }

  private answer(socket: WebSocket, message: Json): void {
    const id = message.id;
    const method = message.method;
    if (id === undefined || typeof method !== "string") return;
    if (this.silence.has(method)) return;
    const failure = this.fail.get(method);
    if (failure) { socket.send(JSON.stringify({ id, error: failure })); return; }
    const params = (message.params ?? {}) as Json;
    let result: Json = {};
    if (method === "initialize") result = { userAgent: "fake-codex", codexHome: "/tmp/codex" };
    else if (method === "thread/start") result = { thread: { id: "thread-1" }, model: "gpt-5" };
    else if (method === "thread/resume") result = { thread: { id: params.threadId } };
    else if (method === "thread/loaded/list") result = { data: ["thread-1"], nextCursor: null };
    else if (method === "turn/start") result = { turn: { id: `turn-${++this.turns}` } };
    socket.send(JSON.stringify({ id, result }));
  }
}

async function until(predicate: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function connected(server: FakeAppServer): Promise<{ client: AppServerClient; events: AppServerEvent[] }> {
  const client = await connectAppServer(server.socketPath, { clientName: "phren_test", clientVersion: "0.0.1" });
  const events: AppServerEvent[] = [];
  client.on(event => events.push(event));
  return { client, events };
}

let root = "", socketPath = "", server: FakeAppServer;
let handles: { stop(): Promise<void> }[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "phren-cas-"));
  socketPath = path.join(root, "app.sock");
  server = new FakeAppServer();
  await server.listen(socketPath);
});
afterEach(async () => {
  for (const handle of handles) await handle.stop().catch(() => {});
  handles = [];
  await server.close();
  await rm(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("connectAppServer", () => {
  it("initializes, then sends the initialized notification", async () => {
    const { client } = await connected(server);
    await until(() => server.received.length >= 2, "the initialized notification");
    expect(server.received[0]).toMatchObject({ method: "initialize" });
    expect((server.received[0].params as Json).clientInfo).toMatchObject({ name: "phren_test", version: "0.0.1" });
    expect(server.received[1]).toMatchObject({ method: "initialized" });
    expect(server.received[1].id).toBeUndefined();
    client.close();
  });

  it("offers no permessage-deflate extension", async () => {
    const { client } = await connected(server);
    expect(server.extensions).toBeUndefined();
    client.close();
  });

  it("returns the turn id from turn/start", async () => {
    const { client } = await connected(server);
    const { turnId } = await client.turnStart({ threadId: "thread-1", input: [{ type: "text", text: "hi" }] });
    expect(turnId).toBe("turn-1");
    expect(server.sent(m => m.method === "turn/start")).toMatchObject({
      params: { threadId: "thread-1", input: [{ type: "text", text: "hi" }] },
    });
    client.close();
  });

  it("rejects a JSON-RPC error with its code and message", async () => {
    server.fail.set("thread/start", { code: -32602, message: "invalid params" });
    const { client } = await connected(server);
    const error = await client.threadStart({ cwd: "/work" }).catch((cause: AppServerRpcError) => cause);
    expect(error).toBeInstanceOf(AppServerRpcError);
    expect(error.code).toBe(-32602);
    expect(error.message).toBe("invalid params");
    client.close();
  });

  it("rejects a request that outlives its timeout", async () => {
    server.silence.add("thread/loaded/list");
    const { client } = await connected(server);
    await expect(client.request("thread/loaded/list", {}, 60)).rejects.toThrow(/Timed out/);
    client.close();
  });
});

describe.skipIf(process.platform === "win32")("server requests", () => {
  it("hands a server request to listeners and responds with its id and result", async () => {
    const { client, events } = await connected(server);
    server.sendRequest(7, "item/commandExecution/requestApproval", { threadId: "thread-1", turnId: "turn-1", itemId: "exec-1" });
    await until(() => client.pending.has(7), "the approval to arrive");
    expect(events.find(event => event.kind === "request")).toMatchObject({ kind: "request", requestId: 7, method: "item/commandExecution/requestApproval", threadId: "thread-1" });
    client.respond(7, { decision: "decline" });
    await until(() => server.sent(m => m.id === 7 && m.result !== undefined) !== undefined, "the response");
    expect(server.sent(m => m.id === 7)).toMatchObject({ id: 7, result: { decision: "decline" } });
    expect(client.pending.has(7)).toBe(false);
    client.close();
  });

  it("sends a coded error with respondError", async () => {
    const { client } = await connected(server);
    server.sendRequest(9, "item/tool/requestUserInput", { threadId: "thread-1", turnId: "turn-1" });
    await until(() => client.pending.has(9), "the request to arrive");
    client.respondError(9, -32601, "not supported");
    await until(() => server.sent(m => m.id === 9) !== undefined, "the error response");
    expect(server.sent(m => m.id === 9)).toMatchObject({ id: 9, error: { code: -32601, message: "not supported" } });
    client.close();
  });

  it("drops a request another client resolved and emits the resolution", async () => {
    const { client, events } = await connected(server);
    server.sendRequest(8, "item/commandExecution/requestApproval", { threadId: "thread-1", turnId: "turn-1" });
    await until(() => client.pending.has(8), "the request to arrive");
    server.notify("serverRequest/resolved", { threadId: "thread-1", requestId: 8 });
    await until(() => !client.pending.has(8), "the resolution to arrive");
    expect(events.find(event => event.kind === "resolved")).toMatchObject({ kind: "resolved", requestId: 8, threadId: "thread-1" });
    client.close();
  });
});

describe.skipIf(process.platform === "win32")("interruptTurn", () => {
  it("declines this thread's parked requests before turn/interrupt, leaving other threads alone", async () => {
    const { client } = await connected(server);
    server.sendRequest(10, "item/commandExecution/requestApproval", { threadId: "thread-A", turnId: "turn-A" });
    server.sendRequest(11, "item/fileChange/requestApproval", { threadId: "thread-B", turnId: "turn-B" });
    await until(() => client.pending.size === 2, "both requests to arrive");
    await client.interruptTurn("thread-A", "turn-A");
    expect(server.sent(m => m.id === 10)).toMatchObject({ id: 10, result: { decision: "cancel" } });
    expect(server.sent(m => m.id === 11)).toBeUndefined();
    expect(server.sent(m => m.method === "turn/interrupt")).toMatchObject({ params: { threadId: "thread-A", turnId: "turn-A" } });
    expect(client.pending.has(11)).toBe(true);
    client.close();
  });

  it("settles each request type with its own decline shape", async () => {
    const { client } = await connected(server);
    server.sendRequest(20, "item/permissions/requestApproval", { threadId: "thread-A", turnId: "turn-A" });
    server.sendRequest(21, "mcpServer/elicitation/request", { threadId: "thread-A", turnId: "turn-A" });
    await until(() => client.pending.size === 2, "both requests to arrive");
    await client.interruptTurn("thread-A", "turn-A");
    expect(server.sent(m => m.id === 20)).toMatchObject({ result: { permissions: {} } });
    expect(server.sent(m => m.id === 21)).toMatchObject({ result: { action: "cancel" } });
    client.close();
  });
});

describe.skipIf(process.platform === "win32")("spawnAppServer", () => {
  it("starts the binary, makes the socket's folder owner-only, and stops it", async () => {
    const wsModule = createRequire(import.meta.url).resolve("ws");
    const codex = path.join(root, "fake-codex.cjs");
    await writeFile(codex, `#!/usr/bin/env node
const { WebSocketServer } = require(${JSON.stringify(wsModule)});
const http = require("node:http");
const { mkdirSync } = require("node:fs");
const path = require("node:path");
const listen = process.argv[process.argv.indexOf("--listen") + 1] || "";
const socketPath = listen.replace(/^unix:\\/\\//, "");
mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
require("node:fs").writeFileSync(path.join(path.dirname(socketPath), "argv.json"), JSON.stringify(process.argv.slice(2)));
const httpServer = http.createServer();
const wss = new WebSocketServer({ server: httpServer });
wss.on("connection", socket => socket.on("message", raw => {
  let message; try { message = JSON.parse(String(raw)); } catch { return; }
  if (message.method === "initialize") socket.send(JSON.stringify({ id: message.id, result: { userAgent: "fake" } }));
}));
httpServer.listen(socketPath);
`, { mode: 0o755 });
    const own = await mkdtemp(path.join(tmpdir(), "phren-as-"));
    const ownSocket = path.join(own, "nested", "worker.sock");
    const handle = await spawnAppServer({ codexBin: codex, socketPath: ownSocket, cwd: root, config: ["features.x=true", 'y="a b"'] });
    handles.push(handle);
    expect(JSON.parse(await readFile(path.join(path.dirname(ownSocket), "argv.json"), "utf8")))
      .toEqual(["app-server", "-c", "features.x=true", "-c", 'y="a b"', "--listen", `unix://${ownSocket}`]);
    expect(handle.child.pid).toBeGreaterThan(0);
    expect((await stat(path.dirname(ownSocket))).mode & 0o077).toBe(0);
    const client = await connectAppServer(ownSocket, { clientName: "phren_test" });
    client.close();
    await handle.stop();
    handles = handles.filter(other => other !== handle);
    expect(handle.child.exitCode !== null || handle.child.signalCode !== null).toBe(true);
    await rm(own, { recursive: true, force: true });
  });
});
