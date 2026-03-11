import * as http from "http";
import * as crypto from "crypto";
import { timingSafeEqual } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as querystring from "querystring";
import { spawn } from "child_process";
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
  TASKS_FILENAME,
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
import { ensureTopicReferenceDoc, getProjectTopicsResponse, listProjectReferenceDocs, readReferenceContent, reclassifyLegacyTopicDocs, writeProjectTopics } from "./project-topics.js";
import { findSkill } from "./skill-registry.js";
import { setSkillEnabledAndSync } from "./skill-files.js";

export interface ReviewUiOptions {
  authToken?: string;
  csrfTokens?: Map<string, number>;
}

export interface ReviewUiStartOptions {
  autoOpen?: boolean;
  allowPortFallback?: boolean;
  browserLauncher?: (url: string) => Promise<void> | void;
}

const CSRF_TOKEN_TTL_MS = 15 * 60 * 1000;
const MAX_FORM_BODY_BYTES = 1_048_576;
const REVIEW_UI_READY_ATTEMPTS = 12;
const REVIEW_UI_READY_DELAY_MS = 75;

export function getReviewUiBrowserCommand(url: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") return { command: process.env.ComSpec || "cmd.exe", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

export async function launchReviewUiBrowser(url: string): Promise<void> {
  const { command, args } = getReviewUiBrowserCommand(url);
  await new Promise<void>((resolve, reject) => {
    try {
      const child = spawn(command, args, { detached: true, stdio: "ignore" });
      child.once("error", reject);
      child.once("spawn", () => {
        child.removeListener("error", reject);
        child.unref();
        resolve();
      });
    } catch (err: unknown) {
      reject(err);
    }
  });
}

export async function waitForReviewUiReady(
  url: string,
  attempts: number = REVIEW_UI_READY_ATTEMPTS,
  delayMs: number = REVIEW_UI_READY_DELAY_MS,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const ready = await new Promise<boolean>((resolve) => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve(true);
      });
      req.setTimeout(1000, () => {
        req.destroy();
        resolve(false);
      });
      req.on("error", () => resolve(false));
    });
    if (ready) return true;
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return false;
}

function isAddressInUse(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as NodeJS.ErrnoException).code === "EADDRINUSE");
}

async function listenOnLoopback(server: http.Server, port: number): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to determine review-ui port"));
        return;
      }
      resolve(address.port);
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

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

function parseTopicsPayload(raw: string): Array<{ slug: string; label: string; description: string; keywords: string[] }> | null {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.map((topic) => ({
      slug: String(topic?.slug || ""),
      label: String(topic?.label || ""),
      description: String(topic?.description || ""),
      keywords: Array.isArray(topic?.keywords) ? topic.keywords.map((keyword: unknown) => String(keyword)) : [],
    }));
  } catch {
    return null;
  }
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
      const allowedFiles = ["FINDINGS.md", TASKS_FILENAME, "CLAUDE.md", "summary.md"];
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

    if (req.method === "GET" && pathname === "/api/project-topics") {
      const qs = url.includes("?") ? querystring.parse(url.slice(url.indexOf("?") + 1)) : {};
      const project = String(qs.project || "");
      if (!project || !isValidProjectName(project)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid project" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, ...getProjectTopicsResponse(cortexPath, project) }));
      return;
    }

    if (req.method === "GET" && pathname === "/api/project-reference-list") {
      const qs = url.includes("?") ? querystring.parse(url.slice(url.indexOf("?") + 1)) : {};
      const project = String(qs.project || "");
      if (!project || !isValidProjectName(project)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid project" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, ...listProjectReferenceDocs(cortexPath, project) }));
      return;
    }

    if (req.method === "GET" && pathname === "/api/project-reference-content") {
      const qs = url.includes("?") ? querystring.parse(url.slice(url.indexOf("?") + 1)) : {};
      const project = String(qs.project || "");
      const file = String(qs.file || "");
      const contentResult = readReferenceContent(cortexPath, project, file);
      res.writeHead(contentResult.ok ? 200 : 400, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(contentResult.ok ? { ok: true, content: contentResult.content } : { ok: false, error: contentResult.error }));
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

    if (req.method === "POST" && pathname === "/api/skill-toggle") {
      void readFormBody(req, res).then((parsed) => {
        if (!parsed) return;
        if (!requirePostAuth(req, res, url, parsed, authToken, true)) return;
        if (!requireCsrf(res, parsed, csrfTokens, true)) return;
        const project = String(parsed.project || "");
        const name = String(parsed.name || "");
        const enabled = String(parsed.enabled || "") === "true";
        if (!project || !name || (project.toLowerCase() !== "global" && !isValidProjectName(project))) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Invalid skill toggle request" }));
          return;
        }
        const skill = findSkill(cortexPath, profile || "", project, name);
        if (!skill || "error" in skill) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: skill && "error" in skill ? skill.error : "Skill not found" }));
          return;
        }
        setSkillEnabledAndSync(cortexPath, project, skill.name, enabled);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, enabled }));
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

    if (req.method === "POST" && pathname === "/api/project-topics/save") {
      void readFormBody(req, res).then((parsed) => {
        if (!parsed) return;
        if (!requirePostAuth(req, res, url, parsed, authToken, true)) return;
        if (!requireCsrf(res, parsed, csrfTokens, true)) return;
        const project = String(parsed.project || "");
        const rawTopics = String(parsed.topics || "");
        if (!project || !isValidProjectName(project)) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Invalid project" }));
          return;
        }
        const topics = parseTopicsPayload(rawTopics);
        if (!topics) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Invalid topics payload" }));
          return;
        }
        const saved = writeProjectTopics(cortexPath, project, topics);
        if (!saved.ok) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(saved));
          return;
        }
        for (const topic of saved.topics) {
          const ensured = ensureTopicReferenceDoc(cortexPath, project, topic);
          if (!ensured.ok) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: ensured.error }));
            return;
          }
        }
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, ...getProjectTopicsResponse(cortexPath, project) }));
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/project-topics/reclassify") {
      void readFormBody(req, res).then((parsed) => {
        if (!parsed) return;
        if (!requirePostAuth(req, res, url, parsed, authToken, true)) return;
        if (!requireCsrf(res, parsed, csrfTokens, true)) return;
        const project = String(parsed.project || "");
        if (!project || !isValidProjectName(project)) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Invalid project" }));
          return;
        }
        const result = reclassifyLegacyTopicDocs(cortexPath, project);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, ...result }));
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
  opts: ReviewUiStartOptions = {},
): Promise<void> {
  const authToken = crypto.randomUUID();
  const csrfTokens = new Map<string, number>();
  const server = createReviewUiHttpServer(cortexPath, renderPage, profile, { authToken, csrfTokens });
  let boundPort: number;
  try {
    boundPort = await listenOnLoopback(server, port);
  } catch (err: unknown) {
    if (!opts.allowPortFallback || port === 0 || !isAddressInUse(err)) throw err;
    process.stderr.write(`[cortex] review-ui port ${port} is busy, using a random local port instead\n`);
    boundPort = await listenOnLoopback(server, 0);
  }

  const publicUrl = `http://127.0.0.1:${boundPort}`;
  const reviewUrl = `${publicUrl}/?_auth=${encodeURIComponent(authToken)}`;
  const ready = await waitForReviewUiReady(reviewUrl);

  process.stdout.write(`cortex review-ui running at ${publicUrl}\n`);
  process.stderr.write(`open: ${reviewUrl}\n`);
  if (!ready) {
    process.stderr.write("[cortex] review-ui health check did not confirm readiness before launch\n");
  }

  const shouldAutoOpen = opts.autoOpen ?? Boolean(process.stdout.isTTY);
  if (shouldAutoOpen) {
    try {
      if (opts.browserLauncher) await opts.browserLauncher(reviewUrl);
      else await launchReviewUiBrowser(reviewUrl);
    } catch (err: unknown) {
      process.stderr.write(`[cortex] review-ui browser launch failed: ${errorMessage(err)}\n`);
      process.stdout.write(`secure session URL: ${reviewUrl}\n`);
    }
  } else {
    process.stdout.write(`secure session URL: ${reviewUrl}\n`);
  }

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      server.close(() => resolve());
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  });
}
