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
 * `permission.reply`, `question.list` and `question.reply`. A question reply
 * takes `{ answers }`, each answer an array of selected labels.
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
}

export interface OpenCodeSession {
  id: string;
  directory?: string;
  /** Set on a subagent's session; the TUI shows its root session. */
  parentID?: string;
  time?: { created?: number; updated?: number };
}

export interface OpenCodeMessage {
  info?: { id?: string; role?: string };
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

export interface PaneEvent {
  type: string;
  properties?: Record<string, unknown>;
}

export type PermissionReply = "once" | "always" | "reject";

export interface PromptOptions {
  /** `provider/model`; split on the first slash. */
  model?: string;
  agent?: string;
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
  sessions(): Promise<OpenCodeSession[]>;
  currentSession(): Promise<OpenCodeSession | undefined>;
  prompt(sessionId: string, text: string, opts?: PromptOptions): Promise<PromptResult>;
  permissions(): Promise<OpenCodePermission[]>;
  replyPermission(id: string, reply: PermissionReply, message?: string): Promise<void>;
  questions(): Promise<OpenCodeQuestion[]>;
  replyQuestion(id: string, answers: string[][]): Promise<void>;
  abort(sessionId: string): Promise<boolean>;
  events(signal?: AbortSignal): AsyncGenerator<PaneEvent>;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export function openPaneClient(entry: PaneServerEntry, fetchImpl: typeof fetch = fetch): PaneClient {
  const base = `http://127.0.0.1:${entry.port}`;
  const auth = "Basic " + Buffer.from(`opencode:${entry.password}`).toString("base64");

  const send = (method: string, route: string, body?: unknown, signal?: AbortSignal, timeout = true): Promise<Response> => {
    const url = new URL(route, base);
    url.searchParams.set("directory", entry.directory);
    const requestSignal = signal ?? (timeout ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined);
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
    sessions: sessionList,
    async currentSession() {
      const list = (await sessionList()).filter(session => typeof session.id === "string" && !session.parentID);
      const matching = list.filter(session => !session.directory || session.directory === entry.directory);
      const pool = matching.length > 0 ? matching : list;
      return pool.sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))[0];
    },
    async prompt(sessionId, text, opts = {}) {
      const before = await messages(sessionId);
      const beforeIds = new Set(before.map(message => message.info?.id).filter((id): id is string => Boolean(id)));
      const body: Record<string, unknown> = { parts: [{ type: "text", text }] };
      if (opts.model) {
        const slash = opts.model.indexOf("/");
        body.model = { providerID: slash < 0 ? opts.model : opts.model.slice(0, slash), modelID: slash < 0 ? "" : opts.model.slice(slash + 1) };
      }
      if (opts.agent) body.agent = opts.agent;
      await json<unknown>("POST", `/session/${encodeURIComponent(sessionId)}/prompt_async`, body);
      const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS);
      for (;;) {
        await sleep(PROMPT_POLL_MS);
        for (const message of await messages(sessionId)) {
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
