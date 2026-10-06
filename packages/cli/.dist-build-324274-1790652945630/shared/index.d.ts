import { type SqlJsDatabase } from "../index-query.js";
export { porterStem } from "./stemmer.js";
export { cosineFallback } from "./search-fallback.js";
export { queryFragmentLinks, getFragmentBoostDocs, ensureGlobalEntitiesTable, queryCrossProjectFragments, logFragmentMiss, extractFragmentNames, } from "./fragment-graph.js";
export { buildSourceDocKey, decodeFiniteNumber, decodeStringRow, extractSnippet, getDocSourceKey, normalizeMemoryId, queryDocBySourceKey, queryDocRows, queryRows, rowToDoc, rowToDocWithRowid, } from "../index-query.js";
export type { SqlValue, DbRow, DocRow, SqlJsDatabase } from "../index-query.js";
/** Drain pending embeddings immediately (used by the MCP server's graceful shutdown). */
export declare function flushEmbeddingQueue(): Promise<void>;
export declare function classifyFile(filename: string, relPath: string): string;
/**
 * Resolve `@import shared/file.md` directives in document content.
 * The import path is resolved relative to the phren root (e.g. `shared/foo.md` -> `~/.phren/global/shared/foo.md`).
 * Circular imports are detected and skipped. Depth is capped to prevent runaway recursion.
 */
/** @internal Exported for tests. */
export declare function resolveImports(content: string, phrenPath: string): string;
export declare function listIndexedDocumentPaths(phrenPath: string, profile?: string): string[];
export declare function normalizeIndexedContent(content: string, type: string, phrenPath: string, maxChars?: number): string;
/**
 * Incrementally update a single file in the FTS index.
 * Deletes the old record for the file, re-reads and re-inserts it.
 * Touches the sentinel file to invalidate caches.
 */
export declare function updateFileInIndex(db: SqlJsDatabase, filePath: string, phrenPath: string): void;
export declare function buildIndex(phrenPath: string, profile?: string, options?: {
    force?: boolean;
}): Promise<SqlJsDatabase>;
/**
 * @internal Exported for tests. The prune is a one-shot per process, so a test
 * that needs to set up state *after* a build (which consumes it) has no other
 * way to exercise the pruning logic a second time.
 */
export declare function __resetFtsCachePruneGuardForTests(): void;
/**
 * Non-blocking index loader for the UserPromptSubmit / PostToolUse hooks.
 * Unlike buildIndex(), this NEVER blocks a hook on a 2-12s rebuild:
 *   - exact stat-hash cache hit → serve it immediately (fast path);
 *   - miss but a usable (possibly stale) cache exists → serve the stale snapshot
 *     now and kick a *detached* `background-reindex` (deduped by the rebuild
 *     lock) so the next prompt gets fresh results. A single prompt's context may
 *     lag one write — far better than freezing the prompt;
 *   - cold start (no cache at all) → block once on a full build so the very first
 *     prompt isn't empty.
 * Freshness stays correct over time: an edit bumps mtime → new stat-hash → this
 * misses → a rebuild is scheduled → the following prompt hits the new cache.
 */
export declare function loadIndexForHook(phrenPath: string, profile?: string): Promise<SqlJsDatabase>;
/** Find the FTS cache file for a specific phrenPath+profile. Returns exists + size. */
export declare function findFtsCacheForPath(phrenPath: string, profile?: string): {
    exists: boolean;
    sizeBytes?: number;
};
export declare function detectProject(phrenPath: string, cwd: string, profile?: string): string | null;
