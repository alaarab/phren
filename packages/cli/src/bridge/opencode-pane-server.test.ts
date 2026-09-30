import { afterEach, expect, it } from "vitest";
import * as http from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  freePort, listPaneServers, newPassword, openPaneClient, PromptNotSent, readPaneServer, registerPaneServer, removePaneServer,
  type PaneServerEntry,
} from "./opencode-pane-server.js";

const PASSWORD = "pw-abc123";
const DIRECTORY = "/tmp/phren-project";
const auth = "Basic " + Buffer.from(`opencode:${PASSWORD}`).toString("base64");

interface Seen { method: string; pathname: string; directory: string | null; auth: string | undefined }

interface Fake {
  port: number;
  seen: Seen[];
  sessions: unknown[];
  messages: unknown[];
  permissions: unknown[];
  questions: unknown[];
  promptBodies: unknown[];
  permissionBodies: unknown[];
  questionBodies: unknown[];
  abortPaths: string[];
  created: unknown[];
  selected: unknown[];
  patched: Array<{ pathname: string; body: unknown }>;
  rejectedQuestions: string[];
  /** A status the prompt route answers with instead of accepting. */
  refusePrompt?: number;
  unauthorized: number;
  /** When false the server accepts a prompt but never records a user message. */
  echoPrompt: boolean;
  close(): Promise<void>;
}

const roots: string[] = [];
const running: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map(server => server.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

/** A stand-in for the OpenCode TUI's HTTP server: it rejects any request whose
 * Basic auth or `directory` query does not match, and records what it got. */
async function startFake(): Promise<Fake> {
  const fake: Fake = { port: 0, seen: [], sessions: [], messages: [], permissions: [], questions: [],
    promptBodies: [], permissionBodies: [], questionBodies: [], abortPaths: [], created: [], selected: [], patched: [], rejectedQuestions: [], unauthorized: 0, echoPrompt: true,
    close: () => new Promise(resolve => server.close(() => resolve())) };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => raw += chunk);
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://fake");
      fake.seen.push({ method: req.method ?? "", pathname: url.pathname, directory: url.searchParams.get("directory"), auth: req.headers.authorization });
      if (req.headers.authorization !== auth || url.searchParams.get("directory") !== DIRECTORY) {
        fake.unauthorized += 1;
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end("unauthorized");
        return;
      }
      const body = raw ? JSON.parse(raw) : undefined;
      const messages = /^\/session\/([^/]+)\/message$/.exec(url.pathname);
      const prompt = /^\/session\/([^/]+)\/prompt_async$/.exec(url.pathname);
      const abort = /^\/session\/([^/]+)\/abort$/.exec(url.pathname);
      const permission = /^\/permission\/([^/]+)\/reply$/.exec(url.pathname);
      const question = /^\/question\/([^/]+)\/reply$/.exec(url.pathname);
      if (req.method === "GET" && url.pathname === "/session") { res.end(JSON.stringify(fake.sessions)); return; }
      if (req.method === "POST" && url.pathname === "/session") { fake.created.push(body); res.end(JSON.stringify({ id: "ses_created", directory: DIRECTORY })); return; }
      if (req.method === "POST" && url.pathname === "/tui/select-session") { fake.selected.push(body); res.end("true"); return; }
      const one = /^\/session\/([^/]+)$/.exec(url.pathname);
      if (req.method === "PATCH" && one) { fake.patched.push({ pathname: url.pathname, body }); res.end(JSON.stringify({ id: one[1], title: (body as { title: string }).title })); return; }
      if (req.method === "GET" && one) {
        const found = (fake.sessions as Array<{ id: string }>).find(value => value.id === one[1]);
        if (!found) { res.writeHead(404); res.end("{}"); return; }
        res.end(JSON.stringify(found)); return;
      }
      const reject = /^\/question\/([^/]+)\/reject$/.exec(url.pathname);
      if (req.method === "POST" && reject) { fake.rejectedQuestions.push(reject[1]); res.end("true"); return; }
      if (req.method === "GET" && messages) { res.end(JSON.stringify(fake.messages)); return; }
      if (req.method === "POST" && prompt) {
        if (fake.refusePrompt) { res.writeHead(fake.refusePrompt); res.end("{}"); return; }
        fake.promptBodies.push(body);
        if (fake.echoPrompt) fake.messages.push({ info: { id: "msg_new", role: "user" }, parts: body.parts });
        res.writeHead(204); res.end(); return;
      }
      if (req.method === "POST" && abort) { fake.abortPaths.push(url.pathname); res.end("true"); return; }
      if (req.method === "GET" && url.pathname === "/permission") { res.end(JSON.stringify(fake.permissions)); return; }
      if (req.method === "POST" && permission) { fake.permissionBodies.push(body); res.end("true"); return; }
      if (req.method === "GET" && url.pathname === "/question") { res.end(JSON.stringify(fake.questions)); return; }
      if (req.method === "POST" && question) { fake.questionBodies.push(body); res.end("true"); return; }
      if (req.method === "GET" && url.pathname === "/event") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const first = 'data: {"type":"server.connected","properties":{"n":1}}\n\n';
        const second = 'data: {"type":"session.status","properties":{"n":2}}\n\n';
        // Three writes with yields in between so the parser sees the frames
        // split across chunks rather than one buffer.
        res.write(first + second.slice(0, 20));
        setImmediate(() => {
          res.write(second.slice(20, 40));
          setImmediate(() => res.end(second.slice(40)));
        });
        return;
      }
      res.writeHead(404); res.end("{}");
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  fake.port = (server.address() as { port: number }).port;
  running.push(fake);
  return fake;
}

function baseEntry(overrides: Partial<PaneServerEntry> = {}): PaneServerEntry {
  return { server: "default", pane: "w1:p1", port: 4096, password: PASSWORD, pid: process.pid,
    directory: DIRECTORY, createdAt: new Date().toISOString(), ...overrides };
}

function entryFor(fake: Fake, overrides: Partial<PaneServerEntry> = {}): PaneServerEntry {
  return baseEntry({ port: fake.port, ...overrides });
}

it("registers a pane server, reads it back, and removes it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "phren-oc-pane-")); roots.push(dir);
  const entry = baseEntry();
  const file = registerPaneServer(dir, entry);
  // Windows reports no POSIX modes (a file reads back as 0o666).
  if (process.platform !== "win32") {
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  }
  expect(readPaneServer(dir, "default", "w1:p1")).toEqual(entry);
  removePaneServer(dir, "default", "w1:p1");
  expect(readPaneServer(dir, "default", "w1:p1")).toBeUndefined();
});

it("returns undefined for a missing entry and for a dead pid", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "phren-oc-pane-")); roots.push(dir);
  expect(readPaneServer(dir, "default", "w1:p1")).toBeUndefined();
  registerPaneServer(dir, baseEntry({ pid: 2_147_483_647 }));
  expect(readPaneServer(dir, "default", "w1:p1")).toBeUndefined();
});

it("rejects unsafe server and pane segments", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "phren-oc-pane-")); roots.push(dir);
  expect(() => registerPaneServer(dir, baseEntry({ pane: "../escape" }))).toThrow("Invalid");
  expect(() => registerPaneServer(dir, baseEntry({ server: "a/b" }))).toThrow("Invalid");
  expect(() => registerPaneServer(dir, baseEntry({ port: 0 }))).toThrow("Invalid");
  expect(readPaneServer(dir, "default", "../escape")).toBeUndefined();
});

it("mints free ports and passwords", async () => {
  const port = await freePort();
  expect(port).toBeGreaterThan(0);
  expect(port).toBeLessThanOrEqual(65_535);
  expect(newPassword()).toMatch(/^[0-9A-Za-z_-]{43}$/);
});

it("confirms a prompt once the new user message lands", async () => {
  const fake = await startFake();
  const client = openPaneClient(entryFor(fake));
  const result = await client.prompt("ses_1", "hello world", { model: "openrouter/anthropic/claude", agent: "build" });
  expect(result).toEqual({ delivered: true, messageId: "msg_new" });
  expect(fake.promptBodies).toEqual([{ model: { providerID: "openrouter", modelID: "anthropic/claude" }, agent: "build",
    parts: [{ type: "text", text: "hello world" }] }]);
});

it("renames a session with PATCH /session/{id} and returns the title the server holds", async () => {
  const fake = await startFake();
  const client = openPaneClient(entryFor(fake));
  expect(await client.setTitle("ses_1", "Tide charts")).toBe("Tide charts");
  expect(fake.patched).toEqual([{ pathname: "/session/ses_1", body: { title: "Tide charts" } }]);
});

it("reports a timeout when no new user message arrives", async () => {
  const fake = await startFake();
  const client = openPaneClient(entryFor(fake));
  fake.echoPrompt = false;
  const result = await client.prompt("ses_1", "hello world", { timeoutMs: 120 });
  expect(result).toEqual({ delivered: false, reason: "timeout" });
});

it("throws with the status when the password is wrong", async () => {
  const fake = await startFake();
  const client = openPaneClient(entryFor(fake, { password: "wrong" }));
  await expect(client.sessions()).rejects.toThrow(/failed with 401/);
  expect(fake.unauthorized).toBe(1);
});

it("sends the permission reply body shape and the abort route", async () => {
  const fake = await startFake();
  const client = openPaneClient(entryFor(fake));
  await client.replyPermission("per_1", "reject", "not this time");
  await client.replyPermission("per_2", "once");
  await client.replyPermission("per_3", "always");
  await client.abort("ses_9");
  expect(fake.permissionBodies).toEqual([{ reply: "reject", message: "not this time" }, { reply: "once" }, { reply: "always" }]);
  expect(fake.abortPaths).toEqual(["/session/ses_9/abort"]);
});

it("lists and answers structured questions", async () => {
  const fake = await startFake();
  fake.questions = [{ id: "que_1", sessionID: "ses_1", questions: [{ question: "Which?", header: "Pick", options: [{ label: "A" }] }] }];
  const client = openPaneClient(entryFor(fake));
  expect(await client.questions()).toEqual(fake.questions);
  await client.replyQuestion("que_1", [["A"]]);
  expect(fake.questionBodies).toEqual([{ answers: [["A"]] }]);
});

it("parses SSE events split across chunks", async () => {
  const fake = await startFake();
  const client = openPaneClient(entryFor(fake));
  const events = [];
  for await (const event of client.events()) events.push(event);
  expect(events).toEqual([
    { type: "server.connected", properties: { n: 1 } },
    { type: "session.status", properties: { n: 2 } },
  ]);
});

it("takes the most recent root session, never a subagent's, and asks for recent messages only", async () => {
  const fake = await startFake();
  fake.sessions = [
    { id: "ses_root_old", directory: DIRECTORY, time: { updated: 1 } },
    { id: "ses_root", directory: DIRECTORY, time: { updated: 5 } },
    { id: "ses_child", parentID: "ses_root", directory: DIRECTORY, time: { updated: 9 } },
  ];
  const client = openPaneClient(entryFor(fake));
  expect((await client.currentSession())?.id).toBe("ses_root");
  expect(await client.prompt("ses_root", "  hello  ", { timeoutMs: 1_000 })).toEqual({ delivered: true, messageId: "msg_new" });
});

it("lists live entries and removes those whose process is gone", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "phren-oc-pane-")); roots.push(dir);
  registerPaneServer(dir, baseEntry());
  const dead = registerPaneServer(dir, baseEntry({ pane: "w1:p2", pid: 2_147_483_647 }));
  expect(listPaneServers(dir).map(entry => entry.pane)).toEqual(["w1:p1"]);
  await expect(stat(dead)).rejects.toThrow();
  expect(listPaneServers(path.join(dir, "missing"))).toEqual([]);
});

it("creates a session, moves the TUI onto it, and reads one session", async () => {
  const fake = await startFake();
  fake.sessions = [{ id: "ses_root", directory: DIRECTORY }, { id: "ses_child", parentID: "ses_root" }];
  const client = openPaneClient(entryFor(fake));
  expect(await client.ready()).toBe(true);
  expect((await client.createSession()).id).toBe("ses_created");
  await client.selectSession("ses_created");
  expect(fake.selected).toEqual([{ sessionID: "ses_created" }]);
  expect((await client.session("ses_child"))?.parentID).toBe("ses_root");
  expect(await client.session("ses_missing")).toBeUndefined();
  await client.rejectQuestion("que_1");
  expect(fake.rejectedQuestions).toEqual(["que_1"]);
});

it("is not ready while nothing answers or the password is wrong", async () => {
  const fake = await startFake();
  expect(await openPaneClient(entryFor(fake, { password: "wrong" })).ready()).toBe(false);
  expect(await openPaneClient(baseEntry({ port: await freePort() })).ready(300)).toBe(false);
});

it("continues with the last user turn's agent, model and variant", async () => {
  const fake = await startFake();
  fake.messages = [
    { info: { id: "msg_1", role: "user", agent: "conductor", model: { providerID: "opencode-go", modelID: "deepseek-v4.1-flash", variant: "high" } }, parts: [] },
    { info: { id: "msg_2", role: "assistant" }, parts: [] },
  ];
  const client = openPaneClient(entryFor(fake));
  await client.prompt("ses_1", "next", { inherit: true, timeoutMs: 500 });
  expect(fake.promptBodies[0]).toEqual({ parts: [{ type: "text", text: "next" }], agent: "conductor",
    model: { providerID: "opencode-go", modelID: "deepseek-v4.1-flash" }, variant: "high" });
  await client.prompt("ses_1", "explicit", { inherit: true, agent: "build", timeoutMs: 500 });
  expect(fake.promptBodies[1]).toEqual({ parts: [{ type: "text", text: "explicit" }], agent: "build" });
});

it("says a refused or unheard prompt was never sent", async () => {
  const fake = await startFake();
  fake.refusePrompt = 400;
  await expect(openPaneClient(entryFor(fake)).prompt("ses_1", "hi")).rejects.toBeInstanceOf(PromptNotSent);
  await expect(openPaneClient(baseEntry({ port: await freePort() })).prompt("ses_1", "hi")).rejects.toBeInstanceOf(PromptNotSent);
});
