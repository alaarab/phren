import { STOP_WORDS } from "./utils.js";
import { queryRows, type DbRow } from "./shared-index.js";
import type { SqlJsDatabase } from "./shared-index.js";

/**
 * Keyword overlap fallback for when FTS5 returns no results.
 * Scans all docs (optionally filtered by project/type), scores each by
 * how many query terms appear in its content, and returns top matches.
 *
 * Shared between the MCP search tool and CLI `cortex search`.
 */
export function keywordFallbackSearch(
  db: SqlJsDatabase,
  query: string,
  opts: { project?: string; type?: string; limit: number }
): DbRow[] | null {
  let fallbackSql = "SELECT project, filename, type, content, path FROM docs";
  const fallbackParams: (string | number)[] = [];
  const clauses: string[] = [];
  if (opts.project) {
    clauses.push("project = ?");
    fallbackParams.push(opts.project);
  }
  if (opts.type) {
    clauses.push("type = ?");
    fallbackParams.push(opts.type);
  }
  if (clauses.length) fallbackSql += " WHERE " + clauses.join(" AND ");

  const allRows = queryRows(db, fallbackSql, fallbackParams);
  if (!allRows) return null;

  const terms = query
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w));

  if (terms.length === 0) return null;

  const scored = allRows
    .map((row: DbRow) => {
      const content = (row[3] as string).toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (content.includes(term)) score++;
      }
      return { row, score };
    })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit);

  if (scored.length === 0) return null;
  return scored.map(s => s.row);
}
