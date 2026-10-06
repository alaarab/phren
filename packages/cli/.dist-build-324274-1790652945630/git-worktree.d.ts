export interface WorktreeAttribution {
    /** Root of the repository this worktree belongs to. */
    repoRoot: string;
    /** Why we concluded `dir` is a worktree — useful in debug output. */
    reason: "agent-worktree-dir" | "linked-worktree";
}
/**
 * If `dir` is (or lives inside) a git worktree, return the repository it belongs
 * to. Returns `null` for ordinary directories, for the main working tree, and
 * for git submodules — a submodule is a separate repository and *should* get its
 * own project.
 */
export declare function resolveWorktreeParent(dir: string): WorktreeAttribution | null;
/**
 * Normalize a path for project attribution: worktrees resolve to the repository
 * they came from, everything else is returned unchanged. Safe to call on any
 * path — it never throws.
 */
export declare function resolveRepoRootForPath(dir: string): string;
