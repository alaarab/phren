import type { SqlJsDatabase } from "./index.js";
/** @internal Exported for tests. */
export declare function escapeRegex(s: string): string;
/** Escape SQL LIKE wildcard characters so user input is treated literally.
 * @internal Exported for tests. */
export declare function escapeLike(s: string): string;
/**
 * Log fragment resolution misses to .runtime/fragment-misses.jsonl.
 *
 * Judgment criteria — what's worth capturing vs noise:
 * - Worth capturing: repeated lookups for the same fragment name (indicates a gap
 *   in the fragment graph that the user keeps hitting), fragment names that look like
 *   real library/tool names (not random query fragments).
 * - Noise: single one-off lookups for short generic terms, lookups that fail
 *   because the query was malformed. We filter these by requiring name.length > 2.
 *
 * Gated by PHREN_DEBUG (or PHREN_DEBUG for compat) to avoid disk writes for
 * regular users. The miss log is append-only JSONL so downstream tooling can
 * detect repeated patterns (e.g. "fragment X was looked up 5 times but never
 * found" -> suggest adding it).
 */
export declare function logFragmentMiss(phrenPath: string, name: string, context: string, project?: string): void;
/**
 * Lightweight synchronous fragment extraction from text — regex only, no DB writes.
 * Used by add_finding to surface detected fragments in the MCP response without
 * requiring a DB reference in the write path. Full DB linking happens on the next
 * index rebuild, which is triggered automatically after every add_finding call via
 * updateFileInIndex -> extractAndLinkFragments.
 */
export declare function extractFragmentNames(content: string): string[];
/**
 * Ensure the global_entities cross-project index table exists.
 * Called during buildIndex to enable cross-project fragment queries.
 */
export declare function ensureGlobalEntitiesTable(db: SqlJsDatabase): void;
/**
 * Prime AGENTS.md fragments per project for a single build pass.
 * During an active build, extractAndLinkFragments resolves user fragments from this
 * in-memory map and avoids per-file sync stat/read calls.
 */
export declare function beginUserFragmentBuildCache(phrenPath: string, projects: Iterable<string>): void;
/** End a build-scoped cache created by beginUserFragmentBuildCache(). */
export declare function endUserFragmentBuildCache(phrenPath: string): void;
export declare function extractAndLinkFragments(db: SqlJsDatabase, content: string, sourceDoc: string, phrenPath?: string): void;
/**
 * Query related fragments for a given name.
 */
export declare function queryFragmentLinks(db: SqlJsDatabase, name: string): {
    related: string[];
};
/**
 * Query cross-project fragment relationships.
 * Returns projects and docs that share fragments with the given query.
 */
export declare function queryCrossProjectFragments(db: SqlJsDatabase, fragmentName: string, excludeProject?: string): Array<{
    fragment: string;
    project: string;
    docKey: string;
}>;
export declare function getFragmentBoostDocs(db: SqlJsDatabase, query: string): Set<string>;
