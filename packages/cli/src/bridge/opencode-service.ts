import { execFile } from "node:child_process";
import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { homeDir } from "../home-paths.js";
import {
  type OpenCodePermission, type OpenCodeQuestion, type OpenCodeSession, type PaneClient, type PaneEvent, type PaneServerEntry,
  PromptNotSent,
} from "./opencode-pane-server.js";
import { atomic, bridgeRoot, object, objects, type Json } from "./protocol.js";

/** OpenCode 2 (`@opencode/cli`) runs one background service per user, and the
 * `opencode` in a pane is only a client of it. No plugin runs in the pane's
 * process, so the Hook asks the service which conversation a pane shows,
 * writes that conversation as the event log phren's OpenCode plugin wrote for
 * 1.x (which every transcript reader already takes), and drives the pane over
 * the service's API through the same `PaneClient` a 1.x pane the Hook started
 * serves: prompts, permission asks, questions, interrupt, rename and the model.
 *
 * Routes and bodies are the service's own spec (`GET /openapi.json`, read on
 * 2.3.0): `/api/session`, `/api/session/{id}/message|prompt|model|interrupt`,
 * `/api/permission/request`, `/api/session/{id}/permission/{id}/reply`,
 * `/api/form`, `/api/session/{id}/form/{id}/reply` and `/api/event`. */

const SESSION = /^ses_[0-9A-Za-z]{1,64}$/;
const MAX_TOOL_OUTPUT = 200_000;
const REQUEST_TIMEOUT_MS = 10_000;
const STOP_REASONS: Record<string, string> = { stop: "end_turn", "tool-calls": "tool_use", length: "max_tokens" };

export interface OpencodeService { url: URL; port: number; password: string; pid: number; version: string; authorization: string }

const stateFile = () => path.join(process.env.XDG_STATE_HOME || path.join(homeDir(), ".local", "state"), "opencode", "service.json");
const basic = (password: string) => `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;

/** Signal 0 only checks existence; EPERM still means the process is alive. */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** The service last read from its state file, for the callers that cannot wait on a read. */
let known: OpencodeService | undefined;

/** The running service, from the state file it writes itself. Only a loopback
 * http address, and only version 2 or later (1.x has no service). */
export async function opencodeService(): Promise<OpencodeService | undefined> {
  // PHREN_OPENCODE_SERVICE=off keeps the Hook on the 1.x paths alone (the vitest config does).
  if (process.env.PHREN_OPENCODE_SERVICE === "off") return known = undefined;
  try {
    const value = object(JSON.parse(await readFile(stateFile(), "utf8")));
    if (typeof value.password !== "string" || !value.password || !(Number.parseInt(String(value.version), 10) >= 2)) return known = undefined;
    const url = new URL(String(value.url)), port = Number(url.port), pid = Number(value.pid);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return known = undefined;
    if (!Number.isInteger(port) || port < 1 || !Number.isInteger(pid) || pid < 1 || !alive(pid)) return known = undefined;
    return known = { url, port, password: value.password, pid, version: String(value.version), authorization: basic(value.password) };
  } catch { return known = undefined; }
}

async function get(live: OpencodeService, route: string, timeoutMs = 2_000): Promise<Json | undefined> {
  try {
    const response = await fetch(new URL(route, live.url), { headers: { Authorization: live.authorization }, signal: AbortSignal.timeout(timeoutMs) });
    return response.ok ? object(await response.json()) : undefined;
  } catch { return undefined; }
}

/** The service's newest root sessions, in one folder or in all of them; one
 * listing serves every pane asking the same for two seconds. */
const listings = new Map<string, { at: number; sessions: Promise<Json[]> }>();
function rootSessions(directory = ""): Promise<Json[]> {
  const cached = listings.get(directory);
  if (cached && Date.now() - cached.at < 2_000) return cached.sessions;
  const sessions = opencodeService().then(async live => live
    ? objects((await get(live, `/api/session?parentID=null&limit=100${directory ? `&directory=${encodeURIComponent(directory)}` : ""}`))?.data) : []);
  listings.delete(directory); listings.set(directory, { at: Date.now(), sessions });
  while (listings.size > 32) listings.delete(listings.keys().next().value!);
  return sessions;
}

/** `--session <id>` / `-s <id>` on an `opencode` command line: the
 * conversation the TUI was started on (the Hook starts its own panes so). */
export function commandSession(command: string): string | undefined {
  if (!/opencode/.test(command)) return undefined;
  const id = /(?:^|\s)(?:--session|-s)(?:\s+|=)(\S+)/.exec(command)?.[1];
  return id && SESSION.test(id) ? id : undefined;
}

/** What each OpenCode 2 pane was last seen showing, by server and pane. */
const bound = new Map<string, { session: string; directory: string; at: number; launched?: true }>();
const BOUND_MS = 1_800_000;
const boundKey = (server: string, pane: string) => `${server}\u0000${pane}`;

/** The conversation an OpenCode 2 pane shows. Its TUI puts the session's title
 * in the terminal title ("OC | <title>", cut to 37 characters and an ellipsis
 * past 40), and plain "OpenCode" until a session has a title of its own. One
 * session with that title in the pane's folder is the pane's; when the title
 * names none or several, the session the TUI was started on (`--session`)
 * decides, if it is one of them or the pane has no title yet. Otherwise the
 * pane stays without a conversation. */
export async function opencodeServiceSession(server: string, pane: Json, commands: () => Promise<string[]> = async () => []): Promise<string | undefined> {
  const key = boundKey(server, String(pane.pane_id)), previous = bound.get(key);
  // A pane the Hook started on a conversation keeps it until its title names one.
  const session = await shownSession(pane, commands).catch(() => undefined)
    ?? (previous?.launched && !TITLE.test(paneTitle(pane)) ? previous.session : undefined);
  const cwd = pane.foreground_cwd ?? pane.cwd;
  if (session && typeof cwd === "string" && cwd) {
    bound.delete(key);
    bound.set(key, { session, directory: cwd, at: Date.now(), ...(previous?.launched && previous.session === session ? { launched: true as const } : {}) });
    while (bound.size > 128) bound.delete(bound.keys().next().value!);
  } else bound.delete(key);
  return session;
}

const TITLE = /^OC \| (.+)$/;
const paneTitle = (pane: Json) => String(pane.terminal_title_stripped ?? pane.terminal_title ?? pane.title ?? "");

async function shownSession(pane: Json, commands: () => Promise<string[]>): Promise<string | undefined> {
  const shown = TITLE.exec(paneTitle(pane))?.[1];
  const named = (sessions: Json[]) => shown ? sessions.filter(session => {
    const title = String(session.title ?? "");
    return (title.length > 40 ? `${title.slice(0, 37)}…` : title) === shown;
  }) : [];
  const valid = (sessions: Json[]) => sessions.filter(session => SESSION.test(String(session.id)));
  const cwd = pane.foreground_cwd ?? pane.cwd;
  // The pane's own folder first: a busy service holds more conversations than one listing.
  const here = typeof cwd === "string" && cwd ? named(valid(await rootSessions(cwd))) : [];
  const sessions = here.length === 1 ? [] : valid(await rootSessions());
  const found = here.length ? here : named(sessions);
  if (found.length === 1) return String(found[0].id);
  const started = (await commands().catch(() => [] as string[])).map(commandSession).find(Boolean);
  if (!started) return undefined;
  const known = found.length ? found : shown ? [] : [...(typeof cwd === "string" && cwd ? valid(await rootSessions(cwd)) : []), ...sessions];
  return known.some(session => session.id === started) ? started : undefined;
}

/** The pane's entry in the shape a served 1.x pane has, when the Hook last
 * saw it showing a conversation of the running service. */
export function servicePane(server: string, pane: string): PaneServerEntry | undefined {
  const key = boundKey(server, pane), entry = bound.get(key);
  if (!entry || !known) return undefined;
  if (Date.now() - entry.at > BOUND_MS || !alive(known.pid)) { bound.delete(key); return undefined; }
  return { server, pane, port: known.port, password: known.password, pid: known.pid, directory: entry.directory,
    createdAt: new Date(entry.at).toISOString(), api: 2, session: entry.session };
}

export function servicePanes(): PaneServerEntry[] {
  return [...bound.keys()].flatMap(key => {
    const [server, pane] = key.split("\u0000");
    const entry = servicePane(server, pane);
    return entry ? [entry] : [];
  });
}

/** For tests: forget every pane and the service. */
export function resetOpencodeService(): void { bound.clear(); known = undefined; listings.clear(); installed = undefined; sessions.clear(); }

const exec = promisify(execFile);
let installed: { at: number; major: Promise<number | undefined> } | undefined;

/** The installed OpenCode's major version: the running service's, else what
 * `opencode --version` prints (asked at most once in five minutes). */
export async function opencodeMajor(): Promise<number | undefined> {
  if (process.env.PHREN_OPENCODE_SERVICE === "off") return undefined;
  const live = await opencodeService();
  if (live) return Number.parseInt(live.version, 10);
  if (installed && Date.now() - installed.at < 300_000) return installed.major;
  const major = exec("opencode", ["--version"], { timeout: 8_000, env: { ...process.env, NO_COLOR: "1" } })
    .then(({ stdout }) => { const found = /(\d+)\.\d+/.exec(String(stdout))?.[1]; return found ? Number(found) : undefined; }, () => undefined);
  installed = { at: Date.now(), major };
  return major;
}

/** The running service, started first (`opencode service start`) when OpenCode 2 is installed and none runs. */
export async function ensureOpencodeService(timeoutMs = 10_000): Promise<OpencodeService | undefined> {
  const live = await opencodeService();
  if (live || !((await opencodeMajor() ?? 0) >= 2)) return live;
  await exec("opencode", ["service", "start"], { timeout: timeoutMs, env: { ...process.env, NO_COLOR: "1" } }).catch(() => undefined);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const started = await opencodeService();
    if (started || Date.now() >= deadline) return started;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

export interface ServiceLaunch { args: string[]; model?: string; agent?: string; variant?: string }

/** A 1.x launch's arguments for OpenCode 2, whose TUI takes no `--model`,
 * `--agent` or `--variant`: those become the new conversation's own settings. */
export function serviceLaunchArgs(args: readonly string[]): ServiceLaunch {
  const out: ServiceLaunch = { args: [] };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index], value = args[index + 1];
    if ((flag === "--model" || flag === "--agent" || flag === "--variant") && typeof value === "string") {
      out[flag.slice(2) as "model" | "agent" | "variant"] = value; index++;
    } else out.args.push(flag);
  }
  return out;
}

/** A new conversation in `directory` for a pane the Hook is about to start on
 * it (`opencode --session <id>`), with the launch's agent and model. */
export async function createServiceSession(live: OpencodeService, directory: string, launch: Omit<ServiceLaunch, "args"> = {}): Promise<string> {
  const slash = launch.model?.indexOf("/") ?? -1;
  const model = launch.model && slash > 0 ? { providerID: launch.model.slice(0, slash), id: launch.model.slice(slash + 1), ...(launch.variant ? { variant: launch.variant } : {}) } : undefined;
  const response = await fetch(new URL("/api/session", live.url), { method: "POST", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Authorization: live.authorization, "Content-Type": "application/json" },
    body: JSON.stringify({ location: { directory }, ...(launch.agent ? { agent: launch.agent } : {}), ...(model ? { model } : {}) }) });
  const id = object(object(response.ok ? await response.json() : undefined).data).id;
  if (typeof id !== "string" || !SESSION.test(id)) throw new Error(`opencode did not create a session (${response.status}).`);
  listings.clear();
  return id;
}

/** Records that the pane the Hook just started shows `session`, before its
 * terminal title can say so. */
export function bindServicePane(server: string, pane: string, session: string, directory: string): PaneServerEntry | undefined {
  bound.set(boundKey(server, pane), { session, directory, at: Date.now(), launched: true });
  return servicePane(server, pane);
}

const sessionInfo = (value: Json): OpenCodeSession => {
  const time = object(value.time);
  return { id: String(value.id), ...(typeof object(value.location).directory === "string" ? { directory: String(object(value.location).directory) } : {}),
    ...(typeof value.title === "string" ? { title: value.title } : {}), ...(typeof value.parentID === "string" ? { parentID: value.parentID } : {}),
    time: { ...(typeof time.created === "number" ? { created: time.created } : {}), ...(typeof time.updated === "number" ? { updated: time.updated } : {}) } };
};

/** A form the question tool raised, as the question set 1.x listed: one
 * question per field, its options by label. A form of any other kind, or a
 * field the phone cannot show (no options), stays in the TUI. */
function question(form: Json): OpenCodeQuestion | undefined {
  const fields = objects(form.fields);
  if (object(form.metadata).kind !== "question" || !fields.length) return undefined;
  const questions: Json[] = [];
  for (const field of fields) {
    const options = objects(field.options).filter(option => typeof option.label === "string" && option.label);
    if (!["string", "multiselect"].includes(String(field.type)) || !options.length) return undefined;
    questions.push({ question: String(field.description || field.title || "Question"), header: String(field.title || "Question").slice(0, 30),
      options: options.map(option => ({ label: option.label, ...(typeof option.description === "string" ? { description: option.description } : {}) })),
      multiple: field.type === "multiselect" });
  }
  return { id: String(form.id), sessionID: String(form.sessionID), questions };
}

/** A `PaneClient` over the service, for one pane's folder and conversation. */
export function openServiceClient(entry: PaneServerEntry, fetchImpl: typeof fetch = fetch): PaneClient {
  const base = `http://127.0.0.1:${entry.port}`, auth = basic(entry.password);
  const location = `location%5Bdirectory%5D=${encodeURIComponent(entry.directory)}`;
  /** Which session asked each listed permission or form, and each form's fields. */
  const askers = new Map<string, { session: string; fields?: Json[] }>();
  const roots = new Map<string, string>();

  const send = (method: string, route: string, body?: unknown, signal?: AbortSignal, timeout: number | false = REQUEST_TIMEOUT_MS): Promise<Response> => {
    const requestSignal = signal ?? (timeout === false ? undefined : AbortSignal.timeout(timeout));
    return fetchImpl(new URL(route, base).toString(), { method,
      headers: { Authorization: auth, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(requestSignal ? { signal: requestSignal } : {}) });
  };
  const json = async (method: string, route: string, body?: unknown): Promise<Json> => {
    const response = await send(method, route, body);
    const text = await response.text();
    if (!response.ok) throw new Error(`opencode ${method} ${route.split("?")[0]} failed with ${response.status}: ${text.slice(0, 300)}`);
    return object(text ? JSON.parse(text) : undefined);
  };
  const one = async (id: string): Promise<OpenCodeSession | undefined> => {
    if (!SESSION.test(id)) return undefined;
    const response = await send("GET", `/api/session/${id}`);
    const text = await response.text();
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`opencode GET /api/session/{id} failed with ${response.status}.`);
    const value = object(object(text ? JSON.parse(text) : undefined).data);
    return typeof value.id === "string" ? sessionInfo(value) : undefined;
  };
  /** The conversation a (possibly subagent) session belongs to. */
  const root = async (id: string): Promise<string> => {
    const cached = roots.get(id);
    if (cached) return cached;
    let current = id;
    for (let depth = 0; depth < 8; depth++) {
      const info = await one(current).catch(() => undefined);
      if (!info?.parentID) break;
      current = info.parentID;
    }
    roots.set(id, current);
    while (roots.size > 256) roots.delete(roots.keys().next().value!);
    return current;
  };
  /** Only what this pane's conversation (or a subagent of it) asks: every pane of the service shares the folder's list. */
  const own = async (rows: Json[]): Promise<Json[]> => {
    const kept: Json[] = [];
    for (const row of rows) {
      if (typeof row.id !== "string" || typeof row.sessionID !== "string") continue;
      if (!entry.session || await root(row.sessionID) === entry.session) kept.push(row);
    }
    return kept;
  };
  const asker = (id: string): { session: string; fields?: Json[] } => {
    const found = askers.get(id);
    if (!found) throw new Error("opencode no longer lists that request.");
    return found;
  };
  const remember = (id: string, value: { session: string; fields?: Json[] }) => {
    askers.delete(id); askers.set(id, value);
    while (askers.size > 256) askers.delete(askers.keys().next().value!);
  };

  return {
    async ready(timeoutMs = 1_500) {
      try { return (await send("GET", "/api/info", undefined, undefined, timeoutMs)).ok; } catch { return false; }
    },
    async sessions() {
      return objects((await json("GET", `/api/session?parentID=null&limit=100&directory=${encodeURIComponent(entry.directory)}`)).data)
        .filter(value => typeof value.id === "string").map(sessionInfo);
    },
    session: one,
    async currentSession() {
      if (entry.session) return one(entry.session);
      return (await this.sessions()).sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))[0];
    },
    async createSession() {
      const created = object((await json("POST", "/api/session", { location: { directory: entry.directory } })).data);
      if (typeof created.id !== "string") throw new Error("opencode POST /api/session returned no session.");
      return sessionInfo(created);
    },
    // The service has no route that moves a TUI: a pane shows the session it was started on.
    async selectSession() {},
    async setTitle(sessionId, title) {
      await json("PATCH", `/api/session/${encodeURIComponent(sessionId)}`, { title });
      return (await one(sessionId))?.title;
    },
    async prompt(sessionId, text, opts = {}) {
      const route = `/api/session/${encodeURIComponent(sessionId)}`;
      const failed = (error: unknown): never => { throw new PromptNotSent((error as Error).message); };
      if (opts.model) {
        const slash = opts.model.indexOf("/");
        if (slash < 1) throw new PromptNotSent("The model is not a provider/model id.");
        await json("POST", `${route}/model`, { model: { providerID: opts.model.slice(0, slash), id: opts.model.slice(slash + 1), ...(opts.variant ? { variant: opts.variant } : {}) } }).catch(failed);
      }
      if (opts.agent) await json("POST", `${route}/agent`, { agent: opts.agent }).catch(failed);
      let response: Response;
      try { response = await send("POST", `${route}/prompt`, { text }, undefined, opts.timeoutMs ?? REQUEST_TIMEOUT_MS); } catch (error) {
        // Nothing listening: the prompt never left. Any other failure may have reached the service.
        if (((error as { cause?: { code?: unknown } }).cause)?.code === "ECONNREFUSED") throw new PromptNotSent("opencode is not listening.");
        return { delivered: false, reason: "timeout" };
      }
      const body = await response.text().catch(() => "");
      if (!response.ok) throw new PromptNotSent(`opencode POST prompt failed with ${response.status}: ${body.slice(0, 300)}`);
      // The service admits the input durably before it answers: an id is the delivery.
      let id: unknown;
      try { id = object(object(JSON.parse(body)).data).id; } catch { /* an answer without a body */ }
      return typeof id === "string" ? { delivered: true, messageId: id } : { delivered: false, reason: "timeout" };
    },
    async permissions() {
      const rows = await own(objects((await json("GET", `/api/permission/request?${location}`)).data));
      return rows.map((row): OpenCodePermission => {
        remember(String(row.id), { session: String(row.sessionID) });
        const resources = (Array.isArray(row.resources) ? row.resources : []).filter((value): value is string => typeof value === "string");
        // 1.x named a shell command in `metadata.command`; the approval card reads it there.
        const metadata = { ...object(row.metadata), ...(row.action === "shell" && resources.length === 1 ? { command: resources[0] } : {}) };
        return { id: String(row.id), sessionID: String(row.sessionID), permission: String(row.action || "action"), patterns: resources, metadata } as OpenCodePermission;
      });
    },
    async replyPermission(id, reply, message) {
      const from = asker(id);
      await json("POST", `/api/session/${from.session}/permission/${encodeURIComponent(id)}/reply`, { decision: reply, ...(message === undefined ? {} : { message }) });
      askers.delete(id);
    },
    async questions() {
      const forms = await own(objects((await json("GET", `/api/form?${location}`)).data));
      return forms.flatMap(form => {
        const mapped = question(form);
        if (!mapped) return [];
        remember(mapped.id, { session: String(form.sessionID), fields: objects(form.fields) });
        return [mapped];
      });
    },
    async replyQuestion(id, answers) {
      const from = asker(id), answer: Json = {};
      (from.fields ?? []).forEach((field, index) => {
        // An option answers by its value; anything else is the owner's own text.
        const values = (answers[index] ?? []).map(label => {
          const option = objects(field.options).find(value => value.label === label);
          return typeof option?.value === "string" ? option.value : label;
        });
        if (field.type === "multiselect") answer[String(field.key)] = values;
        else if (values.length) answer[String(field.key)] = values.join(", ");
      });
      await json("POST", `/api/session/${from.session}/form/${encodeURIComponent(id)}/reply`, { answer });
      askers.delete(id);
    },
    async rejectQuestion(id) {
      const from = asker(id);
      await json("DELETE", `/api/session/${from.session}/form/${encodeURIComponent(id)}`);
      askers.delete(id);
    },
    async abort(sessionId) {
      return (await json("POST", `/api/session/${encodeURIComponent(sessionId)}/interrupt`)).interrupted === true;
    },
    async *events(signal): AsyncGenerator<PaneEvent> {
      const response = await send("GET", "/api/event", undefined, signal, false);
      if (!response.ok || !response.body) throw new Error(`opencode GET /api/event failed with ${response.status}.`);
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let pending = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          pending += decoder.decode(value, { stream: true });
          let boundary: number;
          while ((boundary = pending.indexOf("\n\n")) >= 0) {
            const block = pending.slice(0, boundary);
            pending = pending.slice(boundary + 2);
            const data = block.split("\n").filter(row => row.startsWith("data:")).map(row => row.slice(5).trimStart()).join("\n");
            if (!data) continue;
            // Each frame is one event: its `type` beside the session's `data`.
            try {
              const event = object(JSON.parse(data));
              if (typeof event.type === "string") yield { type: event.type, properties: object(event.data) };
            } catch { /* a malformed frame */ }
          }
          // A stream of frames with no blank line between them is not SSE: stop before it grows.
          if (pending.length > 4_194_304) return;
        }
      } finally { await reader.cancel().catch(() => {}); }
    },
  };
}

/** When the conversation last went to work and last came to rest, as the 1.x
 * plugin stamped a process's turns. */
export async function opencodeServiceStamps(id: string): Promise<{ session: string; at: string; busyAt?: string; idleAt?: string } | undefined> {
  if (!SESSION.test(id)) return undefined;
  const live = await opencodeService();
  if (!live) return undefined;
  const time = object(object((await get(live, `/api/session/${id}`))?.data).time);
  const iso = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : undefined;
  const busyAt = iso(time.busy), idleAt = iso(time.idle);
  if (!busyAt && !idleAt) return undefined;
  return { session: id, at: iso(Math.max(Number(time.busy ?? 0), Number(time.idle ?? 0)))!, ...(busyAt ? { busyAt } : {}), ...(idleAt ? { idleAt } : {}) };
}

/** Whether the conversation is at work, from the same stamps. */
export async function opencodeServiceStatus(id: string): Promise<"working" | "idle" | undefined> {
  const stamps = await opencodeServiceStamps(id);
  if (!stamps) return undefined;
  return stamps.busyAt && !(Date.parse(stamps.idleAt ?? "") >= Date.parse(stamps.busyAt)) ? "working" : "idle";
}

/** Sets the model the conversation's next turns use and returns what the service now holds. */
export async function switchOpencodeModel(entry: PaneServerEntry, id: string, variant?: string): Promise<{ id: string; variant?: string }> {
  const slash = id.indexOf("/");
  if (!entry.session || slash < 1) throw new Error("The model is not a provider/model id.");
  const route = `http://127.0.0.1:${entry.port}/api/session/${entry.session}`, headers = { Authorization: basic(entry.password), "Content-Type": "application/json" };
  const response = await fetch(`${route}/model`, { method: "POST", headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: JSON.stringify({ model: { providerID: id.slice(0, slash), id: id.slice(slash + 1), ...(variant ? { variant } : {}) } }) });
  if (!response.ok) throw new Error(`opencode refused the model (${response.status}): ${(await response.text().catch(() => "")).slice(0, 200)}`);
  const held = await fetch(route, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const model = object(object(object(held.ok ? await held.json() : undefined).data).model);
  if (typeof model.providerID !== "string" || typeof model.id !== "string") throw new Error("opencode did not confirm the model.");
  return { id: `${model.providerID}/${model.id}`, ...(typeof model.variant === "string" ? { variant: model.variant } : {}) };
}

export function opencodeSessionsRoot(): string { return path.join(bridgeRoot(), "opencode-sessions"); }

const toolOutput = (state: Json): string => {
  const text = objects(state.content).filter(part => part.type === "text").map(part => String(part.text ?? "")).join("\n")
    || String(object(state.error).message ?? "");
  return text.length > MAX_TOOL_OUTPUT ? text.slice(0, MAX_TOOL_OUTPUT) : text;
};

/** A session's messages as the plugin's event rows: the three message events
 * the readers show. Reasoning, model switches and system notices stay out,
 * and an assistant's text appears once its message is complete (the live
 * preview carries it until then). */
function eventLines(messages: Json[]): string[] {
  const lines: string[] = [];
  const emit = (type: string, data: Json, created: unknown) => {
    lines.push(JSON.stringify({ seq: lines.length, time: new Date(Number(created) || Date.now()).toISOString(), type, data }));
  };
  for (const message of messages) {
    const time = object(message.time);
    if (message.type === "user" && typeof message.text === "string" && message.text) {
      emit("user/message", { source: "user", message: { role: "user", content: [{ type: "text", text: message.text }] } }, time.created);
    } else if (message.type === "assistant") {
      const complete = Boolean(time.completed || message.finish), parts = objects(message.content);
      const blocks = parts.flatMap((part): Json[] => part.type === "text" && complete && typeof part.text === "string" && part.text ? [{ type: "text", text: part.text }]
        : part.type === "tool" && typeof part.id === "string" ? [{ type: "tool_use", id: part.id, name: String(part.name || "tool"), input: object(part.state).input ?? {} }] : []);
      // A turn the provider refused (no credit, an outage) has no text of its own: its error is the answer.
      const failure = String(object(message.error).message ?? "").slice(0, 2_000);
      if (complete && failure && !blocks.some(block => block.type === "text")) blocks.push({ type: "text", text: `OpenCode could not finish this turn: ${failure}` });
      const tokens = object(message.tokens);
      if (blocks.length) emit("assistant/message", { stop_reason: STOP_REASONS[String(message.finish)] || message.finish || "end_turn", message: { role: "assistant", content: blocks,
        ...(typeof object(message.model).providerID === "string" && typeof object(message.model).id === "string" ? { model: `${object(message.model).providerID}/${object(message.model).id}` } : {}) },
        ...(typeof tokens.input === "number" || typeof tokens.output === "number" ? { usage: { input_tokens: tokens.input ?? 0, output_tokens: tokens.output ?? 0 } } : {}) }, time.created);
      const results = parts.flatMap((part): Json[] => {
        const state = object(part.state);
        return part.type === "tool" && typeof part.id === "string" && (state.status === "completed" || state.status === "error")
          ? [{ type: "tool_result", tool_use_id: part.id, content: toolOutput(state), is_error: state.status === "error" }] : [];
      });
      if (results.length) emit("tool/results", { message: { role: "user", content: results } }, time.completed ?? time.created);
    }
  }
  return lines;
}

const sessions = new Map<string, { stamp: string; messages: Map<string, Json> }>();

/** Brings a session's event log up to date with the service and returns the
 * file, or undefined when the service does not know the session. Safe to call
 * often: an idle, unchanged session costs one small request. A working
 * session rereads its newest pages; a turn's end rereads it whole, so
 * messages OpenCode removed (a revert, a compaction) leave the log too. */
export async function materializeOpencodeSession(session: string): Promise<string | undefined> {
  if (!SESSION.test(session)) return undefined;
  const file = path.join(opencodeSessionsRoot(), `${session}.events.jsonl`);
  const written = () => stat(file).then(() => file, () => undefined);
  const live = await opencodeService();
  if (!live) return written();
  const time = object(object((await get(live, `/api/session/${session}`))?.data).time);
  if (typeof time.created !== "number") return written();
  const stamp = JSON.stringify(time), known = sessions.get(session);
  const working = Number(time.busy ?? 0) > Number(time.idle ?? 0);
  if (known?.stamp === stamp && !working && await written()) return file;
  // At work only the newest messages change: stop at the first page that brings nothing new.
  const messages = working && known ? known.messages : new Map<string, Json>();
  let route = `/api/session/${session}/message?limit=50`, changed = messages !== known?.messages;
  for (let page = 0; page < 400; page++) {
    const body = await get(live, route, 10_000);
    if (!body) return written();
    let fresh = false;
    for (const message of objects(body.data)) {
      const id = String(message.id);
      if (JSON.stringify(messages.get(id)) !== JSON.stringify(message)) fresh = true;
      messages.set(id, message);
    }
    changed ||= fresh;
    const next = object(body.cursor).next;
    if (typeof next !== "string" || (messages === known?.messages && !fresh)) break;
    route = `/api/session/${session}/message?limit=50&cursor=${encodeURIComponent(next)}`;
  }
  if (!changed && await written()) return file;
  const ordered = [...messages.values()].sort((a, b) => Number(object(a.time).created ?? 0) - Number(object(b.time).created ?? 0) || String(a.id).localeCompare(String(b.id)));
  await mkdir(opencodeSessionsRoot(), { recursive: true, mode: 0o700 });
  const lines = eventLines(ordered);
  await atomic(file, lines.length ? `${lines.join("\n")}\n` : "");
  // An answer still being written is the live preview, as the plugin wrote it.
  const latest = ordered.at(-1), user = [...ordered].reverse().find(message => message.type === "user");
  const streaming = working && latest?.type === "assistant" && !object(latest.time).completed && !latest.finish
    ? objects(latest.content).filter(part => part.type === "text").map(part => String(part.text ?? "")).join("\n").slice(0, 32_768) : "";
  if (streaming && user) await atomic(`${file}.preview.json`, { turnStartedAt: new Date(Number(object(user.time).created)).toISOString(), text: streaming });
  else await unlink(`${file}.preview.json`).catch(() => {});
  sessions.delete(session);
  sessions.set(session, { stamp, messages });
  if (sessions.size > 8) sessions.delete(sessions.keys().next().value!);
  return file;
}
