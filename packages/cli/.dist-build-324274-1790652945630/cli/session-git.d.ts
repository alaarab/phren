import { type RunStoreGit } from "../sync/store-merge.js";
import { type AheadBehind } from "../sync/outcome.js";
export interface GitContext {
    branch: string;
    changedFiles: Set<string>;
}
export declare function getGitContext(cwd?: string): GitContext | null;
export declare function runBestEffortGit(args: string[], cwd: string): Promise<{
    ok: boolean;
    output?: string;
    error?: string;
}>;
/**
 * True when local HEAD and the tracking branch share no common ancestor.
 *
 * This is what happens when a store's remote is re-initialized: every
 * an ordinary pull cannot reconcile it, and the next commit re-enters the
 * same loop forever. A generic "pull failed" sends the user chasing
 * network problems, so it is worth naming — no retry will ever fix it.
 *
 * Returns false when there is no upstream, or when git cannot answer; callers
 * treat that as "some other failure" and report the raw error instead.
 */
export declare function hasUnrelatedHistories(cwd: string): Promise<boolean>;
/**
 * Files phren is allowed to auto-stage in a team store. Anything not in this
 * list (notably `.runtime/`, secrets, build output) is skipped on session-stop
 * and `push_changes`.
 */
export declare const TEAM_STORE_PATHSPECS: readonly ["*/journal/*", "*/tasks.md", "*/truths.md", "*/FINDINGS.md", "*/FINDINGS.md.bak", "*/summary.md", "*/review.md", "*/AGENTS.md", "*/topic-config.json", "*/phren.project.yaml", "*/reference/**", "*/skills/**", "*/notes/**", ".phren-team.yaml"];
export declare function countUnsyncedCommits(cwd: string): Promise<number>;
/** Startup pulls share the store's Git lock and never rewrite local commits. */
export declare function pullAtSessionStart(cwd: string, git?: RunStoreGit, now?: number): Promise<{
    ok: boolean;
    output?: string;
    error?: string;
    counts?: AheadBehind;
}>;
export declare function recoverPushConflict(cwd: string): Promise<{
    ok: boolean;
    detail: string;
    pullStatus: "ok" | "error";
    pullDetail: string;
}>;
