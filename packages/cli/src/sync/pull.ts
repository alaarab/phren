/** Periodic, non-interactive remote checks for running MCP servers. */
import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import { tryFileLock } from "../governance/locks.js";
import { updateRuntimeHealth } from "../governance/policy.js";
import { resolveManagementCapabilities } from "../init/management-preset.js";
import { readInstallPreferences } from "../init/preferences.js";
import { atomicWriteText, readRootManifest, runtimeFile } from "../phren-paths.js";
import { debugLog } from "../shared.js";
import { getNonPrimaryStores } from "../store-registry.js";
import { errorMessage } from "../utils.js";
import { nonInteractiveGitEnv } from "../utils-helpers.js";
import { activeStoreAuthFailure, authBackoffActive, storeAuthDetail, withStoreAuthBackoff } from "./auth.js";
import { inProgressGitOperation } from "./git-state.js";
import { aheadBehind, appendSyncLog, logSyncOutcome } from "./outcome.js";
import { mergeStoreUpstream, type GitResult, type RunStoreGit } from "./store-merge.js";

export const DEFAULT_PULL_INTERVAL_SECONDS = 0;
export const MIN_PULL_INTERVAL_SECONDS = 30;
export const MAX_PULL_INTERVAL_SECONDS = 86_400;

export function parsePullInterval(value: unknown): number | undefined {
  if (value === "off") return 0;
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  if (!/^\d+$/.test(String(value))) return undefined;
  const seconds = Number(value);
  return Number.isInteger(seconds) && (seconds === 0 || (seconds >= MIN_PULL_INTERVAL_SECONDS && seconds <= MAX_PULL_INTERVAL_SECONDS))
    ? seconds : undefined;
}

export function resolvePullInterval(phrenPath: string, env: NodeJS.ProcessEnv = process.env): number {
  return parsePullInterval(env.PHREN_PULL_INTERVAL_SECONDS)
    ?? parsePullInterval(readInstallPreferences(phrenPath).pullIntervalSeconds)
    ?? DEFAULT_PULL_INTERVAL_SECONDS;
}

export function periodicPullEnabled(phrenPath: string): boolean {
  const manifest = readRootManifest(phrenPath);
  return manifest?.installMode !== "project-local"
    && (!manifest || manifest.syncMode === "managed-git")
    && resolveManagementCapabilities(phrenPath).lifecycleAutomations;
}

export type RunGit = RunStoreGit;
export type { GitResult };
const execAsync = promisify(execFile);

export const runPollGit: RunGit = async (cwd, args) => {
  try {
    const { stdout } = await execAsync("git", args, {
      cwd, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024,
      env: nonInteractiveGitEnv({ ...process.env, GIT_OPTIONAL_LOCKS: "0" }),
    });
    return { ok: true, output: stdout.trim() };
  } catch (err: unknown) {
    return { ok: false, output: "", error: errorMessage(err) };
  }
};

interface PollState { checkedAt?: number; failures?: number; status?: string; detail?: string }
export interface PullResult { status: "unchanged" | "updated" | "deferred" | "error" | "not-due"; detail: string }

/**
 * A missing state file is a first check. A corrupt one is logged and moved
 * aside (kept for inspection) so the next check starts clean instead of
 * silently resetting the backoff on every poll.
 */
export function readPollState(phrenPath: string): PollState {
  const file = runtimeFile(phrenPath, "pull-poll.json");
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") logPeriodicSync(phrenPath, `poll state unreadable: ${errorMessage(err).split("\n")[0]}`);
    return {};
  }
  let reason: string;
  try {
    const value = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) return value as PollState;
    reason = "not a JSON object";
  } catch (err: unknown) { reason = errorMessage(err).split("\n")[0]; }
  const aside = `${file}.corrupt-${Date.now()}`;
  try { fs.renameSync(file, aside); } catch (err: unknown) { debugLog(`poll state rename: ${errorMessage(err)}`); }
  logPeriodicSync(phrenPath, `poll state was corrupt (${reason}); moved it to ${path.basename(aside)} and started fresh`);
  return {};
}

/** Includes user-owned operations: polling never continues or aborts these. */
async function worktreeBusy(cwd: string, git: RunGit): Promise<boolean> {
  const dir = await git(cwd, ["rev-parse", "--absolute-git-dir"]);
  if (!dir.ok) return true;
  return inProgressGitOperation(cwd) !== undefined;
}

/** The periodic pull writes its decisions to the same log a background sync uses. */
function logPeriodicSync(phrenPath: string, detail: string): void {
  appendSyncLog(phrenPath, "periodic-pull", detail);
}


/** Shared timestamps + a process lock give all MCP clients one check per store/interval. */
export async function pollStore(phrenPath: string, seconds: number, git: RunGit = runPollGit, now = Date.now()): Promise<PullResult> {
  const skipped: PullResult = { status: "not-due", detail: "Periodic check not due." };
  if (!seconds || !periodicPullEnabled(phrenPath) || !fs.existsSync(path.join(phrenPath, ".git"))) return skipped;
  const releasePoll = tryFileLock(runtimeFile(phrenPath, "pull-poll"));
  if (!releasePoll) return skipped;
  try {
    const auth = activeStoreAuthFailure(phrenPath);
    if (authBackoffActive(auth, now)) return { status: "not-due", detail: storeAuthDetail(auth!) };
    git = withStoreAuthBackoff(git, () => now);
    const previous = readPollState(phrenPath);
    const failures = Math.min(10, Math.max(0, Number(previous.failures) || 0));
    const delay = Math.min(seconds * 2 ** failures, Math.max(seconds, 1800)) * 1000;
    if (typeof previous.checkedAt === "number" && now >= previous.checkedAt && now - previous.checkedAt < delay) return skipped;

    const finish = async (result: PullResult, verifiedRemote = false): Promise<PullResult> => {
      atomicWriteText(runtimeFile(phrenPath, "pull-poll.json"), JSON.stringify({
        checkedAt: now, failures: result.status === "error" ? failures + 1 : 0, ...result,
      }) + "\n");
      if (verifiedRemote || result.status === "updated" || result.status === "error" || result.status === "deferred") {
        const at = new Date(now).toISOString();
        const ok = result.status === "updated" || result.status === "unchanged";
        const counts = await aheadBehind(phrenPath, git);
        updateRuntimeHealth(phrenPath, { lastSync: {
          lastPullAt: at, lastPullStatus: ok ? "ok" : "error",
          lastPullDetail: result.detail,
          ...(ok ? { lastSuccessfulPullAt: at } : {}),
          ...(counts ?? {}),
        } });
        // A quiet "unchanged" poll is logged only when it follows a different outcome.
        if (result.status !== "unchanged" || previous.status !== "unchanged") {
          logSyncOutcome(phrenPath, "periodic-pull", { ok, detail: `${result.status}: ${result.detail}`, counts });
        }
      }
      return result;
    };
    const deferred = (detail: string) => finish({ status: "deferred", detail });
    const failed = (detail: string) => finish({ status: "error", detail });
    if (await worktreeBusy(phrenPath, git)) return deferred("Periodic pull deferred: a Git operation is in progress.");
    const branch = await git(phrenPath, ["symbolic-ref", "--quiet", "HEAD"]);
    if (!branch.ok) return deferred("Periodic pull deferred: no branch checked out.");
    const refs = await git(phrenPath, ["for-each-ref", "--format=%(upstream:remotename)%09%(upstream:remoteref)%09%(upstream)", branch.output]);
    const [remote, remoteRef, trackingRef] = refs.output.split("\t");
    if (!refs.ok || !remote || !remoteRef || !trackingRef) return finish({ status: "unchanged", detail: "No tracking remote configured." });

    const advertised = await git(phrenPath, ["ls-remote", "--quiet", "--exit-code", "--", remote, remoteRef]);
    if (!advertised.ok) return failed(`Periodic remote check failed: ${advertised.error}`);
    const remoteHead = advertised.output.split("\n").map((line) => line.split(/\s+/))
      .find(([, ref]) => ref === remoteRef)?.[0];
    if (!remoteHead || !/^[0-9a-f]{40,64}$/.test(remoteHead)) return failed("Tracking branch was not advertised by the remote.");
    const head = await git(phrenPath, ["rev-parse", "HEAD"]);
    if (!head.ok) return failed("Cannot read the store's current commit.");
    const status = await git(phrenPath, ["status", "--porcelain"]);
    if (!status.ok) return failed("Cannot read the store's working tree state.");
    const remoteUnchanged = remoteHead === head.output;
    // The common poll (clean tree, remote already at HEAD) needs no lock.
    if (remoteUnchanged && !status.output) return finish({ status: "unchanged", detail: "Remote is unchanged." }, true);

    const releaseGit = tryFileLock(runtimeFile(phrenPath, "git-op"));
    if (!releaseGit) return deferred("Periodic pull deferred: another Phren Git operation is running.");
    try {
      // Recheck after taking the mutation lock: hooks or another client may have changed the store.
      if (await worktreeBusy(phrenPath, git)) return deferred("Periodic pull deferred: a Git operation is in progress.");
      const currentBranch = await git(phrenPath, ["symbolic-ref", "--quiet", "HEAD"]);
      if (!currentBranch.ok || currentBranch.output !== branch.output) {
        return deferred("Periodic pull deferred: the branch changed while checking.");
      }
      const merged = await mergeStoreUpstream(phrenPath, {
        git,
        advertisedHead: remoteHead,
        commitMessage: "auto-save phren (periodic pull)",
      });
      if (merged.committedLocalWrites) logPeriodicSync(phrenPath, "committed uncommitted store writes before pull");
      if (merged.status === "busy" || merged.status === "conflict") {
        const reason = merged.status === "conflict" ? `local and remote history diverged. ${merged.detail}` : merged.detail;
        return deferred(`Periodic pull deferred: ${reason}`);
      }
      if (merged.status === "error") return failed(`Periodic pull failed: ${merged.detail}`);
      return finish({ status: merged.status, detail: merged.detail }, true);
    } finally { releaseGit(); }
  } finally { releasePoll(); }
}

interface PollingOptions {
  onChange: () => Promise<void>;
  /** Share the MCP write queue so background updates cannot overlap its writes. */
  runExclusive: (fn: () => Promise<void>) => Promise<unknown>;
  git?: RunGit;
}

export function startPullPolling(phrenPath: string, options: PollingOptions): { stop: () => Promise<void> } {
  let stopped = false;
  let running: Promise<void> | undefined;
  const heads = new Map<string, string>();
  const startedAt = Date.now();
  const git = options.git ?? runPollGit;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    if (stopped) return;
    try {
      const seconds = resolvePullInterval(phrenPath);
      if (!seconds || !periodicPullEnabled(phrenPath)) return;
      const stores = [...new Set([phrenPath, ...getNonPrimaryStores(phrenPath).map((store) => store.path)])];
      for (const store of stores) {
        if (stopped) break;
        await options.runExclusive(async () => {
          if (stopped || !fs.existsSync(path.join(store, ".git"))) return;
          const before = await git(store, ["rev-parse", "HEAD"]);
          if (!before.ok) return;
          const previous = heads.get(store) ?? before.output;
          if (Date.now() - startedAt >= seconds * 1000) {
            const result = await pollStore(store, seconds, git);
            if (result.status === "error") debugLog(result.detail);
          }
          const after = await git(store, ["rev-parse", "HEAD"]);
          if (!after.ok) return;
          if (after.output !== previous) await options.onChange();
          heads.set(store, after.output);
        });
      }
    } catch (err: unknown) { debugLog(`periodic pull: ${errorMessage(err)}`); }
    finally {
      if (!stopped) { timer = setTimeout(run, 5000); timer.unref(); }
    }
  };
  const run = () => { running = tick(); };
  // Establish a local baseline without a startup network burst; first check is due after the configured interval.
  running = (async () => {
    for (const store of [phrenPath, ...getNonPrimaryStores(phrenPath).map((s) => s.path)]) {
      const head = await git(store, ["rev-parse", "HEAD"]);
      if (head.ok) heads.set(store, head.output);
    }
  })().catch((err: unknown) => { debugLog(`periodic pull startup: ${errorMessage(err)}`); })
    .finally(() => { if (!stopped) { timer = setTimeout(run, 5000); timer.unref(); } });
  return { stop: async () => { stopped = true; if (timer) clearTimeout(timer); await running; } };
}
