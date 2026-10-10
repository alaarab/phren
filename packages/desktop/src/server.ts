// HTTP + WebSocket server for the Phren desktop phase 0 spike.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import type { MergedOverview, StartServer, TerminalSession } from "./contract.js";
import { ACTIONS, loadKeyConfig } from "./keys-config.js";
import { linkComputer, revokeComputer } from "./keys.js";
import { rehStatus, stopReh } from "./reh.js";
import { collectUsage } from "./usage.js";
import { closeAllPreviews, closePreview, listPreviews, openPreview } from "./web-preview.js";
import { MemoryHttpError, createMemoryService, type ReviewActionBody } from "./memory.js";
import {
  ExtensionError,
  extensionFilePath,
  installFromOpenVsx,
  listExtensions,
  searchOpenVsx,
  setEnabled,
  syncNodeExtensions,
  uninstall,
} from "./extensions.js";

const require = createRequire(import.meta.url);
// The compiled file lives in dist/src/, so the UI folder is two levels up.
const UI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../ui");
const MAX_BODY = 12 * 1024 * 1024;
const COOKIE = "phren_desktop";
const HEARTBEAT_MS = 20_000;
const VENDOR_PREFIXES = ["/vendor/xterm/", "/vendor/addon-fit/", "/vendor/addon-webgl/", "/vendor/monaco/", "/vendor/kit/"];

/** Requests may only name the bound loopback authority; the editor and
 * extension frames additionally use `<uuid>.localhost` on public GET routes. */
function hostAllowed(host: string, port: number, allowSubdomain: boolean): boolean {
  if (host === `localhost:${port}` || host === `127.0.0.1:${port}`) return true;
  return allowSubdomain && new RegExp(`^[a-z0-9-]+\\.localhost:${port}$`).test(host);
}

/** Whether a non-GET/HEAD request may write: JSON body (or an empty DELETE),
 * the desktop header, and a same-origin hint. Exported for tests. */
export function writeAllowed(req: IncomingMessage, port: number): boolean {
  const method = (req.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return true;
  const headers = req.headers;
  const contentType = typeof headers["content-type"] === "string" ? headers["content-type"].toLowerCase() : "";
  const hasBody =
    (typeof headers["content-length"] === "string" && headers["content-length"] !== "0") ||
    headers["transfer-encoding"] !== undefined;
  const json = contentType.startsWith("application/json");
  if (contentType && !json) return false;
  if (!json && !(method === "DELETE" && !hasBody)) return false;
  if (headers["x-phren-desktop"] !== "1") return false;
  if (headers["sec-fetch-site"] === "same-origin") return true;
  const origin = headers["origin"];
  return origin === `http://localhost:${port}` || origin === `http://127.0.0.1:${port}`;
}

/** The Origin to echo on the public routes, when it is the app or a subdomain. */
function publicCorsOrigin(req: IncomingMessage, port: number): string | null {
  const origin = req.headers.origin;
  if (typeof origin !== "string") return null;
  if (origin === `http://localhost:${port}` || origin === `http://127.0.0.1:${port}`) return origin;
  return new RegExp(`^http://[a-z0-9-]+\\.localhost:${port}$`).test(origin) ? origin : null;
}

function corsHeaders(req: IncomingMessage, port: number, allowNull = false): Record<string, string> {
  const headers: Record<string, string> = { Vary: "Origin" };
  // VS Code's extension host fetches extension files from a sandboxed frame,
  // whose Origin is "null"; those files are public Open VSX content.
  const origin = allowNull && req.headers.origin === "null" ? "null" : publicCorsOrigin(req, port);
  if (origin) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function rawToBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/** Ping a socket and terminate it after two missed pongs; returns a stopper. */
function startHeartbeat(socket: WebSocket): () => void {
  let missed = 0;
  const onPong = () => {
    missed = 0;
  };
  socket.on("pong", onPong);
  const timer = setInterval(() => {
    if (missed >= 2) {
      socket.terminate();
      return;
    }
    missed += 1;
    try {
      socket.ping();
    } catch {
      // Socket is already closing.
    }
  }, HEARTBEAT_MS);
  return () => {
    clearInterval(timer);
    socket.off("pong", onPong);
  };
}

function tokenEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function readCookie(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function shortMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return Buffer.from(text).subarray(0, 120).toString("utf8");
}

function intParam(value: string | null, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function safeJoin(baseDir: string, rel: string): string | null {
  const full = resolve(baseDir, rel);
  return full === baseDir || full.startsWith(baseDir + sep) ? full : null;
}

function packageDir(pkg: string): string | null {
  try {
    return dirname(require.resolve(`${pkg}/package.json`));
  } catch {
    // Packages whose "exports" hide package.json (monaco-editor): resolve the
    // entry point and walk up to the package folder.
    try {
      let dir = dirname(require.resolve(pkg));
      while (dir !== dirname(dir) && !existsSync(join(dir, "package.json"))) dir = dirname(dir);
      return existsSync(join(dir, "package.json")) ? dir : null;
    } catch {
      return null;
    }
  }
}

function vendorDirs(prefix: string): string[] {
  if (prefix === "/vendor/xterm/") {
    const dir = packageDir("@xterm/xterm");
    return dir ? [join(dir, "lib"), join(dir, "css")] : [];
  }
  if (prefix === "/vendor/kit/") {
    // @phren/desktop-kit's compiled ES modules: transcripts, timeline, tool cards.
    const dir = packageDir("@phren/desktop-kit");
    return dir ? [join(dir, "dist")] : [];
  }
  if (prefix === "/vendor/monaco/") {
    // Monaco's prebuilt browser bundle (AMD loader, editor, workers, codicon font).
    const dir = packageDir("monaco-editor");
    return dir ? [join(dir, "min")] : [];
  }
  const pkg = prefix === "/vendor/addon-fit/" ? "@xterm/addon-fit" : "@xterm/addon-webgl";
  const dir = packageDir(pkg);
  return dir ? [join(dir, "lib")] : [];
}

function resolveStatic(pathname: string): string | null {
  if (pathname === "/") return join(UI_DIR, "index.html");
  if (pathname === "/vendor/phren-graph.js") {
    // The CLI's 3D memory graph renderer (packages/cli/browser/graph), built by the CLI.
    const dir = packageDir("@phren/cli");
    const file = dir ? join(dir, "dist", "memory-ui-graph.runtime.js") : null;
    return file && existsSync(file) ? file : null;
  }
  const prefix = VENDOR_PREFIXES.find((p) => pathname.startsWith(p));
  if (prefix) {
    const rel = pathname.slice(prefix.length);
    for (const dir of vendorDirs(prefix)) {
      const full = safeJoin(dir, rel);
      if (full && existsSync(full)) return full;
    }
    return null;
  }
  if (pathname.startsWith("/editor-host/")) {
    // The Vite-built VS Code editor host (packages/desktop-editor).
    const full = safeJoin(join(UI_DIR, "editor-host"), pathname.slice("/editor-host/".length));
    return full && existsSync(full) ? full : null;
  }
  // UI files, including the shell/ and sections/ folders; safeJoin keeps them inside UI_DIR.
  if (!/^(?:[\w-]+\/)*[\w.-]+\.(js|css|html|md|json)$/.test(pathname.slice(1))) return null;
  return safeJoin(UI_DIR, pathname.slice(1));
}

function contentType(file: string): string {
  switch (extname(file).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".js":
    case ".mjs": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".md": return "text/markdown; charset=utf-8";
    case ".json":
    case ".map": return "application/json; charset=utf-8";
    case ".ttf": return "font/ttf";
    case ".woff": return "font/woff";
    case ".woff2": return "font/woff2";
    case ".wasm": return "application/wasm";
    case ".png": return "image/png";
    case ".svg": return "image/svg+xml";
    default: return "application/octet-stream";
  }
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(headers).find((h) => h.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

function parseHostPath(pathname: string): { name: string; hookPath: string } | null {
  const rest = pathname.slice("/hosts/".length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  return { name: decodeURIComponent(rest.slice(0, slash)), hookPath: rest.slice(slash) };
}


// Buffer the request body, discarding it past the cap instead of growing memory.
async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  let overflow = false;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    if (overflow) continue;
    size += buf.length;
    if (size > MAX_BODY) {
      overflow = true;
      chunks.length = 0;
    } else {
      chunks.push(buf);
    }
  }
  return overflow ? null : Buffer.concat(chunks);
}

export const startServer: StartServer = async (o) => {
  const overviewSockets = new Set<WebSocket>();
  const liveSockets = new Set<WebSocket>();
  const openHooks = new Set<WebSocket>();
  const terminals = new Map<WebSocket, TerminalSession>();
  const presence = new Map<string, { sentAt: number; unsupportedUntil: number }>();
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  let boundPort = o.port;

  const unauthorized = (res: ServerResponse) => {
    res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("unauthorized");
  };

  const sendJson = (res: ServerResponse, body: unknown, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };

  const sendError = (res: ServerResponse, err: unknown) => {
    sendJson(res, { error: shortMessage(err) }, err instanceof ExtensionError ? err.status : 500);
  };

  const readJson = async (req: IncomingMessage): Promise<unknown> => {
    const buf = await readBody(req);
    if (buf === null) throw new ExtensionError(413, "payload too large");
    if (buf.length === 0) return {};
    try {
      return JSON.parse(buf.toString("utf8"));
    } catch {
      throw new ExtensionError(400, "invalid JSON");
    }
  };

  const sendOverview = (ws: WebSocket, merged: MergedOverview) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "overview", merged }));
  };

  const rejectUpgrade = (socket: Duplex, status: number, text: string) => {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };

  const accept = (req: IncomingMessage, socket: Duplex, head: Buffer, onOpen: (ws: WebSocket) => void) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      liveSockets.add(ws);
      ws.on("close", () => liveSockets.delete(ws));
      onOpen(ws);
    });
  };

  const attachOverview = (ws: WebSocket) => {
    overviewSockets.add(ws);
    ws.on("close", () => overviewSockets.delete(ws));
    sendOverview(ws, o.hub.current());
  };

  const attachHost = async (ws: WebSocket, pathname: string, search: string) => {
    const parsed = parseHostPath(pathname);
    const computer = parsed && o.computers.find((c) => c.name === parsed.name);
    if (!parsed || !computer) {
      ws.close(1008, "unknown computer");
      return;
    }
    // Attach the browser listeners before the Hook connects, buffering frames
    // so nothing typed during the handshake is lost.
    const buffered: Array<{ data: WebSocket.RawData; isBinary: boolean }> = [];
    const stopBrowserPing = startHeartbeat(ws);
    let hook: WebSocket | null = null;
    let browserClosed = false;

    ws.on("message", (data, isBinary) => {
      if (hook && hook.readyState === WebSocket.OPEN) hook.send(data, { binary: isBinary });
      else if (buffered.length < 256) buffered.push({ data, isBinary });
    });
    ws.on("close", () => {
      browserClosed = true;
      stopBrowserPing();
      if (hook) {
        openHooks.delete(hook);
        hook.close();
      }
    });

    try {
      hook = await o.hookWebSocket(computer, parsed.hookPath + search);
    } catch (err) {
      ws.close(1011, shortMessage(err));
      return;
    }
    const hookSocket = hook;
    if (browserClosed || ws.readyState !== WebSocket.OPEN) {
      hookSocket.close();
      return;
    }
    openHooks.add(hookSocket);
    const stopHookPing = startHeartbeat(hookSocket);
    hookSocket.on("message", (data, isBinary) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary: isBinary });
    });
    hookSocket.on("close", () => {
      openHooks.delete(hookSocket);
      stopHookPing();
      if (ws.readyState === WebSocket.OPEN) ws.close();
    });
    hookSocket.on("error", (err) => {
      openHooks.delete(hookSocket);
      stopHookPing();
      if (ws.readyState === WebSocket.OPEN) ws.close(1011, shortMessage(err));
    });
    for (const frame of buffered) hookSocket.send(frame.data, { binary: frame.isBinary });
    buffered.length = 0;
  };

  const attachPty = (ws: WebSocket, url: URL) => {
    const computer = o.computers.find((c) => c.name === url.searchParams.get("computer"));
    if (!computer) {
      ws.close(1008, "unknown computer");
      return;
    }
    const server = url.searchParams.get("server") ?? computer.server;
    const cols = intParam(url.searchParams.get("cols"), 120);
    const rows = intParam(url.searchParams.get("rows"), 32);
    let term: TerminalSession;
    try {
      const folder = url.searchParams.get("folder");
      if (folder !== null) {
        if (!o.attachShell) throw new Error("shells are not available");
        term = o.attachShell(computer, folder, cols, rows);
      } else {
        term = o.attachTerminal(computer, server, cols, rows, url.searchParams.get("pane") ?? undefined);
      }
    } catch (err) {
      ws.close(1011, shortMessage(err));
      return;
    }
    terminals.set(ws, term);
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });
    term.onExit(() => {
      if (ws.readyState === WebSocket.OPEN) ws.close(1000);
    });
    ws.on("message", (data, isBinary) => {
      // Binary frames are always input; text frames are control JSON only and
      // are never written to the terminal.
      if (isBinary) {
        term.write(rawToBuffer(data).toString("utf8"));
        return;
      }
      try {
        const msg = JSON.parse(rawToBuffer(data).toString("utf8")) as { type?: string; cols?: number; rows?: number };
        if (msg.type === "resize") {
          term.resize(intParam(String(msg.cols), cols), intParam(String(msg.rows), rows));
        }
      } catch {
        // Ignore malformed control frames.
      }
    });
    ws.on("close", () => {
      terminals.delete(ws);
      term.kill();
    });
  };

  // One mirror per computer, shared by every Memory-section request so the 10 s
  // sync throttle and the blob-sha map survive across polls.
  const memory = createMemoryService({ hookRequest: o.hookRequest, computers: o.computers });

  const handleHttp = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${boundPort}`);
    const pathname = url.pathname;
    const publicGet = req.method === "GET" && (pathname.startsWith("/editor-host/") || pathname.startsWith("/extension-files/"));
    if (!hostAllowed(req.headers.host ?? "", boundPort, publicGet)) {
      res.writeHead(421, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("misdirected");
      return;
    }

    const queryToken = url.searchParams.get("token");
    if (queryToken && tokenEqual(queryToken, o.token)) {
      res.writeHead(302, {
        "Set-Cookie": `${COOKIE}=${o.token}; HttpOnly; SameSite=Strict; Path=/`,
        Location: "/",
      });
      res.end();
      return;
    }
    // The editor bundle is public code. The extension host frame loads it from
    // its own {{uuid}}.localhost origin, which carries no cookie.
    if (req.method === "GET" && pathname.startsWith("/editor-host/")) {
      const file = resolveStatic(pathname);
      if (!file || !existsSync(file)) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", ...corsHeaders(req, boundPort) });
        res.end("not found");
        return;
      }
      res.writeHead(200, { "Content-Type": contentType(file), "Cross-Origin-Resource-Policy": "cross-origin", ...corsHeaders(req, boundPort) });
      createReadStream(file).on("error", () => res.destroy()).pipe(res);
      return;
    }
    // Installed extensions' files are public Open VSX content. VS Code's
    // extension host fetches them from a sandboxed frame that has no origin and
    // sends no cookie, so they are served read-only without the token.
    if (req.method === "GET" && pathname.startsWith("/extension-files/")) {
      const rest = pathname.slice("/extension-files/".length);
      const slash = rest.indexOf("/");
      let file: string | null = null;
      try { file = slash < 0 ? null : extensionFilePath(decodeURIComponent(rest.slice(0, slash)), decodeURIComponent(rest.slice(slash + 1))); } catch { file = null; }
      if (!file || !existsSync(file)) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", ...corsHeaders(req, boundPort, true) });
        res.end("not found");
        return;
      }
      res.writeHead(200, { "Content-Type": contentType(file), "Cache-Control": "no-store", ...corsHeaders(req, boundPort, true) });
      createReadStream(file).on("error", () => res.destroy()).pipe(res);
      return;
    }
    const cookie = readCookie(req, COOKIE);
    if (!cookie || !tokenEqual(cookie, o.token)) {
      unauthorized(res);
      return;
    }
    if (!writeAllowed(req, boundPort)) {
      sendJson(res, { error: "forbidden" }, 403);
      return;
    }

    if (pathname === "/api/computers") {
      const computers = o.computers.map((c) => ({
        name: c.name,
        local: c.local,
        address: c.address,
        username: c.username,
        port: c.port,
        server: c.server,
      }));
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(computers));
      return;
    }

    if (pathname === "/api/computers/link" && req.method === "POST") {
      try {
        const body = (await readJson(req)) as { host?: unknown; name?: unknown; server?: unknown };
        if (typeof body.host !== "string" || !body.host.trim()) throw new ExtensionError(400, "An ssh host or user@host is required.");
        if (body.name !== undefined && typeof body.name !== "string") throw new ExtensionError(400, "name must be a string.");
        if (body.server !== undefined && typeof body.server !== "string") throw new ExtensionError(400, "server must be a string.");
        const computer = await linkComputer(body.host.trim(), { name: body.name || undefined, server: body.server || undefined });
        sendJson(res, computer);
      } catch (err) {
        sendError(res, err);
      }
      return;
    }

    if (pathname === "/api/computers/revoke" && req.method === "POST") {
      try {
        const body = (await readJson(req)) as { name?: unknown };
        if (typeof body.name !== "string" || !body.name.trim()) throw new ExtensionError(400, "A computer name is required.");
        const { remote } = await revokeComputer(body.name.trim());
        sendJson(res, { remote });
      } catch (err) {
        sendError(res, err);
      }
      return;
    }

    if (pathname === "/api/presence" && req.method === "POST") {
      // The owner is using the desktop: tell each online Hook to hold approval
      // alerts to the phone (desk first). At most every 20 s per computer.
      const now = Date.now();
      for (const c of o.computers) {
        const state = presence.get(c.name) ?? { sentAt: 0, unsupportedUntil: 0 };
        presence.set(c.name, state);
        if (now - state.sentAt < 20_000 || now < state.unsupportedUntil) continue;
        state.sentAt = now;
        void o.hookRequest(c, "POST", "/v1/push/presence", { activeForMs: 60_000 })
          .then((r) => { if (r.status === 404 || r.status === 400) state.unsupportedUntil = now + 10 * 60_000; })
          .catch(() => {});
      }
      sendJson(res, { ok: true });
      return;
    }

    if (pathname === "/api/overview") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(o.hub.current()));
      return;
    }

    if (pathname === "/api/usage" && (req.method ?? "GET") === "GET") {
      // The titlebar rings: every computer's account usage, merged by account
      // and cached for a minute so a polling UI never storms the Hooks.
      try {
        sendJson(res, await collectUsage(o.computers, o.hookRequest));
      } catch (err) {
        sendError(res, err);
      }
      return;
    }

    // The Memory section and the graph read one computer's store through the
    // CLI's own parsers; a remote computer is a synced mirror, and a review
    // mutation uploads only the files it changed.
    const memoryError = (err: unknown) => {
      if (err instanceof MemoryHttpError) sendJson(res, { error: err.message }, err.status);
      else sendError(res, err);
    };

    if (pathname.startsWith("/api/memory/")) {
      try {
        const rest = pathname.slice("/api/memory/".length);
        const slash = rest.indexOf("/");
        if (slash <= 0) throw new MemoryHttpError(404, "not found");
        const name = decodeURIComponent(rest.slice(0, slash));
        const sub = rest.slice(slash + 1);
        const computer = o.computers.find((c) => c.name === name);
        if (!computer) throw new MemoryHttpError(404, "unknown computer");
        const project = url.searchParams.get("project");
        if (sub === "review" && req.method === "POST") {
          sendJson(res, await memory.reviewAction(computer, (await readJson(req)) as ReviewActionBody));
        } else if (sub === "projects") {
          sendJson(res, await memory.projects(computer));
        } else if (sub === "findings") {
          sendJson(res, await memory.findings(computer, project));
        } else if (sub === "review") {
          sendJson(res, await memory.review(computer, project));
        } else if (sub === "notes") {
          sendJson(res, await memory.notes(computer, project));
        } else if (sub === "topics") {
          sendJson(res, await memory.topics(computer, project));
        } else if (sub === "truths") {
          sendJson(res, await memory.truths(computer, project));
        } else {
          throw new MemoryHttpError(404, "not found");
        }
      } catch (err) {
        memoryError(err);
      }
      return;
    }

    if (pathname.startsWith("/api/graph/")) {
      try {
        const name = decodeURIComponent(pathname.slice("/api/graph/".length));
        const computer = o.computers.find((c) => c.name === name);
        if (!computer) throw new MemoryHttpError(404, "unknown computer");
        sendJson(res, await memory.graph(computer, url.searchParams.get("project")));
      } catch (err) {
        memoryError(err);
      }
      return;
    }

    if (pathname === "/api/reh") {
      // The Node extension host: started lazily, address and token for the editor.
      try { await syncNodeExtensions(); } catch { /* still start it */ }
      const status = await rehStatus();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(status));
      return;
    }

    if (pathname === "/api/keys") {
      // Read on every request so "reload key settings" picks up edits.
      const config = await loadKeyConfig();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ...config, actions: ACTIONS }));
      return;
    }

    if (
      pathname === "/api/extensions" ||
      pathname.startsWith("/api/extensions/")
    ) {
      try {
        if (pathname === "/api/extensions" && (req.method ?? "GET") === "GET") {
          sendJson(res, { extensions: await listExtensions() });
          return;
        }
        if (pathname === "/api/extensions/search" && (req.method ?? "GET") === "GET") {
          sendJson(res, { extensions: await searchOpenVsx(url.searchParams.get("q") ?? "") });
          return;
        }
        if (pathname === "/api/extensions/install" && req.method === "POST") {
          const body = (await readJson(req)) as { namespace?: unknown; name?: unknown };
          if (typeof body.namespace !== "string" || typeof body.name !== "string") {
            throw new ExtensionError(400, "namespace and name are required.");
          }
          sendJson(res, await installFromOpenVsx(body.namespace, body.name));
          return;
        }
        const enable = /^\/api\/extensions\/([^/]+)\/enable$/.exec(pathname);
        if (enable && req.method === "POST") {
          const body = (await readJson(req)) as { enabled?: unknown };
          if (typeof body.enabled !== "boolean") throw new ExtensionError(400, "enabled must be a boolean.");
          sendJson(res, await setEnabled(decodeURIComponent(enable[1]), body.enabled));
          return;
        }
        const remove = /^\/api\/extensions\/([^/]+)$/.exec(pathname);
        if (remove && req.method === "DELETE") {
          await uninstall(decodeURIComponent(remove[1]));
          sendJson(res, { ok: true });
          return;
        }
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("not found");
      } catch (err) {
        sendError(res, err);
      }
      return;
    }

    if (pathname === "/api/previews" || pathname.startsWith("/api/previews/")) {
      try {
        const remove = /^\/api\/previews\/([^/]+)$/.exec(pathname);
        if (remove && req.method === "DELETE") {
          sendJson(res, { ok: closePreview(decodeURIComponent(remove[1])) });
          return;
        }
        if (pathname !== "/api/previews") {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("not found");
          return;
        }
        if ((req.method ?? "GET") === "GET") {
          sendJson(res, { previews: listPreviews() });
          return;
        }
        if (req.method === "POST") {
          const body = (await readJson(req)) as { computer?: unknown; port?: unknown };
          if (typeof body.computer !== "string" || !body.computer.trim()) throw new ExtensionError(400, "A computer is required.");
          const computer = o.computers.find((c) => c.name === body.computer);
          if (!computer) throw new ExtensionError(404, "Unknown computer.");
          if (typeof body.port !== "number" || !Number.isInteger(body.port) || body.port < 1 || body.port > 65535) {
            throw new ExtensionError(400, "A port is required.");
          }
          sendJson(res, await openPreview(computer, body.port));
          return;
        }
        res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("method not allowed");
      } catch (err) {
        sendError(res, err);
      }
      return;
    }


    if (pathname.startsWith("/hosts/")) {
      const parsed = parseHostPath(pathname);
      const computer = parsed && o.computers.find((c) => c.name === parsed.name);
      if (!parsed || !computer) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("unknown computer");
        return;
      }
      const buf = await readBody(req);
      if (buf === null) {
        res.writeHead(413, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("payload too large");
        return;
      }
      let body: unknown;
      if (buf.length > 0) {
        try {
          body = JSON.parse(buf.toString("utf8"));
        } catch {
          res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("invalid JSON");
          return;
        }
      }
      try {
        const hookRes = await o.hookRequest(computer, req.method ?? "GET", parsed.hookPath + url.search, body);
        res.writeHead(hookRes.status, {
          "Content-Type": headerValue(hookRes.headers, "content-type") ?? "application/json; charset=utf-8",
        });
        res.end(hookRes.body);
      } catch (err) {
        res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(shortMessage(err));
      }
      return;
    }

    const file = resolveStatic(pathname);
    if (!file || !existsSync(file)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": contentType(file) });
    createReadStream(file).on("error", () => res.destroy()).pipe(res);
  };

  const server = createServer((req, res) => {
    handleHttp(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("internal error");
      } else {
        res.destroy();
      }
    });
  });

  server.on("upgrade", (req, socket, head) => {
    if (!hostAllowed(req.headers.host ?? "", boundPort, false)) {
      rejectUpgrade(socket, 421, "Misdirected");
      return;
    }
    // The UI is served as localhost (VS Code's extension frame policy allows
    // localhost workers); 127.0.0.1 stays accepted for older links.
    if (req.headers.origin !== `http://localhost:${boundPort}` && req.headers.origin !== `http://127.0.0.1:${boundPort}`) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    const cookie = readCookie(req, COOKIE);
    if (!cookie || !tokenEqual(cookie, o.token)) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${boundPort}`);
    const pathname = url.pathname;
    if (pathname === "/api/overview") {
      accept(req, socket, head, attachOverview);
    } else if (pathname === "/pty") {
      accept(req, socket, head, (ws) => attachPty(ws, url));
    } else if (pathname.startsWith("/hosts/")) {
      accept(req, socket, head, (ws) => void attachHost(ws, pathname, url.search));
    } else {
      rejectUpgrade(socket, 404, "Not Found");
    }
  });

  o.hub.on("change", (merged) => {
    for (const ws of overviewSockets) sendOverview(ws, merged);
  });

  await new Promise<void>((done) => server.listen(o.port, "127.0.0.1", done));
  boundPort = (server.address() as AddressInfo).port;
  // Bound to loopback only; named localhost so the editor's extension frame
  // (on {{uuid}}.localhost) may load its worker from this origin.
  const url = `http://localhost:${boundPort}/?token=${encodeURIComponent(o.token)}`;

  const close = async () => {
    for (const ws of liveSockets) ws.terminate();
    liveSockets.clear();
    overviewSockets.clear();
    for (const hook of openHooks) hook.terminate();
    openHooks.clear();
    for (const term of terminals.values()) term.kill();
    terminals.clear();
    closeAllPreviews();
    stopReh();
    await new Promise<void>((done) => wss.close(() => done()));
    await new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections();
    });
  };

  return { url, close };
};
