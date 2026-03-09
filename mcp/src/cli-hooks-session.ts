import {
  debugLog,
  appendAuditLog,
  runtimeFile,
  qualityMarkers,
  sessionMarker,
  EXEC_TIMEOUT_MS,
  getCortexPath,
  homePath,
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
  autoMergeConflicts,
  mergeBacklog,
  mergeFindings,
} from "./shared-content.js";
import { runGit, isFeatureEnabled, errorMessage } from "./utils.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync, spawn } from "child_process";
import { fileURLToPath } from "url";
import { runDoctor } from "./link.js";
import { getHooksEnabledPreference } from "./init.js";
import { detectProjectDir, isProjectTracked } from "./init-setup.js";
import { isToolHookEnabled } from "./hooks.js";
import { appendFindingJournal } from "./finding-journal.js";
import { bootstrapCortexDotEnv } from "./cortex-dotenv.js";
import {
  buildIndex,
  queryRows,
} from "./shared-index.js";
import type { SelectedSnippet } from "./shared-retrieval.js";
import { filterBacklogByPriority } from "./shared-retrieval.js";
import { resolveRuntimeProfile } from "./runtime-profile.js";

function getRuntimeProfile(): string {
  return resolveRuntimeProfile(getCortexPath());
}

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
    path.resolve(homePath(".claude")),
    path.resolve(homePath(".config", "claude")),
  ];
  return safePrefixes.some(prefix => normalized.startsWith(prefix + path.sep) || normalized === prefix);
}

export function getUntrackedProjectNotice(cortexPath: string, cwd: string): string | null {
  const profile = resolveRuntimeProfile(cortexPath);
  const projectDir = detectProjectDir(cwd, cortexPath);
  if (!projectDir) return null;
  const projectName = path.basename(projectDir).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  if (isProjectTracked(cortexPath, projectName, profile || undefined)) return null;
  return [
    "<cortex-notice>",
    "This project directory is not tracked by cortex.",
    "Ask the user whether they want to add it to cortex.",
    `If they say yes, use the \`add_project\` MCP tool with path="${projectDir}" or run \`cortex add\` from that directory.`,
    "</cortex-notice>",
    "",
  ].join("\n");
}

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
  selected: SelectedSnippet[]
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

function scheduleBackgroundSync(cortexPathLocal: string): boolean {
  const lockPath = runtimeFile(cortexPathLocal, "background-sync.lock");
  const logPath = runtimeFile(cortexPathLocal, "background-sync.log");
  const spawnArgs = resolveSubprocessArgs("background-sync");
  if (!spawnArgs) return false;

  try {
    if (fs.existsSync(lockPath)) {
      const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
      if (ageMs <= 10 * 60 * 1000) return false;
      fs.unlinkSync(lockPath);
    }
  } catch (err: unknown) {
    debugLog(`scheduleBackgroundSync: lock check failed: ${errorMessage(err)}`);
    return false;
  }

  try {
    fs.writeFileSync(lockPath, JSON.stringify({ startedAt: new Date().toISOString(), pid: process.pid }) + "\n", { flag: "wx" });
    const logFd = fs.openSync(logPath, "a");
    fs.writeSync(logFd, `[${new Date().toISOString()}] spawn ${process.execPath} ${spawnArgs.join(" ")}\n`);
    const child = spawn(process.execPath, spawnArgs, {
      cwd: process.cwd(),
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        CORTEX_PATH: cortexPathLocal,
        CORTEX_PROFILE: getRuntimeProfile(),
      },
    });
    child.unref();
    fs.closeSync(logFd);
    return true;
  } catch (err: unknown) {
    try { fs.unlinkSync(lockPath); } catch {}
    debugLog(`scheduleBackgroundSync: spawn failed: ${errorMessage(err)}`);
    return false;
  }
}

function scheduleBackgroundMaintenance(cortexPathLocal: string, project?: string): boolean {
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
        CORTEX_PROFILE: getRuntimeProfile(),
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

function isMergeableMarkdown(relPath: string): boolean {
  const filename = path.basename(relPath).toLowerCase();
  return filename === "findings.md" || filename === "backlog.md";
}

async function snapshotLocalMergeableFiles(cwd: string): Promise<Map<string, string>> {
  const upstream = await runBestEffortGit(["rev-parse", "--abbrev-ref", "@{upstream}"], cwd);
  if (!upstream.ok || !upstream.output) return new Map();
  const changed = await runBestEffortGit(["diff", "--name-only", `${upstream.output.trim()}..HEAD`], cwd);
  if (!changed.ok || !changed.output) return new Map();

  const snapshots = new Map<string, string>();
  for (const relPath of changed.output.split("\n").map((line) => line.trim()).filter(Boolean)) {
    if (!isMergeableMarkdown(relPath)) continue;
    const fullPath = path.join(cwd, relPath);
    if (!fs.existsSync(fullPath)) continue;
    snapshots.set(relPath, fs.readFileSync(fullPath, "utf8"));
  }
  return snapshots;
}

async function reconcileMergeableFiles(cwd: string, snapshots: Map<string, string>): Promise<boolean> {
  let changedAny = false;

  for (const [relPath, localBeforePull] of snapshots.entries()) {
    const fullPath = path.join(cwd, relPath);
    if (!fs.existsSync(fullPath)) continue;
    const current = fs.readFileSync(fullPath, "utf8");
    const filename = path.basename(relPath).toLowerCase();
    const merged = filename === "findings.md"
      ? mergeFindings(current, localBeforePull)
      : mergeBacklog(current, localBeforePull);
    if (merged === current) continue;
    fs.writeFileSync(fullPath, merged);
    changedAny = true;
  }

  if (!changedAny) return false;

  const add = await runBestEffortGit(["add", "--", ...snapshots.keys()], cwd);
  if (!add.ok) return false;
  const commit = await runBestEffortGit(["commit", "-m", "auto-merge markdown recovery"], cwd);
  return commit.ok;
}

async function recoverPushConflict(cwd: string): Promise<{ ok: boolean; detail: string; pullStatus: "ok" | "error"; pullDetail: string }> {
  const localSnapshots = await snapshotLocalMergeableFiles(cwd);
  const pull = await runBestEffortGit(["pull", "--rebase", "--quiet"], cwd);
  if (pull.ok) {
    const reconciled = await reconcileMergeableFiles(cwd, localSnapshots);
    const retryPush = await runBestEffortGit(["push"], cwd);
    return {
      ok: retryPush.ok,
      detail: retryPush.ok
        ? (reconciled ? "commit pushed after pull --rebase and markdown reconciliation" : "commit pushed after pull --rebase")
        : (retryPush.error || "push failed after pull --rebase"),
      pullStatus: "ok",
      pullDetail: pull.output || "pull --rebase ok",
    };
  }

  const conflicted = await runBestEffortGit(["diff", "--name-only", "--diff-filter=U"], cwd);
  const conflictedOutput = conflicted.output?.trim() || "";
  if (!conflicted.ok || !conflictedOutput) {
    await runBestEffortGit(["rebase", "--abort"], cwd);
    return {
      ok: false,
      detail: pull.error || "pull --rebase failed",
      pullStatus: "error",
      pullDetail: pull.error || "pull --rebase failed",
    };
  }

  if (!autoMergeConflicts(cwd)) {
    await runBestEffortGit(["rebase", "--abort"], cwd);
    return {
      ok: false,
      detail: `rebase conflicts require manual resolution: ${conflictedOutput}`,
      pullStatus: "error",
      pullDetail: `rebase conflicts require manual resolution: ${conflictedOutput}`,
    };
  }

  const continued = await runBestEffortGit(["-c", "core.editor=true", "rebase", "--continue"], cwd);
  if (!continued.ok) {
    await runBestEffortGit(["rebase", "--abort"], cwd);
    return {
      ok: false,
      detail: continued.error || "rebase --continue failed",
      pullStatus: "error",
      pullDetail: continued.error || "rebase --continue failed",
    };
  }

  const retryPush = await runBestEffortGit(["push"], cwd);
  return {
    ok: retryPush.ok,
    detail: retryPush.ok ? "commit pushed after auto-merge recovery" : (retryPush.error || "push failed after auto-merge recovery"),
    pullStatus: "ok",
    pullDetail: "pull --rebase recovered via auto-merge",
  };
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

  // Untracked project detection: suggest `cortex add` if CWD looks like a project but isn't tracked
  try {
    const cortexPath = getCortexPath();
    if (cortexPath) {
      const cwd = process.cwd();
      const notice = getUntrackedProjectNotice(cortexPath, cwd);
      if (notice) {
        process.stdout.write(notice);
        debugLog(`untracked project detected at ${cwd}`);
      }
    }
  } catch (err: unknown) {
    debugLog(`untracked project detection failed: ${errorMessage(err)}`);
  }
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

export async function handleHookStop() {
  const now = new Date().toISOString();
  bootstrapCortexDotEnv(getCortexPath());
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
        const activeProject = detectProject(getCortexPath(), cwd, getRuntimeProfile());
        if (activeProject) {
          const insights = extractConversationInsights(captureInput);
          for (const insight of insights) {
            appendFindingJournal(getCortexPath(), activeProject, `[pattern] ${insight}`, {
              sessionId: `hook-stop-${Date.now()}`,
            });
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
  let commitMsg = "auto-save cortex";
  if (add.ok) {
    const diff = await runBestEffortGit(["diff", "--cached", "--stat", "--no-color"], getCortexPath());
    if (diff.ok && diff.output) {
      // Parse "project/file.md | 3 +++" lines into project names and file types
      const changes = new Map<string, Set<string>>();
      for (const line of diff.output.split("\n")) {
        const m = line.match(/^\s*([^/]+)\/([^|]+)\s*\|/);
        if (!m) continue;
        const proj = m[1].trim();
        if (proj.startsWith(".")) continue; // skip .governance, .runtime, etc.
        const file = m[2].trim();
        if (!changes.has(proj)) changes.set(proj, new Set());
        if (/findings/i.test(file)) changes.get(proj)!.add("findings");
        else if (/backlog/i.test(file)) changes.get(proj)!.add("backlog");
        else if (/CLAUDE/i.test(file)) changes.get(proj)!.add("config");
        else if (/summary/i.test(file)) changes.get(proj)!.add("summary");
        else if (/skill/i.test(file)) changes.get(proj)!.add("skills");
        else if (/reference/i.test(file)) changes.get(proj)!.add("reference");
        else changes.get(proj)!.add("update");
      }
      if (changes.size > 0) {
        const parts = [...changes.entries()].map(([proj, types]) => `${proj}(${[...types].join(",")})`);
        commitMsg = `cortex: ${parts.join(" ")}`;
      }
    }
  }
  const commit = add.ok ? await runBestEffortGit(["commit", "-m", commitMsg], getCortexPath()) : { ok: false, error: add.error };
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
  const unsyncedCommits = await countUnsyncedCommits(getCortexPath());
  const scheduled = scheduleBackgroundSync(getCortexPath());
  const syncDetail = scheduled
    ? "commit saved; background sync scheduled"
    : "commit saved; background sync already running";
  updateRuntimeHealth(getCortexPath(), {
    lastStopAt: now,
    lastAutoSave: { at: now, status: "saved-local", detail: syncDetail },
    lastSync: {
      lastPushAt: now,
      lastPushStatus: "saved-local",
      lastPushDetail: syncDetail,
      unsyncedCommits,
    },
  });
  appendAuditLog(getCortexPath(), "hook_stop", `status=saved-local detail=${JSON.stringify(syncDetail)}`);

  // Auto governance scheduling (non-blocking)
  scheduleWeeklyGovernance();
}

export async function handleBackgroundSync() {
  const cortexPathLocal = getCortexPath();
  const now = new Date().toISOString();
  const lockPath = runtimeFile(cortexPathLocal, "background-sync.lock");

  try {
    const remotes = await runBestEffortGit(["remote"], cortexPathLocal);
    if (!remotes.ok || !remotes.output) {
      const unsyncedCommits = await countUnsyncedCommits(cortexPathLocal);
      updateRuntimeHealth(cortexPathLocal, {
        lastAutoSave: { at: now, status: "saved-local", detail: "background sync skipped; no remote configured" },
        lastSync: {
          lastPushAt: now,
          lastPushStatus: "saved-local",
          lastPushDetail: "background sync skipped; no remote configured",
          unsyncedCommits,
        },
      });
      appendAuditLog(cortexPathLocal, "background_sync", "status=saved-local detail=no_remote");
      return;
    }

    const push = await runBestEffortGit(["push"], cortexPathLocal);
    if (push.ok) {
      updateRuntimeHealth(cortexPathLocal, {
        lastAutoSave: { at: now, status: "saved-pushed", detail: "commit pushed by background sync" },
        lastSync: {
          lastPushAt: now,
          lastPushStatus: "saved-pushed",
          lastPushDetail: "commit pushed by background sync",
          unsyncedCommits: 0,
        },
      });
      appendAuditLog(cortexPathLocal, "background_sync", "status=saved-pushed");
      return;
    }

    const recovered = await recoverPushConflict(cortexPathLocal);
    if (recovered.ok) {
      updateRuntimeHealth(cortexPathLocal, {
        lastAutoSave: { at: now, status: "saved-pushed", detail: recovered.detail },
        lastSync: {
          lastPullAt: now,
          lastPullStatus: recovered.pullStatus,
          lastPullDetail: recovered.pullDetail,
          lastSuccessfulPullAt: now,
          lastPushAt: now,
          lastPushStatus: "saved-pushed",
          lastPushDetail: recovered.detail,
          unsyncedCommits: 0,
        },
      });
      appendAuditLog(cortexPathLocal, "background_sync", `status=saved-pushed detail=${JSON.stringify(recovered.detail)}`);
      return;
    }

    const unsyncedCommits = await countUnsyncedCommits(cortexPathLocal);
    updateRuntimeHealth(cortexPathLocal, {
      lastAutoSave: { at: now, status: "saved-local", detail: recovered.detail || push.error || "background sync push failed" },
      lastSync: {
        lastPullAt: now,
        lastPullStatus: recovered.pullStatus,
        lastPullDetail: recovered.pullDetail,
        lastPushAt: now,
        lastPushStatus: "saved-local",
        lastPushDetail: recovered.detail || push.error || "background sync push failed",
        unsyncedCommits,
      },
    });
    appendAuditLog(cortexPathLocal, "background_sync", `status=saved-local detail=${JSON.stringify(recovered.detail || push.error || "background sync push failed")}`);
  } finally {
    try { fs.unlinkSync(lockPath); } catch {}
  }
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

  const project = detectProject(getCortexPath(), cwd, getRuntimeProfile());

  const db = await buildIndex(getCortexPath(), getRuntimeProfile());
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
    let activeProject = cwd ? detectProject(getCortexPath(), cwd, getRuntimeProfile()) : null;

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
