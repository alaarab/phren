import * as http from "http";
import * as crypto from "crypto";
import { timingSafeEqual } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as querystring from "querystring";
import {
  CortexError,
  computeCortexLiveStateToken,
  getProjectDirs,
  type CortexResult,
} from "./shared.js";
import {
  approveQueueItem,
  editQueueItem,
  readReviewQueue,
  rejectQueueItem,
} from "./data-access.js";
import { isValidProjectName, errorMessage } from "./utils.js";
import { readInstallPreferences, writeInstallPreferences, type InstallPreferences } from "./init-preferences.js";
import {
  buildGraph,
  collectProjectsForUI,
  collectSkillsForUI,
  getHooksData,
  isAllowedFilePath,
  readSyncSnapshot,
  recentAccepted,
  recentUsage,
} from "./memory-ui-data.js";

export interface ReviewUiOptions {
  authToken?: string;
  csrfTokens?: Map<string, number>;
}

const CSRF_TOKEN_TTL_MS = 15 * 60 * 1000;
const MAX_FORM_BODY_BYTES = 1_048_576;

function pruneExpiredCsrfTokens(csrfTokens?: Map<string, number>): void {
  if (!csrfTokens) return;
  const now = Date.now();
  for (const [token, createdAt] of csrfTokens) {
    if (now - createdAt > CSRF_TOKEN_TTL_MS) csrfTokens.delete(token);
  }
}

function setCommonHeaders(res: http.ServerResponse): void {
  res.setHeader("Referrer-Policy", "no-referrer");
}

function getSubmittedAuthToken(req: http.IncomingMessage, url: string, parsedBody?: querystring.ParsedUrlQuery): string {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string") {
    const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    if (bearerMatch) return bearerMatch[1];
  }

  const query = url.includes("?") ? querystring.parse(url.slice(url.indexOf("?") + 1)) : {};
  const queryAuth = query._auth;
  if (typeof queryAuth === "string") return queryAuth;

  const bodyAuth = parsedBody?._auth;
  if (typeof bodyAuth === "string") return bodyAuth;

  return "";
}

function authTokensMatch(submitted: string, authToken?: string): boolean {
  if (!authToken || !submitted) return false;
  const submittedBuffer = Buffer.from(submitted);
  const authTokenBuffer = Buffer.from(authToken);
  if (submittedBuffer.length !== authTokenBuffer.length) return false;
  return timingSafeEqual(submittedBuffer, authTokenBuffer);
}

function rejectUnauthorized(res: http.ServerResponse, json = false): void {
  if (json) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
    return;
  }
  res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
  res.end("Unauthorized");
}

function requireGetAuth(req: http.IncomingMessage, res: http.ServerResponse, url: string, authToken?: string, json = false): boolean {
  if (!authToken) return true;
  const submitted = getSubmittedAuthToken(req, url);
  if (authTokensMatch(submitted, authToken)) return true;
  rejectUnauthorized(res, json);
  return false;
}

function readFormBody(req: http.IncomingMessage, res: http.ServerResponse): Promise<querystring.ParsedUrlQuery | null> {
  const contentLength = parseInt(req.headers["content-length"] || "0", 10);
  if (contentLength > MAX_FORM_BODY_BYTES) {
    res.writeHead(413, { "content-type": "text/plain" });
    res.end("Request body too large");
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    let body = "";
    let received = 0;
    req.on("data", (chunk) => {
      received += chunk.length;
      if (received > MAX_FORM_BODY_BYTES) {
        req.destroy();
        resolve(null);
        return;
      }
      body += String(chunk);
    });
    req.on("end", () => resolve(querystring.parse(body)));
    req.on("error", () => resolve(null));
    req.on("close", () => {
      if (received > MAX_FORM_BODY_BYTES) resolve(null);
    });
  });
}

function requirePostAuth(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  parsed: querystring.ParsedUrlQuery,
  authToken?: string,
  json = false,
): boolean {
  if (!authToken) return true;
  const submitted = getSubmittedAuthToken(req, url, parsed);
  if (authTokensMatch(submitted, authToken)) return true;
  rejectUnauthorized(res, json);
  return false;
}

function requireCsrf(
  res: http.ServerResponse,
  parsed: querystring.ParsedUrlQuery,
  csrfTokens?: Map<string, number>,
  json = false,
): boolean {
  if (!csrfTokens) return true;
  pruneExpiredCsrfTokens(csrfTokens);
  const submitted = String(parsed._csrf || "");
  if (submitted && csrfTokens.delete(submitted)) return true;
  if (json) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Invalid or missing CSRF token" }));
    return false;
  }
  res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
  res.end("Invalid or missing CSRF token");
  return false;
}

function readProjectQueue(cortexPath: string, profile?: string) {
  const projects = getProjectDirs(cortexPath, profile).map((projectDir) => path.basename(projectDir)).filter((project) => project !== "global");
  const items: Array<{ project: string; section: string; line: string; text: string; date: string; machine?: string; model?: string }> = [];
  for (const project of projects) {
    const queueResult = readReviewQueue(cortexPath, project);
    const queueItems = queueResult.ok ? queueResult.data : [];
    for (const item of queueItems) {
      items.push({
        project,
        section: item.section,
        line: item.line,
        text: item.text,
        date: item.date,
        machine: item.machine || undefined,
        model: item.model || undefined,
      });
    }
  }
  return items;
}

function runQueueAction(cortexPath: string, pathname: string, project: string, line: string, newText: string): CortexResult<string> {
  if (pathname === "/api/approve" || pathname === "/approve") return approveQueueItem(cortexPath, project, line);
  if (pathname === "/api/reject" || pathname === "/reject") return rejectQueueItem(cortexPath, project, line);
  if (pathname === "/api/edit" || pathname === "/edit") return editQueueItem(cortexPath, project, line, newText);
  return { ok: false, error: "unknown action" };
}

function handleLegacyQueueActionResult(res: http.ServerResponse, result: CortexResult<string>): void {
  if (result.ok) {
    res.writeHead(302, { location: "/" });
    res.end();
    return;
  }

  const code = result.code;
  if (code === CortexError.PERMISSION_DENIED || result.error.includes("requires maintainer/admin role")) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end(result.error);
    return;
  }
  if (code === CortexError.NOT_FOUND) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end(result.error);
    return;
  }
  if (code === CortexError.INVALID_PROJECT_NAME || code === CortexError.EMPTY_INPUT) {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end(result.error);
    return;
  }
  res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
  res.end(result.error);
}

export function createReviewUiHttpServer(
  cortexPath: string,
  renderPage: (cortexPath: string, authToken?: string) => string,
  profile?: string,
  opts?: ReviewUiOptions,
): http.Server {
  const authToken = opts?.authToken;
  const csrfTokens = opts?.csrfTokens;

  return http.createServer((req, res) => {
    setCommonHeaders(res);
    const url = req.url || "/";
    const pathname = url.includes("?") ? url.slice(0, url.indexOf("?")) : url;

    if (req.method === "GET" && pathname === "/") {
      if (!requireGetAuth(req, res, url, authToken)) return;
      pruneExpiredCsrfTokens(csrfTokens);
      if (csrfTokens) csrfTokens.set(crypto.randomUUID(), Date.now());
      const html = renderPage(cortexPath, authToken);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (pathname.startsWith("/api/") && req.method === "GET" && !requireGetAuth(req, res, url, authToken)) {
      return;
    }

    if (req.method === "GET" && pathname === "/api/projects") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(collectProjectsForUI(cortexPath, profile)));
      return;
    }

    if (req.method === "GET" && pathname === "/api/change-token") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ token: computeCortexLiveStateToken(cortexPath) }));
      return;
    }

    if (req.method === "GET" && pathname === "/api/runtime-health") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(readSyncSnapshot(cortexPath)));
      return;
    }

    if (req.method === "GET" && pathname === "/api/review-queue") {
      if (!requireGetAuth(req, res, url, authToken, true)) return;
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(readProjectQueue(cortexPath, profile)));
      return;
    }

    if (req.method === "GET" && pathname === "/api/review-activity") {
      if (!requireGetAuth(req, res, url, authToken, true)) return;
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        accepted: recentAccepted(cortexPath),
        usage: recentUsage(cortexPath),
      }));
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/api/project-content")) {
      const qs = url.includes("?") ? querystring.parse(url.slice(url.indexOf("?") + 1)) : {};
      const project = String(qs.project || "");
      const file = String(qs.file || "");
      if (!project || !isValidProjectName(project) || !file) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid project or file" }));
        return;
      }
      const allowedFiles = ["FINDINGS.md", "backlog.md", "CLAUDE.md", "summary.md"];
      if (!allowedFiles.includes(file)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: `File not allowed: ${file}` }));
        return;
      }
      const filePath = path.join(cortexPath, project, file);
      if (!fs.existsSync(filePath)) {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: `File not found: ${file}` }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, content: fs.readFileSync(filePath, "utf8") }));
      return;
    }

    if (req.method === "GET" && pathname === "/api/skills") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(collectSkillsForUI(cortexPath, profile)));
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/api/skill-content")) {
      const qs = url.includes("?") ? querystring.parse(url.slice(url.indexOf("?") + 1)) : {};
      const filePath = String(qs.path || "");
      if (!filePath || !isAllowedFilePath(filePath, cortexPath)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid path" }));
        return;
      }
      if (!fs.existsSync(filePath)) {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "File not found" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, content: fs.readFileSync(filePath, "utf8") }));
      return;
    }

    if (req.method === "GET" && pathname === "/api/hooks") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(getHooksData(cortexPath)));
      return;
    }

    if (req.method === "POST" && pathname === "/api/skill-save") {
      void readFormBody(req, res).then((parsed) => {
        if (!parsed) return;
        if (!requirePostAuth(req, res, url, parsed, authToken, true)) return;
        if (!requireCsrf(res, parsed, csrfTokens, true)) return;
        const filePath = String(parsed.path || "");
        const content = String(parsed.content || "");
        if (!filePath || !isAllowedFilePath(filePath, cortexPath)) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Invalid path" }));
          return;
        }
        try {
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          const tmpPath = `${filePath}.tmp-${crypto.randomUUID()}`;
          fs.writeFileSync(tmpPath, content);
          fs.renameSync(tmpPath, filePath);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (err: unknown) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: errorMessage(err) }));
        }
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/hook-toggle") {
      void readFormBody(req, res).then((parsed) => {
        if (!parsed) return;
        if (!requirePostAuth(req, res, url, parsed, authToken, true)) return;
        if (!requireCsrf(res, parsed, csrfTokens, true)) return;
        const tool = String(parsed.tool || "").toLowerCase();
        const validTools = ["claude", "copilot", "cursor", "codex"];
        if (!validTools.includes(tool)) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Invalid tool" }));
          return;
        }
        const prefs = readInstallPreferences(cortexPath);
        const toolPrefs = (prefs.hookTools && typeof prefs.hookTools === "object") ? prefs.hookTools : {};
        const current = toolPrefs[tool] !== false && prefs.hooksEnabled !== false;
        writeInstallPreferences(cortexPath, {
          hookTools: { ...toolPrefs, [tool]: !current },
        } satisfies Partial<InstallPreferences>);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, enabled: !current }));
      });
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/api/graph")) {
      const graphParams = new URLSearchParams(url.includes("?") ? url.slice(url.indexOf("?") + 1) : "");
      const focusProject = graphParams.get("project") || undefined;
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(buildGraph(cortexPath, profile, focusProject)));
      return;
    }

    if (req.method === "GET" && pathname === "/api/csrf-token") {
      if (!requireGetAuth(req, res, url, authToken, true)) return;
      if (!csrfTokens) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, token: null }));
        return;
      }
      pruneExpiredCsrfTokens(csrfTokens);
      const token = crypto.randomUUID();
      csrfTokens.set(token, Date.now());
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, token }));
      return;
    }

    if (req.method === "POST" && ["/api/approve", "/api/reject", "/api/edit"].includes(pathname)) {
      void readFormBody(req, res).then((parsed) => {
        if (!parsed) return;
        if (!requirePostAuth(req, res, url, parsed, authToken, true)) return;
        if (!requireCsrf(res, parsed, csrfTokens, true)) return;
        const project = String(parsed.project || "");
        const line = String(parsed.line || "");
        const newText = String(parsed.new_text || "");
        if (!project || !line || !isValidProjectName(project)) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Missing or invalid project/line" }));
          return;
        }
        const result = runQueueAction(cortexPath, pathname, project, line, newText);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: result.ok, error: result.ok ? undefined : result.error }));
      });
      return;
    }

    if (req.method === "POST" && ["/approve", "/reject", "/edit"].includes(pathname)) {
      void readFormBody(req, res).then((parsed) => {
        if (!parsed) return;
        if (!requirePostAuth(req, res, url, parsed, authToken)) return;
        if (!requireCsrf(res, parsed, csrfTokens)) return;
        const project = String(parsed.project || "");
        const line = String(parsed.line || "");
        const newText = String(parsed.new_text || "");
        if (!project || !line) {
          res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
          res.end("Missing project/line");
          return;
        }
        if (!isValidProjectName(project)) {
          res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
          res.end("Invalid project name");
          return;
        }
        handleLegacyQueueActionResult(res, runQueueAction(cortexPath, pathname, project, line, newText));
      });
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  });
}

export async function startReviewUiServer(
  cortexPath: string,
  port: number,
  renderPage: (cortexPath: string, authToken?: string) => string,
  profile?: string,
): Promise<void> {
  const authToken = crypto.randomUUID();
  const csrfTokens = new Map<string, number>();
  const server = createReviewUiHttpServer(cortexPath, renderPage, profile, { authToken, csrfTokens });
  const reviewUrl = `http://127.0.0.1:${port}/?_auth=${encodeURIComponent(authToken)}`;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  process.stdout.write(`cortex review-ui running at http://127.0.0.1:${port}\n`);
  process.stderr.write(`open: ${reviewUrl}\n`);

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      server.close(() => resolve());
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  });
}
