// A scripted Phren Hook on a Unix socket, for daemon and UI tests.
// No real computer, SSH or Herdr: node:http serves the HTTP routes and `ws`
// carries the overview, transcripts and status streams. The default fixtures
// match the shapes the desktop daemon and UI read.
import { mkdirSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";

/** What a route handler returns: a status (200 by default) and a body. */
export interface FakeHookReply { status?: number; json?: unknown; text?: string; body?: Buffer; contentType?: string }
export type FakeHookHandler = (req: IncomingMessage, body: unknown, url: URL) => FakeHookReply | Promise<FakeHookReply>;

/** One request the fake Hook saw, in arrival order. */
export interface FakeHookCall {
  method: string;
  path: string;
  body: unknown;
  headers: IncomingHttpHeaders;
}

export interface FakeHookOptions {
  /** The bridge directory; the socket is created at `<dir>/hook.sock`. */
  dir: string;
  /** A recorded trace to replay: HTTP replies and WebSocket frames come from it,
   * and every other request is answered 404 "not in trace". */
  trace?: string;
  /** Extra or overriding `"METHOD /path"` handlers. */
  routes?: Record<string, FakeHookHandler>;
  /** Frames sent on every overview connection (default: one session). */
  overviewFrames?: unknown[];
  /** Backlog entries sent on every transcript connection. */
  transcriptFrames?: unknown[];
}

export interface FakeHook {
  dir: string;
  socketPath: string;
  /** Every HTTP request and WebSocket upgrade, in arrival order. */
  calls: FakeHookCall[];
  /** Push an overview frame to every open overview socket. */
  pushOverview(frame: unknown): void;
  /** Push a transcript frame; `target` a session id (or `{session}`), else all. */
  pushTranscript(target: string | { session?: string } | undefined, frame: unknown): void;
  close(): Promise<void>;
}

const VERSION = "0.3.33";
const APP_PATH = "src/app.ts";
const README_PATH = "README.md";

function defaultSession() {
  return {
    id: "sess-fix-login",
    label: "phren",
    title: "Fix login",
    agent: "claude",
    agentStatus: "working",
    cwd: "/Users/you/phren",
    branch: "main",
    lastChangedAt: new Date().toISOString(),
    target: { server: "default", workspace: "1", tab: "1", pane: "1", source: "claude", session: "sess-fix-login" },
  };
}

function defaultOverview() {
  return {
    type: "overview",
    kind: "overview",
    mux: { id: "default", kind: "herdr", session: "default" },
    groups: [{ id: "1", label: "phren", children: [defaultSession()] }],
    phren: { computer: { id: "test-computer", name: "This computer" }, version: VERSION, capabilities: { overviewStream: true } },
  };
}

function defaultHealth() {
  return {
    ok: true,
    product: "phren-hook",
    protocol: 1,
    version: VERSION,
    computer: { id: "test-computer", name: "This computer" },
    capabilities: {
      fileWrite: true, fileSearch: true, files: true, fileResolution: true, repositoryFiles: true,
      transcript: true, prompt: true, diff: true, overviewStream: true, resources: true,
    },
  };
}

function defaultGitStatus() {
  return {
    repository: "/Users/you/phren",
    observedAt: new Date().toISOString(),
    truncated: false,
    countsComplete: true,
    totalFiles: 2,
    branch: "main",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 1,
    untracked: 1,
    additions: 3,
    deletions: 1,
    defaultBranch: "main",
    files: [
      { path: APP_PATH, status: "M", staged: false, additions: 3, deletions: 1 },
      { path: README_PATH, status: "?", staged: false, additions: 0, deletions: 0 },
    ],
  };
}

function defaultDiff() {
  return {
    branch: "main",
    root: "/Users/you/phren",
    repository: "/Users/you/phren",
    observedAt: new Date().toISOString(),
    launchPath: "/Users/you/phren",
    truncated: false,
    totalFiles: 2,
    files: [
      {
        path: APP_PATH,
        status: "M",
        sections: [{
          id: `unstaged:${APP_PATH}`,
          kind: "unstaged",
          loadState: "loaded",
          patch: "@@ -1,1 +1,2 @@\n-export const app = \"old\";\n+export const app = \"new\";\n+export const ready = true;",
          truncated: false,
        }],
      },
      { path: README_PATH, status: "?", sections: [] },
    ],
  };
}

function defaultTranscript() {
  return [
    { raw: { type: "user", message: { content: "Fix the login flow" } } },
    { raw: { type: "assistant", message: { content: [{ type: "text", text: "On it. The session token is dropped before the guard runs." }] } } },
  ];
}

function send(ws: WebSocket, frame: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer));
  if (!chunks.length) return undefined;
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return undefined; }
}

// ---------------------------------------------------------------- trace replay
interface TraceLine {
  kind: string;
  t?: number;
  method?: string;
  path?: string;
  query?: string;
  status?: number;
  response?: unknown;
  id?: number;
  data?: unknown;
}

interface TraceSession { frames: Array<{ t: number; data: unknown }> }

interface TraceIndex {
  http: Map<string, TraceLine[]>;
  ws: Map<string, TraceSession[]>;
}

/** Query parameters as a stable string, so parameter order never breaks a match. */
function normQuery(query: string): string {
  const q = query.startsWith("?") ? query.slice(1) : query;
  const params = [...new URLSearchParams(q).entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return new URLSearchParams(params).toString();
}

function httpKey(method: string, pathname: string, query: string): string {
  return `${method} ${pathname}?${normQuery(query)}`;
}

function wsKey(fullPath: string): string {
  const index = fullPath.indexOf("?");
  const pathname = index < 0 ? fullPath : fullPath.slice(0, index);
  const query = index < 0 ? "" : fullPath.slice(index + 1);
  return `${pathname}?${normQuery(query)}`;
}

/** Read a trace file into HTTP replies (in recorded order, per key) and WebSocket sessions. */
function loadTraceIndex(file: string): TraceIndex {
  const http = new Map<string, TraceLine[]>();
  const ws = new Map<string, TraceSession[]>();
  const sessions = new Map<number, TraceSession>();
  const sessionPaths = new Map<number, string>();
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    if (!raw.trim()) continue;
    let line: TraceLine;
    try { line = JSON.parse(raw) as TraceLine; } catch { continue; }
    if (line.kind === "http" && typeof line.method === "string" && typeof line.path === "string") {
      const key = httpKey(line.method, line.path, line.query ?? "");
      const list = http.get(key);
      if (list) list.push(line); else http.set(key, [line]);
    } else if (line.kind === "ws-open" && typeof line.id === "number") {
      sessions.set(line.id, { frames: [] });
      sessionPaths.set(line.id, line.path ?? "");
    } else if (line.kind === "ws-in" && typeof line.id === "number") {
      sessions.get(line.id)?.frames.push({ t: line.t ?? 0, data: line.data });
    }
  }
  for (const [id, session] of sessions) {
    const key = wsKey(sessionPaths.get(id) ?? "");
    const list = ws.get(key);
    if (list) list.push(session); else ws.set(key, [session]);
  }
  return { http, ws };
}

/** A recorded HTTP reply: JSON by default, text for strings, bytes for { base64 }. */
function traceReply(entry: TraceLine): FakeHookReply {
  const status = entry.status && entry.status > 0 ? entry.status : 502;
  const response = entry.response;
  if (response && typeof response === "object" && typeof (response as { base64?: unknown }).base64 === "string") {
    return { status, body: Buffer.from((response as { base64: string }).base64, "base64"), contentType: "application/octet-stream" };
  }
  if (typeof response === "string") return { status, text: response };
  return { status, json: response ?? null };
}

function sendFrame(ws: WebSocket, data: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (data && typeof data === "object" && typeof (data as { base64?: unknown }).base64 === "string") {
    ws.send(Buffer.from((data as { base64: string }).base64, "base64"), { binary: true });
  } else {
    ws.send(typeof data === "string" ? data : JSON.stringify(data));
  }
}

/** Send a reply as bytes, text, or JSON, according to what it carries. */
function writeReply(res: ServerResponse, reply: FakeHookReply): void {
  const status = reply.status ?? 200;
  if (reply.body !== undefined) {
    res.writeHead(status, { "Content-Type": reply.contentType ?? "application/octet-stream" });
    res.end(reply.body);
  } else if (reply.text !== undefined) {
    res.writeHead(status, { "Content-Type": reply.contentType ?? "text/plain; charset=utf-8" });
    res.end(reply.text);
  } else {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(reply.json ?? null));
  }
}

/** Start a fake Hook listening on `<dir>/hook.sock`. */
export async function startFakeHook(options: FakeHookOptions): Promise<FakeHook> {
  const dir = path.resolve(options.dir);
  const socketPath = path.join(dir, "hook.sock");
  mkdirSync(dir, { recursive: true });
  await rm(socketPath, { force: true });

  const calls: FakeHookCall[] = [];
  const overviewSockets = new Set<WebSocket>();
  const transcriptSockets = new Set<{ ws: WebSocket; session: string }>();
  const statusSockets = new Set<WebSocket>();
  const overviewFrames = options.overviewFrames ?? [defaultOverview()];
  const transcriptFrames = options.transcriptFrames ?? defaultTranscript();

  // One text file the editor can read and save; version bumps on every write.
  const files = new Map<string, { content: string; version: string }>([
    [APP_PATH, { content: "export const app = \"new\";\nexport const ready = true;\n", version: "v1" }],
  ]);

  const defaults: Record<string, FakeHookHandler> = {
    "GET /v1/health": () => ({ status: 200, json: defaultHealth() }),

    "GET /v1/files/range": (_req, _body, url) => {
      const requested = url.searchParams.get("path") ?? "";
      const entry = files.get(requested);
      if (!entry) return { status: 404, json: { error: "No such file.", code: "file-not-found" } };
      const expected = url.searchParams.get("version");
      if (expected && expected !== entry.version) return { status: 409, json: { error: "The file changed. Open it again.", code: "file-changed" } };
      const bytes = Buffer.from(entry.content, "utf8");
      const offset = Number(url.searchParams.get("offset") ?? "0") || 0;
      const requestedLength = Number(url.searchParams.get("length") ?? String(bytes.length));
      const length = Number.isFinite(requestedLength) && requestedLength > 0 ? requestedLength : bytes.length;
      const slice = bytes.subarray(offset, offset + length);
      return {
        status: 200,
        json: {
          path: requested, offset, length: slice.length, total: bytes.length, contentType: "text/plain",
          version: entry.version, eof: offset + slice.length >= bytes.length, data: slice.toString("base64"),
        },
      };
    },

    "POST /v1/files/write": (_req, body) => {
      const data = (body ?? {}) as { path?: unknown; content?: unknown; version?: unknown };
      const requested = typeof data.path === "string" ? data.path : "";
      const content = typeof data.content === "string" ? data.content : "";
      const expected = typeof data.version === "string" ? data.version : undefined;
      const entry = files.get(requested);
      if (expected === undefined) {
        if (entry) return { status: 409, json: { error: "A file with that name already exists.", code: "file-exists" } };
        files.set(requested, { content, version: "v1" });
        return { status: 200, json: { path: requested, version: "v1", size: Buffer.byteLength(content), created: true } };
      }
      if (!entry || entry.version !== expected) return { status: 409, json: { error: "The file changed since you opened it.", code: "file-changed" } };
      const version = `v${Number(entry.version.slice(1)) + 1}`;
      files.set(requested, { content, version });
      return { status: 200, json: { path: requested, version, size: Buffer.byteLength(content), created: false } };
    },

    "GET /v1/git/status": () => ({ status: 200, json: defaultGitStatus() }),
    "POST /v1/git/status": () => ({ status: 200, json: defaultGitStatus() }),
    "POST /v1/diff": () => ({ status: 200, json: defaultDiff() }),
    "POST /v1/prompt": () => ({ status: 200, json: { ok: true } }),
  };

  const handlers: Record<string, FakeHookHandler> = { ...defaults, ...options.routes };
  const trace = options.trace ? loadTraceIndex(options.trace) : null;
  const httpCursor = new Map<string, number>();
  const wsCursor = new Map<string, number>();

  const tracedReply = (method: string, pathname: string, search: string): FakeHookReply | null => {
    if (!trace) return null;
    const key = httpKey(method, pathname, search);
    const list = trace.http.get(key);
    if (!list || !list.length) return null;
    const cursor = httpCursor.get(key) ?? 0;
    httpCursor.set(key, cursor + 1);
    return traceReply(list[Math.min(cursor, list.length - 1)]);
  };

  const nextSession = (pathname: string, search: string): TraceSession | null => {
    if (!trace) return null;
    const key = wsKey(`${pathname}${search}`);
    const list = trace.ws.get(key);
    if (!list || !list.length) return null;
    const cursor = wsCursor.get(key) ?? 0;
    wsCursor.set(key, cursor + 1);
    return list[Math.min(cursor, list.length - 1)];
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://phren.local");
    void (async () => {
      const body = await readBody(req);
      const method = req.method ?? "GET";
      calls.push({ method, path: req.url ?? "/", body, headers: req.headers });
      let reply: FakeHookReply;
      if (trace) {
        const recorded = tracedReply(method, url.pathname, url.search);
        if (recorded) {
          reply = recorded;
        } else {
          console.warn(`[fake-hook] not in trace: ${method} ${req.url ?? url.pathname}`);
          reply = { status: 404, json: { ok: false, error: "not in trace" } };
        }
      } else {
        const handler = handlers[`${method} ${url.pathname}`];
        reply = handler
          ? await handler(req, body, url)
          : { status: 404, json: { error: "Unknown Phren Hook route.", code: "route-not-found" } };
      }
      writeReply(res, reply);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "fake hook error" }));
    });
  });

  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://phren.local");
    calls.push({ method: "GET", path: req.url ?? "/", body: undefined, headers: req.headers });
    wss.handleUpgrade(req, socket, head, (ws) => {
      const session = nextSession(url.pathname, url.search);
      if (session) {
        // Replay the Hook's frames in order, keeping their spacing (capped at 2 s).
        let at = 0;
        let previous = session.frames[0]?.t ?? 0;
        const timers: NodeJS.Timeout[] = [];
        session.frames.forEach((frame, index) => {
          if (index > 0) {
            at += Math.min(frame.t - previous, 2_000);
            previous = frame.t;
          }
          if (at === 0) sendFrame(ws, frame.data);
          else timers.push(setTimeout(() => sendFrame(ws, frame.data), at));
        });
        // One listener for all pending frames (one per frame trips Node's leak warning).
        ws.once("close", () => { for (const timer of timers) clearTimeout(timer); });
        return;
      }
      if (trace) {
        ws.close(1008, "not in trace");
        return;
      }
      if (url.pathname === "/v1/overview") {
        overviewSockets.add(ws);
        ws.on("close", () => overviewSockets.delete(ws));
        for (const frame of overviewFrames) send(ws, frame);
      } else if (url.pathname === "/v1/transcripts") {
        const entry = { ws, session: url.searchParams.get("session") ?? "" };
        transcriptSockets.add(entry);
        ws.on("close", () => transcriptSockets.delete(entry));
        // The real Hook's backlog shape (packages/cli/src/bridge/transcripts.ts): numbered
        // entries, the harness source and the session, so clients parse it as they do live.
        const source = url.searchParams.get("source") ?? "claude";
        const entries = (transcriptFrames as Array<{ line?: number; raw: unknown }>).map((entry, index) => ({ line: entry.line ?? index + 1, raw: entry.raw }));
        send(ws, { type: "backlog", source, session: url.searchParams.get("session") ?? "", entries, totalLines: entries.length, startLine: 1, hasMore: false, reset: true });
      } else if (url.pathname === "/v1/status") {
        statusSockets.add(ws);
        ws.on("close", () => statusSockets.delete(ws));
        send(ws, { type: "agentStatus", status: "working", pendingApproval: null });
      } else {
        ws.close(1008, "unknown route");
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });

  return {
    dir,
    socketPath,
    calls,
    pushOverview(frame: unknown): void {
      for (const ws of overviewSockets) send(ws, frame);
    },
    pushTranscript(target, frame): void {
      const session = typeof target === "string" ? target : target?.session;
      for (const entry of transcriptSockets) {
        if (!session || entry.session === session) send(entry.ws, frame);
      }
    },
    async close(): Promise<void> {
      for (const ws of overviewSockets) ws.terminate();
      for (const ws of statusSockets) ws.terminate();
      for (const entry of transcriptSockets) entry.ws.terminate();
      overviewSockets.clear();
      statusSockets.clear();
      transcriptSockets.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await rm(socketPath, { force: true });
    },
  };
}
