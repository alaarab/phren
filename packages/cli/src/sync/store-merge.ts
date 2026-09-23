import { resolveStoreConflicts } from "./conflict-resolve.js";
import { gitOperationRecovery, inProgressGitOperation } from "./git-state.js";

export interface GitResult { ok: boolean; output: string; error?: string }
export type RunStoreGit = (cwd: string, args: string[]) => Promise<GitResult>;

export type StoreMergeStatus = "unchanged" | "updated" | "conflict" | "busy" | "error";
export interface StoreMergeResult {
  status: StoreMergeStatus;
  detail: string;
  conflicts?: string[];
  committedLocalWrites?: boolean;
}

export interface StoreMergeOptions {
  git: RunStoreGit;
  /** A head advertised by ls-remote. Lets polling avoid an unnecessary fetch. */
  advertisedHead?: string;
  /** Callers that just made their own commit can skip the auto-save commit. */
  commitLocalWrites?: boolean;
  commitMessage?: string;
}

const SENSITIVE_STORE_PATHSPECS = [".env", "**/.env", "*.pem", "*.key", ".config/auth-profiles.json"];

async function commitLocalStoreWrites(cwd: string, git: RunStoreGit, message: string): Promise<{ committed: boolean; error?: string }> {
  const add = await git(cwd, ["add", "--sparse", "-A"]);
  if (!add.ok) return { committed: false, error: add.error || "git add failed" };
  await git(cwd, ["reset", "HEAD", "--", ...SENSITIVE_STORE_PATHSPECS]);
  const staged = await git(cwd, ["diff", "--cached", "--name-only"]);
  if (!staged.ok) return { committed: false, error: staged.error || "git diff failed" };
  if (!staged.output) return { committed: false };
  const commit = await git(cwd, ["-c", "commit.gpgsign=false", "commit", "-m", message]);
  return commit.ok ? { committed: true } : { committed: false, error: commit.error || "git commit failed" };
}

async function conflictedPaths(cwd: string, git: RunStoreGit): Promise<string[]> {
  const result = await git(cwd, ["diff", "--name-only", "--diff-filter=U"]);
  return result.ok ? result.output.split("\n").map((entry) => entry.trim()).filter(Boolean) : [];
}

async function abortMerge(cwd: string, git: RunStoreGit): Promise<boolean> {
  if (inProgressGitOperation(cwd) !== "merge") return true;
  const aborted = await git(cwd, ["merge", "--abort"]);
  if (aborted.ok) return true;
  const reset = await git(cwd, ["reset", "--merge", "ORIG_HEAD"]);
  return reset.ok && inProgressGitOperation(cwd) !== "merge";
}

/**
 * Fetch and integrate a store's configured upstream without rebasing local
 * commits. Conflicts in tasks.md (per task id against the merge base), the
 * generated summary and topic blocks, findings and the task archive resolve
 * automatically (see conflict-resolve.ts). Any other conflict aborts the
 * merge and names its files.
 */
export async function mergeStoreUpstream(cwd: string, options: StoreMergeOptions): Promise<StoreMergeResult> {
  const { git } = options;
  const operation = inProgressGitOperation(cwd);
  if (operation) {
    const recovery = gitOperationRecovery(operation);
    return {
      status: "busy",
      detail: `The store already has a Git operation in progress (${operation}). Run '${recovery}' in the store before syncing again.`,
    };
  }

  const branch = await git(cwd, ["symbolic-ref", "--quiet", "HEAD"]);
  if (!branch.ok) return { status: "error", detail: "No branch is checked out." };

  let committedLocalWrites = false;
  if (options.commitLocalWrites !== false) {
    const saved = await commitLocalStoreWrites(cwd, git, options.commitMessage ?? "auto-save phren (store sync)");
    if (saved.error) return { status: "error", detail: `Cannot commit local store writes: ${saved.error}` };
    committedLocalWrites = saved.committed;
  }

  const refs = await git(cwd, ["for-each-ref", "--format=%(upstream:remotename)%09%(upstream:remoteref)%09%(upstream)", branch.output]);
  const [remote, remoteRef, trackingRef] = refs.output.split("\t");
  if (!refs.ok || !remote || !remoteRef || !trackingRef) {
    return {
      status: "unchanged",
      detail: committedLocalWrites ? "Committed local store writes; no tracking remote is configured." : "No tracking remote is configured.",
      committedLocalWrites,
    };
  }

  const tracked = await git(cwd, ["rev-parse", "--verify", trackingRef]);
  if (!options.advertisedHead || !tracked.ok || tracked.output !== options.advertisedHead) {
    const fetched = await git(cwd, ["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--", remote, `${remoteRef}:${trackingRef}`]);
    if (!fetched.ok) return { status: "error", detail: `Fetch failed: ${fetched.error || "unknown Git error"}`, committedLocalWrites };
  }

  const target = await git(cwd, ["rev-parse", "--verify", trackingRef]);
  if (!target.ok || !target.output) return { status: "error", detail: "Cannot read the fetched tracking branch.", committedLocalWrites };

  if ((await git(cwd, ["merge-base", "--is-ancestor", target.output, "HEAD"])).ok) {
    return {
      status: "unchanged",
      detail: committedLocalWrites ? "Committed local store writes; the store already contains the remote changes." : "The store already contains the remote changes.",
      committedLocalWrites,
    };
  }

  const canFastForward = (await git(cwd, ["merge-base", "--is-ancestor", "HEAD", target.output])).ok;
  const merged = await git(cwd, canFastForward
    ? ["merge", "--ff-only", target.output]
    : ["merge", "--no-edit", target.output]);
  if (merged.ok) {
    return {
      status: "updated",
      detail: canFastForward ? "Store fast-forwarded to the remote." : "Store merged with the remote.",
      committedLocalWrites,
    };
  }

  const initialConflicts = await conflictedPaths(cwd, git);
  if (initialConflicts.length === 0 && inProgressGitOperation(cwd) !== "merge") {
    return {
      status: "error",
      detail: `Merge failed before it started: ${merged.error || "unknown Git error"}`,
      committedLocalWrites,
    };
  }
  if (initialConflicts.length > 0 && resolveStoreConflicts(cwd).unresolved.length === 0) {
    const commit = await git(cwd, ["-c", "commit.gpgsign=false", "commit", "--no-edit"]);
    if (commit.ok) {
      return {
        status: "updated",
        detail: `Store merged with the remote; resolved conflicts in ${initialConflicts.join(", ")}.`,
        conflicts: initialConflicts,
        committedLocalWrites,
      };
    }
  }

  const unresolvedConflicts = await conflictedPaths(cwd, git);
  const conflicts = unresolvedConflicts.length > 0 ? unresolvedConflicts : initialConflicts;
  const cleaned = await abortMerge(cwd, git);
  if (!cleaned) {
    return {
      status: "error",
      detail: `Merge cleanup failed${conflicts.length ? ` after conflicts in: ${conflicts.join(", ")}` : ""}. Run 'git merge --abort' in the store.`,
      conflicts,
      committedLocalWrites,
    };
  }
  if (conflicts.length > 0) {
    return {
      status: "conflict",
      detail: `Merge aborted; manual resolution is required for: ${conflicts.join(", ")}`,
      conflicts,
      committedLocalWrites,
    };
  }
  return {
    status: "error",
    detail: `Merge failed and was aborted: ${merged.error || "unknown Git error"}`,
    committedLocalWrites,
  };
}
