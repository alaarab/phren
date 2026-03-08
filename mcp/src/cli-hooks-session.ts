import {
  debugLog,
  appendAuditLog,
  runtimeFile,
  qualityMarkers,
  sessionMarker,
  sessionsDir,
  EXEC_TIMEOUT_MS,
  getCortexPath,
  KNOWN_OBSERVATION_TAGS,
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
} from "./shared-content.js";
import { runGit, isFeatureEnabled, errorMessage } from "./utils.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync, spawn } from "child_process";
import { fileURLToPath } from "url";
import { runDoctor } from "./link.js";
import { getHooksEnabledPreference } from "./init.js";
import { isToolHookEnabled } from "./hooks.js";
import { handleExtractMemories } from "./cli-extract.js";
import {
  buildIndex,
  queryRows,
  queryDocRows,
} from "./shared-index.js";
import type { SelectedSnippet } from "./cli-hooks-retrieval.js";
import { filterBacklogByPriority } from "./cli-hooks-retrieval.js";

/** Read JSON from stdin if it's not a TTY. Returns null if stdin is a TTY or parsing fails. */
function readStdinJson<T>(): T | null {
  if (process.stdin.isTTY) return null;
  try {
    return JSON.parse(fs.readFileSync(0, "utf-8")) as T;
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] readStdinJson: ${errorMessage(err)}\n`);
    return null;
  }
}

/** Validate that a transcript path points to a safe, expected location.
 * Uses realpathSync to dereference symlinks, preventing traversal attacks
 * where a symlink inside a safe dir points outside it.
 */
function isSafeTranscriptPath(p: string): boolean {
  // Resolve symlinks so a link like ~/.claude/evil -> /etc/passwd is caught
  let normalized: string;
  try {
    normalized = fs.realpathSync.native(p);
  } catch {
    // If the file doesn't exist yet, fall back to lexical resolution
    try {
      normalized = fs.realpathSync.native(path.dirname(p));
      normalized = path.join(normalized, path.basename(p));
    } catch {
      normalized = path.resolve(p);
    }
  }
  const safePrefixes = [
    path.resolve(os.tmpdir()),
    path.resolve(os.homedir(), ".claude"),
    path.resolve(os.homedir(), ".config", "claude"),
  ];
  return safePrefixes.some(prefix => normalized.startsWith(prefix + path.sep) || normalized === prefix);
}

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
    debugLog(`parseSessionMetrics: failed to read ${file}: ${errorMessage(err)}`);
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
      debugLog(`maybeRunBackgroundMaintenance: lock check failed: ${errorMessage(err)}`);
      return false;
    }
  }

  const spawnArgs = resolveSubprocessArgs("background-maintenance");
  if (!spawnArgs) return false;

  try {
    // Use exclusive open (O_EXCL) to atomically claim the lock; if another process
    // already holds it this throws and we return false without spawning a duplicate.
    const lockContent = JSON.stringify({
      startedAt: new Date().toISOString(),
      project: project || "all",
      pid: process.pid,
    }) + "\n";
    let fd: number;
    try {
      fd = fs.openSync(markers.lock, "wx");
    } catch (err: unknown) {
      // Another process already claimed the lock
      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] backgroundMaintenance lockClaim: ${errorMessage(err)}\n`);
      return false;
    }
    try {
      fs.writeSync(fd, lockContent);
    } finally {
      fs.closeSync(fd);
    }
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
      try { fs.appendFileSync(logPath, msg); } catch (err: unknown) {
        if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] backgroundMaintenance exitLog: ${errorMessage(err)}\n`);
      }
      if (code === 0) {
        try { fs.writeFileSync(markers.done, new Date().toISOString() + "\n"); } catch (err: unknown) {
          if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] backgroundMaintenance doneMarker: ${errorMessage(err)}\n`);
        }
      }
      try { fs.unlinkSync(markers.lock); } catch (err: unknown) {
        if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] backgroundMaintenance unlockOnExit: ${errorMessage(err)}\n`);
      }
    });
    child.on("error", (spawnErr) => {
      const msg = `[${new Date().toISOString()}] spawn error: ${spawnErr.message}\n`;
      try { fs.appendFileSync(logPath, msg); } catch (err: unknown) {
        if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] backgroundMaintenance errorLog: ${errorMessage(err)}\n`);
      }
      try { fs.unlinkSync(markers.lock); } catch (err: unknown) {
        if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] backgroundMaintenance unlockOnError: ${errorMessage(err)}\n`);
      }
    });
    fs.closeSync(logFd);
    child.unref();
    return true;
  } catch (err: unknown) {
    const errMsg = errorMessage(err);
    try {
      const logDir = path.join(cortexPathLocal, ".governance");
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(
        path.join(logDir, "background-maintenance.log"),
        `[${new Date().toISOString()}] spawn failed: ${errMsg}\n`
      );
    } catch (err: unknown) {
      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] backgroundMaintenance logSpawnFailure: ${errorMessage(err)}\n`);
    }
    try { fs.unlinkSync(markers.lock); } catch (err: unknown) {
      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] backgroundMaintenance unlockOnFailure: ${errorMessage(err)}\n`);
    }
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
      const message = errorMessage(err);
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

async function countUnsyncedCommits(cwd: string): Promise<number> {
  const upstream = await runBestEffortGit(["rev-parse", "--abbrev-ref", "@{upstream}"], cwd);
  if (!upstream.ok || !upstream.output) return 0;
  const ahead = await runBestEffortGit(["rev-list", "--count", `${upstream.output.trim()}..HEAD`], cwd);
  if (!ahead.ok || !ahead.output) return 0;
  const parsed = Number.parseInt(ahead.output.trim(), 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

// ── Hook handlers ────────────────────────────────────────────────────────────

export async function handleHookSessionStart() {
  const startedAt = new Date().toISOString();
  if (!getHooksEnabledPreference(getCortexPath())) {
    updateRuntimeHealth(getCortexPath(), { lastSessionStartAt: startedAt });
    appendAuditLog(getCortexPath(), "hook_session_start", "status=disabled");
    return;
  }

  const hookTool = process.env.CORTEX_HOOK_TOOL || "claude";
  if (!isToolHookEnabled(getCortexPath(), hookTool)) {
    appendAuditLog(getCortexPath(), "hook_session_start", `status=tool_disabled tool=${hookTool}`);
    return;
  }

  const pull = await runBestEffortGit(["pull", "--rebase", "--quiet"], getCortexPath());
  const doctor = await runDoctor(getCortexPath(), false);
  const maintenanceScheduled = scheduleBackgroundMaintenance(getCortexPath());
  const unsyncedCommits = await countUnsyncedCommits(getCortexPath());

  try { const { trackSession } = await import("./telemetry.js"); trackSession(getCortexPath()); } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] hookSessionStart trackSession: ${errorMessage(err)}\n`);
  }

  updateRuntimeHealth(getCortexPath(), {
    lastSessionStartAt: startedAt,
    lastSync: {
      lastPullAt: startedAt,
      lastPullStatus: pull.ok ? "ok" : "error",
      lastPullDetail: pull.ok ? (pull.output || "pull ok") : (pull.error || "pull failed"),
      lastSuccessfulPullAt: pull.ok ? startedAt : undefined,
      unsyncedCommits,
    },
  });
  appendAuditLog(
    getCortexPath(),
    "hook_session_start",
    `pull=${pull.ok ? "ok" : "fail"} doctor=${doctor.ok ? "ok" : "issues"} maintenance=${maintenanceScheduled ? "scheduled" : "skipped"}`
  );
}

// ── Q21: Conversation memory capture ─────────────────────────────────────────

const INSIGHT_KEYWORDS = [
  "always", "never", "important", "pitfall", "gotcha", "trick", "workaround",
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

/**
 * Load ~/.cortex/.env into process.env. Only sets keys that are not already set.
 * Called at the start of handleHookStop so feature flags written by init are active.
 */
function loadCortexDotEnv(cortexPathLocal: string): void {
  try {
    const content = fs.readFileSync(path.join(cortexPathLocal, ".env"), "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      // Strip matching surrounding quotes (both ends must use the same quote character)
      const raw = trimmed.slice(eqIdx + 1).trim();
      const val = /^(["'])(.*)\1$/.test(raw) ? raw.slice(1, -1) : raw;
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] loadCortexDotEnv: ${errorMessage(err)}\n`);
  }
}

export async function handleHookStop() {
  const now = new Date().toISOString();
  loadCortexDotEnv(getCortexPath());
  if (!getHooksEnabledPreference(getCortexPath())) {
    updateRuntimeHealth(getCortexPath(), {
      lastStopAt: now,
      lastAutoSave: { at: now, status: "clean", detail: "hooks disabled by preference" },
    });
    appendAuditLog(getCortexPath(), "hook_stop", "status=disabled");
    return;
  }

  const hookTool = process.env.CORTEX_HOOK_TOOL || "claude";
  if (!isToolHookEnabled(getCortexPath(), hookTool)) {
    appendAuditLog(getCortexPath(), "hook_stop", `status=tool_disabled tool=${hookTool}`);
    return;
  }

  // Read stdin early — it's a stream and can only be consumed once.
  // Needed for auto-capture transcript_path parsing.
  const stdinPayload = readStdinJson<{ transcript_path?: string }>();

  // Auto-capture BEFORE git operations so captured insights get committed and pushed.
  // Gated behind CORTEX_FEATURE_AUTO_CAPTURE=1.
  if (isFeatureEnabled("CORTEX_FEATURE_AUTO_CAPTURE", false)) {
    try {
      let captureInput = process.env.CORTEX_CONVERSATION_CONTEXT || "";
      if (!captureInput && stdinPayload?.transcript_path) {
        const transcriptPath = stdinPayload.transcript_path;
        if (!isSafeTranscriptPath(transcriptPath)) {
          debugLog(`auto-capture: skipping unsafe transcript_path: ${transcriptPath}`);
        } else if (fs.existsSync(transcriptPath)) {
          // Cap at last 500 lines (~50 KB) to bound memory usage for long sessions
          const raw = fs.readFileSync(transcriptPath, "utf-8");
          const allLines = raw.split("\n").filter(Boolean);
          const lines = allLines.length > 500 ? allLines.slice(-500) : allLines;
          const assistantTexts: string[] = [];
          for (const line of lines) {
            try {
              const msg = JSON.parse(line) as { role?: string; content?: string | Array<{ type?: string; text?: string }> };
              if (msg.role !== "assistant") continue;
              if (typeof msg.content === "string") assistantTexts.push(msg.content);
              else if (Array.isArray(msg.content)) {
                for (const block of msg.content) {
                  if (block.type === "text" && block.text) assistantTexts.push(block.text);
                }
              }
            } catch (err: unknown) {
              if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] hookSessionStart transcriptParse: ${errorMessage(err)}\n`);
            }
          }
          captureInput = assistantTexts.join("\n");
        }
      }
      if (captureInput) {
        const cwd = process.cwd();
        const activeProject = detectProject(getCortexPath(), cwd, profile);
        if (activeProject) {
          const insights = extractConversationInsights(captureInput);
          for (const insight of insights) {
            addFindingToFile(getCortexPath(), activeProject, `[pattern] ${insight}`);
            debugLog(`auto-capture: saved insight for ${activeProject}: ${insight.slice(0, 60)}`);
          }
        }
      }
    } catch (err: unknown) {
      debugLog(`auto-capture failed: ${errorMessage(err)}`);
    }
  }

  const status = await runBestEffortGit(["status", "--porcelain"], getCortexPath());
  if (!status.ok) {
    updateRuntimeHealth(getCortexPath(), {
      lastStopAt: now,
      lastAutoSave: { at: now, status: "error", detail: status.error || "git status failed" },
      lastSync: {
        lastPushAt: now,
        lastPushStatus: "error",
        lastPushDetail: status.error || "git status failed",
      },
    });
    appendAuditLog(getCortexPath(), "hook_stop", `status=error detail=${JSON.stringify(status.error || "git status failed")}`);
    return;
  }

  if (!status.output) {
    updateRuntimeHealth(getCortexPath(), {
      lastStopAt: now,
      lastAutoSave: { at: now, status: "clean", detail: "no changes" },
      lastSync: {
        lastPushAt: now,
        lastPushStatus: "saved-pushed",
        lastPushDetail: "no changes",
        unsyncedCommits: 0,
      },
    });
    appendAuditLog(getCortexPath(), "hook_stop", "status=clean");
    return;
  }

  // Exclude sensitive files from staging: .env files and private keys should
  // never be committed to the cortex git repository.
  const add = await runBestEffortGit(
    ["add", "-A", "--", ":(exclude).env", ":(exclude)**/.env", ":(exclude)*.pem", ":(exclude)*.key"],
    getCortexPath()
  );
  const commit = add.ok ? await runBestEffortGit(["commit", "-m", "auto-save cortex"], getCortexPath()) : { ok: false, error: add.error };
  if (!add.ok || !commit.ok) {
    updateRuntimeHealth(getCortexPath(), {
      lastStopAt: now,
      lastAutoSave: {
        at: now,
        status: "error",
        detail: add.error || commit.error || "git add/commit failed",
      },
      lastSync: {
        lastPushAt: now,
        lastPushStatus: "error",
        lastPushDetail: add.error || commit.error || "git add/commit failed",
      },
    });
    appendAuditLog(getCortexPath(), "hook_stop", `status=error detail=${JSON.stringify(add.error || commit.error || "git add/commit failed")}`);
    return;
  }

  const remotes = await runBestEffortGit(["remote"], getCortexPath());
  if (!remotes.ok || !remotes.output) {
    const unsyncedCommits = await countUnsyncedCommits(getCortexPath());
    updateRuntimeHealth(getCortexPath(), {
      lastStopAt: now,
      lastAutoSave: { at: now, status: "saved-local", detail: "commit created; no remote configured" },
      lastSync: {
        lastPushAt: now,
        lastPushStatus: "saved-local",
        lastPushDetail: "commit created; no remote configured",
        unsyncedCommits,
      },
    });
    appendAuditLog(getCortexPath(), "hook_stop", "status=saved-local");
    return;
  }

  const lastPushMarker = sessionMarker(getCortexPath(), "last-push");
  const DEBOUNCE_MS = 10_000;
  let shouldPush = true;
  try {
    const stat = fs.statSync(lastPushMarker);
    if (Date.now() - stat.mtimeMs < DEBOUNCE_MS) shouldPush = false;
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] hookStop lastPushMarker: ${errorMessage(err)}\n`);
  }

  if (!shouldPush) {
    const unsyncedCommits = await countUnsyncedCommits(getCortexPath());
    // Debounced: commit is saved locally, push will happen on the next non-debounced stop.
    updateRuntimeHealth(getCortexPath(), {
      lastStopAt: now,
      lastAutoSave: { at: now, status: "saved-local", detail: "commit saved; push debounced" },
      lastSync: {
        lastPushAt: now,
        lastPushStatus: "saved-local",
        lastPushDetail: "commit saved; push debounced",
        unsyncedCommits,
      },
    });
    appendAuditLog(getCortexPath(), "hook_stop", "status=saved-local detail=debounced");

    // Auto governance scheduling (non-blocking)
    scheduleWeeklyGovernance();
    return;
  }

  const push = await runBestEffortGit(["push"], getCortexPath());
  if (push.ok) {
    fs.writeFileSync(lastPushMarker, String(Date.now()));
    updateRuntimeHealth(getCortexPath(), {
      lastStopAt: now,
      lastAutoSave: { at: now, status: "saved-pushed", detail: "commit pushed" },
      lastSync: {
        lastPushAt: now,
        lastPushStatus: "saved-pushed",
        lastPushDetail: "commit pushed",
        unsyncedCommits: 0,
      },
    });
    appendAuditLog(getCortexPath(), "hook_stop", "status=saved-pushed");

    // Auto governance scheduling (non-blocking)
    scheduleWeeklyGovernance();
    return;
  }

  const unsyncedCommits = await countUnsyncedCommits(getCortexPath());
  updateRuntimeHealth(getCortexPath(), {
    lastStopAt: now,
    lastAutoSave: { at: now, status: "saved-local", detail: push.error || "push failed" },
    lastSync: {
      lastPushAt: now,
      lastPushStatus: "saved-local",
      lastPushDetail: push.error || "push failed",
      unsyncedCommits,
    },
  });
  appendAuditLog(getCortexPath(), "hook_stop", `status=saved-local detail=${JSON.stringify(push.error || "push failed")}`);
}

function scheduleWeeklyGovernance(): void {
  try {
    const lastGovPath = runtimeFile(getCortexPath(), "last-governance.txt");
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
    debugLog(`hook_stop: governance scheduling failed: ${errorMessage(err)}`);
  }
}

export async function handleHookContext() {
  if (!getHooksEnabledPreference(getCortexPath())) {
    process.exit(0);
  }

  let cwd = process.cwd();
  const ctxStdin = readStdinJson<{ cwd?: string }>();
  if (ctxStdin?.cwd) cwd = ctxStdin.cwd;

  const project = detectProject(getCortexPath(), cwd, profile);

  const db = await buildIndex(getCortexPath(), profile);
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
const COOLDOWN_MS = parseInt(process.env.CORTEX_AUTOCAPTURE_COOLDOWN_MS ?? "30000", 10);
const SESSION_CAP = parseInt(process.env.CORTEX_AUTOCAPTURE_SESSION_CAP ?? "10", 10);

interface ToolLogEntry {
  at: string;
  session_id?: string;
  tool: string;
  file?: string;
  command?: string;
  error?: string;
}

export async function handleHookTool() {
  if (!getHooksEnabledPreference(getCortexPath())) {
    process.exit(0);
  }

  try {
    const start = Date.now();

    let raw = "";
    if (!process.stdin.isTTY) {
      try {
        raw = fs.readFileSync(0, "utf-8");
      } catch (err: unknown) {
        if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] hookTool stdinRead: ${errorMessage(err)}\n`);
        process.exit(0);
      }
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch (err: unknown) {
      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] hookTool stdinParse: ${errorMessage(err)}\n`);
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
      const logFile = runtimeFile(getCortexPath(), "tool-log.jsonl");
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, JSON.stringify(entry) + "\n");
    } catch (err: unknown) {
      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] hookTool toolLog: ${errorMessage(err)}\n`);
    }

    const cwd: string | undefined = (data.cwd ?? input.cwd ?? undefined) as string | undefined;
    let activeProject = cwd ? detectProject(getCortexPath(), cwd, profile) : null;

    const cooldownFile = runtimeFile(getCortexPath(), "hook-tool-cooldown");
    try {
      if (fs.existsSync(cooldownFile)) {
        const age = Date.now() - fs.statSync(cooldownFile).mtimeMs;
        if (age < COOLDOWN_MS) {
          debugLog(`hook-tool: cooldown active (${Math.round(age / 1000)}s < ${Math.round(COOLDOWN_MS / 1000)}s), skipping extraction`);
          activeProject = null;
        }
      }
    } catch (err: unknown) {
      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] hookTool cooldownStat: ${errorMessage(err)}\n`);
    }

    if (activeProject && sessionId) {
      try {
        const capFile = sessionMarker(getCortexPath(), `tool-findings-${sessionId}`);
        let count = 0;
        if (fs.existsSync(capFile)) {
          count = Number.parseInt(fs.readFileSync(capFile, "utf8").trim(), 10) || 0;
        }
        if (count >= SESSION_CAP) {
          debugLog(`hook-tool: session cap reached (${count}/${SESSION_CAP}), skipping extraction`);
          activeProject = null;
        }
      } catch (err: unknown) {
        if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] hookTool sessionCapCheck: ${errorMessage(err)}\n`);
      }
    }

    if (activeProject) {
      try {
        const candidates = extractToolFindings(toolName, input, responseStr);
        for (const { text, confidence } of candidates) {
          // Queue all candidates for review rather than auto-promoting to FINDINGS.md;
          // requires human review and provenance confirmation before promotion.
          appendReviewQueue(getCortexPath(), activeProject, "Review", [text]);
          debugLog(`hook-tool: queued candidate for review (conf=${confidence}): ${text.slice(0, 60)}`);
        }

        if (candidates.length > 0) {
          try { fs.writeFileSync(cooldownFile, Date.now().toString()); } catch (err: unknown) {
            if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] hookTool cooldownWrite: ${errorMessage(err)}\n`);
          }
          if (sessionId) {
            try {
              const capFile = sessionMarker(getCortexPath(), `tool-findings-${sessionId}`);
              let count = 0;
              try { count = Number.parseInt(fs.readFileSync(capFile, "utf8").trim(), 10) || 0; } catch (err: unknown) {
                if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] hookTool capFileRead: ${errorMessage(err)}\n`);
              }
              count += candidates.length;
              fs.writeFileSync(capFile, count.toString());
            } catch (err: unknown) {
              if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] hookTool capFileWrite: ${errorMessage(err)}\n`);
            }
          }
        }
      } catch (err: unknown) {
        debugLog(`hook-tool: finding extraction failed: ${errorMessage(err)}`);
      }
    }

    const elapsed = Date.now() - start;
    debugLog(`hook-tool: ${toolName} logged in ${elapsed}ms`);
    process.exit(0);
  } catch (err: unknown) {
    debugLog(`hook-tool: unhandled error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
    process.exit(0);
  }
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
