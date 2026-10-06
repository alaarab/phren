import type { RunStoreGit } from "./store-merge.js";
export declare const AUTH_BACKOFF_INITIAL_MS: number;
export declare const AUTH_BACKOFF_MAX_MS: number;
export declare const AUTH_UNREGISTER_AFTER_MS: number;
export interface StoreAuthFailure {
    remote: string;
    remoteName: string;
    firstFailedAt: number;
    lastFailedAt: number;
    failures: number;
    retryAt: number;
}
export declare function isGitAuthFailure(error: unknown): boolean;
export declare function readStoreAuthFailure(cwd: string): StoreAuthFailure | undefined;
export declare function clearStoreAuthFailure(cwd: string): void;
/** Read Git's effective URL, including insteadOf rewrites, without contacting it. */
export declare function storeSyncRemote(cwd: string, name?: string, push?: boolean): {
    remoteName: string;
    remote: string;
} | undefined;
/** Changing the configured remote immediately releases the old credential block. */
export declare function activeStoreAuthFailure(cwd: string): StoreAuthFailure | undefined;
export declare function authBackoffActive(state: StoreAuthFailure | undefined, now?: number): boolean;
export declare function storeAuthDetail(state: StoreAuthFailure): string;
export declare function recordStoreAuthFailure(cwd: string, remoteName: string, remote: string, now?: number): StoreAuthFailure;
/** Only transport failures affect credentials; local merge errors never do. */
export declare function withStoreAuthBackoff(git: RunStoreGit, now?: () => number): RunStoreGit;
