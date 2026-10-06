import type { RunStoreGit } from "../sync/store-merge.js";
export interface TaskWriteReceipt {
    path: string;
    /** A verified commit containing this write, or null if none was observed. */
    commit: string | null;
}
/** Scope receipts to one queued mutation, including its asynchronous claim sync. */
export declare function captureTaskWrites<T>(fn: () => Promise<T>): Promise<{
    result: T;
    write: TaskWriteReceipt | null;
}>;
/** Called only after the task file's atomic rename succeeds. */
export declare function recordTaskWrite(file: string, content: string): void;
/**
 * Observe commits made by task claim sync without changing when it commits.
 * Keep the autosave's hash even if a later fetch/merge moves HEAD or push fails.
 * Reading HEAD alone would also acknowledge unrelated or failed commits.
 */
export declare function trackTaskWriteCommits(git: RunStoreGit): RunStoreGit;
