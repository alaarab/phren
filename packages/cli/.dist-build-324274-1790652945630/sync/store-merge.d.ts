export interface GitResult {
    ok: boolean;
    output: string;
    error?: string;
}
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
/**
 * Fetch and integrate a store's configured upstream without rebasing local
 * commits. Conflicts in tasks.md (per task id against the merge base), the
 * generated summary and topic blocks, findings and the task archive resolve
 * automatically (see conflict-resolve.ts). Any other conflict aborts the
 * merge and names its files.
 */
export declare function mergeStoreUpstream(cwd: string, options: StoreMergeOptions): Promise<StoreMergeResult>;
