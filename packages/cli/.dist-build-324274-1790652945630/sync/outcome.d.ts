type RunGit = (cwd: string, args: string[]) => Promise<{
    ok: boolean;
    output?: string;
    error?: string;
}>;
export interface AheadBehind {
    ahead: number;
    behind: number;
}
/** Commits on each side of the upstream, from the last fetched tracking ref. Undefined without an upstream. */
export declare function aheadBehind(cwd: string, git: RunGit): Promise<AheadBehind | undefined>;
/** The first non-empty line of an error, bounded, for logs and one-line status text. */
export declare function firstLine(text: string | undefined, max?: number): string;
export declare function formatCounts(counts: Partial<AheadBehind> | undefined): string;
/** Appends `[time] <source>: ok|failed <reason> (ahead N, behind M)` to the store's background-sync.log. */
export declare function logSyncOutcome(phrenPath: string, source: string, outcome: {
    ok: boolean;
    detail?: string;
    counts?: AheadBehind;
}): void;
export declare function appendSyncLog(phrenPath: string, source: string, detail: string): void;
/**
 * What doctor's runtime-auto-save check says: a failure names its first
 * error line and the ahead/behind counts instead of only "sync-failed".
 */
export declare function describeAutoSave(autoSave: {
    status?: string;
    detail?: string;
    at?: string;
} | undefined, sync: {
    ahead?: number;
    behind?: number;
} | undefined): string;
export {};
