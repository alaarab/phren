import { type Json } from "./protocol.js";
/** The remote's default branch as its `HEAD` records it. With no recorded
 * `HEAD`, `main` and `master` are treated as default so the guard errs on the
 * side of asking. */
export declare function defaultBranch(root: string, remote?: string): Promise<string | null>;
export interface GitStatusFile {
    path: string;
    status: string;
    staged: boolean;
    additions: number;
    deletions: number;
}
export interface GitStatus {
    branch: string;
    upstream: string | null;
    ahead: number;
    behind: number;
    staged: number;
    unstaged: number;
    untracked: number;
    additions: number;
    deletions: number;
    files: GitStatusFile[];
    /** The branch a push guards: the upstream remote's `HEAD`, else `main`/`master`. */
    defaultBranch: string | null;
}
/** Working-tree status, one record per section: a file edited in both the index
 * and the working tree appears once with `staged: true` and once with `false`. */
export declare function gitStatus(cwd: string): Promise<GitStatus>;
/** Commits newest first, plus a one-line summary of what is not committed yet. */
export declare function gitLog(cwd: string, limit?: number, ref?: string): Promise<Json>;
/** Local branches with their upstream and ahead/behind counts, and remote refs. */
export declare function gitBranches(cwd: string): Promise<Json>;
/** A check rollup as one word: any failure fails, anything unfinished is
 * pending, and only finished successes (or skips) pass. No checks is null. */
export declare function checkRollup(items: unknown): "passing" | "failing" | "pending" | null;
/** Open pull requests through `gh`, or `{ available: false }` when the tool is
 * missing or not signed in. A failure is a normal answer, never an error.
 * `current` is the checked-out branch's own pull request in any state (open,
 * draft, merged or closed) with its checks, which the session card shows. */
export declare function gitPulls(cwd: string): Promise<Json>;
/** Drop the cached tree after a write (commit, push) outside this module. */
export declare function invalidateTree(root: string): void;
/** One lazy directory response from a bounded repo/HEAD/status-hash snapshot.
 * Every request still validates the pane's repo and the requested path. A HEAD
 * move invalidates immediately; external working-tree edits age out after 2s.
 * Status refresh and phone mutations invalidate immediately as well. With
 * `ignored`, git-ignored folders and files at that level are added, marked. */
export declare function gitTree(cwd: string, relPath?: unknown, ignored?: boolean): Promise<Json>;
export declare function gitStage(cwd: string, paths: unknown): Promise<Json>;
export declare function gitUnstage(cwd: string, paths: unknown): Promise<Json>;
/** Destructive: tracked files go back to the index, untracked files are
 * removed. The phone confirms first; no `-d` (directories) and no `-x`. */
export declare function gitDiscard(cwd: string, paths: unknown): Promise<Json>;
