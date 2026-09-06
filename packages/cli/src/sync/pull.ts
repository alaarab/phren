/** Periodic, non-interactive remote checks for running MCP servers. */
import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import { atomicWriteText, readRootManifest, runtimeFile } from "../phren-paths.js";
import { readInstallPreferences } from "../init/preferences.js";
import { resolveManagementCapabilities } from "../init/management-preset.js";
import { tryFileLock } from "../governance/locks.js";
import { getNonPrimaryStores } from "../store-registry.js";
import { updateRuntimeHealth } from "../governance/policy.js";
import { debugLog } from "../shared.js";
import { errorMessage } from "../utils.js";

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

export interface GitResult { ok: boolean; output: string; error?: string }
export type RunGit = (cwd: string, args: string[]) => Promise<GitResult>;
const execAsync = promisify(execFile);

export const runPollGit: RunGit = async (cwd, args) => {
  try {
    const { stdout } = await execAsync("git", args, {
      cwd, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_OPTIONAL_LOCKS: "0" },
    });
    return { ok: true, output: stdout.trim() };
  } catch (err: unknown) {
    return { ok: false, output: "", error: errorMessage(err) };
  }
};

interface PollState { checkedAt?: number; failures?: number; status?: string; detail?: string }
export interface PullResult { status: "unchanged" | "updated" | "deferred" | "error" | "not-due"; detail: string }

function readPollState(phrenPath: string): PollState {
  try {
    const value = JSON.parse(fs.readFileSync(runtimeFile(phrenPath, "pull-poll.json"), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as PollState : {};
  }
  catch { return {}; }
}

/** Includes user-owned operations: polling never continues or aborts these. */
async function worktreeBusy(cwd: string, git: RunGit): Promise<boolean> {
  const dir = await git(cwd, ["rev-parse", "--absolute-git-dir"]);
  if (!dir.ok) return true;
  return ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer", "index.lock"]
    .some((name) => fs.existsSync(path.join(dir.output, name)));
}

/** Shared timestamps + a process lock give all MCP clients one check per store/interval. */
export async function pollStore(phrenPath: string, seconds: number, git: RunGit = runPollGit, now = Date.now()): Promise<PullResult> {
  const skipped: PullResult = { status: "not-due", detail: "Periodic check not due." };
  if (!seconds || !periodicPullEnabled(phrenPath) || !fs.existsSync(path.join(phrenPath, ".git"))) return skipped;
  const releasePoll = tryFileLock(runtimeFile(phrenPath, "pull-poll"));
  if (!releasePoll) return skipped;
  try {
    const previous = readPollState(phrenPath);
    const failures = Math.min(10, Math.max(0, Number(previous.failures) || 0));
    const delay = Math.min(seconds * 2 ** failures, Math.max(seconds, 1800)) * 1000;
    if (typeof previous.checkedAt === "number" && now >= previous.checkedAt && now - previous.checkedAt < delay) return skipped;

    const finish = (result: PullResult, verifiedRemote = false): PullResult => {
      atomicWriteText(runtimeFile(phrenPath, "pull-poll.json"), JSON.stringify({
        checkedAt: now, failures: result.status === "error" ? failures + 1 : 0, ...result,
      }) + "\n");
      if (verifiedRemote || result.status === "updated" || result.status === "error" || result.status === "deferred") {
        const at = new Date(now).toISOString();
        const ok = result.status === "updated" || result.status === "unchanged";
        updateRuntimeHealth(phrenPath, { lastSync: {
          lastPullAt: at, lastPullStatus: ok ? "ok" : "error",
          lastPullDetail: result.detail,
          ...(ok ? { lastSuccessfulPullAt: at } : {}),
        } });
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
    if (remoteHead === head.output) return finish({ status: "unchanged", detail: "Remote is unchanged." }, true);

    const releaseGit = tryFileLock(runtimeFile(phrenPath, "git-op"));
    if (!releaseGit) return deferred("Periodic pull deferred: another Phren Git operation is running.");
    try {
      // Recheck after taking the mutation lock: hooks or another client may have changed the store.
      if (await worktreeBusy(phrenPath, git)) return deferred("Periodic pull deferred: a Git operation is in progress.");
      const currentBranch = await git(phrenPath, ["symbolic-ref", "--quiet", "HEAD"]);
      const status = await git(phrenPath, ["status", "--porcelain"]);
      if (!currentBranch.ok || currentBranch.output !== branch.output || !status.ok || status.output) {
        return deferred("Periodic pull deferred: the branch changed or the store has uncommitted edits.");
      }
      const tracking = await git(phrenPath, ["rev-parse", "--verify", trackingRef]);
      if (!tracking.ok || tracking.output !== remoteHead) {
        const fetched = await git(phrenPath, ["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--", remote, `${remoteRef}:${trackingRef}`]);
        if (!fetched.ok) return failed(`Periodic fetch failed: ${fetched.error}`);
      }
      const target = await git(phrenPath, ["rev-parse", "--verify", trackingRef]);
      if (!target.ok) return failed("Cannot read the fetched tracking branch.");
      if ((await git(phrenPath, ["merge-base", "--is-ancestor", target.output, "HEAD"])).ok) {
        return finish({ status: "unchanged", detail: "The store already contains the remote changes." }, true);
      }
      if (!(await git(phrenPath, ["merge-base", "--is-ancestor", "HEAD", target.output])).ok) {
        return deferred("Periodic pull deferred: local and remote history diverged. Resolve the store's sync conflict before pulling.");
      }
      const merged = await git(phrenPath, ["merge", "--ff-only", "--no-edit", target.output]);
      return merged.ok
        ? finish({ status: "updated", detail: "Store fast-forwarded by periodic pull." })
        : deferred(`Periodic fast-forward deferred: ${merged.error}`);
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
