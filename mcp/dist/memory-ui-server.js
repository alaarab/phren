import * as http from "http";
import * as crypto from "crypto";
import { timingSafeEqual } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as querystring from "querystring";
import { spawn, execFileSync } from "child_process";
import { computePhrenLiveStateToken, getProjectDirs, } from "./shared.js";
import { editFinding, readReviewQueue, removeFinding, readFindings, addFinding as addFindingStore, readTasksAcrossProjects, addTask as addTaskStore, completeTask as completeTaskStore, removeTask as removeTaskStore, TASKS_FILENAME, } from "./data-access.js";
import { isValidProjectName, errorMessage } from "./utils.js";
import { readInstallPreferences, writeInstallPreferences, writeGovernanceInstallPreferences } from "./init-preferences.js";
import { buildGraph, collectProjectsForUI, collectSkillsForUI, getHooksData, isAllowedFilePath, readSyncSnapshot, recentAccepted, recentUsage, } from "./memory-ui-data.js";
import { CONSOLIDATION_ENTRY_THRESHOLD } from "./content-validate.js";
import { ensureTopicReferenceDoc, getProjectTopicsResponse, listProjectReferenceDocs, pinProjectTopicSuggestion, readReferenceContent, reclassifyLegacyTopicDocs, unpinProjectTopicSuggestion, writeProjectTopics, } from "./project-topics.js";
import { getWorkflowPolicy, updateWorkflowPolicy } from "./governance-policy.js";
import { findSkill } from "./skill-registry.js";
import { setSkillEnabledAndSync } from "./skill-files.js";
import { listAllSessions, getSessionArtifacts } from "./mcp-session.js";
import { repairPreexistingInstall } from "./init-setup.js";
const CSRF_TOKEN_TTL_MS = 15 * 60 * 1000;
const MAX_FORM_BODY_BYTES = 1_048_576;
const WEB_UI_READY_ATTEMPTS = 12;
const WEB_UI_READY_DELAY_MS = 75;
const WEB_UI_PORT_RETRY_ATTEMPTS = 3;
export function getWebUiBrowserCommand(url, platform = process.platform) {
    if (platform === "darwin")
        return { command: "open", args: [url] };
    if (platform === "win32")
        return { command: process.env.ComSpec || "cmd.exe", args: ["/c", "start", "", url] };
    return { command: "xdg-open", args: [url] };
}
export async function launchWebUiBrowser(url) {
    const { command, args } = getWebUiBrowserCommand(url);
    await new Promise((resolve, reject) => {
        try {
            const child = spawn(command, args, { detached: true, stdio: "ignore" });
            child.once("error", reject);
            child.once("spawn", () => {
                child.removeListener("error", reject);
                child.unref();
                resolve();
            });
        }
        catch (err) {
            reject(err);
        }
    });
}
export async function waitForWebUiReady(url, attempts = WEB_UI_READY_ATTEMPTS, delayMs = WEB_UI_READY_DELAY_MS) {
    for (let attempt = 0; attempt < attempts; attempt++) {
        const ready = await new Promise((resolve) => {
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
        if (ready)
            return true;
        if (attempt < attempts - 1) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }
    return false;
}
function isAddressInUse(err) {
    return Boolean(err && typeof err === "object" && "code" in err && err.code === "EADDRINUSE");
}
async function listenOnLoopback(server, port) {
    return await new Promise((resolve, reject) => {
        const onError = (err) => {
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
async function bindWebUiPort(server, requestedPort, allowPortFallback) {
    const candidates = [requestedPort];
    if (allowPortFallback && requestedPort > 0) {
        for (let i = 1; i <= WEB_UI_PORT_RETRY_ATTEMPTS; i++) {
            candidates.push(requestedPort + i);
        }
    }
    let lastError = null;
    for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        try {
            if (candidate !== requestedPort) {
                process.stderr.write(`[phren] web-ui port ${candidate - 1} is busy, retrying on ${candidate}\n`);
            }
            return await listenOnLoopback(server, candidate);
        }
        catch (err) {
            lastError = err;
            if (!allowPortFallback || !isAddressInUse(err) || i === candidates.length - 1)
                break;
        }
    }
    throw lastError instanceof Error ? lastError : new Error("failed to bind web-ui server");
}
function pruneExpiredCsrfTokens(csrfTokens) {
    if (!csrfTokens)
        return;
    const now = Date.now();
    for (const [token, createdAt] of csrfTokens) {
        if (now - createdAt > CSRF_TOKEN_TTL_MS)
            csrfTokens.delete(token);
    }
}
function setCommonHeaders(res, nonce) {
    res.setHeader("Referrer-Policy", "no-referrer");
    if (nonce) {
        // Page responses: allow nonce-gated inline scripts but disallow inline event handlers
        res.setHeader("Content-Security-Policy", `default-src 'self'; script-src 'self' 'nonce-${nonce}' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.bunny.net; font-src https://fonts.bunny.net; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'`);
    }
    else {
        // API responses: no inline scripts needed
        res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
}
function getSubmittedAuthToken(req, url, parsedBody) {
    const authHeader = req.headers.authorization;
    if (typeof authHeader === "string") {
        const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
        if (bearerMatch)
            return bearerMatch[1];
    }
    const query = url.includes("?") ? querystring.parse(url.slice(url.indexOf("?") + 1)) : {};
    const queryAuth = query._auth;
    if (typeof queryAuth === "string")
        return queryAuth;
    const bodyAuth = parsedBody?._auth;
    if (typeof bodyAuth === "string")
        return bodyAuth;
    return "";
}
function authTokensMatch(submitted, authToken) {
    if (!authToken || !submitted)
        return false;
    const submittedBuffer = Buffer.from(submitted);
    const authTokenBuffer = Buffer.from(authToken);
    if (submittedBuffer.length !== authTokenBuffer.length)
        return false;
    return timingSafeEqual(submittedBuffer, authTokenBuffer);
}
function rejectUnauthorized(res, json = false) {
    if (json) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
        return;
    }
    res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
    res.end("Unauthorized");
}
function requireGetAuth(req, res, url, authToken, json = false) {
    if (!authToken)
        return true;
    const submitted = getSubmittedAuthToken(req, url);
    if (authTokensMatch(submitted, authToken))
        return true;
    rejectUnauthorized(res, json);
    return false;
}
function readFormBody(req, res) {
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
            if (received > MAX_FORM_BODY_BYTES)
                resolve(null);
        });
    });
}
function requirePostAuth(req, res, url, parsed, authToken, json = false) {
    if (!authToken)
        return true;
    const submitted = getSubmittedAuthToken(req, url, parsed);
    if (authTokensMatch(submitted, authToken))
        return true;
    rejectUnauthorized(res, json);
    return false;
}
function requireCsrf(res, parsed, csrfTokens, json = false) {
    if (!csrfTokens)
        return true;
    pruneExpiredCsrfTokens(csrfTokens);
    const submitted = String(parsed._csrf || "");
    if (submitted && csrfTokens.delete(submitted))
        return true;
    if (json) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid or missing CSRF token" }));
        return false;
    }
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("Invalid or missing CSRF token");
    return false;
}
function readProjectQueue(phrenPath, profile) {
    const projects = getProjectDirs(phrenPath, profile).map((projectDir) => path.basename(projectDir)).filter((project) => project !== "global");
    const items = [];
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
function parseTopicsPayload(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return null;
        return parsed.map((topic) => ({
            slug: String(topic?.slug || ""),
            label: String(topic?.label || ""),
            description: String(topic?.description || ""),
            keywords: Array.isArray(topic?.keywords) ? topic.keywords.map((keyword) => String(keyword)) : [],
        }));
    }
    catch {
        return null;
    }
}
function parseTopicPayload(raw) {
    try {
        const topic = JSON.parse(raw);
        if (!topic || typeof topic !== "object")
            return null;
        return {
            slug: String(topic.slug || ""),
            label: String(topic.label || ""),
            description: String(topic.description || ""),
            keywords: Array.isArray(topic.keywords)
                ? topic.keywords.map((keyword) => String(keyword))
                : [],
        };
    }
    catch {
        return null;
    }
}
export function createWebUiHttpServer(phrenPath, renderPage, profile, opts) {
    try {
        repairPreexistingInstall(phrenPath);
    }
    catch (err) {
        if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG))
            process.stderr.write(`[phren] web-ui repair: ${errorMessage(err)}\n`);
    }
    const authToken = opts?.authToken;
    const csrfTokens = opts?.csrfTokens;
    return http.createServer(async (req, res) => {
        const url = req.url || "/";
        const pathname = url.includes("?") ? url.slice(0, url.indexOf("?")) : url;
        if (req.method === "GET" && pathname === "/") {
            if (!requireGetAuth(req, res, url, authToken))
                return;
            pruneExpiredCsrfTokens(csrfTokens);
            if (csrfTokens)
                csrfTokens.set(crypto.randomUUID(), Date.now());
            const nonce = crypto.randomBytes(16).toString("base64");
            setCommonHeaders(res, nonce);
            const html = renderPage(phrenPath, authToken, nonce);
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(html);
            return;
        }
        setCommonHeaders(res);
        if (pathname.startsWith("/api/") && req.method === "GET" && !requireGetAuth(req, res, url, authToken)) {
            return;
        }
        if (req.method === "GET" && pathname === "/api/projects") {
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify(collectProjectsForUI(phrenPath, profile)));
            return;
        }
        if (req.method === "GET" && pathname === "/api/change-token") {
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ token: computePhrenLiveStateToken(phrenPath) }));
            return;
        }
        if (req.method === "GET" && pathname === "/api/runtime-health") {
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify(readSyncSnapshot(phrenPath)));
            return;
        }
        if (req.method === "POST" && pathname === "/api/sync") {
            void readFormBody(req, res).then((parsed) => {
                if (!parsed)
                    return;
                if (!requirePostAuth(req, res, url, parsed, authToken, true))
                    return;
                if (!requireCsrf(res, parsed, csrfTokens, true))
                    return;
                const message = String(parsed.message || "update phren");
                try {
                    const EXEC_TIMEOUT = 15_000;
                    const runGit = (args) => execFileSync("git", args, { cwd: phrenPath, encoding: "utf8", timeout: EXEC_TIMEOUT }).trim();
                    const status = runGit(["status", "--porcelain"]);
                    if (!status) {
                        res.writeHead(200, { "content-type": "application/json" });
                        res.end(JSON.stringify({ ok: true, message: "Nothing to sync — working tree clean." }));
                        return;
                    }
                    runGit(["add", "--", "*.md", "*.json", "*.yaml", "*.yml", "*.jsonl", "*.txt"]);
                    runGit(["commit", "-m", message]);
                    let pushed = false;
                    try {
                        const remotes = runGit(["remote"]);
                        if (remotes) {
                            runGit(["push"]);
                            pushed = true;
                        }
                    }
                    catch { /* no remote or push failed */ }
                    const changedFiles = status.split("\n").filter(Boolean).length;
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ ok: true, message: `Synced ${changedFiles} file(s).${pushed ? " Pushed to remote." : " No remote, saved locally."}` }));
                }
                catch (err) {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
                }
            });
            return;
        }
        if (req.method === "GET" && pathname === "/api/review-queue") {
            if (!requireGetAuth(req, res, url, authToken, true))
                return;
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify(readProjectQueue(phrenPath, profile)));
            return;
        }
        if (req.method === "GET" && pathname === "/api/review-activity") {
            if (!requireGetAuth(req, res, url, authToken, true))
                return;
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({
                accepted: recentAccepted(phrenPath),
                usage: recentUsage(phrenPath),
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
            const filePath = path.join(phrenPath, project, file);
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
            res.end(JSON.stringify({ ok: true, ...getProjectTopicsResponse(phrenPath, project) }));
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
            res.end(JSON.stringify({ ok: true, ...listProjectReferenceDocs(phrenPath, project) }));
            return;
        }
        if (req.method === "GET" && pathname === "/api/project-reference-content") {
            const qs = url.includes("?") ? querystring.parse(url.slice(url.indexOf("?") + 1)) : {};
            const project = String(qs.project || "");
            const file = String(qs.file || "");
            const contentResult = readReferenceContent(phrenPath, project, file);
            res.writeHead(contentResult.ok ? 200 : 400, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify(contentResult.ok ? { ok: true, content: contentResult.content } : { ok: false, error: contentResult.error }));
            return;
        }
        if (req.method === "GET" && pathname === "/api/skills") {
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify(collectSkillsForUI(phrenPath, profile)));
            return;
        }
        if (req.method === "GET" && pathname.startsWith("/api/skill-content")) {
            const qs = url.includes("?") ? querystring.parse(url.slice(url.indexOf("?") + 1)) : {};
            const filePath = String(qs.path || "");
            if (!filePath || !isAllowedFilePath(filePath, phrenPath)) {
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
            res.end(JSON.stringify(getHooksData(phrenPath)));
            return;
        }
        if (req.method === "POST" && pathname === "/api/skill-save") {
            void readFormBody(req, res).then((parsed) => {
                if (!parsed)
                    return;
                if (!requirePostAuth(req, res, url, parsed, authToken, true))
                    return;
                if (!requireCsrf(res, parsed, csrfTokens, true))
                    return;
                const filePath = String(parsed.path || "");
                const content = String(parsed.content || "");
                if (!filePath || !isAllowedFilePath(filePath, phrenPath)) {
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
                }
                catch (err) {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ ok: false, error: errorMessage(err) }));
                }
            });
            return;
        }
        if (req.method === "POST" && pathname === "/api/skill-toggle") {
            void readFormBody(req, res).then((parsed) => {
                if (!parsed)
                    return;
                if (!requirePostAuth(req, res, url, parsed, authToken, true))
                    return;
                if (!requireCsrf(res, parsed, csrfTokens, true))
                    return;
                const project = String(parsed.project || "");
                const name = String(parsed.name || "");
                const enabled = String(parsed.enabled || "") === "true";
                if (!project || !name || (project.toLowerCase() !== "global" && !isValidProjectName(project))) {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ ok: false, error: "Invalid skill toggle request" }));
                    return;
                }
                const skill = findSkill(phrenPath, profile || "", project, name);
                if (!skill || "error" in skill) {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ ok: false, error: skill && "error" in skill ? skill.error : "Skill not found" }));
                    return;
                }
                setSkillEnabledAndSync(phrenPath, project, skill.name, enabled);
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, enabled }));
            });
            return;
        }
        if (req.method === "POST" && pathname === "/api/hook-toggle") {
            void readFormBody(req, res).then((parsed) => {
                if (!parsed)
                    return;
                if (!requirePostAuth(req, res, url, parsed, authToken, true))
                    return;
                if (!requireCsrf(res, parsed, csrfTokens, true))
                    return;
                const tool = String(parsed.tool || "").toLowerCase();
                const validTools = ["claude", "copilot", "cursor", "codex"];
                if (!validTools.includes(tool)) {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ ok: false, error: "Invalid tool" }));
                    return;
                }
                const prefs = readInstallPreferences(phrenPath);
                const toolPrefs = (prefs.hookTools && typeof prefs.hookTools === "object") ? prefs.hookTools : {};
                const current = toolPrefs[tool] !== false && prefs.hooksEnabled !== false;
                writeInstallPreferences(phrenPath, {
                    hookTools: { ...toolPrefs, [tool]: !current },
                });
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, enabled: !current }));
            });
            return;
        }
        if (req.method === "POST" && pathname === "/api/project-topics/save") {
            void readFormBody(req, res).then((parsed) => {
                if (!parsed)
                    return;
                if (!requirePostAuth(req, res, url, parsed, authToken, true))
                    return;
                if (!requireCsrf(res, parsed, csrfTokens, true))
                    return;
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
                const saved = writeProjectTopics(phrenPath, project, topics);
                if (!saved.ok) {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify(saved));
                    return;
                }
                for (const topic of saved.topics) {
                    const ensured = ensureTopicReferenceDoc(phrenPath, project, topic);
                    if (!ensured.ok) {
                        res.writeHead(200, { "content-type": "application/json" });
                        res.end(JSON.stringify({ ok: false, error: ensured.error }));
                        return;
                    }
                }
                res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ ok: true, ...getProjectTopicsResponse(phrenPath, project) }));
            });
            return;
        }
        if (req.method === "POST" && pathname === "/api/project-topics/reclassify") {
            void readFormBody(req, res).then((parsed) => {
                if (!parsed)
                    return;
                if (!requirePostAuth(req, res, url, parsed, authToken, true))
                    return;
                if (!requireCsrf(res, parsed, csrfTokens, true))
                    return;
                const project = String(parsed.project || "");
                if (!project || !isValidProjectName(project)) {
                    res.writeHead(400, { "content-type": "application/json" });
                    res.end(JSON.stringify({ ok: false, error: "Invalid project" }));
                    return;
                }
                const result = reclassifyLegacyTopicDocs(phrenPath, project);
                res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ ok: true, ...result }));
            });
            return;
        }
        if (req.method === "POST" && pathname === "/api/project-topics/pin") {
            void readFormBody(req, res).then((parsed) => {
                if (!parsed)
                    return;
                if (!requirePostAuth(req, res, url, parsed, authToken, true))
                    return;
                if (!requireCsrf(res, parsed, csrfTokens, true))
                    return;
                const project = String(parsed.project || "");
                const rawTopic = String(parsed.topic || "");
                if (!project || !isValidProjectName(project)) {
                    res.writeHead(400, { "content-type": "application/json" });
                    res.end(JSON.stringify({ ok: false, error: "Invalid project" }));
                    return;
                }
                const topic = parseTopicPayload(rawTopic);
                if (!topic) {
                    res.writeHead(400, { "content-type": "application/json" });
                    res.end(JSON.stringify({ ok: false, error: "Invalid topic payload" }));
                    return;
                }
                const pinned = pinProjectTopicSuggestion(phrenPath, project, topic);
                if (!pinned.ok) {
                    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
                    res.end(JSON.stringify(pinned));
                    return;
                }
                res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ ok: true, ...getProjectTopicsResponse(phrenPath, project) }));
            });
            return;
        }
        if (req.method === "POST" && pathname === "/api/project-topics/unpin") {
            void readFormBody(req, res).then((parsed) => {
                if (!parsed)
                    return;
                if (!requirePostAuth(req, res, url, parsed, authToken, true))
                    return;
                if (!requireCsrf(res, parsed, csrfTokens, true))
                    return;
                const project = String(parsed.project || "");
                const slug = String(parsed.slug || "");
                if (!project || !isValidProjectName(project)) {
                    res.writeHead(400, { "content-type": "application/json" });
                    res.end(JSON.stringify({ ok: false, error: "Invalid project" }));
                    return;
                }
                const unpinned = unpinProjectTopicSuggestion(phrenPath, project, slug);
                if (!unpinned.ok) {
                    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
                    res.end(JSON.stringify(unpinned));
                    return;
                }
                res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ ok: true, ...getProjectTopicsResponse(phrenPath, project) }));
            });
            return;
        }
        if (req.method === "GET" && pathname === "/api/search") {
            if (!requireGetAuth(req, res, url, authToken, true))
                return;
            const searchParams = new URLSearchParams(url.includes("?") ? url.slice(url.indexOf("?") + 1) : "");
            const query = searchParams.get("q") || searchParams.get("query") || "";
            const searchProject = searchParams.get("project") || undefined;
            const searchType = searchParams.get("type") || undefined;
            const searchLimit = parseInt(searchParams.get("limit") || "10", 10) || 10;
            if (!query.trim()) {
                res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ ok: false, error: "Missing query parameter (q or query)." }));
                return;
            }
            try {
                const { runSearch } = await import("./cli-search.js");
                const result = await runSearch({ query, limit: Math.min(searchLimit, 50), project: searchProject, type: searchType }, phrenPath, profile || "");
                res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ ok: true, query, results: result.lines }));
            }
            catch (err) {
                res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ ok: false, error: errorMessage(err) }));
            }
            return;
        }
        if (req.method === "GET" && pathname.startsWith("/api/graph")) {
            const graphParams = new URLSearchParams(url.includes("?") ? url.slice(url.indexOf("?") + 1) : "");
            const focusProject = graphParams.get("project") || undefined;
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify(await buildGraph(phrenPath, profile, focusProject)));
            return;
        }
        if (req.method === "GET" && pathname === "/api/scores") {
            let scores = {};
            try {
                const raw = fs.readFileSync(path.join(phrenPath, ".runtime", "memory-scores.json"), "utf-8");
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === "object") {
                    scores = parsed;
                }
            }
            catch {
                // file missing or unparseable – return empty
            }
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify(scores));
            return;
        }
        if (req.method === "GET" && pathname === "/api/tasks") {
            if (!requireGetAuth(req, res, url, authToken, true))
                return;
            try {
                const docs = readTasksAcrossProjects(phrenPath, profile);
                const tasks = [];
                for (const doc of docs) {
                    for (const section of ["Active", "Queue", "Done"]) {
                        for (const item of doc.items[section]) {
                            tasks.push({
                                project: doc.project,
                                section: item.section,
                                line: item.line,
                                priority: item.priority,
                                pinned: item.pinned,
                                githubIssue: item.githubIssue,
                                githubUrl: item.githubUrl,
                                context: item.context,
                                checked: item.checked,
                            });
                        }
                    }
                }
                res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ ok: true, tasks }));
            }
            catch (err) {
                res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ ok: false, error: errorMessage(err), tasks: [] }));
            }
            return;
        }
        if (req.method === "POST" && pathname === "/api/tasks/complete") {
            void readFormBody(req, res).then((parsed) => {
                if (!parsed)
                    return;
                if (!requirePostAuth(req, res, url, parsed, authToken, true))
                    return;
                if (!requireCsrf(res, parsed, csrfTokens, true))
                    return;
                const project = String(parsed.project || "");
                const item = String(parsed.item || "");
                if (!project || !item || !isValidProjectName(project)) {
                    res.writeHead(400, { "content-type": "application/json" });
                    res.end(JSON.stringify({ ok: false, error: "Missing or invalid project/item" }));
                    return;
                }
                const result = completeTaskStore(phrenPath, project, item);
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: result.ok, message: result.ok ? result.data : undefined, error: result.ok ? undefined : result.error }));
            });
            return;
        }
        if (req.method === "POST" && pathname === "/api/tasks/add") {
            void readFormBody(req, res).then((parsed) => {
                if (!parsed)
                    return;
                if (!requirePostAuth(req, res, url, parsed, authToken, true))
                    return;
                if (!requireCsrf(res, parsed, csrfTokens, true))
                    return;
                const project = String(parsed.project || "");
                const item = String(parsed.item || "");
                if (!project || !item || !isValidProjectName(project)) {
                    res.writeHead(400, { "content-type": "application/json" });
                    res.end(JSON.stringify({ ok: false, error: "Missing or invalid project/item" }));
                    return;
                }
                const result = addTaskStore(phrenPath, project, item);
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: result.ok, message: result.ok ? `Task added: ${result.data.line}` : undefined, error: result.ok ? undefined : result.error }));
            });
            return;
        }
        if (req.method === "POST" && pathname === "/api/tasks/remove") {
            void readFormBody(req, res).then((parsed) => {
                if (!parsed)
                    return;
                if (!requirePostAuth(req, res, url, parsed, authToken, true))
                    return;
                if (!requireCsrf(res, parsed, csrfTokens, true))
                    return;
                const project = String(parsed.project || "");
                const item = String(parsed.item || "");
                if (!project || !item || !isValidProjectName(project)) {
                    res.writeHead(400, { "content-type": "application/json" });
                    res.end(JSON.stringify({ ok: false, error: "Missing or invalid project/item" }));
                    return;
                }
                const result = removeTaskStore(phrenPath, project, item);
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: result.ok, message: result.ok ? result.data : undefined, error: result.ok ? undefined : result.error }));
            });
            return;
        }
        if (req.method === "GET" && pathname === "/api/sessions") {
            if (!requireGetAuth(req, res, url, authToken, true))
                return;
            try {
                const qs = url.includes("?") ? querystring.parse(url.slice(url.indexOf("?") + 1)) : {};
                const sessionId = typeof qs.sessionId === "string" ? qs.sessionId : undefined;
                const project = typeof qs.project === "string" ? qs.project : undefined;
                const limit = parseInt(typeof qs.limit === "string" ? qs.limit : "50", 10) || 50;
                if (sessionId) {
                    const sessions = listAllSessions(phrenPath, 200);
                    const session = sessions.find(s => s.sessionId === sessionId || s.sessionId.startsWith(sessionId));
                    if (!session) {
                        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
                        res.end(JSON.stringify({ ok: false, error: "Session not found" }));
                        return;
                    }
                    const artifacts = getSessionArtifacts(phrenPath, session.sessionId, project);
                    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
                    res.end(JSON.stringify({ ok: true, session, ...artifacts }));
                }
                else {
                    const sessions = listAllSessions(phrenPath, limit);
                    const filtered = project ? sessions.filter(s => s.project === project) : sessions;
                    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
                    res.end(JSON.stringify({ ok: true, sessions: filtered }));
                }
            }
            catch (err) {
                res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ ok: false, error: errorMessage(err), sessions: [] }));
            }
            return;
        }
        if (req.method === "GET" && pathname === "/api/settings") {
            if (!requireGetAuth(req, res, url, authToken, true))
                return;
            try {
                const prefs = readInstallPreferences(phrenPath);
                const workflowPolicy = getWorkflowPolicy(phrenPath);
                const hooksData = getHooksData(phrenPath);
                const proactivityFindings = prefs.proactivityFindings || prefs.proactivity || "high";
                res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({
                    ok: true,
                    proactivity: prefs.proactivity || "high",
                    proactivityFindings,
                    proactivityTask: prefs.proactivityTask || prefs.proactivity || "high",
                    taskMode: workflowPolicy.taskMode,
                    findingSensitivity: workflowPolicy.findingSensitivity || "balanced",
                    autoCaptureEnabled: proactivityFindings !== "low",
                    consolidationEntryThreshold: CONSOLIDATION_ENTRY_THRESHOLD,
                    hooksEnabled: hooksData.globalEnabled,
                    mcpEnabled: prefs.mcpEnabled !== false,
                    hookTools: hooksData.tools,
                }));
            }
            catch (err) {
                res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ ok: false, error: errorMessage(err) }));
            }
            return;
        }
        if (req.method === "POST" && pathname === "/api/settings/finding-sensitivity") {
            void readFormBody(req, res).then((parsed) => {
                if (!parsed)
                    return;
                if (!requirePostAuth(req, res, url, parsed, authToken, true))
                    return;
                if (!requireCsrf(res, parsed, csrfTokens, true))
                    return;
                const value = String(parsed.value || "");
                const valid = ["minimal", "conservative", "balanced", "aggressive"];
                if (!valid.includes(value)) {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ ok: false, error: `Invalid finding sensitivity: "${value}". Must be one of: ${valid.join(", ")}` }));
                    return;
                }
                const result = updateWorkflowPolicy(phrenPath, { findingSensitivity: value });
                res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
                res.end(JSON.stringify(result.ok ? { ok: true, findingSensitivity: result.data.findingSensitivity } : { ok: false, error: result.error }));
            });
            return;
        }
        if (req.method === "POST" && pathname === "/api/settings/task-mode") {
            void readFormBody(req, res).then((parsed) => {
                if (!parsed)
                    return;
                if (!requirePostAuth(req, res, url, parsed, authToken, true))
                    return;
                if (!requireCsrf(res, parsed, csrfTokens, true))
                    return;
                const value = String(parsed.value || "").trim().toLowerCase();
                const valid = ["off", "manual", "auto"];
                if (!valid.includes(value)) {
                    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
                    res.end(JSON.stringify({ ok: false, error: `Invalid task mode: "${value}". Must be one of: ${valid.join(", ")}` }));
                    return;
                }
                const result = updateWorkflowPolicy(phrenPath, { taskMode: value });
                res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
                res.end(JSON.stringify(result.ok ? { ok: true, taskMode: result.data.taskMode } : { ok: false, error: result.error }));
            });
            return;
        }
        if (req.method === "POST" && pathname === "/api/settings/proactivity") {
            void readFormBody(req, res).then((parsed) => {
                if (!parsed)
                    return;
                if (!requirePostAuth(req, res, url, parsed, authToken, true))
                    return;
                if (!requireCsrf(res, parsed, csrfTokens, true))
                    return;
                const value = String(parsed.value || "").trim().toLowerCase();
                const valid = ["high", "medium", "low"];
                if (!valid.includes(value)) {
                    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
                    res.end(JSON.stringify({ ok: false, error: `Invalid proactivity: "${value}". Must be one of: ${valid.join(", ")}` }));
                    return;
                }
                writeInstallPreferences(phrenPath, { proactivity: value });
                writeGovernanceInstallPreferences(phrenPath, { proactivity: value });
                res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ ok: true, proactivity: value }));
            });
            return;
        }
        if (req.method === "POST" && pathname === "/api/settings/auto-capture") {
            void readFormBody(req, res).then((parsed) => {
                if (!parsed)
                    return;
                if (!requirePostAuth(req, res, url, parsed, authToken, true))
                    return;
                if (!requireCsrf(res, parsed, csrfTokens, true))
                    return;
                const enabled = String(parsed.enabled || "").toLowerCase() === "true";
                const next = enabled ? "high" : "low";
                writeInstallPreferences(phrenPath, { proactivityFindings: next });
                writeGovernanceInstallPreferences(phrenPath, { proactivityFindings: next });
                res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ ok: true, autoCaptureEnabled: enabled, proactivityFindings: next }));
            });
            return;
        }
        if (req.method === "POST" && pathname === "/api/settings/mcp-enabled") {
            void readFormBody(req, res).then((parsed) => {
                if (!parsed)
                    return;
                if (!requirePostAuth(req, res, url, parsed, authToken, true))
                    return;
                if (!requireCsrf(res, parsed, csrfTokens, true))
                    return;
                const enabled = String(parsed.enabled || "").toLowerCase() === "true";
                writeInstallPreferences(phrenPath, { mcpEnabled: enabled });
                res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ ok: true, mcpEnabled: enabled }));
            });
            return;
        }
        if (req.method === "GET" && pathname === "/api/csrf-token") {
            if (!requireGetAuth(req, res, url, authToken, true))
                return;
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
        // GET /api/findings/:project — list findings for a project
        if (req.method === "GET" && pathname.startsWith("/api/findings/")) {
            const project = decodeURIComponent(pathname.slice("/api/findings/".length));
            if (!project || !isValidProjectName(project)) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: "Invalid project name" }));
                return;
            }
            const result = readFindings(phrenPath, project);
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            if (!result.ok) {
                res.end(JSON.stringify({ ok: false, error: result.error }));
            }
            else {
                res.end(JSON.stringify({ ok: true, data: { project, findings: result.data } }));
            }
            return;
        }
        // POST /api/findings/:project — add a finding
        if (req.method === "POST" && pathname.startsWith("/api/findings/")) {
            const project = decodeURIComponent(pathname.slice("/api/findings/".length));
            if (!project || !isValidProjectName(project)) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: "Invalid project name" }));
                return;
            }
            void readFormBody(req, res).then((parsed) => {
                if (!parsed)
                    return;
                if (!requirePostAuth(req, res, url, parsed, authToken, true))
                    return;
                if (!requireCsrf(res, parsed, csrfTokens, true))
                    return;
                const text = String(parsed.text || "");
                if (!text) {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ ok: false, error: "text is required" }));
                    return;
                }
                const result = addFindingStore(phrenPath, project, text);
                res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ ok: result.ok, message: result.ok ? result.data : undefined, error: result.ok ? undefined : result.error }));
            });
            return;
        }
        // PUT /api/findings/:project — edit a finding (old_text → new_text)
        if (req.method === "PUT" && pathname.startsWith("/api/findings/")) {
            const project = decodeURIComponent(pathname.slice("/api/findings/".length));
            if (!project || !isValidProjectName(project)) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: "Invalid project name" }));
                return;
            }
            void readFormBody(req, res).then((parsed) => {
                if (!parsed)
                    return;
                if (!requirePostAuth(req, res, url, parsed, authToken, true))
                    return;
                if (!requireCsrf(res, parsed, csrfTokens, true))
                    return;
                const oldText = String(parsed.old_text || "");
                const newText = String(parsed.new_text || "");
                if (!oldText || !newText) {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ ok: false, error: "old_text and new_text are required" }));
                    return;
                }
                const result = editFinding(phrenPath, project, oldText, newText);
                res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ ok: result.ok, error: result.ok ? undefined : result.error }));
            });
            return;
        }
        // DELETE /api/findings/:project — remove a finding by text match
        if (req.method === "DELETE" && pathname.startsWith("/api/findings/")) {
            const project = decodeURIComponent(pathname.slice("/api/findings/".length));
            if (!project || !isValidProjectName(project)) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: "Invalid project name" }));
                return;
            }
            void readFormBody(req, res).then((parsed) => {
                if (!parsed)
                    return;
                if (!requirePostAuth(req, res, url, parsed, authToken, true))
                    return;
                if (!requireCsrf(res, parsed, csrfTokens, true))
                    return;
                const text = String(parsed.text || "");
                if (!text) {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ ok: false, error: "text is required" }));
                    return;
                }
                const result = removeFinding(phrenPath, project, text);
                res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ ok: result.ok, error: result.ok ? undefined : result.error }));
            });
            return;
        }
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("Not found");
    });
}
export async function startWebUiServer(phrenPath, port, renderPage, profile, opts = {}) {
    const authToken = crypto.randomUUID();
    const csrfTokens = new Map();
    const server = createWebUiHttpServer(phrenPath, renderPage, profile, { authToken, csrfTokens });
    const boundPort = await bindWebUiPort(server, port, Boolean(opts.allowPortFallback && port !== 0));
    const publicUrl = `http://127.0.0.1:${boundPort}`;
    const reviewUrl = `${publicUrl}/?_auth=${encodeURIComponent(authToken)}`;
    const ready = await waitForWebUiReady(reviewUrl);
    process.stdout.write(`phren web-ui running at ${publicUrl}\n`);
    process.stderr.write(`open: ${reviewUrl}\n`);
    if (!ready) {
        process.stderr.write("[phren] web-ui health check did not confirm readiness before launch\n");
    }
    const shouldAutoOpen = opts.autoOpen ?? Boolean(process.stdout.isTTY);
    if (shouldAutoOpen && ready) {
        try {
            if (opts.browserLauncher)
                await opts.browserLauncher(reviewUrl);
            else
                await launchWebUiBrowser(reviewUrl);
        }
        catch (err) {
            process.stderr.write(`[phren] web-ui browser launch failed: ${errorMessage(err)}\n`);
            process.stdout.write(`secure session URL: ${reviewUrl}\n`);
        }
    }
    else if (shouldAutoOpen && !ready) {
        process.stderr.write("[phren] skipped auto-open because readiness check failed; use the secure URL below\n");
        process.stdout.write(`secure session URL: ${reviewUrl}\n`);
    }
    else {
        process.stdout.write(`secure session URL: ${reviewUrl}\n`);
    }
    await new Promise((resolve) => {
        const shutdown = () => {
            server.close(() => resolve());
        };
        process.on("SIGTERM", shutdown);
        process.on("SIGINT", shutdown);
    });
}
