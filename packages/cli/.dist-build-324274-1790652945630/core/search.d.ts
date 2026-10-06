import type { DocRow, SqlJsDatabase } from "../shared/index.js";
/**
 * Keyword overlap fallback for when FTS5 returns no results.
 * Scans all docs (optionally filtered by project/type), scores each by
 * how many query terms appear in its content, and returns top matches.
 *
 * Shared between the MCP search tool and CLI `phren search`.
 */
export declare function keywordFallbackSearch(db: SqlJsDatabase, query: string, opts: {
    project?: string;
    type?: string;
    limit: number;
}): DocRow[] | null;
