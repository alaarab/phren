import { afterEach, beforeEach, expect, it } from "vitest";
import * as http from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { paneClient, servedPane } from "./opencode-panes.js";
import {
  bindServicePane, commandSession, materializeOpencodeSession, opencodeServiceSession, opencodeServiceStatus, resetOpencodeService,
  serviceLaunchArgs, switchOpencodeModel,
} from "./opencode-service.js";

// Shapes are the ones OpenCode 2.3.0's service returned on 2026-11-17.
const PASSWORD = "pw-service";
const auth = "Basic " + Buffer.from(`opencode:${PASSWORD}`).toString("base64");
const ROOT = "ses_e1439b8daffewluQBSB9HJjrG9", CHILD = "ses_e14396524ffeJNfYQ5sUd6fQ5J", OTHER = "ses_e161e786effeQ5XZ0AtGsXOPk9";
const DIRECTORY = "/home/owner/Projects/app";

interface Fake {
  sessions: Record<string, unknown>[];
  messages: Record<string, Record<string, unknown>[]>;
  permissions: Record<string, unknown>[];
  forms: Record<string, unknown>[];
  calls: Array<{ method: string; path: string; query: string; body?: unknown }>;
  events: string[];
}

let fake: Fake, server: http.Server, home: string;
const saved = { state: process.env.XDG_STATE_HOME, bridge: process.env.PHREN_BRIDGE_HOME, off: process.env.PHREN_OPENCODE_SERVICE };

beforeEach(async () => {
  fake = { sessions: [], messages: {}, permissions: [], forms: [], calls: [], events: [] };
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => raw += chunk);
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://fake"), method = req.method ?? "";
      const body = raw ? JSON.parse(raw) : undefined;
      fake.calls.push({ method, path: url.pathname, query: url.search, ...(body === undefined ? {} : { body }) });
      const reply = (status: number, value?: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(value === undefined ? "" : JSON.stringify(value)); };
      if (req.headers.authorization !== auth) return reply(401, {});
      const one = /^\/api\/session\/(ses_\w+)(\/.*)?$/.exec(url.pathname);
      const found = one ? fake.sessions.find(value => value.id === one[1]) : undefined;
      if (url.pathname === "/api/event") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: {"id":"evt_1","type":"server.connected","data":{}}\n\n: heartbeat\n\n`);
        for (const event of fake.events) res.write(`data: ${event}\n\n`);
        return res.end();
      }
      if (url.pathname === "/api/info") return reply(200, { version: "2.3.0", pid: process.pid });
      if (url.pathname === "/api/session" && method === "GET") return reply(200, { data: fake.sessions.filter(value => !value.parentID), cursor: {} });
      if (url.pathname === "/api/permission/request") return reply(200, { location: { directory: DIRECTORY }, data: fake.permissions });
      if (url.pathname === "/api/form") return reply(200, { location: { directory: DIRECTORY }, data: fake.forms });
      if (!one || !found) return reply(404, { error: "not found" });
      const rest = one[2] ?? "";
      if (!rest && method === "GET") return reply(200, { data: found });
      if (!rest && method === "PATCH") { Object.assign(found, body); return reply(204); }
      if (rest === "/message") return reply(200, { data: fake.messages[one[1]] ?? [], cursor: {} });
      if (rest === "/prompt") return reply(200, { data: { id: "msg_1ebc64b1b001nb0I71I2P7WERe", sessionID: one[1], type: "user", payload: body, delivery: "steer" } });
      if (rest === "/model") { found.model = (body as { model: unknown }).model; return reply(204); }
      if (rest === "/interrupt") return reply(200, { interrupted: true });
      return reply(204);
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  home = await mkdtemp(path.join(tmpdir(), "phren-oc2-"));
  await mkdir(path.join(home, "opencode"), { recursive: true });
  const port = (server.address() as { port: number }).port;
  await writeFile(path.join(home, "opencode", "service.json"), JSON.stringify({ id: "x", version: "2.3.0", url: `http://127.0.0.1:${port}`, pid: process.pid, password: PASSWORD }));
  process.env.XDG_STATE_HOME = home; process.env.PHREN_BRIDGE_HOME = path.join(home, "bridge"); process.env.PHREN_OPENCODE_SERVICE = "on";
  await mkdir(process.env.PHREN_BRIDGE_HOME, { recursive: true });
  resetOpencodeService();
});

afterEach(async () => {
  await new Promise(resolve => server.close(resolve));
  await rm(home, { recursive: true, force: true });
  for (const [key, value] of [["XDG_STATE_HOME", saved.state], ["PHREN_BRIDGE_HOME", saved.bridge], ["PHREN_OPENCODE_SERVICE", saved.off]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  resetOpencodeService();
});

const session = (id: string, title: string | undefined, extra: Record<string, unknown> = {}) => ({ id, ...(title ? { title } : {}),
  time: { created: 1794957002535, updated: 1794957006213 }, location: { directory: DIRECTORY }, ...extra });
const pane = (title: string, id = "p1") => ({ pane_id: id, terminal_title_stripped: title, cwd: DIRECTORY });

/** The pane bound to ROOT, and its client. */
async function boundClient() {
  fake.sessions.push(session(ROOT, "Fix the login page"));
  expect(await opencodeServiceSession("default", pane("OC | Fix the login page"))).toBe(ROOT);
  return paneClient(servedPane("default", "p1")!);
}

it("binds a pane to the one conversation its terminal title names", async () => {
  fake.sessions.push(session(ROOT, "Fix the login page"), session(OTHER, "A title that runs well past the forty characters the TUI shows"));
  expect(await opencodeServiceSession("default", pane("OC | Fix the login page"))).toBe(ROOT);
  expect(servedPane("default", "p1")).toMatchObject({ api: 2, session: ROOT, directory: DIRECTORY });
  // The TUI cuts a long title to 37 characters and an ellipsis.
  expect(await opencodeServiceSession("default", pane("OC | A title that runs well past the forty…", "p2"))).toBe(OTHER);
  // A pane with no conversation of its own yet shows the plain name.
  expect(await opencodeServiceSession("default", pane("OpenCode", "p3"))).toBeUndefined();
  expect(servedPane("default", "p3")).toBeUndefined();
});

it("leaves a pane unbound when two conversations share its title, unless it was started on one", async () => {
  fake.sessions.push(session(ROOT, "Same title"), session(OTHER, "Same title"));
  expect(await opencodeServiceSession("default", pane("OC | Same title"))).toBeUndefined();
  expect(servedPane("default", "p1")).toBeUndefined();
  expect(await opencodeServiceSession("default", pane("OC | Same title"), async () => [`opencode --session ${OTHER}`])).toBe(OTHER);
  expect(commandSession("opencode -s not-a-session")).toBeUndefined();
  expect(commandSession(`vim --session ${ROOT}`)).toBeUndefined();
});

it("keeps a pane the Hook started on its conversation until a title names another", async () => {
  fake.sessions.push(session(ROOT, undefined), session(OTHER, "Another conversation"));
  await opencodeServiceSession("default", pane("OpenCode"));
  expect(bindServicePane("default", "p1", ROOT, DIRECTORY)).toMatchObject({ session: ROOT });
  // A launcher shim can hide the command line; the untitled pane still shows what it was started on.
  expect(await opencodeServiceSession("default", pane("OpenCode"))).toBe(ROOT);
  expect(await opencodeServiceSession("default", pane("OC | Another conversation"))).toBe(OTHER);
});

it("sends a prompt into the conversation and reports the service's own receipt", async () => {
  const client = await boundClient();
  expect(await client.prompt(ROOT, "run the tests")).toEqual({ delivered: true, messageId: "msg_1ebc64b1b001nb0I71I2P7WERe" });
  expect(fake.calls.find(call => call.path.endsWith("/prompt"))).toMatchObject({ method: "POST", path: `/api/session/${ROOT}/prompt`, body: { text: "run the tests" } });
});

it("lists only its own conversation's permission asks and answers the session that asked", async () => {
  const client = await boundClient();
  fake.sessions.push(session(CHILD, "subagent", { parentID: ROOT }), session(OTHER, "Someone else's"));
  fake.permissions.push(
    { id: "per_1ebc6ae7e001qnqiklM5TYncmT", sessionID: CHILD, action: "shell", resources: ["touch probe2.txt"], save: ["touch *"] },
    { id: "per_other", sessionID: OTHER, action: "edit", resources: ["a.ts"] });
  const asks = await client.permissions();
  expect(asks).toEqual([{ id: "per_1ebc6ae7e001qnqiklM5TYncmT", sessionID: CHILD, permission: "shell", patterns: ["touch probe2.txt"], metadata: { command: "touch probe2.txt" } }]);
  expect(fake.calls.find(call => call.path === "/api/permission/request")?.query).toBe(`?location%5Bdirectory%5D=${encodeURIComponent(DIRECTORY)}`);
  await client.replyPermission("per_1ebc6ae7e001qnqiklM5TYncmT", "once");
  expect(fake.calls.at(-1)).toMatchObject({ method: "POST", path: `/api/session/${CHILD}/permission/per_1ebc6ae7e001qnqiklM5TYncmT/reply`, body: { decision: "once" } });
  await expect(client.replyPermission("per_other", "once")).rejects.toThrow();
});

it("shows a question form as questions and answers each field by its option's value", async () => {
  const client = await boundClient();
  fake.forms.push({ id: "frm_1ebc65188001soLZ1BQNzhl69C", sessionID: ROOT, title: "Questions", metadata: { kind: "question" }, fields: [
    { key: "q0", title: "Choose a color", description: "Please choose one: Red or Blue?", type: "string", custom: true,
      options: [{ value: "red", label: "Red", description: "Pick the color red" }, { value: "blue", label: "Blue" }] },
    { key: "q1", title: "Sizes", description: "Which sizes?", type: "multiselect", options: [{ value: "S", label: "Small" }, { value: "L", label: "Large" }] }] },
  // A sign-in form is not a question the phone can show: it stays in the TUI.
  { id: "frm_login", sessionID: ROOT, title: "Sign in", metadata: { kind: "auth" }, fields: [{ key: "token", type: "string" }] });
  expect(await client.questions()).toEqual([{ id: "frm_1ebc65188001soLZ1BQNzhl69C", sessionID: ROOT, questions: [
    { question: "Please choose one: Red or Blue?", header: "Choose a color", multiple: false,
      options: [{ label: "Red", description: "Pick the color red" }, { label: "Blue" }] },
    { question: "Which sizes?", header: "Sizes", multiple: true, options: [{ label: "Small" }, { label: "Large" }] }] }]);
  await client.replyQuestion("frm_1ebc65188001soLZ1BQNzhl69C", [["Blue"], ["Small", "Large"]]);
  expect(fake.calls.at(-1)).toMatchObject({ method: "POST", path: `/api/session/${ROOT}/form/frm_1ebc65188001soLZ1BQNzhl69C/reply`, body: { answer: { q0: "blue", q1: ["S", "L"] } } });
  // Declining one cancels the form.
  await client.questions();
  await client.rejectQuestion("frm_1ebc65188001soLZ1BQNzhl69C");
  expect(fake.calls.at(-1)).toMatchObject({ method: "DELETE", path: `/api/session/${ROOT}/form/frm_1ebc65188001soLZ1BQNzhl69C` });
});

it("interrupts, renames and names the events it streams", async () => {
  const client = await boundClient();
  expect(await client.abort(ROOT)).toBe(true);
  expect(await client.setTitle(ROOT, "Login page")).toBe("Login page");
  fake.events.push(`{"id":"evt_2","type":"permission.asked","location":{"directory":"${DIRECTORY}"},"data":{"id":"per_1","sessionID":"${ROOT}"}}`);
  const seen: string[] = [];
  for await (const event of client.events()) seen.push(event.type);
  expect(seen).toEqual(["server.connected", "permission.asked"]);
});

it("switches the conversation's model and reports what the service holds", async () => {
  await boundClient();
  const entry = servedPane("default", "p1")!;
  expect(await switchOpencodeModel(entry, "opencode-go/glm-5.3", "high")).toEqual({ id: "opencode-go/glm-5.3", variant: "high" });
  expect(fake.calls.find(call => call.path.endsWith("/model"))?.body).toEqual({ model: { providerID: "opencode-go", id: "glm-5.3", variant: "high" } });
  await expect(switchOpencodeModel(entry, "glm-5.3")).rejects.toThrow();
});

it("says whether the conversation is at work from the service's own times", async () => {
  fake.sessions.push(session(ROOT, "Busy", { time: { created: 1, updated: 2, busy: 1794957003553, idle: 1794957000000 } }),
    session(OTHER, "Resting", { time: { created: 1, updated: 2, busy: 1794957003553, idle: 1794957006218 } }));
  expect(await opencodeServiceStatus(ROOT)).toBe("working");
  expect(await opencodeServiceStatus(OTHER)).toBe("idle");
  expect(await opencodeServiceStatus("ses_unknown0000000000000000000")).toBeUndefined();
});

it("writes a conversation as the event log the transcript readers take", async () => {
  fake.sessions.push(session(ROOT, "Fix the login page", { time: { created: 1794957002535, updated: 1794957006213, busy: 1794957003553, idle: 1794957006218 } }));
  const model = { id: "glm-5.3", providerID: "opencode-go", variant: "default" };
  // The service lists newest first.
  fake.messages[ROOT] = [
    { id: "msg_5", type: "idle", time: { created: 1794957006218 }, outcome: "succeeded" },
    { id: "msg_4", type: "assistant", time: { created: 1794957005700, completed: 1794957005800 }, agent: "build", model: { id: "gpt-6.2-sol", providerID: "opencode" },
      content: [], finish: "error", error: { type: "provider.quota", message: "Insufficient balance." } },
    { id: "msg_3", type: "assistant", time: { created: 1794957005584, completed: 1794957005650 }, agent: "build", model, finish: "stop", tokens: { input: 239, output: 3 },
      content: [{ type: "reasoning", text: "The user chose Blue." }, { type: "text", text: "done" }] },
    { id: "msg_2", type: "assistant", time: { created: 1794957003567, completed: 1794957005572 }, agent: "build", model, finish: "tool-calls",
      content: [{ type: "tool", id: "call_f801", name: "shell", state: { status: "completed", input: { command: "touch probe.txt" }, content: [{ type: "text", text: "(no output)" }] } }] },
    { id: "msg_1", type: "user", time: { created: 1794957003559 }, text: "touch a file" },
    { id: "msg_0", type: "model-switched", time: { created: 1794957002540 }, model },
  ];
  const file = await materializeOpencodeSession(ROOT);
  const rows = (await readFile(file!, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(rows.map(row => row.type)).toEqual(["user/message", "assistant/message", "tool/results", "assistant/message", "assistant/message"]);
  expect(rows[0].data.message.content).toEqual([{ type: "text", text: "touch a file" }]);
  expect(rows[1].data).toMatchObject({ stop_reason: "tool_use", message: { model: "opencode-go/glm-5.3",
    content: [{ type: "tool_use", id: "call_f801", name: "shell", input: { command: "touch probe.txt" } }] } });
  expect(rows[2].data.message.content).toEqual([{ type: "tool_result", tool_use_id: "call_f801", content: "(no output)", is_error: false }]);
  // Reasoning stays on the computer; the answer and its usage are kept.
  expect(rows[3].data).toMatchObject({ stop_reason: "end_turn", usage: { input_tokens: 239, output_tokens: 3 }, message: { content: [{ type: "text", text: "done" }] } });
  // A turn the provider refused shows why instead of nothing.
  expect(rows[4].data.message.content).toEqual([{ type: "text", text: "OpenCode could not finish this turn: Insufficient balance." }]);
  expect(await materializeOpencodeSession("ses_unknown0000000000000000000")).toBeUndefined();
});

it("moves a 1.x launch's model, agent and variant flags off the command line", () => {
  expect(serviceLaunchArgs(["--model", "opencode-go/glm-5.3", "--agent", "conductor", "--variant", "high", "--auto"]))
    .toEqual({ args: ["--auto"], model: "opencode-go/glm-5.3", agent: "conductor", variant: "high" });
});
