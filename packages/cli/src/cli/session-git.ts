/**
 * Git helpers for session hooks.
 * Extracted from hooks-session.ts for modularity.
 */
import { execFileSync } from "child_process";
import * as path from "path";
import {
  EXEC_TIMEOUT_MS,
  debugLog,
  errorMessage,
} from "./hooks-context.js";
import { runGit } from "../utils.js";
import { nonInteractiveGitEnv } from "../utils-helpers.js";
import { withFileLock } from "../governance/locks.js";
import { runtimeFile } from "../phren-paths.js";
import { mergeStoreUpstream, type RunStoreGit } from "../sync/store-merge.js";

// ── Git context ─────────────────────────────────────────────────────────────

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

// ── Git command helpers ─────────────────────────────────────────────────────

function isTransientGitError(message: string): boolean {
  return /(timed out|connection|network|could not resolve host|rpc failed|429|502|503|504|service unavailable)/i.test(message);
}

function shouldRetryGitCommand(args: string[]): boolean {
  const cmd = args[0] || "";
  return cmd === "push" || cmd === "pull" || cmd === "fetch";
}

export async function runBestEffortGit(args: string[], cwd: string): Promise<{ ok: boolean; output?: string; error?: string }> {
  const retries = shouldRetryGitCommand(args) ? 2 : 0;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const output = execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: EXEC_TIMEOUT_MS,
        env: nonInteractiveGitEnv(),
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

/**
 * True when local HEAD and the tracking branch share no common ancestor.
 *
 * This is what happens when a store's remote is re-initialized: every
 * an ordinary pull cannot reconcile it, and the next commit re-enters the
 * same loop forever. A generic "pull failed" sends the user chasing
 * network problems, so it is worth naming — no retry will ever fix it.
 *
 * Returns false when there is no upstream, or when git cannot answer; callers
 * treat that as "some other failure" and report the raw error instead.
 */
export async function hasUnrelatedHistories(cwd: string): Promise<boolean> {
  const upstream = await runBestEffortGit(["rev-parse", "--abbrev-ref", "@{upstream}"], cwd);
  if (!upstream.ok || !upstream.output) return false;

  // Make sure we are comparing against what the remote actually has now.
  await runBestEffortGit(["fetch", "--quiet"], cwd);

  const localHead = await runBestEffortGit(["rev-parse", "HEAD"], cwd);
  const remoteHead = await runBestEffortGit(["rev-parse", upstream.output.trim()], cwd);
  if (!localHead.ok || !remoteHead.ok || !localHead.output || !remoteHead.output) return false;

  // `merge-base` exits non-zero with no output when the two commits are
  // unrelated, which is exactly the signal we want.
  const mergeBase = await runBestEffortGit(["merge-base", localHead.output.trim(), remoteHead.output.trim()], cwd);
  return !mergeBase.ok || !mergeBase.output?.trim();
}

/**
 * Files phren is allowed to auto-stage in a team store. Anything not in this
 * list (notably `.runtime/`, secrets, build output) is skipped on session-stop
 * and `push_changes`.
 */
export const TEAM_STORE_PATHSPECS = [
  "*/journal/*",
  "*/tasks.md",
  "*/truths.md",
  "*/FINDINGS.md",
  "*/FINDINGS.md.bak",
  "*/summary.md",
  "*/review.md",
  "*/AGENTS.md",
  "*/topic-config.json",
  "*/phren.project.yaml",
  "*/reference/**",
  "*/skills/**",
  "*/notes/**",
  ".phren-team.yaml",
] as const;

export async function countUnsyncedCommits(cwd: string): Promise<number> {
  const upstream = await runBestEffortGit(["rev-parse", "--abbrev-ref", "@{upstream}"], cwd);
  if (!upstream.ok || !upstream.output) {
    const allCommits = await runBestEffortGit(["rev-list", "--count", "HEAD"], cwd);
    if (!allCommits.ok || !allCommits.output) return 0;
    const parsed = Number.parseInt(allCommits.output.trim(), 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  const ahead = await runBestEffortGit(["rev-list", "--count", `${upstream.output.trim()}..HEAD`], cwd);
  if (!ahead.ok || !ahead.output) return 0;
  const parsed = Number.parseInt(ahead.output.trim(), 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

const runSessionStoreGit: RunStoreGit = async (cwd, args) => {
  const result = await runBestEffortGit(args, cwd);
  return { ok: result.ok, output: result.output ?? "", error: result.error };
};

/** Startup pulls share the store's Git lock and never rewrite local commits. */
export async function pullAtSessionStart(cwd: string): Promise<{ ok: boolean; output?: string; error?: string }> {
  try {
    return await withFileLock(runtimeFile(cwd, "git-op"), async () => {
      const result = await mergeStoreUpstream(cwd, {
        git: runSessionStoreGit,
        commitMessage: "auto-save phren (session start)",
      });
      return result.status === "updated" || result.status === "unchanged"
        ? { ok: true, output: result.detail }
        : { ok: false, error: result.detail };
    });
  } catch (err: unknown) { return { ok: false, error: errorMessage(err) }; }
}

export async function recoverPushConflict(cwd: string): Promise<{ ok: boolean; detail: string; pullStatus: "ok" | "error"; pullDetail: string }> {
  const merged = await mergeStoreUpstream(cwd, { git: runSessionStoreGit, commitLocalWrites: false });
  if (merged.status !== "updated" && merged.status !== "unchanged") {
    return { ok: false, detail: merged.detail, pullStatus: "error", pullDetail: merged.detail };
  }
  const retryPush = await runBestEffortGit(["push"], cwd);
  return {
    ok: retryPush.ok,
    detail: retryPush.ok ? "commit pushed after merging remote changes" : (retryPush.error || "push failed after merging remote changes"),
    pullStatus: "ok",
    pullDetail: merged.detail,
  };
}
