// A scripted Phren Hook on a Unix socket, for daemon and UI tests.
// No real computer, SSH or Herdr: node:http serves the HTTP routes and `ws`
// carries the overview, transcripts and status streams. The default fixtures
// match the shapes the desktop daemon and UI read.
import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server } from "node:http";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";

/** What a route handler returns: a status (200 by default) and a JSON body. */
export interface FakeHookReply { status?: number; json: unknown }
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

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://phren.local");
    void (async () => {
      const body = await readBody(req);
      calls.push({ method: req.method ?? "GET", path: req.url ?? "/", body, headers: req.headers });
      const handler = handlers[`${req.method ?? "GET"} ${url.pathname}`];
      const reply = handler
        ? await handler(req, body, url)
        : { status: 404, json: { error: "Unknown Phren Hook route.", code: "route-not-found" } };
      res.writeHead(reply.status ?? 200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(reply.json));
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
      if (url.pathname === "/v1/overview") {
        overviewSockets.add(ws);
        ws.on("close", () => overviewSockets.delete(ws));
        for (const frame of overviewFrames) send(ws, frame);
      } else if (url.pathname === "/v1/transcripts") {
        const entry = { ws, session: url.searchParams.get("session") ?? "" };
        transcriptSockets.add(entry);
        ws.on("close", () => transcriptSockets.delete(entry));
        send(ws, { type: "backlog", entries: transcriptFrames });
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
