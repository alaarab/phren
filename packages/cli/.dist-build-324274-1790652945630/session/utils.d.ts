export { sessionsDir } from "../phren-paths.js";
/**
 * Write JSON to a file atomically using temp-file + rename.
 * Ensures the parent directory exists before writing.
 */
export declare function atomicWriteJson(filePath: string, data: unknown): void;
export interface SessionState {
    sessionId: string;
    project?: string;
    agentScope?: string;
    startedAt: string;
    endedAt?: string;
    summary?: string;
    findingsAdded: number;
    tasksCompleted: number;
    /** When true, this session was created by a lifecycle hook, not an explicit MCP call. */
    hookCreated?: boolean;
    /** When true, this session was created by the coding agent runtime. */
    agentCreated?: boolean;
}
export declare function runtimeSessionsDir(phrenPath: string): string;
export declare function sessionFileForId(phrenPath: string, sessionId: string): string;
export declare function isSessionStateFileName(name: string): boolean;
export declare function readSessionStateFile(file: string): SessionState | null;
export declare function writeSessionStateFile(file: string, state: SessionState): void;
/**
 * Log an error to stderr when PHREN_DEBUG is enabled.
 * Centralises the repeated `if (PHREN_DEBUG) stderr.write(...)` pattern.
 */
export declare function debugError(scope: string, err: unknown): void;
interface SessionFileEntry<T> {
    fullPath: string;
    data: T;
    mtimeMs: number;
}
/**
 * Enumerate all `session-*.json` files under `dir`, parse each one via `parse`,
 * and keep entries where `filter` returns true.
 *
 * Returns an array of `{ fullPath, data, mtimeMs }` sorted newest-mtime-first.
 * `includeMtime` controls whether `fs.statSync` is called (some callers don't need it).
 */
export declare function scanSessionFiles<T>(dir: string, parse: (filePath: string) => T | null, filter: (data: T, fullPath: string) => boolean, opts?: {
    includeMtime?: boolean;
    errorScope?: string;
}): SessionFileEntry<T>[];
