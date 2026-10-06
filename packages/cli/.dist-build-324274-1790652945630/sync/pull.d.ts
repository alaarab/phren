import { type GitResult, type RunStoreGit } from "./store-merge.js";
export declare const DEFAULT_PULL_INTERVAL_SECONDS = 0;
export declare const MIN_PULL_INTERVAL_SECONDS = 30;
export declare const MAX_PULL_INTERVAL_SECONDS = 86400;
export declare function parsePullInterval(value: unknown): number | undefined;
export declare function resolvePullInterval(phrenPath: string, env?: NodeJS.ProcessEnv): number;
export declare function periodicPullEnabled(phrenPath: string): boolean;
export type RunGit = RunStoreGit;
export type { GitResult };
export declare const runPollGit: RunGit;
interface PollState {
    checkedAt?: number;
    failures?: number;
    status?: string;
    detail?: string;
}
export interface PullResult {
    status: "unchanged" | "updated" | "deferred" | "error" | "not-due";
    detail: string;
}
/**
 * A missing state file is a first check. A corrupt one is logged and moved
 * aside (kept for inspection) so the next check starts clean instead of
 * silently resetting the backoff on every poll.
 */
export declare function readPollState(phrenPath: string): PollState;
/** Shared timestamps + a process lock give all MCP clients one check per store/interval. */
export declare function pollStore(phrenPath: string, seconds: number, git?: RunGit, now?: number): Promise<PullResult>;
interface PollingOptions {
    onChange: () => Promise<void>;
    /** Share the MCP write queue so background updates cannot overlap its writes. */
    runExclusive: (fn: () => Promise<void>) => Promise<unknown>;
    git?: RunGit;
}
export declare function startPullPolling(phrenPath: string, options: PollingOptions): {
    stop: () => Promise<void>;
};
