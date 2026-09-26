import { execSync } from "node:child_process";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

const WORKTREE_BASE = path.join(os.homedir(), ".phren-agent", "worktrees");

export interface WorktreeInfo {
  path: string;
  branch: string;
  agentId: string;
}

/** Create a git worktree for an agent. Returns the worktree path. */
export function createWorktree(cwd: string, agentId: string): WorktreeInfo {
  const safeName = agentId.replace(/[^a-zA-Z0-9-]/g, "-");
  const worktreePath = path.join(WORKTREE_BASE, safeName);
  const branch = `phren-agent/${safeName}`;

  fs.mkdirSync(WORKTREE_BASE, { recursive: true });

  // Create worktree with new branch
  execSync(`git worktree add "${worktreePath}" -b "${branch}"`, { cwd, stdio: "pipe" });

  return { path: worktreePath, branch, agentId };
}

/** Check if a worktree has uncommitted changes. */
export function hasWorktreeChanges(worktreePath: string): boolean {
  try {
    const status = execSync("git status --porcelain", { cwd: worktreePath, encoding: "utf-8" });
    return status.trim().length > 0;
  } catch {
    return false;
  }
}

/** Remove a worktree and its branch. */
export function removeWorktree(cwd: string, worktreePath: string, branch: string): void {
  try {
    execSync(`git worktree remove "${worktreePath}" --force`, { cwd, stdio: "pipe" });
  } catch { /* already gone */ }
  try {
    execSync(`git branch -D "${branch}"`, { cwd, stdio: "pipe" });
  } catch { /* branch doesn't exist */ }
}

/** Clean up all stale phren-agent worktrees. */
export function cleanupStaleWorktrees(cwd: string): void {
  try {
    execSync("git worktree prune", { cwd, stdio: "pipe" });
  } catch { /* not a git repo */ }
}
