import {
  debugLog,
  appendAuditLog,
  runtimeFile,
  sessionMarker,
  sessionsDir,
  EXEC_TIMEOUT_MS,
  ensureCortexPath,
} from "./shared.js";
import {
  appendReviewQueue,
  recordFeedback,
  getQualityMultiplier,
  updateRuntimeHealth,
  withFileLock,
} from "./shared-governance.js";
import {
  detectProject,
} from "./shared-index.js";
import {
  addFindingToFile,
  KNOWN_OBSERVATION_TAGS,
} from "./shared-content.js";
import { runGit, isFeatureEnabled } from "./utils.js";
import * as fs from "fs";
import * as path from "path";
import { execFileSync, spawn } from "child_process";
import { fileURLToPath } from "url";
import { runDoctor } from "./link.js";
import { getHooksEnabledPreference } from "./init.js";
import { handleExtractMemories } from "./cli-extract.js";
import {
  buildIndex,
  queryRows,
  queryDocRows,
} from "./shared-index.js";
import type { SelectedSnippet } from "./cli-hooks-retrieval.js";
import { filterBacklogByPriority } from "./cli-hooks-retrieval.js";

const cortexPath = ensureCortexPath();
const profile = process.env.CORTEX_PROFILE || "";

// ── Git helpers ──────────────────────────────────────────────────────────────

export interface GitContext {
  branch: string;
  changedFiles: Set<string>;
}

export function getGitContext(cwd?: string): GitContext | null {
  if (!cwd) return null;
  const git = (args: string[]) => runGit(cwd, args, EXEC_TIMEOUT_MS, debugLog);
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch) return null;
  const changedFiles = new Set<string>();
  for (const changed of [
    git(["diff", "--name-only"]),
    git(["diff", "--name-only", "--cached"]),
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
  } catch (err: unknown) {
    debugLog(`parseSessionMetrics: failed to read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

function writeSessionMetrics(cortexPathLocal: string, data: Record<string, SessionMetric>) {
  const file = path.join(cortexPathLocal, ".governance", "session-metrics.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

function updateSessionMetrics(
  cortexPathLocal: string,
  updater: (data: Record<string, SessionMetric>) => void
): void {
  const file = path.join(cortexPathLocal, ".governance", "session-metrics.json");
  withFileLock(file, () => {
    const metrics = parseSessionMetrics(cortexPathLocal);
    updater(metrics);
    writeSessionMetrics(cortexPathLocal, metrics);
  });
}

export function trackSessionMetrics(
  cortexPathLocal: string,
  sessionId: string,
  selected: SelectedSnippet[],
  changedCount: number
): void {
  updateSessionMetrics(cortexPathLocal, (metrics) => {
    if (!metrics[sessionId]) metrics[sessionId] = { prompts: 0, keys: {}, lastChangedCount: 0, lastKeys: [] };
    metrics[sessionId].prompts += 1;
    const injectedKeys: string[] = [];
    for (const injected of selected) {
      injectedKeys.push(injected.key);
      const key = injected.key;
      const seen = metrics[sessionId].keys[key] || 0;
      metrics[sessionId].keys[key] = seen + 1;
      if (seen >= 1) recordFeedback(cortexPathLocal, key, "reprompt");
    }

    const relevantCount = selected.filter((s) => getQualityMultiplier(cortexPathLocal, s.key) > 0.5).length;
    const prevRelevant = metrics[sessionId].lastChangedCount || 0;
    const prevKeys = metrics[sessionId].lastKeys || [];
    if (relevantCount > prevRelevant) {
      for (const prevKey of prevKeys) {
        recordFeedback(cortexPathLocal, prevKey, "helpful");
      }
    }
    metrics[sessionId].lastChangedCount = relevantCount;
    metrics[sessionId].lastKeys = injectedKeys;
    metrics[sessionId].lastSeen = new Date().toISOString();

    const thirtyDaysAgo = Date.now() - 30 * 86400000;
    for (const sid of Object.keys(metrics)) {
      const seen = metrics[sid].lastSeen;
      if (seen && new Date(seen).getTime() < thirtyDaysAgo) {
        delete metrics[sid];
      }
    }
  });
}

// ── Background maintenance ───────────────────────────────────────────────────

function qualityMarkers(cortexPathLocal: string): { done: string; lock: string } {
  const today = new Date().toISOString().slice(0, 10);
  return {
    done: runtimeFile(cortexPathLocal, `quality-${today}`),
    lock: runtimeFile(cortexPathLocal, `quality-${today}.lock`),
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
    } catch (err: unknown) {
      debugLog(`maybeRunBackgroundMaintenance: lock check failed: ${err instanceof Error ? err.message : String(err)}`);
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
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
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
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
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

  try { const { trackSession } = await import("./telemetry.js"); trackSession(cortexPath); } catch { /* best-effort */ }

  updateRuntimeHealth(cortexPath, { lastSessionStartAt: startedAt });
  appendAuditLog(
    cortexPath,
    "hook_session_start",
    `pull=${pull.ok ? "ok" : "fail"} doctor=${doctor.ok ? "ok" : "issues"} maintenance=${maintenanceScheduled ? "scheduled" : "skipped"}`
  );
}

// ── Q21: Conversation memory capture ─────────────────────────────────────────

const INSIGHT_KEYWORDS = [
  "always", "never", "important", "gotcha", "trick", "workaround",
  "careful", "caveat", "beware", "note that", "make sure",
  "don't forget", "remember to", "must", "avoid", "prefer",
];

const INSIGHT_KEYWORD_RE = new RegExp(
  `\\b(${INSIGHT_KEYWORDS.join("|")})\\b`,
  "i"
);

/**
 * Extract potential insights from conversation text using keyword heuristics.
 * Returns lines that contain insight-signal words and look like actionable knowledge.
 */
export function extractConversationInsights(text: string): string[] {
  const lines = text.split("\n").filter(l => l.trim().length > 20 && l.trim().length < 300);
  const insights: string[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip code-only lines, headers, etc.
    if (trimmed.startsWith("```") || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;
    if (trimmed.startsWith("$") || trimmed.startsWith(">")) continue;

    if (INSIGHT_KEYWORD_RE.test(trimmed)) {
      // Normalize for dedup
      const normalized = trimmed.toLowerCase().replace(/\s+/g, " ");
      if (!seen.has(normalized)) {
        seen.add(normalized);
        insights.push(trimmed);
      }
    }
  }

  // Cap to prevent flooding
  return insights.slice(0, 5);
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

    // Q21: Auto-capture conversation insights (gated behind CORTEX_FEATURE_AUTO_CAPTURE=1)
    if (isFeatureEnabled("CORTEX_FEATURE_AUTO_CAPTURE", false)) {
      try {
        const captureInput = process.env.CORTEX_CONVERSATION_CONTEXT || "";
        if (captureInput) {
          const cwd = process.cwd();
          const activeProject = detectProject(cortexPath, cwd, profile);
          if (activeProject) {
            const insights = extractConversationInsights(captureInput);
            for (const insight of insights) {
              addFindingToFile(cortexPath, activeProject, `[pattern] ${insight}`);
              debugLog(`auto-capture: saved insight for ${activeProject}: ${insight.slice(0, 60)}`);
            }
          }
        }
      } catch (err: unknown) {
        debugLog(`auto-capture failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Auto governance scheduling: run governance weekly if overdue
    try {
      const lastGovPath = runtimeFile(cortexPath, "last-governance.txt");
      const lastRun = fs.existsSync(lastGovPath) ? parseInt(fs.readFileSync(lastGovPath, "utf8"), 10) : 0;
      const daysSince = (Date.now() - lastRun) / 86_400_000;
      if (daysSince >= 7) {
        const spawnArgs = resolveSubprocessArgs("background-maintenance");
        if (spawnArgs) {
          const child = spawn(process.execPath, spawnArgs, { detached: true, stdio: "ignore" });
          child.unref();
          fs.writeFileSync(lastGovPath, Date.now().toString());
          debugLog("hook_stop: scheduled weekly governance run");
        }
      }
    } catch (err: unknown) {
      debugLog(`hook_stop: governance scheduling failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    return;
  }

  updateRuntimeHealth(cortexPath, {
    lastStopAt: now,
    lastAutoSave: { at: now, status: "saved-local", detail: push.error || "push failed" },
  });
  appendAuditLog(cortexPath, "hook_stop", `status=saved-local detail=${JSON.stringify(push.error || "push failed")}`);
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
  } catch (err: unknown) {
    debugLog(`hook-context: no stdin or invalid JSON, using cwd: ${err instanceof Error ? err.message : String(err)}`);
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

    const findingsRow = queryRows(
      db,
      "SELECT content FROM docs WHERE project = ? AND type = 'findings'",
      [project]
    );
    if (findingsRow) {
      const content = findingsRow[0][0] as string;
      const bullets = content.split("\n").filter(l => l.startsWith("- ")).slice(0, 10);
      if (bullets.length > 0) {
        parts.push("## Recent findings");
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
      const activeItems = content.split("\n").filter(l => l.startsWith("- "));
      const filtered = filterBacklogByPriority(activeItems);
      const trimmed = filtered.slice(0, 5);
      if (trimmed.length > 0) {
        parts.push("## Active backlog");
        parts.push(trimmed.join("\n"));
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

// ── PostToolUse hook ─────────────────────────────────────────────────────────

const INTERESTING_TOOLS = new Set(["Read", "Write", "Edit", "Bash", "Glob", "Grep"]);

interface ToolLogEntry {
  at: string;
  session_id?: string;
  tool: string;
  file?: string;
  command?: string;
  error?: string;
}

export async function handleHookTool() {
  if (!getHooksEnabledPreference(cortexPath)) {
    process.exit(0);
  }

  const start = Date.now();

  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf-8");
  } catch {
    process.exit(0);
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    process.exit(0);
  }

  const toolName: string = String(data.tool_name ?? data.tool ?? "");
  if (!INTERESTING_TOOLS.has(toolName)) {
    process.exit(0);
  }

  const sessionId: string | undefined = data.session_id as string | undefined;
  const input: Record<string, unknown> = (data.tool_input ?? {}) as Record<string, unknown>;

  const entry: ToolLogEntry = {
    at: new Date().toISOString(),
    session_id: sessionId,
    tool: toolName,
  };

  if (toolName === "Read" || toolName === "Write" || toolName === "Edit") {
    const filePath = input.file_path ?? input.path ?? undefined;
    if (filePath) entry.file = String(filePath);
  } else if (toolName === "Bash") {
    const cmd = input.command ?? undefined;
    if (cmd) entry.command = String(cmd).slice(0, 200);
  } else if (toolName === "Glob") {
    const pattern = input.pattern ?? undefined;
    if (pattern) entry.file = String(pattern);
  } else if (toolName === "Grep") {
    const pattern = input.pattern ?? undefined;
    const searchPath = input.path ?? undefined;
    if (pattern) entry.command = `grep ${pattern}${searchPath ? ` in ${searchPath}` : ""}`.slice(0, 200);
  }

  const responseStr = typeof data.tool_response === "string"
    ? data.tool_response
    : JSON.stringify(data.tool_response ?? "");
  if (/(error|exception|failed|no such file|ENOENT)/i.test(responseStr)) {
    entry.error = responseStr.slice(0, 300);
  }

  try {
    const logFile = runtimeFile(cortexPath, "tool-log.jsonl");
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, JSON.stringify(entry) + "\n");
  } catch {
    // best effort
  }

  const cwd: string | undefined = (data.cwd ?? input.cwd ?? undefined) as string | undefined;
  const activeProject = cwd ? detectProject(cortexPath, cwd, profile) : null;

  if (activeProject) {
    try {
      const candidates = extractToolFindings(toolName, input, responseStr);
      for (const { text, confidence } of candidates) {
        if (confidence >= 0.85) {
          addFindingToFile(cortexPath, activeProject, text);
          debugLog(`hook-tool: auto-added learning (conf=${confidence}): ${text.slice(0, 60)}`);
        } else {
          appendReviewQueue(cortexPath, activeProject, "Review", [text]);
          debugLog(`hook-tool: queued candidate (conf=${confidence}): ${text.slice(0, 60)}`);
        }
      }
    } catch (err: unknown) {
      debugLog(`hook-tool: learning extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const elapsed = Date.now() - start;
  debugLog(`hook-tool: ${toolName} logged in ${elapsed}ms`);

  process.exit(0);
}

// ── Tool finding extraction ──────────────────────────────────────────────────

interface LearningCandidate {
  text: string;
  confidence: number;
}

const EXPLICIT_TAG_PATTERN = /\[(pitfall|decision|pattern|tradeoff|architecture|bug)\]\s*(.+)/i;

export function extractToolFindings(
  toolName: string,
  input: Record<string, unknown>,
  responseStr: string
): LearningCandidate[] {
  const candidates: LearningCandidate[] = [];

  const tagMatches = responseStr.matchAll(new RegExp(EXPLICIT_TAG_PATTERN.source, "gi"));
  for (const m of tagMatches) {
    const tag = m[1].toLowerCase();
    const content = m[2].trim().slice(0, 200);
    if (content) {
      candidates.push({ text: `[${tag}] ${content}`, confidence: 0.85 });
    }
  }

  if (toolName === "Edit" || toolName === "Write") {
    const changedContent = String(input.new_string ?? input.content ?? "");
    const filePath = String(input.file_path ?? input.path ?? "unknown");
    const filename = path.basename(filePath);
    if (/\b(TODO|FIXME)\b/.test(changedContent)) {
      const firstLine = changedContent.split("\n").find((l) => /\b(TODO|FIXME)\b/.test(l));
      if (firstLine) {
        candidates.push({
          text: `[pitfall] ${filename}: ${firstLine.trim().slice(0, 150)}`,
          confidence: 0.45,
        });
      }
    }
    if (/\btry\s*\{[\s\S]*?\bcatch\b/.test(changedContent)) {
      const meaningfulLine = changedContent.split("\n").find(
        (l) => l.trim().length > 10 && !/^\s*(try|catch|\{|\})/.test(l)
      );
      if (meaningfulLine) {
        candidates.push({
          text: `[pitfall] ${filename}: error handling added near "${meaningfulLine.trim().slice(0, 100)}"`,
          confidence: 0.45,
        });
      }
    }
  }

  if (toolName === "Bash") {
    const cmd = String(input.command ?? "").slice(0, 30);
    const hasError = /(error|exception|failed|ENOENT|command not found|permission denied)/i.test(responseStr);
    if (hasError && cmd) {
      const firstErrorLine = responseStr.split("\n").find(
        (l) => /(error|exception|failed|ENOENT|command not found|permission denied)/i.test(l)
      );
      if (firstErrorLine) {
        candidates.push({
          text: `[bug] command '${cmd}' failed: ${firstErrorLine.trim().slice(0, 150)}`,
          confidence: 0.55,
        });
      }
    }
  }

  return candidates;
}
