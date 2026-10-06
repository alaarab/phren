/**
 * A single "lookup event" — emitted each time a memory search lands on a result.
 * Powers the live activity feed in the web UI (SSE) and the VS Code extension
 * (file watcher). Kept deliberately compact so the JSONL stays cheap to tail.
 */
export interface LookupEvent {
    /** ISO timestamp of when the lookup happened. */
    at: string;
    /** The search query that surfaced this memory. */
    query: string;
    /** Project the memory belongs to. */
    project: string;
    /** Memory filename (e.g. "findings.md", "reference/api/auth.md"). */
    filename: string;
    /** Doc type: findings, reference, summary, task, skill, claude. */
    type: string;
    /** Source key / path of the memory, when available. */
    path?: string;
    /** Precomputed graph node id for this hit (e.g. a specific finding), when resolvable. */
    nodeId?: string;
    /** Short snippet of the matched content. */
    snippet?: string;
    /** What triggered the lookup: "search" (MCP search) | "inject" (hook). */
    source: string;
    /** Originating session id, when known. */
    session?: string;
}
/**
 * Append one or more lookup events to the live log. Best-effort: a logging
 * failure must never break a search, so all errors are swallowed (debug-logged).
 */
export declare function recordLookupEvents(phrenPath: string, events: Array<Omit<LookupEvent, "at"> & {
    at?: string;
}>): void;
/** Read the most recent lookup events (newest first), parsed from the JSONL log. */
export declare function readRecentLookups(phrenPath: string, limit?: number): LookupEvent[];
