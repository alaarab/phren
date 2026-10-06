/**
 * In-memory Hook counters: Herdr RPCs by method, process identity probes,
 * git child processes and timer ticks by name. Counting is an integer add on
 * a Map entry, so the hot paths stay as they were. Nothing here is persisted
 * and names come from the Hook's own code, never from a request.
 */
export type MetricKind = "herdr" | "identity" | "git" | "timer";
export declare class HookMetrics {
    private readonly now;
    private readonly counters;
    readonly startedAt: number;
    constructor(now?: () => number);
    count(kind: MetricKind, name: string): void;
    /**
     * Totals since start, the last complete minute, the minute in progress and
     * the average per minute since start, for each counted name.
     */
    snapshot(): Json;
    private minute;
    private roll;
}
type Json = Record<string, unknown>;
/** The Hook process's counters. */
export declare const hookMetrics: HookMetrics;
export declare const countHerdr: (method: string) => void;
export declare const countIdentity: (probe: string) => void;
export declare const countGit: (caller: string) => void;
export declare const countTick: (timer: string) => void;
export {};
