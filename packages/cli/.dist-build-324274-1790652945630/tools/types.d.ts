import type { SqlJsDatabase } from "../shared/index.js";
import { type StoreEntry } from "../store-registry.js";
export interface McpContext {
    phrenPath: string;
    profile: string;
    db: () => SqlJsDatabase;
    rebuildIndex: () => Promise<void>;
    updateFileInIndex: (filePath: string) => void;
    withWriteQueue: <T>(fn: () => Promise<T>) => Promise<T | {
        content: {
            type: "text";
            text: string;
        }[];
    }>;
}
/**
 * How the caller intends to use the resolved store.
 *
 * - `"write"` (default) — the resolution must be exact. If a store claims the
 *   project but is not attached on this machine, resolution **fails loudly**
 *   rather than silently redirecting the write somewhere else.
 * - `"read"` — the caller only reads. Missing team stores degrade to the
 *   primary store so search/list surfaces keep working offline; nothing leaves
 *   the machine, so a wrong answer here is a gap, not a leak.
 *
 * Defaulting to `"write"` is deliberate: an unclassified call site should get
 * the safe behavior, not the lossy one.
 */
export type StoreAccessMode = "read" | "write";
/**
 * Error raised when a project is claimed by a store that is attached on this
 * machine but whose directory is missing. Distinct class so callers
 * can special-case it if they ever want to offer an interactive fix.
 */
export declare class StoreUnavailableError extends Error {
    readonly storeName: string;
    readonly storePath: string;
    constructor(store: StoreEntry, project: string);
}
/**
 * Resolve the effective phrenPath and bare project name for a project input.
 * Handles store-qualified names ("store/project") by routing to the correct store.
 * Returns the primary store path for bare names that no store claims.
 *
 * Note on the bare-name path: a store that claims the project but is missing
 * locally used to fall through to the primary store, which quietly relocated
 * team-store projects into the user's personal store. That fallback is gone for
 * writes — see {@link StoreAccessMode}.
 */
export declare function resolveStoreForProject(ctx: McpContext, projectInput: string, mode?: StoreAccessMode): {
    phrenPath: string;
    project: string;
    storeRole: string;
};
/**
 * Standardized MCP tool response payload, based on PhrenResult conventions.
 * - ok: true  → data is present, message is optional display text
 * - ok: false → error is present, data may carry diagnostic info
 *
 * Accepts `boolean` for ok (not just literals) to support computed expressions
 * like `ok: added.length > 0`. All MCP tool handlers use this type.
 */
interface McpToolResult {
    ok: boolean;
    data?: unknown;
    error?: string;
    errorCode?: string;
    message?: string;
}
/**
 * Convert an McpToolResult into the MCP SDK response format.
 * Single shared implementation — replaces the per-file jsonResponse() duplicates.
 */
export declare function mcpResponse(payload: McpToolResult): {
    content: {
        type: "text";
        text: string;
    }[];
};
export {};
