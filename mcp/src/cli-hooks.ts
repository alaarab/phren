import {
  ensureCortexPath,
  buildIndex,
  extractSnippet,
  queryRows,
  queryDocRows,
  detectProject,
  checkConsolidationNeeded,
  debugLog,
  filterTrustedLearningsDetailed,
  appendMemoryQueue,
  appendAuditLog,
  getMemoryPolicy,
  recordMemoryInjection,
  recordMemoryFeedback,
  flushMemoryScores,
  getMemoryQualityMultiplier,
  memoryScoreKey,
  updateRuntimeHealth,
  EXEC_TIMEOUT_MS,
  type DocRow,
} from "./shared.js";
import { buildRobustFtsQuery, extractKeywords, STOP_WORDS } from "./utils.js";
import * as fs from "fs";
import * as path from "path";
import { execFileSync, spawn } from "child_process";
import { fileURLToPath } from "url";
import { runDoctor } from "./link.js";
import { getHooksEnabledPreference } from "./init.js";
import { handleExtractMemories } from "./cli-extract.js";

const cortexPath = ensureCortexPath();
const profile = process.env.CORTEX_PROFILE || "";

// ── Git helpers ──────────────────────────────────────────────────────────────

interface GitContext {
  branch: string;
  changedFiles: Set<string>;
}

function runGit(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: EXEC_TIMEOUT_MS }).trim();
  } catch {
    return null;
  }
}

function isFeatureEnabled(envName: string, defaultValue: boolean = true): boolean {
  const raw = process.env[envName];
  if (!raw) return defaultValue;
  return !["0", "false", "off", "no"].includes(raw.trim().toLowerCase());
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(raw || "", 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function getGitContext(cwd?: string): GitContext | null {
  if (!cwd) return null;
  const branch = runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch) return null;
  const changedFiles = new Set<string>();
  for (const changed of [
    runGit(cwd, ["diff", "--name-only"]),
    runGit(cwd, ["diff", "--name-only", "--cached"]),
  ]) {
    if (!changed) continue;
    for (const line of changed.split("\n").map((s) => s.trim()).filter(Boolean)) {
      changedFiles.add(line);
      const basename = path.basename(line);
      if (basename) changedFiles.add(basename);
    }
  }
  return { branch, changedFiles };
}

function branchTokens(branch: string): string[] {
  return branch
    .split(/[\/._-]/g)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 2 && !["main", "master", "feature", "fix", "bugfix", "hotfix"].includes(s));
}

// ── Intent and scoring helpers ───────────────────────────────────────────────

export function detectTaskIntent(prompt: string): "debug" | "review" | "build" | "docs" | "general" {
  const p = prompt.toLowerCase();
  if (/(bug|error|fix|broken|regression|fail|stack trace)/.test(p)) return "debug";
  if (/(review|audit|pr|pull request|nit|refactor)/.test(p)) return "review";
  if (/(build|deploy|release|ci|workflow|pipeline|test)/.test(p)) return "build";
  if (/(doc|readme|explain|guide|instruction)/.test(p)) return "docs";
  return "general";
}

function intentBoost(intent: string, docType: string): number {
  if (intent === "debug" && (docType === "learnings" || docType === "knowledge")) return 3;
  if (intent === "review" && (docType === "canonical" || docType === "changelog")) return 3;
  if (intent === "build" && (docType === "backlog" || docType === "knowledge")) return 2;
  if (intent === "docs" && (docType === "summary" || docType === "claude")) return 2;
  if (docType === "canonical") return 2;
  return 0;
}

function fileRelevanceBoost(filePath: string, changedFiles: Set<string>): number {
  if (changedFiles.size === 0) return 0;
  const normalized = filePath.replace(/\\/g, "/");
  for (const cf of changedFiles) {
    const n = cf.replace(/\\/g, "/");
    if (normalized.endsWith(n) || normalized.includes(`/${n}`)) return 3;
  }
  return 0;
}

function branchMatchBoost(content: string, branch: string | undefined): number {
  if (!branch) return 0;
  const text = content.toLowerCase();
  const tokens = branchTokens(branch);
  let score = 0;
  for (const t of tokens) {
    if (text.includes(t)) score += 1;
  }
  return Math.min(3, score);
}

function lowValuePenalty(content: string, docType: string): number {
  if (docType !== "learnings") return 0;
  const bullets = content.split("\n").filter((l) => l.startsWith("- "));
  if (bullets.length === 0) return 0;
  const defaults = ["fixed stuff", "updated things", "misc", "temp", "wip", "todo", "placeholder", "cleanup"];
  const configured = (process.env.CORTEX_LOW_VALUE_PATTERNS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const fragments = configured.length ? configured : defaults;
  const pattern = new RegExp(`(${fragments.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "i");
  const low = bullets.filter((b) => pattern.test(b) || b.length < 16).length;
  return low >= Math.ceil(bullets.length * 0.5) ? 2 : 0;
}

// ── Token and snippet helpers ────────────────────────────────────────────────

function normalizeToken(token: string): string {
  let t = token.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (t.length > 4 && t.endsWith("s") && !t.endsWith("ss")) t = t.slice(0, -1);
  return t;
}

function tokenizeForOverlap(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s]/g, " ")
    .split(/\s+/)
    .map(normalizeToken)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
  return [...new Set(tokens)].slice(0, 24);
}

function overlapScore(queryTokens: string[], content: string): number {
  if (!queryTokens.length) return 0;
  const contentTokens = new Set(tokenizeForOverlap(content));
  if (!contentTokens.size) return 0;
  let matched = 0;
  for (const t of queryTokens) {
    if (contentTokens.has(t)) matched += 1;
  }
  const denominator = Math.max(2, Math.min(queryTokens.length, 10));
  return matched / denominator;
}

function mergeUniqueDocs(primary: DocRow[] | null, secondary: DocRow[]): DocRow[] | null {
  if (!primary || !primary.length) return secondary.length ? secondary : null;
  const seen = new Set(primary.map((r) => r.path || `${r.project}/${r.filename}`));
  for (const doc of secondary) {
    const key = doc.path || `${doc.project}/${doc.filename}`;
    if (seen.has(key)) continue;
    seen.add(key);
    primary.push(doc);
  }
  return primary;
}

function semanticFallbackDocs(db: any, prompt: string, project?: string | null): DocRow[] {
  const queryTokens = tokenizeForOverlap(prompt);
  if (!queryTokens.length) return [];
  const sampleLimit = project ? 180 : 260;
  const docs = project
    ? queryDocRows(
      db,
      "SELECT project, filename, type, content, path FROM docs WHERE project = ? LIMIT ?",
      [project, sampleLimit]
    ) || []
    : queryDocRows(
      db,
      "SELECT project, filename, type, content, path FROM docs LIMIT ?",
      [sampleLimit]
    ) || [];

  const scored = docs
    .map((doc) => {
      const corpus = `${doc.project} ${doc.filename} ${doc.type} ${doc.path}\n${doc.content.slice(0, 5000)}`;
      const score = overlapScore(queryTokens, corpus);
      return { doc, score };
    })
    .filter((x) => x.score >= 0.15)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((x) => x.doc);

  return scored;
}

function approximateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function compactSnippet(snippet: string, maxLines: number, maxChars: number): string {
  const lines = snippet
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
    .slice(0, Math.max(1, maxLines));
  let out = lines.join("\n");
  if (out.length > maxChars) out = out.slice(0, Math.max(24, maxChars - 1)).trimEnd() + "\u2026";
  return out;
}

// ── Session metrics ──────────────────────────────────────────────────────────

interface SessionMetric {
  prompts: number;
  keys: Record<string, number>;
  lastChangedCount: number;
  lastKeys: string[];
  lastSeen?: string;
}

function parseSessionMetrics(cortexPathLocal: string): Record<string, SessionMetric> {
  const file = path.join(cortexPathLocal, ".governance", "session-metrics.json");
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, SessionMetric>;
  } catch {
    return {};
  }
}

function writeSessionMetrics(cortexPathLocal: string, data: Record<string, SessionMetric>) {
  const file = path.join(cortexPathLocal, ".governance", "session-metrics.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

// ── Background maintenance ───────────────────────────────────────────────────

function qualityMarkers(cortexPathLocal: string): { done: string; lock: string } {
  const today = new Date().toISOString().slice(0, 10);
  return {
    done: path.join(cortexPathLocal, `.quality-${today}`),
    lock: path.join(cortexPathLocal, `.quality-${today}.lock`),
  };
}

export function resolveSubprocessArgs(command: string): string[] | null {
  const distEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js");
  if (fs.existsSync(distEntry)) return [distEntry, command];
  const sourceEntry = process.argv.find((a) => /[\\/]index\.(ts|js)$/.test(a) && fs.existsSync(a));
  const runner = process.argv[1];
  if (sourceEntry && runner) return [runner, sourceEntry, command];
  return null;
}

export function scheduleBackgroundMaintenance(cortexPathLocal: string, project?: string): boolean {
  if (!isFeatureEnabled("CORTEX_FEATURE_DAILY_MAINTENANCE", true)) return false;
  const markers = qualityMarkers(cortexPathLocal);
  if (fs.existsSync(markers.done)) return false;
  if (fs.existsSync(markers.lock)) {
    try {
      const ageMs = Date.now() - fs.statSync(markers.lock).mtimeMs;
      if (ageMs <= 2 * 60 * 60 * 1000) return false;
      fs.unlinkSync(markers.lock);
    } catch {
      return false;
    }
  }

  const spawnArgs = resolveSubprocessArgs("background-maintenance");
  if (!spawnArgs) return false;

  try {
    fs.writeFileSync(
      markers.lock,
      JSON.stringify({
        startedAt: new Date().toISOString(),
        project: project || "all",
        pid: process.pid,
      }) + "\n"
    );
    if (project) spawnArgs.push(project);
    const logDir = path.join(cortexPathLocal, ".governance");
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, "background-maintenance.log");
    const logFd = fs.openSync(logPath, "a");
    fs.writeSync(
      logFd,
      `[${new Date().toISOString()}] spawn ${process.execPath} ${spawnArgs.join(" ")}\n`
    );
    const child = spawn(process.execPath, spawnArgs, {
      cwd: process.cwd(),
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        CORTEX_PATH: cortexPathLocal,
        CORTEX_PROFILE: profile,
      },
    });
    child.on("exit", (code, signal) => {
      const msg = `[${new Date().toISOString()}] exit code=${code ?? "null"} signal=${signal ?? "none"}\n`;
      try { fs.appendFileSync(logPath, msg); } catch { /* best effort */ }
      if (code === 0) {
        try { fs.writeFileSync(markers.done, new Date().toISOString() + "\n"); } catch { /* best effort */ }
      }
      try { fs.unlinkSync(markers.lock); } catch { /* best effort */ }
    });
    child.on("error", (err) => {
      const msg = `[${new Date().toISOString()}] spawn error: ${err.message}\n`;
      try { fs.appendFileSync(logPath, msg); } catch { /* best effort */ }
      try { fs.unlinkSync(markers.lock); } catch { /* best effort */ }
    });
    fs.closeSync(logFd);
    child.unref();
    return true;
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    try {
      const logDir = path.join(cortexPathLocal, ".governance");
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(
        path.join(logDir, "background-maintenance.log"),
        `[${new Date().toISOString()}] spawn failed: ${errMsg}\n`
      );
    } catch { /* best effort */ }
    try { fs.unlinkSync(markers.lock); } catch { /* best effort */ }
    return false;
  }
}

// ── Git command helpers for hooks ────────────────────────────────────────────

function isTransientGitError(message: string): boolean {
  return /(timed out|connection|network|could not resolve host|rpc failed|429|502|503|504|service unavailable)/i.test(message);
}

function shouldRetryGitCommand(args: string[]): boolean {
  const cmd = args[0] || "";
  return cmd === "push" || cmd === "pull" || cmd === "fetch";
}

async function runBestEffortGit(args: string[], cwd: string): Promise<{ ok: boolean; output?: string; error?: string }> {
  const retries = shouldRetryGitCommand(args) ? 2 : 0;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const output = execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: EXEC_TIMEOUT_MS,
      }).trim();
      return { ok: true, output };
    } catch (err: any) {
      const message = err?.message || String(err);
      if (attempt < retries && isTransientGitError(message)) {
        const delayMs = 500 * (attempt + 1);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      return { ok: false, error: message };
    }
  }
  return { ok: false, error: "git command failed" };
}

// ── Hook handlers ────────────────────────────────────────────────────────────

export async function handleHookSessionStart() {
  const startedAt = new Date().toISOString();
  if (!getHooksEnabledPreference(cortexPath)) {
    updateRuntimeHealth(cortexPath, { lastSessionStartAt: startedAt });
    appendAuditLog(cortexPath, "hook_session_start", "status=disabled");
    return;
  }

  const pull = await runBestEffortGit(["pull", "--rebase", "--quiet"], cortexPath);
  const doctor = await runDoctor(cortexPath, false);
  const maintenanceScheduled = scheduleBackgroundMaintenance(cortexPath);

  updateRuntimeHealth(cortexPath, { lastSessionStartAt: startedAt });
  appendAuditLog(
    cortexPath,
    "hook_session_start",
    `pull=${pull.ok ? "ok" : "fail"} doctor=${doctor.ok ? "ok" : "issues"} maintenance=${maintenanceScheduled ? "scheduled" : "skipped"}`
  );
}

export async function handleHookStop() {
  const now = new Date().toISOString();
  if (!getHooksEnabledPreference(cortexPath)) {
    updateRuntimeHealth(cortexPath, {
      lastStopAt: now,
      lastAutoSave: { at: now, status: "clean", detail: "hooks disabled by preference" },
    });
    appendAuditLog(cortexPath, "hook_stop", "status=disabled");
    return;
  }

  const status = await runBestEffortGit(["status", "--porcelain"], cortexPath);
  if (!status.ok) {
    updateRuntimeHealth(cortexPath, {
      lastStopAt: now,
      lastAutoSave: { at: now, status: "error", detail: status.error || "git status failed" },
    });
    appendAuditLog(cortexPath, "hook_stop", `status=error detail=${JSON.stringify(status.error || "git status failed")}`);
    return;
  }

  if (!status.output) {
    updateRuntimeHealth(cortexPath, {
      lastStopAt: now,
      lastAutoSave: { at: now, status: "clean", detail: "no changes" },
    });
    appendAuditLog(cortexPath, "hook_stop", "status=clean");
    return;
  }

  const add = await runBestEffortGit(["add", "-A"], cortexPath);
  const commit = add.ok ? await runBestEffortGit(["commit", "-m", "auto-save cortex"], cortexPath) : { ok: false, error: add.error };
  if (!add.ok || !commit.ok) {
    updateRuntimeHealth(cortexPath, {
      lastStopAt: now,
      lastAutoSave: {
        at: now,
        status: "error",
        detail: add.error || commit.error || "git add/commit failed",
      },
    });
    appendAuditLog(cortexPath, "hook_stop", `status=error detail=${JSON.stringify(add.error || commit.error || "git add/commit failed")}`);
    return;
  }

  const remotes = await runBestEffortGit(["remote"], cortexPath);
  if (!remotes.ok || !remotes.output) {
    updateRuntimeHealth(cortexPath, {
      lastStopAt: now,
      lastAutoSave: { at: now, status: "saved-local", detail: "commit created; no remote configured" },
    });
    appendAuditLog(cortexPath, "hook_stop", "status=saved-local");
    return;
  }

  const push = await runBestEffortGit(["push"], cortexPath);
  if (push.ok) {
    updateRuntimeHealth(cortexPath, {
      lastStopAt: now,
      lastAutoSave: { at: now, status: "saved-pushed", detail: "commit pushed" },
    });
    appendAuditLog(cortexPath, "hook_stop", "status=saved-pushed");
    return;
  }

  updateRuntimeHealth(cortexPath, {
    lastStopAt: now,
    lastAutoSave: { at: now, status: "saved-local", detail: push.error || "push failed" },
  });
  appendAuditLog(cortexPath, "hook_stop", `status=saved-local detail=${JSON.stringify(push.error || "push failed")}`);
}

// ── hook-prompt pipeline stages (exported for testability, #64) ──────────────

export interface HookPromptInput {
  prompt: string;
  cwd?: string;
  sessionId?: string;
}

export function parseHookInput(raw: string): HookPromptInput | null {
  try {
    const data = JSON.parse(raw);
    const prompt = data.prompt || "";
    if (!prompt.trim()) return null;
    return { prompt, cwd: data.cwd, sessionId: data.session_id };
  } catch {
    return null;
  }
}

export function searchDocuments(
  db: any,
  safeQuery: string,
  prompt: string,
  keywords: string,
  detectedProject: string | null
): DocRow[] | null {
  let rows: DocRow[] | null = null;

  if (detectedProject) {
    rows = queryDocRows(
      db,
      "SELECT project, filename, type, content, path FROM docs WHERE docs MATCH ? AND project = ? ORDER BY rank LIMIT 7",
      [safeQuery, detectedProject]
    );
  }

  if (!rows || rows.length < 3) {
    const globalRows = queryDocRows(
      db,
      "SELECT project, filename, type, content, path FROM docs WHERE docs MATCH ? ORDER BY rank LIMIT 10",
      [safeQuery]
    );
    rows = mergeUniqueDocs(rows, globalRows || []);
  }

  if (!rows || rows.length < 2) {
    const semanticRows = semanticFallbackDocs(db, `${prompt}\n${keywords}`, detectedProject);
    rows = mergeUniqueDocs(rows, semanticRows);
  }

  return rows;
}

export function applyTrustFilter(
  rows: DocRow[],
  cortexPathLocal: string,
  ttlDays: number,
  minConfidence: number,
  decay: any
): DocRow[] {
  return rows
    .map((doc) => {
      if (doc.type !== "learnings") return doc;
      const trust = filterTrustedLearningsDetailed(doc.content, { ttlDays, minConfidence, decay });
      if (trust.issues.length > 0) {
        const stale = trust.issues.filter((i) => i.reason === "stale").map((i) => i.bullet);
        const conflicts = trust.issues.filter((i) => i.reason === "invalid_citation").map((i) => i.bullet);
        if (stale.length) appendMemoryQueue(cortexPathLocal, doc.project, "Stale", stale);
        if (conflicts.length) appendMemoryQueue(cortexPathLocal, doc.project, "Conflicts", conflicts);
        appendAuditLog(
          cortexPathLocal,
          "trust_filter",
          `project=${doc.project} stale=${stale.length} invalid_citation=${conflicts.length}`
        );
      }
      return { ...doc, content: trust.content };
    })
    .filter((doc) => {
      return doc.type !== "learnings" || Boolean(doc.content.trim());
    });
}

function mostRecentDate(content: string): string {
  const matches = content.match(/^## (\d{4}-\d{2}-\d{2})/gm);
  if (!matches || matches.length === 0) return "0000-00-00";
  return matches.map((m) => m.slice(3)).sort().reverse()[0];
}

export function rankResults(
  rows: DocRow[],
  intent: string,
  gitCtx: GitContext | null,
  detectedProject: string | null,
  cortexPathLocal: string,
  db: any
): DocRow[] {
  let ranked = [...rows];

  if (detectedProject) {
    const localByType = new Set(
      ranked.filter((r) => r.project === detectedProject).map((r) => r.type)
    );
    ranked = ranked.filter((r) => {
      if (r.project === detectedProject) return true;
      return !localByType.has(r.type);
    });

    const canonicalRows = queryDocRows(
      db,
      "SELECT project, filename, type, content, path FROM docs WHERE project = ? AND type = 'canonical' LIMIT 1",
      [detectedProject]
    );
    if (canonicalRows) ranked = [...canonicalRows, ...ranked];
  }

  ranked.sort((a, b) => {
    const isLearningsA = a.type === "learnings";
    const isLearningsB = b.type === "learnings";
    if (isLearningsA !== isLearningsB) return isLearningsA ? 1 : -1;
    if (isLearningsA && isLearningsB) {
      const byDate = mostRecentDate(b.content).localeCompare(mostRecentDate(a.content));
      if (byDate !== 0) return byDate;
    }

    const intentDelta = intentBoost(intent, b.type) - intentBoost(intent, a.type);
    if (intentDelta !== 0) return intentDelta;

    const changedFiles = gitCtx?.changedFiles || new Set<string>();
    const fileDelta = fileRelevanceBoost(b.path, changedFiles) - fileRelevanceBoost(a.path, changedFiles);
    if (fileDelta !== 0) return fileDelta;

    const branchDelta = branchMatchBoost(b.content, gitCtx?.branch) - branchMatchBoost(a.content, gitCtx?.branch);
    if (branchDelta !== 0) return branchDelta;

    const keyA = memoryScoreKey(a.project, a.filename, a.content);
    const keyB = memoryScoreKey(b.project, b.filename, b.content);
    const qualityDelta = getMemoryQualityMultiplier(cortexPathLocal, keyB) - getMemoryQualityMultiplier(cortexPathLocal, keyA);
    if (qualityDelta !== 0) return qualityDelta;

    const penaltyDelta = lowValuePenalty(a.content, a.type) - lowValuePenalty(b.content, b.type);
    if (penaltyDelta !== 0) return penaltyDelta;

    return 0;
  });

  ranked = ranked.slice(0, 8);

  if (intent !== "build") {
    ranked = ranked.filter((r) => r.type !== "backlog");
  }

  if (gitCtx && gitCtx.changedFiles.size > 0) {
    ranked = ranked.filter((r) => {
      if (["summary", "canonical", "claude"].includes(r.type)) return true;
      return fileRelevanceBoost(r.path, gitCtx.changedFiles) > 0 || branchMatchBoost(r.content, gitCtx.branch) > 0;
    });
  }

  return ranked;
}

export interface SelectedSnippet {
  doc: DocRow;
  snippet: string;
  key: string;
}

export function selectSnippets(
  rows: DocRow[],
  keywords: string,
  tokenBudget: number,
  lineBudget: number,
  charBudget: number
): { selected: SelectedSnippet[]; usedTokens: number } {
  const selected: SelectedSnippet[] = [];
  let usedTokens = 36;
  for (const doc of rows) {
    let snippet = compactSnippet(extractSnippet(doc.content, keywords, 8), lineBudget, charBudget);
    if (!snippet.trim()) continue;
    let est = approximateTokens(snippet) + 14;
    if (selected.length > 0 && usedTokens + est > tokenBudget) continue;
    if (selected.length === 0 && usedTokens + est > tokenBudget) {
      snippet = compactSnippet(snippet, 3, Math.floor(charBudget * 0.55));
      est = approximateTokens(snippet) + 14;
    }
    const key = memoryScoreKey(doc.project, doc.filename, snippet);
    selected.push({ doc, snippet, key });
    usedTokens += est;
    if (selected.length >= 3) break;
  }
  return { selected, usedTokens };
}

export function buildHookOutput(
  selected: SelectedSnippet[],
  usedTokens: number,
  intent: string,
  gitCtx: GitContext | null,
  detectedProject: string | null,
  stage: Record<string, number>,
  tokenBudget: number,
  cortexPathLocal: string,
  sessionId?: string
): string[] {
  const projectLabel = detectedProject ? ` \u00b7 ${detectedProject}` : "";
  const resultLabel = selected.length === 1 ? "1 result" : `${selected.length} results`;
  const statusLine = `\u25c6 cortex${projectLabel} \u00b7 ${resultLabel}`;

  const parts: string[] = [statusLine, "<cortex-context>"];
  for (const injected of selected) {
    const { doc, snippet, key } = injected;
    recordMemoryInjection(cortexPathLocal, key, sessionId);
    parts.push(`[${doc.project}/${doc.filename}] (${doc.type})`);
    parts.push(snippet);
    parts.push("");
  }
  parts.push("</cortex-context>");

  const changedCount = gitCtx?.changedFiles.size ?? 0;
  if (gitCtx) {
    const fileHits = selected.filter((r) => fileRelevanceBoost(r.doc.path, gitCtx.changedFiles) > 0).length;
    const branchHits = selected.filter((r) => branchMatchBoost(r.doc.content, gitCtx.branch) > 0).length;
    parts.push(
      `\u25c6 cortex \u00b7 trace: intent=${intent}; reasons=file:${fileHits},branch:${branchHits}; branch=${gitCtx.branch}; changed_files=${changedCount}; tokens\u2248${usedTokens}/${tokenBudget}; stages=index:${stage.indexMs}ms,search:${stage.searchMs}ms,trust:${stage.trustMs}ms,rank:${stage.rankMs}ms,select:${stage.selectMs}ms`
    );
  } else {
    parts.push(`\u25c6 cortex \u00b7 trace: intent=${intent}; reasons=intent-only; tokens\u2248${usedTokens}/${tokenBudget}; stages=index:${stage.indexMs}ms,search:${stage.searchMs}ms,trust:${stage.trustMs}ms,rank:${stage.rankMs}ms,select:${stage.selectMs}ms`);
  }

  return parts;
}

export function trackSessionMetrics(
  cortexPathLocal: string,
  sessionId: string,
  selected: SelectedSnippet[],
  changedCount: number
): void {
  const metrics = parseSessionMetrics(cortexPathLocal);
  if (!metrics[sessionId]) metrics[sessionId] = { prompts: 0, keys: {}, lastChangedCount: 0, lastKeys: [] };
  metrics[sessionId].prompts += 1;
  const injectedKeys: string[] = [];
  for (const injected of selected) {
    injectedKeys.push(injected.key);
    const key = injected.key;
    const seen = metrics[sessionId].keys[key] || 0;
    metrics[sessionId].keys[key] = seen + 1;
    if (seen >= 1) recordMemoryFeedback(cortexPathLocal, key, "reprompt");
  }

  const prevChanged = metrics[sessionId].lastChangedCount || 0;
  const prevKeys = metrics[sessionId].lastKeys || [];
  if (changedCount > prevChanged) {
    for (const prevKey of prevKeys) {
      recordMemoryFeedback(cortexPathLocal, prevKey, "helpful");
    }
  }
  metrics[sessionId].lastChangedCount = changedCount;
  metrics[sessionId].lastKeys = injectedKeys;
  metrics[sessionId].lastSeen = new Date().toISOString();

  const thirtyDaysAgo = Date.now() - 30 * 86400000;
  for (const sid of Object.keys(metrics)) {
    const seen = metrics[sid].lastSeen;
    if (seen && new Date(seen).getTime() < thirtyDaysAgo) {
      delete metrics[sid];
    }
  }

  writeSessionMetrics(cortexPathLocal, metrics);
}

// ── handleHookPrompt: orchestrator using extracted stages ────────────────────

export async function handleHookPrompt() {
  const stage = { indexMs: 0, searchMs: 0, trustMs: 0, rankMs: 0, selectMs: 0 };

  let raw = "";
  try { raw = fs.readFileSync(0, "utf-8"); } catch { process.exit(0); }

  const input = parseHookInput(raw);
  if (!input) process.exit(0);

  const { prompt, cwd, sessionId } = input;

  if (!getHooksEnabledPreference(cortexPath)) {
    appendAuditLog(cortexPath, "hook_prompt", "status=disabled");
    process.exit(0);
  }

  updateRuntimeHealth(cortexPath, { lastPromptAt: new Date().toISOString() });

  const keywords = extractKeywords(prompt);
  if (!keywords) process.exit(0);
  debugLog(`hook-prompt keywords: "${keywords}"`);

  const tIndex0 = Date.now();
  const db = await buildIndex(cortexPath, profile);
  stage.indexMs = Date.now() - tIndex0;

  const gitCtx = getGitContext(cwd);
  const intent = detectTaskIntent(prompt);
  const detectedProject = cwd ? detectProject(cortexPath, cwd, profile) : null;
  if (detectedProject) debugLog(`Detected project: ${detectedProject}`);

  const safeQuery = buildRobustFtsQuery(keywords);
  if (!safeQuery) process.exit(0);

  try {
    const tSearch0 = Date.now();
    let rows = searchDocuments(db, safeQuery, prompt, keywords, detectedProject);
    stage.searchMs = Date.now() - tSearch0;
    if (!rows || !rows.length) process.exit(0);

    const tTrust0 = Date.now();
    const policy = getMemoryPolicy(cortexPath);
    const memoryTtlDays = Number.parseInt(
      process.env.CORTEX_MEMORY_TTL_DAYS || String(policy.ttlDays), 10
    );
    rows = applyTrustFilter(
      rows, cortexPath,
      Number.isNaN(memoryTtlDays) ? policy.ttlDays : memoryTtlDays,
      policy.minInjectConfidence, policy.decay
    );
    stage.trustMs = Date.now() - tTrust0;
    if (!rows.length) process.exit(0);

    if (isFeatureEnabled("CORTEX_FEATURE_AUTO_EXTRACT", true) && sessionId && detectedProject && cwd) {
      const marker = path.join(cortexPath, `.extracted-${sessionId}-${detectedProject}`);
      if (!fs.existsSync(marker)) {
        try {
          await handleExtractMemories(detectedProject, cwd, true);
          fs.writeFileSync(marker, "");
        } catch { /* best effort */ }
      }
    }

    const tRank0 = Date.now();
    rows = rankResults(rows, intent, gitCtx, detectedProject, cortexPath, db);
    stage.rankMs = Date.now() - tRank0;
    if (!rows.length) process.exit(0);

    const safeTokenBudget = clampInt(process.env.CORTEX_CONTEXT_TOKEN_BUDGET, 550, 180, 10000);
    const safeLineBudget = clampInt(process.env.CORTEX_CONTEXT_SNIPPET_LINES, 6, 2, 100);
    const safeCharBudget = clampInt(process.env.CORTEX_CONTEXT_SNIPPET_CHARS, 520, 120, 10000);

    const tSelect0 = Date.now();
    const { selected, usedTokens } = selectSnippets(rows, keywords, safeTokenBudget, safeLineBudget, safeCharBudget);
    stage.selectMs = Date.now() - tSelect0;
    if (!selected.length) process.exit(0);

    const parts = buildHookOutput(selected, usedTokens, intent, gitCtx, detectedProject, stage, safeTokenBudget, cortexPath, sessionId);

    const changedCount = gitCtx?.changedFiles.size ?? 0;
    if (sessionId) {
      trackSessionMetrics(cortexPath, sessionId, selected, changedCount);
    }

    flushMemoryScores(cortexPath);
    scheduleBackgroundMaintenance(cortexPath);

    const noticeFile = sessionId ? path.join(cortexPath, `.noticed-${sessionId}`) : null;
    const alreadyNoticed = noticeFile ? fs.existsSync(noticeFile) : false;

    if (!alreadyNoticed) {
      try {
        const cutoff = Date.now() - 86400000;
        for (const f of fs.readdirSync(cortexPath)) {
          if (!f.startsWith(".noticed-") && !f.startsWith(".extracted-")) continue;
          const fp = path.join(cortexPath, f);
          if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
        }
      } catch { /* best effort */ }

      const needed = checkConsolidationNeeded(cortexPath, profile);
      if (needed.length > 0) {
        const notices = needed.map((n) => {
          const since = n.lastConsolidated ? ` since ${n.lastConsolidated}` : "";
          return `  ${n.project}: ${n.entriesSince} new learnings${since}`;
        });
        parts.push(`\u25c8 cortex \u00b7 consolidation ready`);
        parts.push(`<cortex-notice>`);
        parts.push(`Learnings ready for consolidation:`);
        parts.push(notices.join("\n"));
        parts.push(`Run /cortex-consolidate when ready.`);
        parts.push(`</cortex-notice>`);
      }

      if (noticeFile) {
        try { fs.writeFileSync(noticeFile, ""); } catch { /* best effort */ }
      }
    }

    console.log(parts.join("\n"));
  } catch (err: any) {
    process.stderr.write("cortex hook-prompt error: " + String(err?.message || err) + "\n");
    process.exit(0);
  }
}

export async function handleHookContext() {
  if (!getHooksEnabledPreference(cortexPath)) {
    process.exit(0);
  }

  let cwd = process.cwd();
  try {
    const input = fs.readFileSync(0, "utf-8");
    const data = JSON.parse(input);
    if (data.cwd) cwd = data.cwd;
  } catch {
    // No stdin or invalid JSON, fall back to process.cwd()
  }

  const project = detectProject(cortexPath, cwd, profile);

  const db = await buildIndex(cortexPath, profile);
  const contextLabel = project ? `\u25c6 cortex \u00b7 ${project} \u00b7 context` : `\u25c6 cortex \u00b7 context`;
  const parts: string[] = [contextLabel, "<cortex-context>"];

  if (project) {
    const summaryRow = queryRows(db, "SELECT content FROM docs WHERE project = ? AND type = 'summary'", [project]);
    if (summaryRow) {
      parts.push(`# ${project}`);
      parts.push(summaryRow[0][0] as string);
      parts.push("");
    }

    const learningsRow = queryRows(
      db,
      "SELECT content FROM docs WHERE project = ? AND type = 'learnings'",
      [project]
    );
    if (learningsRow) {
      const content = learningsRow[0][0] as string;
      const bullets = content.split("\n").filter(l => l.startsWith("- ")).slice(0, 10);
      if (bullets.length > 0) {
        parts.push("## Recent learnings");
        parts.push(bullets.join("\n"));
        parts.push("");
      }
    }

    const backlogRow = queryRows(
      db,
      "SELECT content FROM docs WHERE project = ? AND type = 'backlog'",
      [project]
    );
    if (backlogRow) {
      const content = backlogRow[0][0] as string;
      const activeItems = content.split("\n").filter(l => l.startsWith("- ")).slice(0, 5);
      if (activeItems.length > 0) {
        parts.push("## Active backlog");
        parts.push(activeItems.join("\n"));
        parts.push("");
      }
    }
  } else {
    const projectRows = queryRows(db, "SELECT DISTINCT project FROM docs ORDER BY project", []);
    if (projectRows) {
      parts.push("# Cortex projects");
      parts.push(projectRows.map(r => `- ${r[0]}`).join("\n"));
      parts.push("");
    }
  }

  parts.push("</cortex-context>");

  if (parts.length > 2) {
    console.log(parts.join("\n"));
  }
}
