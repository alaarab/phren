/** A bounded process pool. Cancelled waiters never start work. */
export declare class ProcessPool {
    private readonly limit;
    private active;
    private waiting;
    constructor(limit: number);
    run<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T>;
}
/** Shared by workspace and tab creation, including agent startup. */
export declare class LaunchLimiter {
    private readonly now;
    private active;
    private starts;
    constructor(now?: () => number);
    run<T>(work: () => Promise<T>): Promise<T>;
}
/** A millisecond interval read once at startup from the environment variable
 * `name`, when it is a number within `[min, max]`; otherwise `fallback`.
 * Tests shorten these. */
export declare function intervalFromEnv(name: string, fallback: number, min?: number, max?: number): number;
