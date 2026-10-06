import { type Json } from "./protocol.js";
export declare const worktreeIdPattern: RegExp;
/** Someone known to be working in a worktree: a fan-out job from its
 * manifest, or a sub-agent whose own transcript runs there. */
export interface WorktreeWorker {
    /** The worker's working directory; a worktree is matched when this is it or inside it. */
    cwd: string;
    label: string;
    provider: string;
    /** This conversation's public child id, when the worker is one of its agents. */
    child?: string;
    state?: string;
}
export declare function worktreeId(abs: string): string;
/** The pane repository's other worktrees with branch, HEAD, commits ahead of
 * and behind this pane's HEAD, uncommitted file count and, when known, the
 * worker editing there. */
export declare function gitWorktrees(cwd: string, workers?: WorktreeWorker[]): Promise<Json>;
/** The checkout for one listed worktree id of the pane's repository, or a
 * 404; never a path the phone supplied. */
export declare function resolveWorktree(cwd: string, id: unknown): Promise<string>;
