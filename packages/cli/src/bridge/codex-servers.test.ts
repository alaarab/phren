import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { SpawnAppServerOptions } from "./codex-app-server.js";
import { type CodexServerEntry, CodexServers, codexServersRoot, CODEX_SERVER_ENV, serverEnvironment } from "./codex-servers.js";
import type { Json, Target } from "./protocol.js";

/** A `codex app-server` as far as the Hook's client can tell: answers its
 * requests, records them, and pushes requests and notifications at it. */
class FakeAppServer {
  readonly http = createServer();
  readonly wss = new WebSocketServer({ server: this.http });
  readonly sockets: WebSocket[] = [];
  readonly received: Json[] = [];
  threadStatus = "idle";
  /** The turn `turn/steer` accepts; any other expected turn is refused. */
  running?: string;
  private turns = 0;

  constructor() {
    this.wss.on("connection", socket => {
      this.sockets.push(socket);
      socket.on("message", raw => {
        const message = JSON.parse(String(raw)) as Json;
        this.received.push(message);
        const id = message.id, method = message.method;
        if (id === undefined || typeof method !== "string") return;
        const params = (message.params ?? {}) as Json;
        let result: Json = {};
        if (method === "initialize") result = { userAgent: "fake" };
        else if (method === "thread/start") result = { thread: { id: "thread-1" }, reasoningEffort: (params.config as Json | undefined)?.model_reasoning_effort ?? null };
        else if (method === "thread/resume") result = { thread: { id: params.threadId, status: { type: this.threadStatus } } };
        else if (method === "turn/start") result = { turn: { id: `turn-${++this.turns}`, status: "inProgress" } };
        else if (method === "turn/steer") {
          if (params.expectedTurnId !== this.running) { socket.send(JSON.stringify({ id, error: { code: -32600, message: "no active turn to steer" } })); return; }
          result = { turnId: params.expectedTurnId };
        }
        socket.send(JSON.stringify({ id, result }));
      });
    });
  }
  listen(socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => { this.http.once("error", reject); this.http.listen(socketPath, () => resolve()); });
  }
  send(message: Json): void { for (const socket of this.sockets) socket.send(JSON.stringify(message)); }
  sent(method: string): Json[] { return this.received.filter(message => message.method === method); }
  async close(): Promise<void> {
    for (const socket of this.sockets) socket.terminate();
    await new Promise<void>(resolve => this.wss.close(() => resolve()));
    await new Promise<void>(resolve => this.http.close(() => resolve()));
  }
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

const place = { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1" };
const target: Target = { ...place, source: "codex", session: "thread-1" };

let root = "", previousHome: string | undefined;
let fakes: FakeAppServer[] = [];
let spawned: SpawnAppServerOptions[] = [];
let alive: Set<number>, killed: number[];
let servers: CodexServers;
let requests: { target: Target; method: string; answer: (result: Json) => void }[], resolved: { target: Target; requestId: unknown }[];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "phren-cs-"));
  previousHome = process.env.PHREN_BRIDGE_HOME;
  process.env.PHREN_BRIDGE_HOME = root;
  fakes = []; spawned = []; alive = new Set([4242]); killed = []; requests = []; resolved = [];
  servers = new CodexServers({
    spawn: async options => {
      spawned.push(options);
      const fake = new FakeAppServer();
      await fake.listen(options.socketPath);
      fakes.push(fake);
      return { child: { pid: 4242 } as never, socketPath: options.socketPath, stop: async () => { alive.delete(4242); } };
    },
    connect: (await import("./codex-app-server.js")).connectAppServer,
    alive: pid => alive.has(pid),
    kill: pid => { killed.push(pid); alive.delete(pid); },
  });
  servers.setSink({
    request: (where, request, answer) => requests.push({ target: where, method: request.method, answer }),
    resolved: (where, requestId) => resolved.push({ target: where, requestId }),
  });
});
afterEach(async () => {
  servers.reset();
  for (const fake of fakes) await fake.close();
  if (previousHome === undefined) delete process.env.PHREN_BRIDGE_HOME; else process.env.PHREN_BRIDGE_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
});

async function launched(options: Partial<Parameters<CodexServers["launch"]>[1]> = {}): Promise<CodexServerEntry> {
  return (await servers.launch(place, { cwd: root, startThread: true, ...options })).entry;
}
const registry = async (entry: CodexServerEntry) => JSON.parse(await readFile(path.join(codexServersRoot(), entry.id, "server.json"), "utf8")) as Json;

describe.skipIf(process.platform === "win32")("launching a pane's Codex server", () => {
  it("starts the thread in the pane's folder, with its model and effort, and registers it", async () => {
    const entry = await launched({ model: "gpt-5.4", effort: "low", env: { HERDR_PANE_ID: "w1:p1", PHREN_DISPATCH_ID: "dispatch-1234" }, dispatchId: "dispatch-1234" });
    expect(entry).toMatchObject({ ...place, threadId: "thread-1", pid: 4242, cwd: root, dispatchId: "dispatch-1234" });
    expect(entry.socket).toBe(path.join(codexServersRoot(), entry.id, "app.sock"));
    expect((await stat(path.dirname(entry.socket))).mode & 0o777).toBe(0o700);
    expect(fakes[0].sent("thread/start")[0].params).toEqual({ cwd: root, model: "gpt-5.4", config: { model_reasoning_effort: "low" } });
    expect(spawned[0]).toMatchObject({ detached: true, replaceEnv: true, cwd: root, logFile: path.join(path.dirname(entry.socket), "server.log") });
    expect(spawned[0].env?.[CODEX_SERVER_ENV]).toBe(entry.id);
    expect(spawned[0].env?.HERDR_PANE_ID).toBe("w1:p1");
    expect(await registry(entry)).toMatchObject({ id: entry.id, threadId: "thread-1", pane: "w1:p1" });
    const again = await servers.launch({ ...place, pane: "w1:p2" }, { cwd: root, startThread: true });
    expect(again.args).toEqual(["resume", "thread-1", "--remote", `unix://${again.entry.socket}`]);
    expect(servers.forTarget(target)).toBe(entry);
    expect(servers.forTarget({ ...target, session: "other" })).toBeUndefined();
  });

  it("without a brief, lets the pane's TUI start the thread and learns it from thread/started", async () => {
    const { entry, args } = await servers.launch(place, { cwd: root, model: "gpt-5.4", effort: "low" });
    expect(args).toEqual(["--remote", `unix://${entry.socket}`, "--model", "gpt-5.4", "-c", "model_reasoning_effort=low"]);
    expect(entry.threadId).toBeUndefined();
    expect(fakes[0].sent("thread/start")).toEqual([]);
    const waiting = servers.awaitThread(entry, 3_000);
    // A helper thread (no environment) and a thread in another folder are not the pane's.
    fakes[0].send({ method: "thread/started", params: { thread: { id: "helper", environments: [], parentThreadId: null } } });
    fakes[0].send({ method: "thread/started", params: { thread: { id: "elsewhere", environments: [{ cwd: "/elsewhere" }], parentThreadId: null } } });
    fakes[0].send({ method: "thread/started", params: { thread: { id: "tui-thread", environments: [{ cwd: root }], parentThreadId: null } } });
    expect(await waiting).toBe("tui-thread");
    await until(() => fakes[0].sent("thread/resume").length === 1, "the join");
    expect(fakes[0].sent("thread/resume")[0].params).toEqual({ excludeTurns: true, threadId: "tui-thread" });
    expect(servers.forTarget({ ...target, session: "tui-thread" })).toBe(entry);
  });

  it("follows the pane's TUI to a new thread (/new or /resume)", async () => {
    const entry = await launched();
    fakes[0].send({ id: 11, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", turnId: "t", itemId: "i" } });
    await until(() => requests.length === 1, "the old thread's approval");
    fakes[0].send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-7" } } });
    await until(() => entry.activeTurn === "turn-7", "the old turn");
    // /new: a new top-level thread in the pane's folder; a subagent's is ignored.
    fakes[0].send({ method: "thread/started", params: { thread: { id: "sub", environments: [{ cwd: root }], parentThreadId: "thread-1" } } });
    fakes[0].send({ method: "thread/started", params: { thread: { id: "thread-2", environments: [{ cwd: root }], parentThreadId: null } } });
    await until(() => entry.threadId === "thread-2", "the new thread");
    expect(entry.activeTurn).toBeUndefined();
    expect(resolved).toEqual([{ target, requestId: 11 }]);
    await until(() => fakes[0].sent("thread/resume").some(message => (message.params as Json).threadId === "thread-2"), "the join");
    expect(servers.forTarget(target)).toBeUndefined();
    expect(servers.forTarget({ ...target, session: "thread-2" })).toBe(entry);
    await servers.prompt(entry, "hi");
    expect(fakes[0].sent("turn/start").at(-1)?.params).toMatchObject({ threadId: "thread-2" });
    // /resume of an older thread, as the TUI's SessionStart hook reports it.
    expect(servers.follow("default", "w1:p1", "thread-old")).toBe(true);
    expect(servers.follow("default", "w9:p9", "thread-old")).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(await registry(entry)).toMatchObject({ threadId: "thread-old" });
    // Events of the thread it left no longer count.
    fakes[0].send({ id: 12, method: "item/commandExecution/requestApproval", params: { threadId: "thread-2", turnId: "t", itemId: "j" } });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(requests).toHaveLength(1);
  });

  it("gives the server none of the Hook's own terminal variables", () => {
    const env = serverEnvironment({ PATH: "/bin", HERDR_PANE_ID: "hook-pane", HERDR_ENV: "1", TMUX: "/tmp/x,1,0", TMUX_PANE: "%1", PHREN_DISPATCH_ID: "old" },
      { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" });
    expect(env).toEqual({ PATH: "/bin", HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" });
  });

  it("stops the server and leaves nothing registered when the thread cannot start", async () => {
    const failing = new CodexServers({
      spawn: async options => { const fake = new FakeAppServer(); await fake.listen(options.socketPath); fakes.push(fake); fake.wss.removeAllListeners("connection"); fake.wss.on("connection", socket => socket.close()); return { child: { pid: 4242 } as never, socketPath: options.socketPath, stop: async () => { alive.delete(4242); } }; },
      connect: (await import("./codex-app-server.js")).connectAppServer, alive: pid => alive.has(pid), kill: () => {},
    });
    await expect(failing.launch(place, { cwd: root, startThread: true })).rejects.toThrow();
    expect(alive.has(4242)).toBe(false);
    expect(failing.entries()).toEqual([]);
    expect(await readdir(codexServersRoot())).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("driving the thread", () => {
  it("sends a prompt as a turn and follows the turn to its end", async () => {
    const entry = await launched();
    expect(await servers.prompt(entry, "reply ok")).toEqual({ turnId: "turn-1" });
    expect(fakes[0].sent("turn/start")[0].params).toEqual({ threadId: "thread-1", input: [{ type: "text", text: "reply ok", text_elements: [] }] });
    fakes[0].send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } } });
    await until(() => entry.activeTurn === "turn-1", "the running turn");
    fakes[0].send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
    await until(() => entry.lastTurn?.status === "completed", "the finished turn");
    expect(entry.activeTurn).toBeUndefined();
    expect(servers.turnState("thread-1")).toMatchObject({ lastTurn: { id: "turn-1", status: "completed" } });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(await registry(entry)).toMatchObject({ lastTurn: { id: "turn-1", status: "completed" } });
  });

  it("hands the thread's approvals to the sink and answers with its decision", async () => {
    const entry = await launched();
    fakes[0].send({ id: 7, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", turnId: "turn-1", itemId: "i1", command: "touch x" } });
    fakes[0].send({ id: 8, method: "item/commandExecution/requestApproval", params: { threadId: "another", turnId: "t", itemId: "i2" } });
    await until(() => requests.length === 1, "the approval");
    expect(requests[0]).toMatchObject({ target, method: "item/commandExecution/requestApproval" });
    requests[0].answer({ decision: "accept" });
    await until(() => fakes[0].received.some(message => message.id === 7 && !message.method), "the answer");
    expect(fakes[0].received.find(message => message.id === 7 && !message.method)).toEqual({ id: 7, result: { decision: "accept" } });
    fakes[0].send({ method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: 9 } });
    await until(() => resolved.length === 1, "the resolution");
    expect(resolved[0]).toEqual({ target, requestId: 9 });
    expect(entry.threadId).toBe("thread-1");
  });

  it("steers an answer into the running turn, starts one when that turn has ended, and answers parked questions", async () => {
    const entry = await launched();
    fakes[0].running = "turn-5";
    fakes[0].send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-5" } } });
    await until(() => entry.activeTurn === "turn-5", "the running turn");
    expect(await servers.steer(entry, "an answer")).toEqual({ turnId: "turn-5" });
    expect(fakes[0].sent("turn/steer")[0].params).toEqual({ threadId: "thread-1", expectedTurnId: "turn-5", input: [{ type: "text", text: "an answer", text_elements: [] }] });
    expect(fakes[0].sent("turn/start")).toEqual([]);
    fakes[0].running = undefined;
    expect(await servers.steer(entry, "a late answer")).toEqual({ turnId: "turn-1" });
    expect(fakes[0].sent("turn/start")[0].params).toMatchObject({ threadId: "thread-1", input: [{ type: "text", text: "a late answer" }] });

    fakes[0].send({ id: 21, method: "item/tool/requestUserInput", params: { threadId: "thread-1", turnId: "turn-5", itemId: "i", isBlocking: true, questions: [] } });
    fakes[0].send({ id: 22, method: "item/tool/requestUserInput", params: { threadId: "another", turnId: "t", itemId: "j", isBlocking: true, questions: [] } });
    fakes[0].send({ id: 23, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", turnId: "turn-5", itemId: "k" } });
    await until(() => requests.length === 2, "the thread's question and approval");
    expect(servers.questions(entry).map(request => request.requestId)).toEqual([21]);
    expect(servers.answerQuestion(entry, 21, { answers: {} })).toBe(true);
    await until(() => fakes[0].received.some(message => message.id === 21 && !message.method), "the answer");
    expect(fakes[0].received.find(message => message.id === 21 && !message.method)).toEqual({ id: 21, result: { answers: {} } });
    expect(servers.answerQuestion(entry, 21, { answers: {} })).toBe(false);
  });

  it("declines parked requests before interrupting the running turn", async () => {
    const entry = await launched();
    expect(await servers.interrupt(entry)).toBe(false);
    fakes[0].send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-4" } } });
    fakes[0].send({ id: 3, method: "item/fileChange/requestApproval", params: { threadId: "thread-1", turnId: "turn-4", itemId: "i" } });
    await until(() => requests.length === 1 && entry.activeTurn === "turn-4", "the parked request");
    expect(await servers.interrupt(entry)).toBe(true);
    const order = fakes[0].received.filter(message => message.id === 3 || message.method === "turn/interrupt");
    expect(order[0]).toEqual({ id: 3, result: { decision: "cancel" } });
    expect(order[1]).toMatchObject({ method: "turn/interrupt", params: { threadId: "thread-1", turnId: "turn-4" } });
    expect(resolved).toEqual([{ target, requestId: 3 }]);
  });
});

describe.skipIf(process.platform === "win32")("a restarted Hook", () => {
  it("rejoins a running server's thread and forgets a dead one", async () => {
    const entry = await launched();
    entry.activeTurn = "turn-9";
    await writeFile(path.join(codexServersRoot(), entry.id, "server.json"), JSON.stringify(entry));
    const dead = { ...entry, id: "0123456789ab", pid: 999, socket: path.join(codexServersRoot(), "0123456789ab", "app.sock") };
    await mkdir(path.dirname(dead.socket), { recursive: true });
    await writeFile(path.join(codexServersRoot(), dead.id, "server.json"), JSON.stringify(dead));
    servers.reset();
    fakes[0].threadStatus = "active";
    await servers.adopt();
    expect(servers.entries().map(item => item.id)).toEqual([entry.id]);
    expect(fakes[0].sent("thread/resume").at(-1)?.params).toEqual({ excludeTurns: true, threadId: "thread-1" });
    expect(servers.forThread("thread-1")?.activeTurn).toBe("turn-9");
    await expect(stat(path.join(codexServersRoot(), dead.id))).rejects.toThrow();
    // A replayed approval reaches the new client.
    fakes[0].send({ id: 2, method: "item/permissions/requestApproval", params: { threadId: "thread-1", turnId: "turn-9", itemId: "p" } });
    await until(() => requests.length === 1, "the replayed approval");
  });

  it("clears a turn that ended while no Hook listened", async () => {
    const entry = await launched();
    entry.activeTurn = "turn-9";
    await writeFile(path.join(codexServersRoot(), entry.id, "server.json"), JSON.stringify(entry));
    servers.reset();
    await servers.adopt();
    expect(servers.forThread("thread-1")?.activeTurn).toBeUndefined();
  });
});

describe.skipIf(process.platform === "win32")("reaping", () => {
  const pane = (agent?: string) => ({ panes: [{ pane_id: "w1:p1", ...(agent ? { agent } : {}) }] });

  it("stops the server when its pane closes", async () => {
    const entry = await launched();
    await servers.reap("default", pane("codex"));
    expect(servers.entries()).toHaveLength(1);
    await servers.reap("other", { panes: [] });
    expect(servers.entries()).toHaveLength(1);
    await servers.reap("default", { panes: [] });
    expect(killed).toEqual([4242]);
    expect(servers.entries()).toEqual([]);
    await expect(stat(path.join(codexServersRoot(), entry.id))).rejects.toThrow();
  });

  it("stops the server after its pane has shown no Codex for two minutes", async () => {
    await launched();
    await servers.reap("default", pane(), 1_000);
    await servers.reap("default", pane(), 60_000);
    expect(killed).toEqual([]);
    await servers.reap("default", pane("codex"), 90_000);
    await servers.reap("default", pane(), 100_000);
    await servers.reap("default", pane(), 219_999);
    expect(killed).toEqual([]);
    await servers.reap("default", pane(), 220_000);
    expect(killed).toEqual([4242]);
  });

  it("stops a server whose terminal server has been gone for two minutes", async () => {
    await launched();
    await servers.sweep(["default"], 0);
    await servers.sweep([], 1_000);
    await servers.sweep([], 120_999);
    expect(killed).toEqual([]);
    await servers.sweep([], 121_000);
    expect(killed).toEqual([4242]);
    expect(servers.entries()).toEqual([]);
  });

  it("forgets a server whose process ended", async () => {
    await launched();
    alive.clear();
    await servers.reap("default", pane("codex"));
    expect(servers.entries()).toEqual([]);
    expect(killed).toEqual([]);
  });
});
