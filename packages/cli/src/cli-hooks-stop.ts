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
  buildSyncStatus,
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
} from "./cli/hooks-context.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawnDetachedChild } from "./shared/process.js";
import {
  resolveSubprocessArgs as _resolveSubprocessArgs,
  runBestEffortGit,
  countUnsyncedCommits,
  recoverPushConflict,
} from "./cli-hooks-git.js";
import { logger } from "./logger.js";

const SYNC_LOCK_STALE_MS = 10 * 60 * 1000; // 10 minutes

/** Read JSON from stdin if it's not a TTY. Returns null if stdin is a TTY or parsing fails. */
export function readStdinJson<T>(): T | null {
  if (process.stdin.isTTY) return null;
  try {
    return JSON.parse(fs.readFileSync(0, "utf-8")) as T;
  } catch (err: unknown) {
    logger.debug("readStdinJson", errorMessage(err));
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
      if (ageMs <= SYNC_LOCK_STALE_MS) return false;
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
    const child = spawnDetachedChild(spawnArgs, { phrenPath: phrenPathLocal, logFd });
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
              logger.debug("hookStop transcriptParse", errorMessage(err));
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
              logger.debug("hookStop sessionCapCheck", errorMessage(err));
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
    process.stderr.write(`phren: git repo error — ${gitRepo.detail}. Run 'phren doctor --fix' for details.\n`);
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
    process.stderr.write(`phren: git status failed — your changes may not be saved. Run 'phren doctor --fix'.\n`);
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
    process.stderr.write(`phren: git commit failed — ${add.error || commit.error || "unknown error"}. Changes not saved.\n`);
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
    if (unsyncedCommits > 3) {
      process.stderr.write(`phren: ${unsyncedCommits} unsynced commits — no git remote configured.\n`);
    }
    return;
  }
  // Check if HEAD has an upstream tracking branch before attempting sync.
  // If no upstream is set but a remote exists, auto-set it to avoid silent push failures.
  const upstream = await runBestEffortGit(["rev-parse", "--abbrev-ref", "@{upstream}"], phrenPath);
  if (!upstream.ok || !upstream.output) {
    // Try to auto-set upstream: get current branch and set tracking to origin/<branch>
    const branch = await runBestEffortGit(["rev-parse", "--abbrev-ref", "HEAD"], phrenPath);
    if (branch.ok && branch.output) {
      const branchName = branch.output.trim();
      const setUpstream = await runBestEffortGit(
        ["branch", "--set-upstream-to", `origin/${branchName}`, branchName],
        phrenPath,
      );
      if (!setUpstream.ok) {
        // Upstream auto-set failed — log and continue to sync anyway
        logger.debug("hookStop", `failed to auto-set upstream for ${branchName}`);
      }
    }
    // Fall through to scheduleBackgroundSync instead of returning early
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

  // Sync non-primary stores: commit+push team stores, pull-only readonly stores
  try {
    const { getNonPrimaryStores } = await import("./store-registry.js");
    const otherStores = getNonPrimaryStores(phrenPath);
    for (const store of otherStores) {
      if (!fs.existsSync(store.path) || !fs.existsSync(path.join(store.path, ".git"))) continue;

      if (store.role === "team" && store.sync !== "pull-only") {
        // Team stores with managed-git sync: stage team-safe files, commit, and push
        try {
          const storeStatus = await runBestEffortGit(["status", "--porcelain"], store.path);
          if (storeStatus.ok && storeStatus.output) {
            // Only stage journal/, tasks.md, truths.md, FINDINGS.md, summary.md — NOT .runtime/
            await runBestEffortGit(["add", "--", "*/journal/*", "*/tasks.md", "*/truths.md", "*/FINDINGS.md", "*/summary.md", ".phren-team.yaml"], store.path);
            const actor = process.env.PHREN_ACTOR || process.env.USER || "unknown";
            const teamCommit = await runBestEffortGit(["commit", "-m", `phren: ${actor} team sync`], store.path);
            if (teamCommit.ok) {
              // Check for remote before pushing
              const storeRemotes = await runBestEffortGit(["remote"], store.path);
              if (storeRemotes.ok && storeRemotes.output?.trim()) {
                const teamPush = await runBestEffortGit(["push"], store.path);
                if (!teamPush.ok) {
                  // Try pull-rebase then push
                  await runBestEffortGit(["pull", "--rebase", "--quiet"], store.path);
                  await runBestEffortGit(["push"], store.path);
                }
              }
            }
          }
        } catch (err: unknown) {
          debugLog(`hook-stop team-store-sync ${store.name}: ${errorMessage(err)}`);
        }
      } else {
        // Readonly stores: pull only
        try {
          await runBestEffortGit(["pull", "--rebase", "--quiet"], store.path);
        } catch (err: unknown) {
          debugLog(`hook-stop store-pull ${store.name}: ${errorMessage(err)}`);
        }
      }
    }
  } catch {
    // store-registry not available or no stores — skip silently
  }

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
        lastSync: buildSyncStatus({ now, pushStatus: "saved-local", pushDetail: "background sync skipped; no remote configured", unsyncedCommits }),
      });
      appendAuditLog(phrenPathLocal, "background_sync", "status=saved-local detail=no_remote");
      return;
    }

    const push = await runBestEffortGit(["push"], phrenPathLocal);
    if (push.ok) {
      updateRuntimeHealth(phrenPathLocal, {
        lastAutoSave: { at: now, status: "saved-pushed", detail: "commit pushed by background sync" },
        lastSync: buildSyncStatus({ now, pushStatus: "saved-pushed", pushDetail: "commit pushed by background sync", unsyncedCommits: 0 }),
      });
      appendAuditLog(phrenPathLocal, "background_sync", "status=saved-pushed");
      return;
    }

    const recovered = await recoverPushConflict(phrenPathLocal);
    if (recovered.ok) {
      updateRuntimeHealth(phrenPathLocal, {
        lastAutoSave: { at: now, status: "saved-pushed", detail: recovered.detail },
        lastSync: buildSyncStatus({ now, pushStatus: "saved-pushed", pushDetail: recovered.detail, pullAt: now, pullStatus: recovered.pullStatus, pullDetail: recovered.pullDetail, successfulPullAt: now, unsyncedCommits: 0 }),
      });
      appendAuditLog(phrenPathLocal, "background_sync", `status=saved-pushed detail=${JSON.stringify(recovered.detail)}`);
      return;
    }

    const unsyncedCommits = await countUnsyncedCommits(phrenPathLocal);
    const failDetail = recovered.detail || push.error || "background sync push failed";
    updateRuntimeHealth(phrenPathLocal, {
      lastAutoSave: { at: now, status: "saved-local", detail: failDetail },
      lastSync: buildSyncStatus({ now, pushStatus: "saved-local", pushDetail: failDetail, pullAt: now, pullStatus: recovered.pullStatus, pullDetail: recovered.pullDetail, unsyncedCommits }),
    });
    appendAuditLog(phrenPathLocal, "background_sync", `status=saved-local detail=${JSON.stringify(failDetail)}`);

    // Append to sync-warnings.jsonl so health_check and session_start can surface recent failures
    try {
      const warningsPath = runtimeFile(phrenPathLocal, "sync-warnings.jsonl");
      const entry = JSON.stringify({ at: now, error: failDetail, unsyncedCommits }) + "\n";
      fs.appendFileSync(warningsPath, entry);
    } catch (err: unknown) {
      debugLog(`background-sync: failed to write sync warning: ${errorMessage(err)}`);
    }
  } finally {
    try { fs.unlinkSync(lockPath); } catch {}
  }
}
