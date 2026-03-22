/**
 * Stop hook handler: git commit/push, background sync, auto-capture, governance.
 * Extracted from cli-hooks-session.ts for modularity.
 */
import {
  buildHookContext,
  handleGuardSkip,
  debugLog,
  runtimeFile,
  sessionMarker,
  getPhrenPath,
  updateRuntimeHealth,
  appendAuditLog,
  withFileLock,
  getWorkflowPolicy,
  isProjectHookEnabled,
  ensureLocalGitRepo,
  getProactivityLevelForTask,
  getProactivityLevelForFindings,
  hasExplicitFindingSignal,
  shouldAutoCaptureFindingsForLevel,
  FINDING_SENSITIVITY_CONFIG,
  isFeatureEnabled,
  errorMessage,
  bootstrapPhrenDotEnv,
  finalizeTaskSession,
  appendFindingJournal,
  homePath,
  resolveRuntimeProfile,
} from "./hooks-context.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn } from "child_process";
import {
  resolveSubprocessArgs as _resolveSubprocessArgs,
  runBestEffortGit,
  countUnsyncedCommits,
  recoverPushConflict,
} from "./cli-hooks-git.js";
import { logDebug } from "./logger.js";

function getRuntimeProfile(): string {
  return resolveRuntimeProfile(getPhrenPath());
}

/** Read JSON from stdin if it's not a TTY. Returns null if stdin is a TTY or parsing fails. */
export function readStdinJson<T>(): T | null {
  if (process.stdin.isTTY) return null;
  try {
    return JSON.parse(fs.readFileSync(0, "utf-8")) as T;
  } catch (err: unknown) {
    logDebug("readStdinJson", errorMessage(err));
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

    if (INSIGHT_KEYWORD_RE.test(trimmed) || hasExplicitFindingSignal(trimmed)) {
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

export function filterConversationInsightsForProactivity(
  insights: string[],
  level = getProactivityLevelForFindings(getPhrenPath())
): string[] {
  if (level === "high") return insights;
  return insights.filter((insight) => shouldAutoCaptureFindingsForLevel(level, insight));
}

export function getSessionCap(): number {
  if (process.env.PHREN_AUTOCAPTURE_SESSION_CAP) {
    return parseInt(process.env.PHREN_AUTOCAPTURE_SESSION_CAP, 10);
  }
  try {
    const policy = getWorkflowPolicy(getPhrenPath());
    const sensitivity = policy.findingSensitivity ?? "balanced";
    return FINDING_SENSITIVITY_CONFIG[sensitivity]?.sessionCap ?? 10;
  } catch {
    return 10;
  }
}

function scheduleBackgroundSync(phrenPathLocal: string): boolean {
  const lockPath = runtimeFile(phrenPathLocal, "background-sync.lock");
  const logPath = runtimeFile(phrenPathLocal, "background-sync.log");
  const spawnArgs = _resolveSubprocessArgs("background-sync");
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
        PHREN_PATH: phrenPathLocal,
        PHREN_PROFILE: getRuntimeProfile(),
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

function scheduleWeeklyGovernance(): void {
  try {
    const lastGovPath = runtimeFile(getPhrenPath(), "last-governance.txt");
    const lastRun = fs.existsSync(lastGovPath) ? parseInt(fs.readFileSync(lastGovPath, "utf8"), 10) : 0;
    const daysSince = (Date.now() - lastRun) / 86_400_000;
    if (daysSince >= 7) {
      const spawnArgs = _resolveSubprocessArgs("background-maintenance");
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

export async function handleHookStop() {
  const ctx = buildHookContext();
  const { phrenPath, activeProject, manifest } = ctx;
  const now = new Date().toISOString();
  bootstrapPhrenDotEnv(phrenPath);

  if (!ctx.hooksEnabled) {
    handleGuardSkip(ctx, "hook_stop", "disabled", {
      lastStopAt: now,
      lastAutoSave: { at: now, status: "clean", detail: "hooks disabled by preference" },
    });
    return;
  }
  if (!ctx.toolHookEnabled) {
    handleGuardSkip(ctx, "hook_stop", `tool_disabled tool=${ctx.hookTool}`);
    return;
  }
  if (!isProjectHookEnabled(phrenPath, activeProject, "Stop")) {
    handleGuardSkip(ctx, "hook_stop", `project_disabled project=${activeProject}`, {
      lastStopAt: now,
      lastAutoSave: { at: now, status: "clean", detail: `hooks disabled for project ${activeProject}` },
    });
    return;
  }

  // Read stdin early — it's a stream and can only be consumed once.
  // Needed for auto-capture transcript_path parsing.
  const stdinPayload = readStdinJson<{ transcript_path?: string; session_id?: string }>();
  const taskSessionId = typeof stdinPayload?.session_id === "string" ? stdinPayload.session_id : undefined;
  const taskLevel = getProactivityLevelForTask(phrenPath);
  if (taskSessionId && taskLevel !== "high") {
    debugLog(`hook-stop task proactivity=${taskLevel}`);
  }

  // Auto-capture BEFORE git operations so captured insights get committed and pushed.
  // Gated behind PHREN_FEATURE_AUTO_CAPTURE=1.
  const findingsLevel = getProactivityLevelForFindings(phrenPath);
  if (isFeatureEnabled("PHREN_FEATURE_AUTO_CAPTURE", false) && findingsLevel !== "low") {
    try {
      let captureInput = process.env.PHREN_CONVERSATION_CONTEXT || "";
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
              logDebug("hookStop transcriptParse", errorMessage(err));
            }
          }
          captureInput = assistantTexts.join("\n");
        }
      }
      if (captureInput) {
        if (activeProject) {
          // Check session cap before extracting — same guard as PostToolUse hook
          let capReached = false;
          if (taskSessionId) {
            try {
              const capFile = sessionMarker(phrenPath, `tool-findings-${taskSessionId}`);
              let count = 0;
              if (fs.existsSync(capFile)) {
                count = Number.parseInt(fs.readFileSync(capFile, "utf8").trim(), 10) || 0;
              }
              const cap = getSessionCap();
              if (count >= cap) {
                debugLog(`hook-stop: session cap reached (${count}/${cap}), skipping extraction`);
                capReached = true;
              }
            } catch (err: unknown) {
              logDebug("hookStop sessionCapCheck", errorMessage(err));
            }
          }
          if (!capReached) {
            const insights = filterConversationInsightsForProactivity(extractConversationInsights(captureInput), findingsLevel);
            for (const insight of insights) {
              appendFindingJournal(phrenPath, activeProject, `[pattern] ${insight}`, {
                source: "hook",
                sessionId: `hook-stop-${Date.now()}`,
              });
              debugLog(`auto-capture: saved insight for ${activeProject}: ${insight.slice(0, 60)}`);
            }
          }
        }
      }
    } catch (err: unknown) {
      debugLog(`auto-capture failed: ${errorMessage(err)}`);
    }
  } else if (isFeatureEnabled("PHREN_FEATURE_AUTO_CAPTURE", false)) {
    debugLog("auto-capture: skipped because findings proactivity is low");
  }

  // Wrap git operations in a file lock to prevent concurrent agents from fighting
  const gitOpLockPath = path.join(phrenPath, ".runtime", "git-op");
  await withFileLock(gitOpLockPath, async () => {

  if (manifest?.installMode === "project-local") {
    updateRuntimeHealth(phrenPath, {
      lastStopAt: now,
      lastAutoSave: { at: now, status: "saved-local", detail: "project-local mode writes files only" },
      lastSync: {
        lastPushAt: now,
        lastPushStatus: "saved-local",
        lastPushDetail: "project-local mode does not manage git sync",
      },
    });
    appendAuditLog(phrenPath, "hook_stop", "status=skipped-local");
    return;
  }

  const gitRepo = ensureLocalGitRepo(phrenPath);
  if (!gitRepo.ok) {
    finalizeTaskSession({
      phrenPath,
      sessionId: taskSessionId,
      status: "error",
      detail: gitRepo.detail,
    });
    updateRuntimeHealth(phrenPath, {
      lastStopAt: now,
      lastAutoSave: { at: now, status: "error", detail: gitRepo.detail },
      lastSync: {
        lastPushAt: now,
        lastPushStatus: "error",
        lastPushDetail: gitRepo.detail,
      },
    });
    appendAuditLog(phrenPath, "hook_stop", `status=error detail=${JSON.stringify(gitRepo.detail)}`);
    return;
  }

  const status = await runBestEffortGit(["status", "--porcelain"], phrenPath);
  if (!status.ok) {
    finalizeTaskSession({
      phrenPath,
      sessionId: taskSessionId,
      status: "error",
      detail: status.error || "git status failed",
    });
    updateRuntimeHealth(phrenPath, {
      lastStopAt: now,
      lastAutoSave: { at: now, status: "error", detail: status.error || "git status failed" },
      lastSync: {
        lastPushAt: now,
        lastPushStatus: "error",
        lastPushDetail: status.error || "git status failed",
      },
    });
    appendAuditLog(phrenPath, "hook_stop", `status=error detail=${JSON.stringify(status.error || "git status failed")}`);
    return;
  }

  if (!status.output) {
    updateRuntimeHealth(phrenPath, {
      lastStopAt: now,
      lastAutoSave: { at: now, status: "clean", detail: "no changes" },
      lastSync: {
        lastPushAt: now,
        lastPushStatus: "saved-pushed",
        lastPushDetail: "no changes",
        unsyncedCommits: 0,
      },
    });
    appendAuditLog(phrenPath, "hook_stop", "status=clean");
    return;
  }

  // Stage all changes first, then unstage any sensitive files that slipped
  // through. Using pathspec exclusions with `git add -A` can fail when
  // excluded paths are also gitignored (git treats the pathspec as an error).
  let add = await runBestEffortGit(["add", "-A"], phrenPath);
  if (add.ok) {
    // Belt-and-suspenders: unstage sensitive files that .gitignore should
    // already block. Failures here are non-fatal (files may not exist).
    await runBestEffortGit(["reset", "HEAD", "--", ".env", "**/.env", "*.pem", "*.key"], phrenPath);
  }
  let commitMsg = "auto-save phren";
  if (add.ok) {
    const diff = await runBestEffortGit(["diff", "--cached", "--stat", "--no-color"], phrenPath);
    if (diff.ok && diff.output) {
      // Parse "project/file.md | 3 +++" lines into project names and file types
      const changes = new Map<string, Set<string>>();
      for (const line of diff.output.split("\n")) {
        const m = line.match(/^\s*([^/]+)\/([^|]+)\s*\|/);
        if (!m) continue;
        const proj = m[1].trim();
        if (proj.startsWith(".")) continue; // skip .config, .runtime, etc.
        const file = m[2].trim();
        if (!changes.has(proj)) changes.set(proj, new Set());
        if (/findings/i.test(file)) changes.get(proj)!.add("findings");
        else if (/tasks/i.test(file)) changes.get(proj)!.add("task");
        else if (/CLAUDE/i.test(file)) changes.get(proj)!.add("config");
        else if (/summary/i.test(file)) changes.get(proj)!.add("summary");
        else if (/skill/i.test(file)) changes.get(proj)!.add("skills");
        else if (/reference/i.test(file)) changes.get(proj)!.add("reference");
        else changes.get(proj)!.add("update");
      }
      if (changes.size > 0) {
        const parts = [...changes.entries()].map(([proj, types]) => `${proj}(${[...types].join(",")})`);
        commitMsg = `phren: ${parts.join(" ")}`;
      }
    }
  }
  const commit = add.ok ? await runBestEffortGit(["commit", "-m", commitMsg], phrenPath) : { ok: false, error: add.error };
  if (!add.ok || !commit.ok) {
    finalizeTaskSession({
      phrenPath,
      sessionId: taskSessionId,
      status: "error",
      detail: add.error || commit.error || "git add/commit failed",
    });
    updateRuntimeHealth(phrenPath, {
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
    appendAuditLog(phrenPath, "hook_stop", `status=error detail=${JSON.stringify(add.error || commit.error || "git add/commit failed")}`);
    return;
  }

  const remotes = await runBestEffortGit(["remote"], phrenPath);
  if (!remotes.ok || !remotes.output) {
    finalizeTaskSession({
      phrenPath,
      sessionId: taskSessionId,
      status: "saved-local",
      detail: "commit created; no remote configured",
    });
    const unsyncedCommits = await countUnsyncedCommits(phrenPath);
    updateRuntimeHealth(phrenPath, {
      lastStopAt: now,
      lastAutoSave: { at: now, status: "saved-local", detail: "commit created; no remote configured" },
      lastSync: {
        lastPushAt: now,
        lastPushStatus: "saved-local",
        lastPushDetail: "commit created; no remote configured",
        unsyncedCommits,
      },
    });
    appendAuditLog(phrenPath, "hook_stop", "status=saved-local");
    return;
  }
  const unsyncedCommits = await countUnsyncedCommits(phrenPath);
  const scheduled = scheduleBackgroundSync(phrenPath);
  const syncDetail = scheduled
    ? "commit saved; background sync scheduled"
    : "commit saved; background sync already running";
  finalizeTaskSession({
    phrenPath,
    sessionId: taskSessionId,
    status: "saved-local",
    detail: syncDetail,
  });
  updateRuntimeHealth(phrenPath, {
    lastStopAt: now,
    lastAutoSave: { at: now, status: "saved-local", detail: syncDetail },
    lastSync: {
      lastPushAt: now,
      lastPushStatus: "saved-local",
      lastPushDetail: syncDetail,
      unsyncedCommits,
    },
  });
  appendAuditLog(phrenPath, "hook_stop", `status=saved-local detail=${JSON.stringify(syncDetail)}`);

  }); // end withFileLock(gitOpLockPath)

  // Auto governance scheduling (non-blocking)
  scheduleWeeklyGovernance();
}

export async function handleBackgroundSync() {
  const phrenPathLocal = getPhrenPath();
  const now = new Date().toISOString();
  const lockPath = runtimeFile(phrenPathLocal, "background-sync.lock");

  try {
    const remotes = await runBestEffortGit(["remote"], phrenPathLocal);
    if (!remotes.ok || !remotes.output) {
      const unsyncedCommits = await countUnsyncedCommits(phrenPathLocal);
      updateRuntimeHealth(phrenPathLocal, {
        lastAutoSave: { at: now, status: "saved-local", detail: "background sync skipped; no remote configured" },
        lastSync: {
          lastPushAt: now,
          lastPushStatus: "saved-local",
          lastPushDetail: "background sync skipped; no remote configured",
          unsyncedCommits,
        },
      });
      appendAuditLog(phrenPathLocal, "background_sync", "status=saved-local detail=no_remote");
      return;
    }

    const push = await runBestEffortGit(["push"], phrenPathLocal);
    if (push.ok) {
      updateRuntimeHealth(phrenPathLocal, {
        lastAutoSave: { at: now, status: "saved-pushed", detail: "commit pushed by background sync" },
        lastSync: {
          lastPushAt: now,
          lastPushStatus: "saved-pushed",
          lastPushDetail: "commit pushed by background sync",
          unsyncedCommits: 0,
        },
      });
      appendAuditLog(phrenPathLocal, "background_sync", "status=saved-pushed");
      return;
    }

    const recovered = await recoverPushConflict(phrenPathLocal);
    if (recovered.ok) {
      updateRuntimeHealth(phrenPathLocal, {
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
      appendAuditLog(phrenPathLocal, "background_sync", `status=saved-pushed detail=${JSON.stringify(recovered.detail)}`);
      return;
    }

    const unsyncedCommits = await countUnsyncedCommits(phrenPathLocal);
    updateRuntimeHealth(phrenPathLocal, {
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
    appendAuditLog(phrenPathLocal, "background_sync", `status=saved-local detail=${JSON.stringify(recovered.detail || push.error || "background sync push failed")}`);
  } finally {
    try { fs.unlinkSync(lockPath); } catch {}
  }
}
