/**
 * SessionStart handler and onboarding helpers.
 * Extracted from cli-hooks-session.ts for modularity.
 */
import {
  buildHookContext,
  handleGuardSkip,
  debugLog,
  sessionMarker,
  getProjectDirs,
  findProjectNameCaseInsensitive,
  updateRuntimeHealth,
  appendAuditLog,
  detectProject,
  isProjectHookEnabled,
  readProjectConfig,
  getProjectSourcePath,
  detectProjectDir,
  ensureLocalGitRepo,
  isProjectTracked,
  repairPreexistingInstall,
  isFeatureEnabled,
  errorMessage,
  runDoctor,
  resolveRuntimeProfile,
} from "./cli/hooks-context.js";
import {
  qualityMarkers,
} from "./shared.js";
import { readInstallPreferences } from "./init/preferences.js";
import { logger } from "./logger.js";
import * as fs from "fs";
import * as path from "path";
import { spawnDetachedChild } from "./shared/process.js";
import { TASKS_FILENAME } from "./data/tasks.js";
import {
  resolveSubprocessArgs as _resolveSubprocessArgs,
  runBestEffortGit,
  countUnsyncedCommits,
} from "./cli-hooks-git.js";

const SESSION_START_ONBOARDING_MARKER = "session-start-onboarding-v1";
const SYNC_WARN_MARKER = "sync-broken-warned-v1";

function projectHasBootstrapSignals(phrenPath: string, project: string): boolean {
  const projectDir = path.join(phrenPath, project);
  const findingsPath = path.join(projectDir, "FINDINGS.md");
  if (fs.existsSync(findingsPath)) {
    const findings = fs.readFileSync(findingsPath, "utf8");
    if (/^-\s+/m.test(findings)) return true;
  }

  const tasksPath = path.join(projectDir, TASKS_FILENAME);
  if (fs.existsSync(tasksPath)) {
    const tasks = fs.readFileSync(tasksPath, "utf8");
    if (/^-\s+\[(?: |x|X)\]/m.test(tasks)) return true;
  }

  return false;
}

export function getUntrackedProjectNotice(phrenPath: string, cwd: string): string | null {
  const profile = resolveRuntimeProfile(phrenPath);
  const projectDir = detectProjectDir(cwd, phrenPath);
  if (!projectDir) return null;
  const activeProfile = profile || undefined;
  // Check the exact current working directory against projects in the active profile.
  // This avoids prompting when cwd is already inside a tracked sourcePath.
  if (detectProject(phrenPath, cwd, activeProfile)) return null;
  if (detectProject(phrenPath, projectDir, activeProfile)) return null;
  const projectName = path.basename(projectDir).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  if (isProjectTracked(phrenPath, projectName, activeProfile)) {
    const trackedName = getProjectDirs(phrenPath, activeProfile)
      .map((dir) => path.basename(dir))
      .find((name) => name.toLowerCase() === projectName)
      || findProjectNameCaseInsensitive(phrenPath, projectName)
      || projectName;
    const config = readProjectConfig(phrenPath, trackedName);
    const sourcePath = getProjectSourcePath(phrenPath, trackedName, config);
    if (!sourcePath) return null;
    const resolvedProjectDir = path.resolve(projectDir);
    const sameSource = resolvedProjectDir === sourcePath || resolvedProjectDir.startsWith(sourcePath + path.sep);
    if (sameSource) return null;
  }
  return [
    "<phren-notice>",
    "This project directory is not tracked by phren yet.",
    "Run `phren add` to track it now.",
    `Suggested command: \`phren add "${projectDir}"\``,
    "Ask the user whether they want to add it to phren now.",
    "If they say no, tell them they can always run `phren add` later.",
    "If they say yes, also ask whether phren should manage repo instruction files or leave their existing repo-owned CLAUDE/AGENTS files alone.",
    `Then use the \`add_project\` MCP tool with path="${projectDir}" and ownership="phren-managed"|"detached"|"repo-managed", or run \`phren add\` from that directory.`,
    "After onboarding, run `phren doctor` if hooks or MCP tools are not responding.",
    "<phren-notice>",
    "",
  ].join("\n");
}

export function getSessionStartOnboardingNotice(
  phrenPath: string,
  cwd: string,
  activeProject: string | null,
): string | null {
  const markerPath = sessionMarker(phrenPath, SESSION_START_ONBOARDING_MARKER);
  if (fs.existsSync(markerPath)) return null;

  if (getUntrackedProjectNotice(phrenPath, cwd)) return null;

  const profile = resolveRuntimeProfile(phrenPath);
  const trackedProjects = getProjectDirs(phrenPath, profile).filter((dir) => path.basename(dir) !== "global");

  if (trackedProjects.length === 0) {
    return [
      "<phren-notice>",
      "Phren onboarding: no tracked projects are active for this workspace yet.",
      "Start in a project repo and run `phren add` so SessionStart can inject project context.",
      "Run `phren doctor` to verify hooks and MCP wiring after setup.",
      "<phren-notice>",
      "",
    ].join("\n");
  }

  if (!activeProject) return null;
  if (projectHasBootstrapSignals(phrenPath, activeProject)) return null;

  return [
    "<phren-notice>",
    `Phren onboarding: project "${activeProject}" is tracked but memory is still empty.`,
    "Capture one finding with `add_finding` and one task with `add_task` to seed future SessionStart context.",
    "Run `phren doctor` if setup seems incomplete.",
    "<phren-notice>",
    "",
  ].join("\n");
}

function scheduleBackgroundMaintenance(phrenPathLocal: string, project?: string): boolean {
  if (!isFeatureEnabled("PHREN_FEATURE_DAILY_MAINTENANCE", true)) return false;
  const markers = qualityMarkers(phrenPathLocal);
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

  const spawnArgs = _resolveSubprocessArgs("background-maintenance");
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
      logger.debug("backgroundMaintenance lockClaim", errorMessage(err));
      return false;
    }
    try {
      fs.writeSync(fd, lockContent);
    } finally {
      fs.closeSync(fd);
    }
    if (project) spawnArgs.push(project);
    const logDir = path.join(phrenPathLocal, ".config");
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, "background-maintenance.log");
    const logFd = fs.openSync(logPath, "a");
    fs.writeSync(
      logFd,
      `[${new Date().toISOString()}] spawn ${process.execPath} ${spawnArgs.join(" ")}\n`
    );
    const child = spawnDetachedChild(spawnArgs, { phrenPath: phrenPathLocal, logFd });
    child.on("exit", (code, signal) => {
      const msg = `[${new Date().toISOString()}] exit code=${code ?? "null"} signal=${signal ?? "none"}\n`;
      try { fs.appendFileSync(logPath, msg); } catch (err: unknown) {
        logger.debug("backgroundMaintenance exitLog", errorMessage(err));
      }
      if (code === 0) {
        try { fs.writeFileSync(markers.done, new Date().toISOString() + "\n"); } catch (err: unknown) {
          logger.debug("backgroundMaintenance doneMarker", errorMessage(err));
        }
      }
      try { fs.unlinkSync(markers.lock); } catch (err: unknown) {
        logger.debug("backgroundMaintenance unlockOnExit", errorMessage(err));
      }
    });
    child.on("error", (spawnErr) => {
      const msg = `[${new Date().toISOString()}] spawn error: ${spawnErr.message}\n`;
      try { fs.appendFileSync(logPath, msg); } catch (err: unknown) {
        logger.debug("backgroundMaintenance errorLog", errorMessage(err));
      }
      try { fs.unlinkSync(markers.lock); } catch (err: unknown) {
        logger.debug("backgroundMaintenance unlockOnError", errorMessage(err));
      }
    });
    fs.closeSync(logFd);
    child.unref();
    return true;
  } catch (err: unknown) {
    const errMsg = errorMessage(err);
    try {
      const logDir = path.join(phrenPathLocal, ".config");
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(
        path.join(logDir, "background-maintenance.log"),
        `[${new Date().toISOString()}] spawn failed: ${errMsg}\n`
      );
    } catch (err: unknown) {
      logger.debug("backgroundMaintenance logSpawnFailure", errorMessage(err));
    }
    try { fs.unlinkSync(markers.lock); } catch (err: unknown) {
      logger.debug("backgroundMaintenance unlockOnFailure", errorMessage(err));
    }
    return false;
  }
}

export async function handleHookSessionStart() {
  const startedAt = new Date().toISOString();
  const ctx = buildHookContext();
  const { phrenPath, cwd, activeProject, manifest } = ctx;

  // Check common guards (hooks enabled, tool enabled)
  if (!ctx.hooksEnabled) {
    handleGuardSkip(ctx, "hook_session_start", "disabled", { lastSessionStartAt: startedAt });
    return;
  }
  if (!ctx.toolHookEnabled) {
    handleGuardSkip(ctx, "hook_session_start", `tool_disabled tool=${ctx.hookTool}`);
    return;
  }

  try {
    repairPreexistingInstall(phrenPath);
  } catch (err: unknown) {
    debugLog(`hook-session-start repair failed: ${errorMessage(err)}`);
  }

  if (!isProjectHookEnabled(phrenPath, activeProject, "SessionStart")) {
    handleGuardSkip(ctx, "hook_session_start", `project_disabled project=${activeProject}`, { lastSessionStartAt: startedAt });
    return;
  }

  if (manifest?.installMode === "project-local") {
    updateRuntimeHealth(phrenPath, {
      lastSessionStartAt: startedAt,
      lastSync: {
        lastPullAt: startedAt,
        lastPullStatus: "ok",
        lastPullDetail: "project-local mode does not manage git sync",
      },
    });
    appendAuditLog(phrenPath, "hook_session_start", "status=skipped-local");
    return;
  }

  const gitRepo = ensureLocalGitRepo(phrenPath);
  const remotes = gitRepo.ok ? await runBestEffortGit(["remote"], phrenPath) : { ok: false, error: gitRepo.detail };
  const hasRemote = Boolean(remotes.ok && remotes.output && remotes.output.trim());
  const pull = !gitRepo.ok
    ? { ok: false, error: gitRepo.detail }
    : hasRemote
      ? await runBestEffortGit(["pull", "--rebase", "--quiet"], phrenPath)
      : {
          ok: true,
          output: gitRepo.initialized
            ? "initialized local git repo; no remote configured"
            : "local-only repo; no remote configured",
        };
  const doctor = await runDoctor(phrenPath, false);
  const maintenanceScheduled = scheduleBackgroundMaintenance(phrenPath);
  const unsyncedCommits = hasRemote ? await countUnsyncedCommits(phrenPath) : 0;

  try { const { trackSession } = await import("./telemetry.js"); trackSession(phrenPath); } catch (err: unknown) {
    logger.debug("hookSessionStart trackSession", errorMessage(err));
  }

  // Pull non-primary stores (team + readonly) so session starts with fresh data
  try {
    const { getNonPrimaryStores } = await import("./store-registry.js");
    const otherStores = getNonPrimaryStores(phrenPath);
    for (const store of otherStores) {
      if (!fs.existsSync(store.path) || !fs.existsSync(path.join(store.path, ".git"))) continue;
      try {
        await runBestEffortGit(["pull", "--rebase", "--quiet"], store.path);
      } catch (err: unknown) {
        debugLog(`session-start store-pull ${store.name}: ${errorMessage(err)}`);
      }
    }
  } catch {
    // store-registry not available — skip silently
  }

  updateRuntimeHealth(phrenPath, {
    lastSessionStartAt: startedAt,
    lastSync: {
      lastPullAt: startedAt,
      lastPullStatus: pull.ok ? "ok" : "error",
      lastPullDetail: pull.ok ? (pull.output || "pull ok") : (pull.error || "pull failed"),
      lastSuccessfulPullAt: pull.ok && hasRemote ? startedAt : undefined,
      unsyncedCommits,
    },
  });
  appendAuditLog(
    phrenPath,
    "hook_session_start",
    `pull=${hasRemote ? (pull.ok ? "ok" : "fail") : "skipped-local"} doctor=${doctor.ok ? "ok" : "issues"} maintenance=${maintenanceScheduled ? "scheduled" : "skipped"}`
  );

  // Sync intent warning: if the user intended sync but remote is missing or pull failed, warn once
  try {
    const syncPrefs = readInstallPreferences(phrenPath);
    const syncBroken = syncPrefs.syncIntent === "sync" && (!hasRemote || !pull.ok);
    if (syncBroken) {
      const syncWarnPath = sessionMarker(phrenPath, SYNC_WARN_MARKER);
      if (!fs.existsSync(syncWarnPath)) {
        const reason = !hasRemote
          ? "no git remote is connected"
          : `pull failed: ${pull.error || "unknown error"}`;
        process.stdout.write([
          "<phren-notice>",
          `Sync is configured but ${reason}. Your phren data is local-only.`,
          `To fix: cd ${phrenPath} && git remote add origin <YOUR_REPO_URL> && git push -u origin main`,
          "<phren-notice>",
          "",
        ].join("\n"));
        try {
          fs.writeFileSync(syncWarnPath, `${startedAt}\n`);
        } catch (err: unknown) {
          debugLog(`sync-warn marker write failed: ${errorMessage(err)}`);
        }
      }
    }
  } catch (err: unknown) {
    debugLog(`sync-intent check failed: ${errorMessage(err)}`);
  }

  // Untracked project detection: suggest `phren add` if CWD looks like a project but isn't tracked
  try {
    const notice = getUntrackedProjectNotice(phrenPath, cwd);
    if (notice) {
      process.stdout.write(notice);
      debugLog(`untracked project detected at ${cwd}`);
    }
    const onboarding = getSessionStartOnboardingNotice(phrenPath, cwd, activeProject);
    if (onboarding) {
      process.stdout.write(onboarding);
      try {
        fs.writeFileSync(sessionMarker(phrenPath, SESSION_START_ONBOARDING_MARKER), `${startedAt}\n`);
      } catch (err: unknown) {
        debugLog(`session-start onboarding marker write failed: ${errorMessage(err)}`);
      }
    }
  } catch (err: unknown) {
    debugLog(`session-start onboarding detection failed: ${errorMessage(err)}`);
  }
}
