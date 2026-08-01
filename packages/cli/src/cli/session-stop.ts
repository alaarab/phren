/**
 * Session stop hook handler, background sync, and conversation capture.
 * Extracted from hooks-session.ts for modularity.
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  buildHookContext,
  handleGuardSkip,
  debugLog,
  appendAuditLog,
  runtimeFile,
  sessionMarker,
  getPhrenPath,
  updateRuntimeHealth,
  withFileLock,
  getWorkflowPolicy,
  getProactivityLevelForTask,
  getProactivityLevelForFindings,
  hasExplicitFindingSignal,
  shouldAutoCaptureFindingsForLevel,
  FINDING_SENSITIVITY_CONFIG,
  isFeatureEnabled,
  errorMessage,
  homePath,
  isProjectHookEnabled,
  ensureLocalGitRepo,
  bootstrapPhrenDotEnv,
  finalizeTaskSession,
  appendFindingJournal,
} from "./hooks-context.js";
import { logger } from "../logger.js";
import {
  runBestEffortGit,
  countUnsyncedCommits,
  recoverPushConflict,
  hasUnrelatedHistories,
} from "./session-git.js";
import {
  assessSyncOutage,
  getRuntimeHealth,
  type AutoSaveStatus,
  type PushStatus,
  type SyncStatus,
} from "../shared/governance.js";
import {
  resolveSubprocessArgs,
  scheduleBackgroundSync,
} from "./session-background.js";
import { spawnDetachedChild } from "../shared/process.js";
import { resolveManagementCapabilities } from "../init/management-preset.js";

// ── Utility ─────────────────────────────────────────────────────────────────

/** Read JSON from stdin if it's not a TTY. Returns null if stdin is a TTY or parsing fails. */
function readStdinJson<T>(): T | null {
  if (process.stdin.isTTY) return null;
  try {
    return JSON.parse(fs.readFileSync(0, "utf-8")) as T;
  } catch (err: unknown) {
    logger.debug("hooks-session", `readStdinJson: ${errorMessage(err)}`);
    return null;
  }
}

/** Validate that a transcript path points to a safe, expected location. */
function isSafeTranscriptPath(p: string): boolean {
  let normalized: string;
  try {
    normalized = fs.realpathSync.native(p);
  } catch {
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

// ── Conversation memory capture ─────────────────────────────────────────────

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

// ── Sync failure accounting ─────────────────────────────────────────────────

const SYNC_WARN_MARKER = "sync-outage-warned-v1";
/** Re-warn at most once a day, so a broken store nags without spamming. */
const SYNC_WARN_INTERVAL_MS = 86_400_000;

/**
 * Build the `lastSync` patch for a sync attempt, carrying the failure streak
 * forward. Success resets the counter and stamps `lastSuccessfulPushAt`;
 * failure increments it. Without this the runtime health file only ever showed
 * the most recent attempt, so "failed once" and "failed for two months" looked
 * identical.
 */
export function nextSyncStatus(
  previous: SyncStatus | undefined,
  patch: Omit<SyncStatus, "consecutiveFailures" | "lastSuccessfulPushAt"> & { lastPushStatus: PushStatus },
  now: string,
): SyncStatus {
  const failed = ["pull-failed", "push-failed", "unrelated-histories", "error"].includes(patch.lastPushStatus);
  if (failed) {
    return {
      ...patch,
      consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
      ...(previous?.lastSuccessfulPushAt ? { lastSuccessfulPushAt: previous.lastSuccessfulPushAt } : {}),
    };
  }
  const reachedRemote = patch.lastPushStatus === "saved-pushed";
  return {
    ...patch,
    consecutiveFailures: 0,
    ...(reachedRemote
      ? { lastSuccessfulPushAt: now }
      : previous?.lastSuccessfulPushAt
        ? { lastSuccessfulPushAt: previous.lastSuccessfulPushAt }
        : {}),
  };
}

/**
 * Tell the user, on stdout, that their store has stopped syncing. The Stop hook
 * is the only place that runs on every turn, so silence here is what let a
 * two-month outage go unnoticed. Rate-limited via a marker file.
 */
function warnIfSyncDegraded(phrenPath: string): void {
  try {
    const assessment = assessSyncOutage(getRuntimeHealth(phrenPath).lastSync);
    if (!assessment.degraded) return;

    const markerPath = sessionMarker(phrenPath, SYNC_WARN_MARKER);
    try {
      const lastWarned = Date.parse(fs.readFileSync(markerPath, "utf8").trim());
      if (!Number.isNaN(lastWarned) && Date.now() - lastWarned < SYNC_WARN_INTERVAL_MS) return;
    } catch {
      // No marker yet (or unreadable) — warn.
    }

    process.stdout.write([
      "<phren-notice>",
      assessment.summary,
      `Your findings and tasks are safe on disk in ${phrenPath}, but they are not reaching the remote.`,
      `Diagnose with: phren status  (then: cd ${phrenPath} && git pull --rebase)`,
      "<phren-notice>",
      "",
    ].join("\n"));
    try {
      fs.writeFileSync(markerPath, `${new Date().toISOString()}\n`);
    } catch (err: unknown) {
      debugLog(`sync-outage marker write failed: ${errorMessage(err)}`);
    }
  } catch (err: unknown) {
    debugLog(`sync-outage check failed: ${errorMessage(err)}`);
  }
}

// ── Session cap helper ──────────────────────────────────────────────────────

function getSessionCap(): number {
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

// ── Hook stop handler ───────────────────────────────────────────────────────

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
              logger.debug("hooks-session", `hookStop transcriptParse: ${errorMessage(err)}`);
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
              const sessionCap = getSessionCap();
              if (count >= sessionCap) {
                debugLog(`hook-stop: session cap reached (${count}/${sessionCap}), skipping extraction`);
                capReached = true;
              }
            } catch (err: unknown) {
              logger.debug("hooks-session", `hookStop sessionCapCheck: ${errorMessage(err)}`);
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

  // Under the manual preset lifecycle automations are off: never auto commit or
  // push the store, even if a stale Stop hook fires. Files on disk are the record.
  if (!resolveManagementCapabilities(phrenPath).lifecycleAutomations) {
    updateRuntimeHealth(phrenPath, {
      lastStopAt: now,
      lastAutoSave: { at: now, status: "saved-local", detail: "manual preset: auto-commit disabled" },
      lastSync: {
        lastPushAt: now,
        lastPushStatus: "saved-local",
        lastPushDetail: "manual preset does not auto-commit or push",
      },
    });
    appendAuditLog(phrenPath, "hook_stop", "status=skipped-manual-preset");
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
    // A clean working tree says nothing about whether the store is in sync.
    // Reporting "saved-pushed / no changes" here was the core lie: it
    // overwrote a real `pull-failed` from the previous run every single turn,
    // so the failure never accumulated and the user never saw it.
    const previousSync = getRuntimeHealth(phrenPath).lastSync;
    const pending = await countUnsyncedCommits(phrenPath);
    const inSync = pending === 0;
    const detail = inSync ? "no changes" : `no changes; ${pending} commit(s) still unpushed`;
    updateRuntimeHealth(phrenPath, {
      lastStopAt: now,
      lastAutoSave: { at: now, status: inSync ? "clean" : "sync-failed", detail },
      lastSync: inSync
        ? { ...previousSync, lastPushAt: now, lastPushDetail: detail, unsyncedCommits: 0 }
        : { ...previousSync, lastPushAt: now, lastPushDetail: detail, unsyncedCommits: pending },
    });
    appendAuditLog(phrenPath, "hook_stop", `status=${inSync ? "clean" : "clean-unsynced"} pending=${pending}`);
    if (!inSync) warnIfSyncDegraded(phrenPath);
    return;
  }

  // Stage all changes first, then unstage any sensitive files that slipped
  // through. Using pathspec exclusions with `git add -A` can fail when
  // excluded paths are also gitignored (git treats the pathspec as an error).
  let add = await runBestEffortGit(["add", "--sparse", "-A"], phrenPath);
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
  // The push has been handed to the background sync and has not happened yet,
  // so only the push *detail* is updated here — the status, failure streak and
  // last-success timestamp are left for whoever actually talks to the remote.
  const priorSync = getRuntimeHealth(phrenPath).lastSync;
  updateRuntimeHealth(phrenPath, {
    lastStopAt: now,
    lastAutoSave: { at: now, status: "saved-local", detail: syncDetail },
    lastSync: {
      ...priorSync,
      lastPushAt: now,
      lastPushDetail: syncDetail,
      unsyncedCommits,
    },
  });
  appendAuditLog(phrenPath, "hook_stop", `status=saved-local detail=${JSON.stringify(syncDetail)}`);
  warnIfSyncDegraded(phrenPath);

  }); // end withFileLock(gitOpLockPath)

  // Auto governance scheduling (non-blocking)
  scheduleWeeklyGovernance();
}

// ── Background sync handler ─────────────────────────────────────────────────

export async function handleBackgroundSync() {
  const phrenPathLocal = getPhrenPath();
  const now = new Date().toISOString();
  const lockPath = runtimeFile(phrenPathLocal, "background-sync.lock");

  try {
    const previousSync = getRuntimeHealth(phrenPathLocal).lastSync;
    const record = (
      autoSaveStatus: AutoSaveStatus,
      patch: Omit<SyncStatus, "consecutiveFailures" | "lastSuccessfulPushAt"> & { lastPushStatus: PushStatus },
      detail: string,
    ) => {
      updateRuntimeHealth(phrenPathLocal, {
        lastAutoSave: { at: now, status: autoSaveStatus, detail },
        lastSync: nextSyncStatus(previousSync, patch, now),
      });
      appendAuditLog(phrenPathLocal, "background_sync", `status=${patch.lastPushStatus} detail=${JSON.stringify(detail)}`);
    };

    const remotes = await runBestEffortGit(["remote"], phrenPathLocal);
    if (!remotes.ok || !remotes.output) {
      const unsyncedCommits = await countUnsyncedCommits(phrenPathLocal);
      const detail = "background sync skipped; no remote configured";
      record("saved-local", { lastPushAt: now, lastPushStatus: "saved-local", lastPushDetail: detail, unsyncedCommits }, detail);
      return;
    }

    const push = await runBestEffortGit(["push"], phrenPathLocal);
    if (push.ok) {
      const detail = "commit pushed by background sync";
      record("saved-pushed", { lastPushAt: now, lastPushStatus: "saved-pushed", lastPushDetail: detail, unsyncedCommits: 0 }, detail);
      return;
    }

    const recovered = await recoverPushConflict(phrenPathLocal);
    if (recovered.ok) {
      record("saved-pushed", {
        lastPushAt: now,
        lastPushStatus: "saved-pushed",
        lastPushDetail: recovered.detail,
        lastPullAt: now,
        lastPullStatus: recovered.pullStatus,
        lastPullDetail: recovered.pullDetail,
        lastSuccessfulPullAt: now,
        unsyncedCommits: 0,
      }, recovered.detail);
      return;
    }

    // The push leg genuinely failed. Report *which* leg failed instead of the
    // old success-shaped "saved-local", and name the unrelated-histories case
    // specifically — no retry will ever clear it, so a generic "pull failed"
    // would send the user chasing the wrong problem.
    const unsyncedCommits = await countUnsyncedCommits(phrenPathLocal);
    const unrelated = recovered.pullStatus === "error" && await hasUnrelatedHistories(phrenPathLocal);
    const pushStatus: PushStatus = unrelated
      ? "unrelated-histories"
      : recovered.pullStatus === "error" ? "pull-failed" : "push-failed";
    const failDetail = unrelated
      ? `local and remote histories are unrelated (no merge base) — the remote was most likely re-initialized. ` +
        `Reconcile manually: cd ${phrenPathLocal} && git fetch && git log --oneline origin/HEAD`
      : (recovered.detail || push.error || "background sync push failed");
    record("sync-failed", {
      lastPushAt: now,
      lastPushStatus: pushStatus,
      lastPushDetail: failDetail,
      lastPullAt: now,
      lastPullStatus: recovered.pullStatus,
      lastPullDetail: recovered.pullDetail,
      unsyncedCommits,
    }, failDetail);
  } finally {
    try { fs.unlinkSync(lockPath); } catch {}
  }
}

// ── Weekly governance ───────────────────────────────────────────────────────

function scheduleWeeklyGovernance(): void {
  try {
    const lastGovPath = runtimeFile(getPhrenPath(), "last-governance.txt");
    const lastRun = fs.existsSync(lastGovPath) ? parseInt(fs.readFileSync(lastGovPath, "utf8"), 10) : 0;
    const daysSince = (Date.now() - lastRun) / 86_400_000;
    if (daysSince >= 7) {
      const spawnArgs = resolveSubprocessArgs("background-maintenance");
      if (spawnArgs) {
        const child = spawnDetachedChild(spawnArgs, { phrenPath: getPhrenPath() });
        child.unref();
        fs.writeFileSync(lastGovPath, Date.now().toString());
        debugLog("hook_stop: scheduled weekly governance run");
      }
    }
  } catch (err: unknown) {
    debugLog(`hook_stop: governance scheduling failed: ${errorMessage(err)}`);
  }
}
