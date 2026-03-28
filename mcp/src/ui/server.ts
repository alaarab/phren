import * as http from "http";
import * as crypto from "crypto";
import { timingSafeEqual } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as querystring from "querystring";
import { spawn, execFileSync } from "child_process";
import {
  computePhrenLiveStateToken,
  getProjectDirs,
} from "../shared.js";
import { getNonPrimaryStores } from "../store-registry.js";
import {
  editFinding,
  readReviewQueue,
  removeFinding,
  readFindings,
  addFinding as addFindingStore,
  readTasksAcrossProjects,
  addTask as addTaskStore,
  completeTask as completeTaskStore,
  removeTask as removeTaskStore,
  updateTask as updateTaskStore,
  TASKS_FILENAME,
} from "../data/access.js";
import { isValidProjectName, errorMessage, queueFilePath, safeProjectPath } from "../utils.js";
import { readInstallPreferences, writeInstallPreferences, writeGovernanceInstallPreferences, type InstallPreferences } from "../init/preferences.js";
import {
  buildGraph,
  collectProjectsForUI,
  collectSkillsForUI,
  getHooksData,
  isAllowedSkillPath,
  readSyncSnapshot,
  recentAccepted,
  recentUsage,
} from "./data.js";
import { CONSOLIDATION_ENTRY_THRESHOLD } from "../content/validate.js";
import {
  ensureTopicReferenceDoc,
  getProjectTopicsResponse,
  listProjectReferenceDocs,
  pinProjectTopicSuggestion,
  readReferenceContent,
  reclassifyLegacyTopicDocs,
  unpinProjectTopicSuggestion,
  writeProjectTopics,
} from "../project-topics.js";
import { getWorkflowPolicy, updateWorkflowPolicy, mergeConfig, getRetentionPolicy, getProjectConfigOverrides, VALID_TASK_MODES } from "../governance/policy.js";
import { readProjectConfig, updateProjectConfigOverrides } from "../project-config.js";
import { findSkill } from "../skill/registry.js";
import { setSkillEnabledAndSync } from "../skill/files.js";
import { repairPreexistingInstall } from "../init/setup.js";
import { logger } from "../logger.js";

export interface WebUiOptions {
  authToken?: string;
  csrfTokens?: Map<string, number>;
}

export interface WebUiStartOptions {
  autoOpen?: boolean;
  allowPortFallback?: boolean;
  browserLauncher?: (url: string) => Promise<void> | void;
}

const CSRF_TOKEN_TTL_MS = 15 * 60 * 1000;
const MAX_FORM_BODY_BYTES = 1_048_576;
const WEB_UI_READY_ATTEMPTS = 12;
const WEB_UI_READY_DELAY_MS = 75;
const WEB_UI_PORT_RETRY_ATTEMPTS = 3;

export function getWebUiBrowserCommand(url: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") return { command: process.env.ComSpec || "cmd.exe", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

async function launchWebUiBrowser(url: string): Promise<void> {
  const { command, args } = getWebUiBrowserCommand(url);
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

export async function waitForWebUiReady(
  url: string,
  attempts: number = WEB_UI_READY_ATTEMPTS,
  delayMs: number = WEB_UI_READY_DELAY_MS,
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
        reject(new Error("failed to determine web-ui port"));
        return;
      }
      resolve(address.port);
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

async function bindWebUiPort(
  server: http.Server,
  requestedPort: number,
  allowPortFallback: boolean,
): Promise<number> {
  const candidates: number[] = [requestedPort];
  if (allowPortFallback && requestedPort > 0) {
    for (let i = 1; i <= WEB_UI_PORT_RETRY_ATTEMPTS; i++) {
      candidates.push(requestedPort + i);
    }
  }

  let lastError: unknown = null;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    try {
      if (candidate !== requestedPort) {
        logger.info("web-ui", `port ${candidate - 1} is busy, retrying on ${candidate}`);
      }
      return await listenOnLoopback(server, candidate);
    } catch (err: unknown) {
      lastError = err;
      if (!allowPortFallback || !isAddressInUse(err) || i === candidates.length - 1) break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("failed to bind web-ui server");
}

function pruneExpiredCsrfTokens(csrfTokens?: Map<string, number>): void {
  if (!csrfTokens) return;
  const now = Date.now();
  for (const [token, createdAt] of csrfTokens) {
    if (now - createdAt > CSRF_TOKEN_TTL_MS) csrfTokens.delete(token);
  }
}

function setCommonHeaders(res: http.ServerResponse, nonce?: string): void {
  res.setHeader("Referrer-Policy", "no-referrer");
  if (nonce) {
    // Page responses: allow nonce-gated inline scripts but disallow inline event handlers
    res.setHeader("Content-Security-Policy", `default-src 'self'; script-src 'self' 'nonce-${nonce}' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.bunny.net; font-src https://fonts.bunny.net; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'`);
  } else {
    // API responses: no inline scripts needed
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
  }
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
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
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Request body too large" }));
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

function readProjectQueue(phrenPath: string, profile?: string) {
  const projects = getProjectDirs(phrenPath, profile).map((projectDir) => path.basename(projectDir)).filter((project) => project !== "global");
  const items: Array<{ project: string; section: string; line: string; text: string; date: string; machine?: string; model?: string }> = [];
  for (const project of projects) {
    const queueResult = readReviewQueue(phrenPath, project);
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

function parseTopicPayload(raw: string): { slug: string; label: string; description: string; keywords: string[] } | null {
  try {
    const topic = JSON.parse(raw);
    if (!topic || typeof topic !== "object") return null;
    return {
      slug: String((topic as Record<string, unknown>).slug || ""),
      label: String((topic as Record<string, unknown>).label || ""),
      description: String((topic as Record<string, unknown>).description || ""),
      keywords: Array.isArray((topic as Record<string, unknown>).keywords)
        ? ((topic as Record<string, unknown>).keywords as unknown[]).map((keyword) => String(keyword))
        : [],
    };
  } catch {
    return null;
  }
}

// ── Route context shared by all handlers ──────────────────────────────────────

interface RouteCtx {
  phrenPath: string;
  profile?: string;
  authToken?: string;
  csrfTokens?: Map<string, number>;
  renderPage: (phrenPath: string, authToken?: string, nonce?: string) => string;
}

type Req = http.IncomingMessage;
type Res = http.ServerResponse;

function parseQs(url: string): querystring.ParsedUrlQuery {
  return url.includes("?") ? querystring.parse(url.slice(url.indexOf("?") + 1)) : {};
}

function jsonOk(res: Res, data: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function jsonErr(res: Res, error: string, status = 200): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: false, error }));
}

function withPostBody(
  req: Req, res: Res, url: string, ctx: RouteCtx,
  handler: (parsed: querystring.ParsedUrlQuery) => void,
): void {
  void readFormBody(req, res).then((parsed) => {
    if (!parsed) return;
    if (!requirePostAuth(req, res, url, parsed, ctx.authToken, true)) return;
    if (!requireCsrf(res, parsed, ctx.csrfTokens, true)) return;
    handler(parsed);
  });
}

// ── GET handlers ──────────────────────────────────────────────────────────────

function handleGetHome(res: Res, ctx: RouteCtx): void {
  const nonce = crypto.randomBytes(16).toString("base64");
  setCommonHeaders(res, nonce);
  const html = ctx.renderPage(ctx.phrenPath, ctx.authToken, nonce);
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

/** Returns the store base path that contains the given project (primary or team store). */
function resolveProjectBasePath(phrenPath: string, project: string): string {
  const primaryDir = path.join(phrenPath, project);
  if (fs.existsSync(primaryDir)) return phrenPath;
  try {
    for (const store of getNonPrimaryStores(phrenPath)) {
      if (fs.existsSync(path.join(store.path, project))) return store.path;
    }
  } catch { /* fall through */ }
  return phrenPath;
}

function handleGetProjects(res: Res, ctx: RouteCtx): void {
  jsonOk(res, collectProjectsForUI(ctx.phrenPath, ctx.profile));
}

function handleGetChangeToken(res: Res, ctx: RouteCtx): void {
  jsonOk(res, { token: computePhrenLiveStateToken(ctx.phrenPath) });
}

function handleGetRuntimeHealth(res: Res, ctx: RouteCtx): void {
  jsonOk(res, readSyncSnapshot(ctx.phrenPath));
}

function handleGetReviewQueue(res: Res, ctx: RouteCtx): void {
  jsonOk(res, readProjectQueue(ctx.phrenPath, ctx.profile));
}

function handleGetReviewActivity(res: Res, ctx: RouteCtx): void {
  jsonOk(res, { accepted: recentAccepted(ctx.phrenPath), usage: recentUsage(ctx.phrenPath) });
}

function handleGetProjectContent(res: Res, url: string, ctx: RouteCtx): void {
  const qs = parseQs(url);
  const project = String(qs.project || "");
  const file = String(qs.file || "");
  if (!project || !isValidProjectName(project) || !file) return jsonErr(res, "Invalid project or file", 400);
  const allowedFiles = ["FINDINGS.md", TASKS_FILENAME, "CLAUDE.md", "summary.md"];
  if (!allowedFiles.includes(file)) return jsonErr(res, `File not allowed: ${file}`, 400);
  const basePath = resolveProjectBasePath(ctx.phrenPath, project);
  const filePath = safeProjectPath(basePath, project, file);
  if (!filePath) return jsonErr(res, "Invalid project or file path", 400);
  if (!fs.existsSync(filePath)) return jsonErr(res, `File not found: ${file}`);
  jsonOk(res, { ok: true, content: fs.readFileSync(filePath, "utf8") });
}

function handleGetProjectTopics(res: Res, url: string, ctx: RouteCtx): void {
  const project = String(parseQs(url).project || "");
  if (!project || !isValidProjectName(project)) return jsonErr(res, "Invalid project", 400);
  const basePath = resolveProjectBasePath(ctx.phrenPath, project);
  jsonOk(res, { ok: true, ...getProjectTopicsResponse(basePath, project) });
}

function handleGetProjectReferenceList(res: Res, url: string, ctx: RouteCtx): void {
  const project = String(parseQs(url).project || "");
  if (!project || !isValidProjectName(project)) return jsonErr(res, "Invalid project", 400);
  const basePath = resolveProjectBasePath(ctx.phrenPath, project);
  jsonOk(res, { ok: true, ...listProjectReferenceDocs(basePath, project) });
}

function handleGetProjectReferenceContent(res: Res, url: string, ctx: RouteCtx): void {
  const qs = parseQs(url);
  const project = String(qs.project || "");
  const basePath = resolveProjectBasePath(ctx.phrenPath, project);
  const contentResult = readReferenceContent(basePath, project, String(qs.file || ""));
  res.writeHead(contentResult.ok ? 200 : 400, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(contentResult.ok ? { ok: true, content: contentResult.content } : { ok: false, error: contentResult.error }));
}

function handleGetSkills(res: Res, ctx: RouteCtx): void {
  jsonOk(res, collectSkillsForUI(ctx.phrenPath, ctx.profile));
}

function handleGetSkillContent(res: Res, url: string, ctx: RouteCtx): void {
  const filePath = String(parseQs(url).path || "");
  if (!filePath || !isAllowedSkillPath(filePath, ctx.phrenPath)) return jsonErr(res, "Invalid path", 400);
  if (!fs.existsSync(filePath)) return jsonErr(res, "File not found");
  jsonOk(res, { ok: true, content: fs.readFileSync(filePath, "utf8") });
}

function handleGetHooks(res: Res, ctx: RouteCtx): void {
  jsonOk(res, getHooksData(ctx.phrenPath));
}

async function handleGetSearch(res: Res, url: string, ctx: RouteCtx): Promise<void> {
  const searchParams = new URLSearchParams(url.includes("?") ? url.slice(url.indexOf("?") + 1) : "");
  const query = searchParams.get("q") || searchParams.get("query") || "";
  const searchProject = searchParams.get("project") || undefined;
  const searchType = searchParams.get("type") || undefined;
  const searchLimit = parseInt(searchParams.get("limit") || "10", 10) || 10;
  if (!query.trim()) return jsonErr(res, "Missing query parameter (q or query).");
  try {
    const { runSearch } = await import("../cli/search.js");
    const result = await runSearch(
      { query, limit: Math.min(searchLimit, 50), project: searchProject, type: searchType },
      ctx.phrenPath, ctx.profile || "",
    );
    const fileDates: Record<string, string> = {};
    for (const line of result.lines) {
      const srcMatch = line.match(/^\[([^\]]+)\]\s/);
      if (srcMatch) {
        const sourceKey = srcMatch[1];
        if (fileDates[sourceKey]) continue;
        const slashIdx = sourceKey.indexOf("/");
        if (slashIdx > 0) {
          try {
            const filePath = path.join(ctx.phrenPath, sourceKey.slice(0, slashIdx), sourceKey.slice(slashIdx + 1));
            if (fs.existsSync(filePath)) fileDates[sourceKey] = fs.statSync(filePath).mtime.toISOString();
          } catch { /* skip */ }
        }
      }
    }
    jsonOk(res, { ok: true, query, results: result.lines, fileDates });
  } catch (err: unknown) {
    jsonErr(res, errorMessage(err));
  }
}

async function handleGetGraph(res: Res, url: string, ctx: RouteCtx): Promise<void> {
  const graphParams = new URLSearchParams(url.includes("?") ? url.slice(url.indexOf("?") + 1) : "");
  jsonOk(res, await buildGraph(ctx.phrenPath, ctx.profile, graphParams.get("project") || undefined));
}

function handleGetScores(res: Res, ctx: RouteCtx): void {
  let scores: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(path.join(ctx.phrenPath, ".runtime", "memory-scores.json"), "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") scores = parsed as Record<string, unknown>;
  } catch { /* file missing or unparseable */ }
  jsonOk(res, scores);
}

function handleGetTasks(res: Res, ctx: RouteCtx): void {
  try {
    const docs = readTasksAcrossProjects(ctx.phrenPath, ctx.profile);
    const tasks: Array<{ project: string; section: string; line: string; priority?: string; pinned?: boolean; githubIssue?: number; githubUrl?: string; context?: string; checked?: boolean; sessionId?: string }> = [];
    for (const doc of docs) {
      for (const section of ["Active", "Queue", "Done"] as const) {
        for (const item of doc.items[section]) {
          tasks.push({
            project: doc.project, section: item.section, line: item.line, priority: item.priority,
            pinned: item.pinned, githubIssue: item.githubIssue, githubUrl: item.githubUrl,
            context: item.context, checked: item.checked, sessionId: item.sessionId,
          });
        }
      }
    }
    jsonOk(res, { ok: true, tasks });
  } catch (err: unknown) {
    jsonOk(res, { ok: false, error: errorMessage(err), tasks: [] });
  }
}

function handleGetSettings(res: Res, url: string, ctx: RouteCtx): void {
  try {
    const prefs = readInstallPreferences(ctx.phrenPath);
    const workflowPolicy = getWorkflowPolicy(ctx.phrenPath);
    const retentionPolicy = getRetentionPolicy(ctx.phrenPath);
    const hooksData = getHooksData(ctx.phrenPath);
    const proactivityFindings = prefs.proactivityFindings || prefs.proactivity || "high";
    const settingsProject = String(parseQs(url).project || "");
    const merged = settingsProject && isValidProjectName(settingsProject) ? mergeConfig(ctx.phrenPath, settingsProject) : null;
    const overrides = settingsProject && isValidProjectName(settingsProject) ? getProjectConfigOverrides(ctx.phrenPath, settingsProject) : null;
    let projectInfo: { diskPath: string; ownership: string; configFile: string; configExists: boolean; hasFindings: boolean; hasTasks: boolean; hasSummary: boolean; hasClaudeMd: boolean; findingCount: number; taskCount: number } | null = null;
    if (settingsProject && isValidProjectName(settingsProject)) {
      const projectDir = path.join(ctx.phrenPath, settingsProject);
      const configFile = path.join(projectDir, "phren.project.yaml");
      const projConfig = readProjectConfig(ctx.phrenPath, settingsProject);
      const findingsPath = path.join(projectDir, "FINDINGS.md");
      const taskPath = path.join(projectDir, "tasks.md");
      let findingCount = 0;
      if (fs.existsSync(findingsPath)) findingCount = (fs.readFileSync(findingsPath, "utf8").match(/^- /gm) || []).length;
      let taskCount = 0;
      if (fs.existsSync(taskPath)) {
        const queueMatch = fs.readFileSync(taskPath, "utf8").match(/## Queue[\s\S]*?(?=## |$)/);
        if (queueMatch) taskCount = (queueMatch[0].match(/^- /gm) || []).length;
      }
      projectInfo = {
        diskPath: projConfig.sourcePath || projectDir, ownership: projConfig.ownership || "default",
        configFile, configExists: fs.existsSync(configFile), hasFindings: fs.existsSync(findingsPath),
        hasTasks: fs.existsSync(taskPath), hasSummary: fs.existsSync(path.join(projectDir, "summary.md")),
        hasClaudeMd: fs.existsSync(path.join(projectDir, "CLAUDE.md")), findingCount, taskCount,
      };
    }
    jsonOk(res, {
      ok: true, proactivity: prefs.proactivity || "high", proactivityFindings,
      proactivityTask: prefs.proactivityTask || prefs.proactivity || "high", taskMode: workflowPolicy.taskMode,
      findingSensitivity: workflowPolicy.findingSensitivity || "balanced", autoCaptureEnabled: proactivityFindings !== "low",
      consolidationEntryThreshold: CONSOLIDATION_ENTRY_THRESHOLD, hooksEnabled: hooksData.globalEnabled,
      mcpEnabled: prefs.mcpEnabled !== false, hookTools: hooksData.tools,
      retentionPolicy, workflowPolicy, merged, overrides, projectInfo,
    });
  } catch (err: unknown) {
    jsonErr(res, errorMessage(err));
  }
}

function handleGetConfig(res: Res, url: string, ctx: RouteCtx): void {
  const project = String(parseQs(url).project || "");
  if (project && !isValidProjectName(project)) return jsonErr(res, "Invalid project name", 400);
  try {
    const config = mergeConfig(ctx.phrenPath, project || undefined);
    const projects = getProjectDirs(ctx.phrenPath, ctx.profile).map((d) => path.basename(d)).filter((p) => p !== "global");
    jsonOk(res, { ok: true, config, projects });
  } catch (err: unknown) {
    jsonErr(res, errorMessage(err));
  }
}

function handleGetCsrfToken(res: Res, ctx: RouteCtx): void {
  if (!ctx.csrfTokens) return jsonOk(res, { ok: true, token: null });
  pruneExpiredCsrfTokens(ctx.csrfTokens);
  const token = crypto.randomUUID();
  ctx.csrfTokens.set(token, Date.now());
  jsonOk(res, { ok: true, token });
}

function handleGetFindings(res: Res, pathname: string, ctx: RouteCtx): void {
  const project = decodeURIComponent(pathname.slice("/api/findings/".length));
  if (!project || !isValidProjectName(project)) return jsonErr(res, "Invalid project name", 400);
  const basePath = resolveProjectBasePath(ctx.phrenPath, project);
  const result = readFindings(basePath, project);
  jsonOk(res, result.ok ? { ok: true, data: { project, findings: result.data } } : { ok: false, error: result.error });
}

// ── POST handlers ─────────────────────────────────────────────────────────────

function handlePostSync(req: Req, res: Res, url: string, ctx: RouteCtx): void {
  withPostBody(req, res, url, ctx, (parsed) => {
    const message = String(parsed.message || "update phren");
    try {
      const EXEC_TIMEOUT = 15_000;
      const runGit = (args: string[]) =>
        execFileSync("git", args, { cwd: ctx.phrenPath, encoding: "utf8", timeout: EXEC_TIMEOUT }).trim();
      const status = runGit(["status", "--porcelain"]);
      if (!status) return jsonOk(res, { ok: true, message: "Nothing to sync — working tree clean." });
      runGit(["add", "--", "*.md", "*.json", "*.yaml", "*.yml", "*.jsonl", "*.txt"]);
      const stagedFiles = runGit(["diff", "--cached", "--name-only"]);
      if (!stagedFiles) return jsonOk(res, { ok: true, message: "Nothing to sync — no matching files to commit." });
      runGit(["commit", "-m", message, "--only", "--", ...stagedFiles.split("\n").filter(Boolean)]);
      let pushed = false;
      try { if (runGit(["remote"])) { runGit(["push"]); pushed = true; } } catch { /* no remote or push failed */ }
      const changedFiles = status.split("\n").filter(Boolean).length;
      jsonOk(res, { ok: true, message: `Synced ${changedFiles} file(s).${pushed ? " Pushed to remote." : " No remote, saved locally."}` });
    } catch (err: unknown) {
      jsonErr(res, errorMessage(err));
    }
  });
}

function handlePostApprove(req: Req, res: Res, url: string, ctx: RouteCtx): void {
  withPostBody(req, res, url, ctx, (parsed) => {
    const project = String(parsed.project || "");
    const line = String(parsed.line || "");
    if (!project || !isValidProjectName(project) || !line) return jsonErr(res, "Missing project or line");
    try {
      const qPath = queueFilePath(ctx.phrenPath, project);
      if (fs.existsSync(qPath)) {
        const lines = fs.readFileSync(qPath, "utf8").split("\n").filter((l) => l.trim() !== line.trim());
        fs.writeFileSync(qPath, lines.join("\n"));
      }
      jsonOk(res, { ok: true });
    } catch (err: unknown) {
      jsonErr(res, errorMessage(err));
    }
  });
}

function handlePostReject(req: Req, res: Res, url: string, ctx: RouteCtx): void {
  withPostBody(req, res, url, ctx, (parsed) => {
    const project = String(parsed.project || "");
    const line = String(parsed.line || "");
    if (!project || !isValidProjectName(project) || !line) return jsonErr(res, "Missing project or line");
    try {
      const qPath = queueFilePath(ctx.phrenPath, project);
      if (fs.existsSync(qPath)) {
        const lines = fs.readFileSync(qPath, "utf8").split("\n").filter((l) => l.trim() !== line.trim());
        fs.writeFileSync(qPath, lines.join("\n"));
      }
      const findingText = line.replace(/^-\s*/, "").replace(/<!--.*?-->/g, "").trim();
      if (findingText) removeFinding(ctx.phrenPath, project, findingText);
      jsonOk(res, { ok: true });
    } catch (err: unknown) {
      jsonErr(res, errorMessage(err));
    }
  });
}

function handlePostEdit(req: Req, res: Res, url: string, ctx: RouteCtx): void {
  withPostBody(req, res, url, ctx, (parsed) => {
    const project = String(parsed.project || "");
    const line = String(parsed.line || "");
    const newText = String(parsed.new_text || "");
    if (!project || !isValidProjectName(project) || !line || !newText) return jsonErr(res, "Missing project, line, or new_text");
    try {
      const oldText = line.replace(/^-\s*/, "").replace(/<!--.*?-->/g, "").trim();
      const result = editFinding(ctx.phrenPath, project, oldText, newText);
      jsonOk(res, { ok: result.ok, error: result.ok ? undefined : result.error });
    } catch (err: unknown) {
      jsonErr(res, errorMessage(err));
    }
  });
}

function handlePostSkillSave(req: Req, res: Res, url: string, ctx: RouteCtx): void {
  withPostBody(req, res, url, ctx, (parsed) => {
    const filePath = String(parsed.path || "");
    const content = String(parsed.content || "");
    if (!filePath || !isAllowedSkillPath(filePath, ctx.phrenPath)) return jsonErr(res, "Invalid path");
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmpPath = `${filePath}.tmp-${crypto.randomUUID()}`;
      fs.writeFileSync(tmpPath, content);
      fs.renameSync(tmpPath, filePath);
      jsonOk(res, { ok: true });
    } catch (err: unknown) {
      jsonErr(res, errorMessage(err));
    }
  });
}

function handlePostSkillToggle(req: Req, res: Res, url: string, ctx: RouteCtx): void {
  withPostBody(req, res, url, ctx, (parsed) => {
    const project = String(parsed.project || "");
    const name = String(parsed.name || "");
    const enabled = String(parsed.enabled || "") === "true";
    if (!project || !name || (project.toLowerCase() !== "global" && !isValidProjectName(project))) return jsonErr(res, "Invalid skill toggle request");
    const skill = findSkill(ctx.phrenPath, ctx.profile || "", project, name);
    if (!skill || "error" in skill) return jsonErr(res, skill && "error" in skill ? skill.error : "Skill not found");
    setSkillEnabledAndSync(ctx.phrenPath, project, skill.name, enabled);
    jsonOk(res, { ok: true, enabled });
  });
}

function handlePostHookToggle(req: Req, res: Res, url: string, ctx: RouteCtx): void {
  withPostBody(req, res, url, ctx, (parsed) => {
    const tool = String(parsed.tool || "").toLowerCase();
    if (!["claude", "copilot", "cursor", "codex"].includes(tool)) return jsonErr(res, "Invalid tool");
    const prefs = readInstallPreferences(ctx.phrenPath);
    const toolPrefs = (prefs.hookTools && typeof prefs.hookTools === "object") ? prefs.hookTools : {};
    const current = toolPrefs[tool] !== false && prefs.hooksEnabled !== false;
    writeInstallPreferences(ctx.phrenPath, { hookTools: { ...toolPrefs, [tool]: !current } } satisfies Partial<InstallPreferences>);
    jsonOk(res, { ok: true, enabled: !current });
  });
}

function handlePostTopicsSave(req: Req, res: Res, url: string, ctx: RouteCtx): void {
  withPostBody(req, res, url, ctx, (parsed) => {
    const project = String(parsed.project || "");
    if (!project || !isValidProjectName(project)) return jsonErr(res, "Invalid project", 400);
    const topics = parseTopicsPayload(String(parsed.topics || ""));
    if (!topics) return jsonErr(res, "Invalid topics payload", 400);
    const saved = writeProjectTopics(ctx.phrenPath, project, topics);
    if (!saved.ok) return jsonOk(res, saved);
    for (const topic of saved.topics) {
      const ensured = ensureTopicReferenceDoc(ctx.phrenPath, project, topic);
      if (!ensured.ok) return jsonErr(res, ensured.error);
    }
    jsonOk(res, { ok: true, ...getProjectTopicsResponse(ctx.phrenPath, project) });
  });
}

function handlePostTopicsReclassify(req: Req, res: Res, url: string, ctx: RouteCtx): void {
  withPostBody(req, res, url, ctx, (parsed) => {
    const project = String(parsed.project || "");
    if (!project || !isValidProjectName(project)) return jsonErr(res, "Invalid project", 400);
    jsonOk(res, { ok: true, ...reclassifyLegacyTopicDocs(ctx.phrenPath, project) });
  });
}

function handlePostTopicsPin(req: Req, res: Res, url: string, ctx: RouteCtx): void {
  withPostBody(req, res, url, ctx, (parsed) => {
    const project = String(parsed.project || "");
    if (!project || !isValidProjectName(project)) return jsonErr(res, "Invalid project", 400);
    const topic = parseTopicPayload(String(parsed.topic || ""));
    if (!topic) return jsonErr(res, "Invalid topic payload", 400);
    const pinned = pinProjectTopicSuggestion(ctx.phrenPath, project, topic);
    if (!pinned.ok) return jsonOk(res, pinned);
    jsonOk(res, { ok: true, ...getProjectTopicsResponse(ctx.phrenPath, project) });
  });
}

function handlePostTopicsUnpin(req: Req, res: Res, url: string, ctx: RouteCtx): void {
  withPostBody(req, res, url, ctx, (parsed) => {
    const project = String(parsed.project || "");
    if (!project || !isValidProjectName(project)) return jsonErr(res, "Invalid project", 400);
    const unpinned = unpinProjectTopicSuggestion(ctx.phrenPath, project, String(parsed.slug || ""));
    if (!unpinned.ok) return jsonOk(res, unpinned);
    jsonOk(res, { ok: true, ...getProjectTopicsResponse(ctx.phrenPath, project) });
  });
}

function handlePostTaskAction(req: Req, res: Res, url: string, ctx: RouteCtx, action: "complete" | "add" | "remove"): void {
  withPostBody(req, res, url, ctx, (parsed) => {
    const project = String(parsed.project || "");
    const item = String(parsed.item || "");
    if (!project || !item || !isValidProjectName(project)) return jsonErr(res, "Missing or invalid project/item", 400);
    if (action === "complete") {
      const result = completeTaskStore(ctx.phrenPath, project, item);
      jsonOk(res, { ok: result.ok, message: result.ok ? result.data : undefined, error: result.ok ? undefined : result.error });
    } else if (action === "add") {
      const result = addTaskStore(ctx.phrenPath, project, item);
      jsonOk(res, { ok: result.ok, message: result.ok ? `Task added: ${result.data.line}` : undefined, error: result.ok ? undefined : result.error });
    } else {
      const result = removeTaskStore(ctx.phrenPath, project, item);
      jsonOk(res, { ok: result.ok, message: result.ok ? result.data : undefined, error: result.ok ? undefined : result.error });
    }
  });
}

function handlePostTaskUpdate(req: Req, res: Res, url: string, ctx: RouteCtx): void {
  withPostBody(req, res, url, ctx, (parsed) => {
    const project = String(parsed.project || "");
    const item = String(parsed.item || "");
    if (!project || !item || !isValidProjectName(project)) return jsonErr(res, "Missing or invalid project/item", 400);
    const updates: { text?: string; priority?: string; section?: string } = {};
    if (Object.prototype.hasOwnProperty.call(parsed, "text")) updates.text = String(parsed.text || "");
    if (Object.prototype.hasOwnProperty.call(parsed, "priority")) updates.priority = String(parsed.priority || "");
    if (Object.prototype.hasOwnProperty.call(parsed, "section")) updates.section = String(parsed.section || "");
    const result = updateTaskStore(ctx.phrenPath, project, item, updates);
    jsonOk(res, { ok: result.ok, message: result.ok ? result.data : undefined, error: result.ok ? undefined : result.error });
  });
}

function handlePostSettingsFindingSensitivity(req: Req, res: Res, url: string, ctx: RouteCtx): void {
  withPostBody(req, res, url, ctx, (parsed) => {
    const value = String(parsed.value || "");
    const valid = ["minimal", "conservative", "balanced", "aggressive"];
    if (!valid.includes(value)) return jsonErr(res, `Invalid finding sensitivity: "${value}". Must be one of: ${valid.join(", ")}`);
    const result = updateWorkflowPolicy(ctx.phrenPath, { findingSensitivity: value as "minimal" | "conservative" | "balanced" | "aggressive" });
    jsonOk(res, result.ok ? { ok: true, findingSensitivity: result.data.findingSensitivity } : { ok: false, error: result.error });
  });
}

function handlePostSettingsTaskMode(req: Req, res: Res, url: string, ctx: RouteCtx): void {
  withPostBody(req, res, url, ctx, (parsed) => {
    const value = String(parsed.value || "").trim().toLowerCase();
    const valid: readonly string[] = VALID_TASK_MODES;
    if (!valid.includes(value)) return jsonErr(res, `Invalid task mode: "${value}". Must be one of: ${valid.join(", ")}`);
    const result = updateWorkflowPolicy(ctx.phrenPath, { taskMode: value as typeof VALID_TASK_MODES[number] });
    jsonOk(res, result.ok ? { ok: true, taskMode: result.data.taskMode } : { ok: false, error: result.error });
  });
}

function handlePostSettingsProactivity(req: Req, res: Res, url: string, ctx: RouteCtx): void {
  withPostBody(req, res, url, ctx, (parsed) => {
    const value = String(parsed.value || "").trim().toLowerCase();
    const valid = ["high", "medium", "low"];
    if (!valid.includes(value)) return jsonErr(res, `Invalid proactivity: "${value}". Must be one of: ${valid.join(", ")}`);
    writeInstallPreferences(ctx.phrenPath, { proactivity: value as "high" | "medium" | "low" });
    writeGovernanceInstallPreferences(ctx.phrenPath, { proactivity: value as "high" | "medium" | "low" });
    jsonOk(res, { ok: true, proactivity: value });
  });
}

function handlePostSettingsAutoCapture(req: Req, res: Res, url: string, ctx: RouteCtx): void {
  withPostBody(req, res, url, ctx, (parsed) => {
    const enabled = String(parsed.enabled || "").toLowerCase() === "true";
    const next = enabled ? "high" : "low";
    writeInstallPreferences(ctx.phrenPath, { proactivityFindings: next });
    writeGovernanceInstallPreferences(ctx.phrenPath, { proactivityFindings: next });
    jsonOk(res, { ok: true, autoCaptureEnabled: enabled, proactivityFindings: next });
  });
}

function handlePostSettingsMcpEnabled(req: Req, res: Res, url: string, ctx: RouteCtx): void {
  withPostBody(req, res, url, ctx, (parsed) => {
    const enabled = String(parsed.enabled || "").toLowerCase() === "true";
    writeInstallPreferences(ctx.phrenPath, { mcpEnabled: enabled });
    jsonOk(res, { ok: true, mcpEnabled: enabled });
  });
}

function handlePostSettingsProjectOverrides(req: Req, res: Res, url: string, ctx: RouteCtx): void {
  withPostBody(req, res, url, ctx, (parsed) => {
    const project = String(parsed.project || "");
    const field = String(parsed.field || "");
    const value = String(parsed.value || "");
    const clearField = String(parsed.clear || "") === "true";
    if (!project || !isValidProjectName(project)) return jsonErr(res, "Invalid project name", 400);
    const registeredProjects = getProjectDirs(ctx.phrenPath, ctx.profile).map((d) => path.basename(d)).filter((p) => p !== "global");
    const registrationWarning = registeredProjects.includes(project) ? undefined : `Project '${project}' is not registered in the active profile. Config was saved but it will have no effect until the project is added with 'phren add'.`;
    const VALID_FIELDS: Record<string, string[]> = {
      findingSensitivity: ["minimal", "conservative", "balanced", "aggressive"],
      proactivity: ["high", "medium", "low"], proactivityFindings: ["high", "medium", "low"],
      proactivityTask: ["high", "medium", "low"], taskMode: ["off", "manual", "suggest", "auto"],
    };
    const NUMERIC_RETENTION_FIELDS = ["ttlDays", "retentionDays", "autoAcceptThreshold", "minInjectConfidence"];
    const NUMERIC_WORKFLOW_FIELDS = ["lowConfidenceThreshold"];
    try {
      updateProjectConfigOverrides(ctx.phrenPath, project, (current) => {
        const next = { ...current };
        if (clearField) {
          if (field in VALID_FIELDS) delete (next as Record<string, unknown>)[field];
          else if (NUMERIC_RETENTION_FIELDS.includes(field)) { if (next.retentionPolicy) delete (next.retentionPolicy as Record<string, unknown>)[field]; }
          else if (NUMERIC_WORKFLOW_FIELDS.includes(field)) { if (next.workflowPolicy) delete (next.workflowPolicy as Record<string, unknown>)[field]; }
          return next;
        }
        if (field in VALID_FIELDS) {
          if (!VALID_FIELDS[field].includes(value)) throw new Error(`Invalid value "${value}" for ${field}`);
          (next as Record<string, unknown>)[field] = value;
        } else if (NUMERIC_RETENTION_FIELDS.includes(field)) {
          const num = parseFloat(value);
          if (!Number.isFinite(num) || num < 0) throw new Error(`Invalid numeric value for ${field}`);
          next.retentionPolicy = { ...next.retentionPolicy, [field]: num };
        } else if (NUMERIC_WORKFLOW_FIELDS.includes(field)) {
          const num = parseFloat(value);
          if (!Number.isFinite(num) || num < 0 || num > 1) throw new Error(`Invalid value for ${field} (must be 0-1)`);
          next.workflowPolicy = { ...next.workflowPolicy, [field]: num };
        } else {
          throw new Error(`Unknown config field: ${field}`);
        }
        return next;
      });
      jsonOk(res, { ok: true, config: mergeConfig(ctx.phrenPath, project), ...(registrationWarning ? { warning: registrationWarning } : {}) });
    } catch (err: unknown) {
      jsonErr(res, errorMessage(err));
    }
  });
}

function handleFindingsWrite(req: Req, res: Res, url: string, pathname: string, ctx: RouteCtx): void {
  const project = decodeURIComponent(pathname.slice("/api/findings/".length));
  if (!project || !isValidProjectName(project)) return jsonErr(res, "Invalid project name", 400);

  if (req.method === "POST") {
    withPostBody(req, res, url, ctx, (parsed) => {
      const text = String(parsed.text || "");
      if (!text) return jsonErr(res, "text is required");
      const result = addFindingStore(ctx.phrenPath, project, text);
      jsonOk(res, { ok: result.ok, message: result.ok ? result.data : undefined, error: result.ok ? undefined : result.error });
    });
  } else if (req.method === "PUT") {
    withPostBody(req, res, url, ctx, (parsed) => {
      const oldText = String(parsed.old_text || "");
      const newText = String(parsed.new_text || "");
      if (!oldText || !newText) return jsonErr(res, "old_text and new_text are required");
      const result = editFinding(ctx.phrenPath, project, oldText, newText);
      jsonOk(res, { ok: result.ok, error: result.ok ? undefined : result.error });
    });
  } else {
    // DELETE
    withPostBody(req, res, url, ctx, (parsed) => {
      const text = String(parsed.text || "");
      if (!text) return jsonErr(res, "text is required");
      const result = removeFinding(ctx.phrenPath, project, text);
      jsonOk(res, { ok: result.ok, error: result.ok ? undefined : result.error });
    });
  }
}

// ── Main router ───────────────────────────────────────────────────────────────

export function createWebUiHttpServer(
  phrenPath: string,
  renderPage: (phrenPath: string, authToken?: string, nonce?: string) => string,
  profile?: string,
  opts?: WebUiOptions,
): http.Server {
  try {
    repairPreexistingInstall(phrenPath);
  } catch (err: unknown) {
    logger.debug("web-ui", `web-ui repair: ${errorMessage(err)}`);
  }

  const ctx: RouteCtx = {
    phrenPath, profile, authToken: opts?.authToken, csrfTokens: opts?.csrfTokens, renderPage,
  };

  return http.createServer(async (req, res) => {
    const url = req.url || "/";
    const pathname = url.includes("?") ? url.slice(0, url.indexOf("?")) : url;

    // Home page
    if (req.method === "GET" && pathname === "/") {
      if (!requireGetAuth(req, res, url, ctx.authToken)) return;
      pruneExpiredCsrfTokens(ctx.csrfTokens);
      if (ctx.csrfTokens) ctx.csrfTokens.set(crypto.randomUUID(), Date.now());
      return handleGetHome(res, ctx);
    }

    setCommonHeaders(res);

    // Auth gate for all GET /api/* routes
    if (pathname.startsWith("/api/") && req.method === "GET" && !requireGetAuth(req, res, url, ctx.authToken)) return;

    // ── GET routes ──
    if (req.method === "GET") {
      switch (pathname) {
        case "/api/projects": return handleGetProjects(res, ctx);
        case "/api/change-token": return handleGetChangeToken(res, ctx);
        case "/api/runtime-health": return handleGetRuntimeHealth(res, ctx);
        case "/api/review-queue": return handleGetReviewQueue(res, ctx);
        case "/api/review-activity": return handleGetReviewActivity(res, ctx);
        case "/api/project-topics": return handleGetProjectTopics(res, url, ctx);
        case "/api/project-reference-list": return handleGetProjectReferenceList(res, url, ctx);
        case "/api/project-reference-content": return handleGetProjectReferenceContent(res, url, ctx);
        case "/api/skills": return handleGetSkills(res, ctx);
        case "/api/hooks": return handleGetHooks(res, ctx);
        case "/api/scores": return handleGetScores(res, ctx);
        case "/api/tasks": return handleGetTasks(res, ctx);
        case "/api/settings": return handleGetSettings(res, url, ctx);
        case "/api/config": return handleGetConfig(res, url, ctx);
        case "/api/csrf-token": return handleGetCsrfToken(res, ctx);
        case "/api/search": return await handleGetSearch(res, url, ctx);
      }
      // Prefix-matched GET routes
      if (pathname.startsWith("/api/project-content")) return handleGetProjectContent(res, url, ctx);
      if (pathname.startsWith("/api/skill-content")) return handleGetSkillContent(res, url, ctx);
      if (pathname.startsWith("/api/graph")) return await handleGetGraph(res, url, ctx);
      if (pathname.startsWith("/api/findings/")) return handleGetFindings(res, pathname, ctx);
    }

    // ── POST/PUT/DELETE routes ──
    if (req.method === "POST" || req.method === "PUT" || req.method === "DELETE") {
      switch (pathname) {
        case "/api/sync": return handlePostSync(req, res, url, ctx);
        case "/api/approve": return handlePostApprove(req, res, url, ctx);
        case "/api/reject": return handlePostReject(req, res, url, ctx);
        case "/api/edit": return handlePostEdit(req, res, url, ctx);
        case "/api/skill-save": return handlePostSkillSave(req, res, url, ctx);
        case "/api/skill-toggle": return handlePostSkillToggle(req, res, url, ctx);
        case "/api/hook-toggle": return handlePostHookToggle(req, res, url, ctx);
        case "/api/project-topics/save": return handlePostTopicsSave(req, res, url, ctx);
        case "/api/project-topics/reclassify": return handlePostTopicsReclassify(req, res, url, ctx);
        case "/api/project-topics/pin": return handlePostTopicsPin(req, res, url, ctx);
        case "/api/project-topics/unpin": return handlePostTopicsUnpin(req, res, url, ctx);
        case "/api/tasks/complete": return handlePostTaskAction(req, res, url, ctx, "complete");
        case "/api/tasks/add": return handlePostTaskAction(req, res, url, ctx, "add");
        case "/api/tasks/remove": return handlePostTaskAction(req, res, url, ctx, "remove");
        case "/api/tasks/update": return handlePostTaskUpdate(req, res, url, ctx);
        case "/api/settings/finding-sensitivity": return handlePostSettingsFindingSensitivity(req, res, url, ctx);
        case "/api/settings/task-mode": return handlePostSettingsTaskMode(req, res, url, ctx);
        case "/api/settings/proactivity": return handlePostSettingsProactivity(req, res, url, ctx);
        case "/api/settings/auto-capture": return handlePostSettingsAutoCapture(req, res, url, ctx);
        case "/api/settings/mcp-enabled": return handlePostSettingsMcpEnabled(req, res, url, ctx);
        case "/api/settings/project-overrides": return handlePostSettingsProjectOverrides(req, res, url, ctx);
      }
      // Prefix-matched write routes
      if (pathname.startsWith("/api/findings/")) return handleFindingsWrite(req, res, url, pathname, ctx);
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  });
}

export async function startWebUiServer(
  phrenPath: string,
  port: number,
  renderPage: (phrenPath: string, authToken?: string, nonce?: string) => string,
  profile?: string,
  opts: WebUiStartOptions = {},
): Promise<void> {
  const authToken = crypto.randomUUID();
  const csrfTokens = new Map<string, number>();
  const server = createWebUiHttpServer(phrenPath, renderPage, profile, { authToken, csrfTokens });
  const boundPort = await bindWebUiPort(server, port, Boolean(opts.allowPortFallback && port !== 0));

  const publicUrl = `http://127.0.0.1:${boundPort}`;
  const reviewUrl = `${publicUrl}/?_auth=${encodeURIComponent(authToken)}`;
  const ready = await waitForWebUiReady(reviewUrl);

  process.stdout.write(`phren web-ui running at ${publicUrl}\n`);
  process.stderr.write(`open: ${reviewUrl}\n`);
  if (!ready) {
    logger.warn("web-ui", "health check did not confirm readiness before launch");
  }

  const shouldAutoOpen = opts.autoOpen ?? Boolean(process.stdout.isTTY);
  if (shouldAutoOpen && ready) {
    try {
      if (opts.browserLauncher) await opts.browserLauncher(reviewUrl);
      else await launchWebUiBrowser(reviewUrl);
    } catch (err: unknown) {
      logger.warn("web-ui", `browser launch failed: ${errorMessage(err)}`);
      process.stdout.write(`secure session URL: ${reviewUrl}\n`);
    }
  } else if (shouldAutoOpen && !ready) {
    logger.warn("web-ui", "skipped auto-open because readiness check failed; use the secure URL below");
    process.stdout.write(`secure session URL: ${reviewUrl}\n`);
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
