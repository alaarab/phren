/**
 * Tail the live lookup-events log.
 *
 * `.runtime/lookup-events.jsonl` is append-only: every memory phren lands on
 * during a search, and every memory a hook injects, is written as one JSON
 * line. Two hosts follow it live — the web UI's Activity stream and the
 * shell's graph watch mode — so the read-only tailing logic lives here once.
 *
 * Reads only the bytes appended since the last poll, which is far more robust
 * across platforms than fs.watch, and survives the file being rotated or
 * truncated underneath it.
 */
import type { LookupEvent } from "../governance/activity.js";
export interface LookupTailOptions {
    /**
     * Start at the current end of the file so only events appended after
     * construction are delivered. Callers wanting history use
     * `readRecentLookups` for the backfill. Default true.
     */
    fromEnd?: boolean;
}
export declare class LookupTail {
    private readonly logPath;
    private offset;
    private carry;
    constructor(logPath: string, opts?: LookupTailOptions);
    /**
     * Raw JSON lines appended since the last poll, each already validated as
     * parseable. Never throws: a logging or read failure yields nothing rather
     * than breaking the caller's render or stream.
     */
    pollLines(): string[];
    /** Parsed events appended since the last poll. */
    poll(): LookupEvent[];
}
