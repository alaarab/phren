import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { atomicWriteText } from "../phren-paths.js";

/**
 * The HTTP API an OpenCode TUI serves when started as
 * `OPENCODE_SERVER_PASSWORD=<pw> opencode --port <port>`. The Hook drives a
 * visible pane by talking to it instead of typing keys: register the pane's
 * server here, then `openPaneClient` sends a prompt into the session the TUI is
 * already showing and confirms the user message landed.
 *
 * Routes and bodies are the server's own spec (opencode 1.18.31, saved to
 * `.scratch/openapi.json`): `session.list`, `session.prompt_async`,
 * `session.messages`, `session.abort`, `event.subscribe`, `permission.list`,
 * `permission.reply`, `question.list`, `question.reply`, `question.reject`,
 * `session.create` and `tui.selectSession`. A question reply takes
 * `{ answers }`, each answer an array of selected labels. A session created
 * over HTTP is not what the TUI shows until `tui.selectSession` moves it there.
 */

const MAX_PASSWORD = 200;
const REQUEST_TIMEOUT_MS = 10_000;
const PROMPT_POLL_MS = 200;
const DEFAULT_PROMPT_TIMEOUT_MS = 3_000;
/** Enough recent messages to find the one just sent without paging a long history. */
const RECENT_MESSAGES = 20;

export interface PaneServerEntry {
  server: string;
  pane: string;
  port: number;
  password: string;
  pid: number;
  directory: string;
  createdAt: string;
  /** What the TUI was started with (`--agent`, `--model`, `--variant`), for
   * the first prompt of a session that has no earlier turn to follow. */
  defaults?: { agent?: string; model?: string; variant?: string };
}

export interface OpenCodeSession {
  id: string;
  directory?: string;
  /** Set on a subagent's session; the TUI shows its root session. */
  parentID?: string;
  time?: { created?: number; updated?: number };
}

export interface OpenCodeMessage {
  info?: { id?: string; role?: string; agent?: string; model?: { providerID?: string; modelID?: string; variant?: string } };
  parts?: Array<{ type?: string; text?: string }>;
}

export interface OpenCodePermission {
  id: string;
  sessionID?: string;
  permission?: string;
  patterns?: string[];
}

export interface OpenCodeQuestion {
  id: string;
  sessionID?: string;
  questions?: unknown[];
}

/** The prompt never reached the server (refused, or nothing listening), so
 * the caller may still send it another way without a duplicate. */
export class PromptNotSent extends Error {}

export interface PaneEvent {
  type: string;
  properties?: Record<string, unknown>;
}

export type PermissionReply = "once" | "always" | "reject";

export interface PromptOptions {
  /** `provider/model`; split on the first slash. */
  model?: string;
  agent?: string;
  /** A model variant (reasoning effort), as `opencode --variant` takes it. */
  variant?: string;
  /** Without an explicit model or agent, continue with the ones the
   * session's last user turn used, as the TUI would. */
  inherit?: boolean;
  timeoutMs?: number;
}

export type PromptResult = { delivered: true; messageId: string } | { delivered: false; reason: "timeout" };

/** A segment safe to embed in a filename: never `.`, `..`, or a path separator. */
function safeSegment(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
    && value !== "." && value !== ".." && !/[/\\\u0000-\u001f\u007f]/.test(value);
}

function validEntry(value: unknown): value is PaneServerEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return safeSegment(entry.server) && safeSegment(entry.pane)
    && Number.isInteger(entry.port) && (entry.port as number) >= 1 && (entry.port as number) <= 65_535
    && typeof entry.password === "string" && entry.password.length > 0 && entry.password.length <= MAX_PASSWORD
    && Number.isInteger(entry.pid) && (entry.pid as number) > 0
    && typeof entry.directory === "string" && entry.directory.length > 0
    && typeof entry.createdAt === "string";
}

/** Signal 0 only checks existence; EPERM still means the process is alive. */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** The `%2F`-joined name keeps a server/pane pair unique without a path separator. */
function paneServerFile(dir: string, server: string, pane: string): string {
  return path.join(dir, `${encodeURIComponent(`${server}/${pane}`)}.json`);
}

export function registerPaneServer(dir: string, entry: PaneServerEntry): string {
  if (!validEntry(entry)) throw new Error("Invalid OpenCode pane server entry.");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = paneServerFile(dir, entry.server, entry.pane);
  atomicWriteText(file, JSON.stringify(entry), { mode: 0o600 });
  return file;
}

export function readPaneServer(dir: string, server: string, pane: string): PaneServerEntry | undefined {
  if (!safeSegment(server) || !safeSegment(pane)) return undefined;
  let raw: string;
  try { raw = fs.readFileSync(paneServerFile(dir, server, pane), "utf8"); } catch { return undefined; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return undefined; }
  if (!validEntry(parsed)) return undefined;
  if (parsed.server !== server || parsed.pane !== pane) return undefined;
  if (!alive(parsed.pid)) return undefined;
  return parsed;
}

/** Every registered pane whose OpenCode process is still running. An entry
 * whose process is gone is removed as it is found. */
export function listPaneServers(dir: string): PaneServerEntry[] {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const entries: PaneServerEntry[] = [];
  for (const name of names.slice(0, 1024)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    let parsed: unknown;
    try {
      const info = fs.lstatSync(file);
      if (!info.isFile() || info.size > 16_384) continue;
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch { continue; }
    if (!validEntry(parsed) || paneServerFile(dir, parsed.server, parsed.pane) !== file) continue;
    if (!alive(parsed.pid)) { try { fs.rmSync(file, { force: true }); } catch { /* already gone */ } continue; }
    entries.push(parsed);
  }
  return entries;
}

export function removePaneServer(dir: string, server: string, pane: string): void {
  if (!safeSegment(server) || !safeSegment(pane)) return;
  try { fs.rmSync(paneServerFile(dir, server, pane), { force: true }); } catch { /* already gone */ }
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export function newPassword(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export interface PaneClient {
  /** True once the server answers an authenticated request within `timeoutMs`. */
  ready(timeoutMs?: number): Promise<boolean>;
  sessions(): Promise<OpenCodeSession[]>;
  session(id: string): Promise<OpenCodeSession | undefined>;
  currentSession(): Promise<OpenCodeSession | undefined>;
  /** A new root session in the pane's directory. The TUI does not show it
   * until `selectSession` moves it there. */
  createSession(): Promise<OpenCodeSession>;
  /** Asks the TUI to show `id`. A TUI still starting drops the request, so
   * the caller checks the pane and asks again. */
  selectSession(id: string): Promise<void>;
  prompt(sessionId: string, text: string, opts?: PromptOptions): Promise<PromptResult>;
  permissions(): Promise<OpenCodePermission[]>;
  replyPermission(id: string, reply: PermissionReply, message?: string): Promise<void>;
  questions(): Promise<OpenCodeQuestion[]>;
  replyQuestion(id: string, answers: string[][]): Promise<void>;
  rejectQuestion(id: string): Promise<void>;
  abort(sessionId: string): Promise<boolean>;
  events(signal?: AbortSignal): AsyncGenerator<PaneEvent>;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export function openPaneClient(entry: PaneServerEntry, fetchImpl: typeof fetch = fetch): PaneClient {
  const base = `http://127.0.0.1:${entry.port}`;
  const auth = "Basic " + Buffer.from(`opencode:${entry.password}`).toString("base64");

  const send = (method: string, route: string, body?: unknown, signal?: AbortSignal, timeout: boolean | number = true): Promise<Response> => {
    const url = new URL(route, base);
    url.searchParams.set("directory", entry.directory);
    const requestSignal = signal ?? (timeout === false ? undefined : AbortSignal.timeout(timeout === true ? REQUEST_TIMEOUT_MS : timeout));
    return fetchImpl(url.toString(), { method,
      headers: { Authorization: auth, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(requestSignal ? { signal: requestSignal } : {}) });
  };

  const json = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const response = await send(method, route, body);
    const text = await response.text();
    if (!response.ok) throw new Error(`opencode ${method} ${route} failed with ${response.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : undefined) as T;
  };

  const messages = async (sessionId: string): Promise<OpenCodeMessage[]> => {
    const rows = await json<unknown>("GET", `/session/${encodeURIComponent(sessionId)}/message?limit=${RECENT_MESSAGES}`);
    return Array.isArray(rows) ? rows as OpenCodeMessage[] : [];
  };

  const sessionList = async (): Promise<OpenCodeSession[]> => {
    const rows = await json<unknown>("GET", "/session");
    return Array.isArray(rows) ? rows as OpenCodeSession[] : [];
  };

  const textOf = (message: OpenCodeMessage): string =>
    (message.parts ?? []).filter(part => part.type === "text").map(part => part.text ?? "").join("").trim();

  return {
    async ready(timeoutMs = 1_500) {
      try { return (await send("GET", "/session?limit=1", undefined, undefined, timeoutMs)).ok; } catch { return false; }
    },
    sessions: sessionList,
    async session(id) {
      const response = await send("GET", `/session/${encodeURIComponent(id)}`);
      const text = await response.text();
      if (response.status === 404) return undefined;
      if (!response.ok) throw new Error(`opencode GET /session/{id} failed with ${response.status}.`);
      const value = text ? JSON.parse(text) as OpenCodeSession : undefined;
      return value && typeof value.id === "string" ? value : undefined;
    },
    async createSession() {
      const created = await json<OpenCodeSession>("POST", "/session", {});
      if (!created || typeof created.id !== "string") throw new Error("opencode POST /session returned no session.");
      return created;
    },
    async selectSession(id) {
      await json<unknown>("POST", "/tui/select-session", { sessionID: id });
    },
    async currentSession() {
      const list = (await sessionList()).filter(session => typeof session.id === "string" && !session.parentID);
      const matching = list.filter(session => !session.directory || session.directory === entry.directory);
      const pool = matching.length > 0 ? matching : list;
      return pool.sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))[0];
    },
    async prompt(sessionId, text, opts = {}) {
      let before: OpenCodeMessage[];
      try { before = await messages(sessionId); } catch (error) { throw new PromptNotSent((error as Error).message); }
      const beforeIds = new Set(before.map(message => message.info?.id).filter((id): id is string => Boolean(id)));
      const body: Record<string, unknown> = { parts: [{ type: "text", text }] };
      const last = opts.inherit ? before.filter(message => message.info?.role === "user").at(-1)?.info : undefined;
      if (!opts.model && !opts.agent && last) {
        if (typeof last.agent === "string" && last.agent) body.agent = last.agent;
        if (typeof last.model?.providerID === "string" && typeof last.model.modelID === "string") {
          body.model = { providerID: last.model.providerID, modelID: last.model.modelID };
          if (typeof last.model.variant === "string" && last.model.variant) body.variant = last.model.variant;
        }
      }
      if (opts.model) {
        const slash = opts.model.indexOf("/");
        body.model = { providerID: slash < 0 ? opts.model : opts.model.slice(0, slash), modelID: slash < 0 ? "" : opts.model.slice(slash + 1) };
      }
      if (opts.agent) body.agent = opts.agent;
      if (opts.variant) body.variant = opts.variant;
      let response: Response;
      try { response = await send("POST", `/session/${encodeURIComponent(sessionId)}/prompt_async`, body); } catch (error) {
        // Nothing listening: the prompt never left. Any other failure (a
        // timeout, a reset) may have reached the server, so it is unconfirmed.
        const code = ((error as { cause?: { code?: unknown } }).cause)?.code;
        if (code === "ECONNREFUSED") throw new PromptNotSent("opencode is not listening.");
        return { delivered: false, reason: "timeout" };
      }
      const refused = await response.text().catch(() => "");
      if (!response.ok) throw new PromptNotSent(`opencode POST prompt_async failed with ${response.status}: ${refused.slice(0, 300)}`);
      const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS);
      for (;;) {
        await sleep(PROMPT_POLL_MS);
        const after = await messages(sessionId).catch(() => [] as OpenCodeMessage[]);
        for (const message of after) {
          const id = message.info?.id;
          if (message.info?.role !== "user" || !id || beforeIds.has(id)) continue;
          if (textOf(message) === text.trim()) return { delivered: true, messageId: id };
        }
        if (Date.now() >= deadline) return { delivered: false, reason: "timeout" };
      }
    },
    async permissions() {
      const rows = await json<unknown>("GET", "/permission");
      return Array.isArray(rows) ? rows as OpenCodePermission[] : [];
    },
    async replyPermission(id, reply, message) {
      await json<unknown>("POST", `/permission/${encodeURIComponent(id)}/reply`, { reply, ...(message === undefined ? {} : { message }) });
    },
    async questions() {
      const rows = await json<unknown>("GET", "/question");
      return Array.isArray(rows) ? rows as OpenCodeQuestion[] : [];
    },
    async replyQuestion(id, answers) {
      await json<unknown>("POST", `/question/${encodeURIComponent(id)}/reply`, { answers });
    },
    async rejectQuestion(id) {
      await json<unknown>("POST", `/question/${encodeURIComponent(id)}/reject`);
    },
    async abort(sessionId) {
      return json<boolean>("POST", `/session/${encodeURIComponent(sessionId)}/abort`);
    },
    async *events(signal) {
      const response = await send("GET", "/event", undefined, signal, false);
      if (!response.ok || !response.body) throw new Error(`opencode GET /event failed with ${response.status}.`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
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
            try { yield JSON.parse(data) as PaneEvent; } catch { /* keep-alive or malformed frame */ }
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    },
  };
}
