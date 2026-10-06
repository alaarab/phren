import * as fs from "node:fs";
import * as path from "node:path";

export type GitOperation = "rebase" | "merge" | "cherry-pick" | "revert" | "sequencer" | "index lock";

function gitDirectory(store: string): string | undefined {
  const dotGit = path.join(store, ".git");
  try {
    const stat = fs.statSync(dotGit);
    if (stat.isDirectory()) return dotGit;
    if (!stat.isFile()) return undefined;
    const match = /^gitdir:\s*(.+)\s*$/i.exec(fs.readFileSync(dotGit, "utf8"));
    if (!match) return undefined;
    return path.resolve(store, match[1]);
  } catch {
    return undefined;
  }
}

/** Detect user-owned Git state without running a command that could alter it. */
export function inProgressGitOperation(store: string): GitOperation | undefined {
  const gitDir = gitDirectory(store);
  if (!gitDir) return undefined;
  if (fs.existsSync(path.join(gitDir, "rebase-merge")) || fs.existsSync(path.join(gitDir, "rebase-apply"))) return "rebase";
  if (fs.existsSync(path.join(gitDir, "MERGE_HEAD"))) return "merge";
  if (fs.existsSync(path.join(gitDir, "CHERRY_PICK_HEAD"))) return "cherry-pick";
  if (fs.existsSync(path.join(gitDir, "REVERT_HEAD"))) return "revert";
  if (fs.existsSync(path.join(gitDir, "sequencer"))) return "sequencer";
  if (fs.existsSync(path.join(gitDir, "index.lock"))) return "index lock";
  return undefined;
}

export function gitOperationRecovery(operation: GitOperation): string {
  if (operation === "rebase") return "git rebase --abort";
  if (operation === "merge") return "git merge --abort";
  if (operation === "cherry-pick") return "git cherry-pick --abort";
  if (operation === "revert") return "git revert --abort";
  return "git status";
}

/**
 * Why an automatic store commit must not happen now. `git add -A` during an
 * unfinished merge marks every conflicted file resolved, markers and all, and
 * the next commit concludes the merge with them: that is how a
 * phren.project.yaml with `<<<<<<< HEAD` reached a store. Check before
 * staging for the in-progress operation, and after staging for added marker
 * pairs (a lone `=======` is a Markdown heading underline, so it needs both
 * ends).
 */
export async function storeAutoCommitBlocker(
  store: string,
  stagedDiff?: () => Promise<{ ok: boolean; output?: string }>,
): Promise<string | undefined> {
  const operation = inProgressGitOperation(store);
  if (operation) {
    return `The store has a Git ${operation} in progress, so nothing was committed. Run '${gitOperationRecovery(operation)}' in the store, or finish it by hand.`;
  }
  if (!stagedDiff) return undefined;
  const diff = await stagedDiff();
  if (diff.ok && diff.output && /^\+<{7}(?: |$)/m.test(diff.output) && /^\+>{7}(?: |$)/m.test(diff.output)) {
    return "Staged store changes contain merge conflict markers, so nothing was committed. Resolve them in the store first.";
  }
  return undefined;
}
