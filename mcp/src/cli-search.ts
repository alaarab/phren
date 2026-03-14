import * as fs from "fs";
import * as path from "path";
import { runtimeFile } from "./shared.js";
import { buildIndex, extractSnippet, queryDocRows, queryRows, queryEntityLinks, queryDocBySourceKey, logEntityMiss } from "./shared-index.js";
import { buildFtsQueryVariants, errorMessage, isValidProjectName } from "./utils.js";
import { keywordFallbackSearch } from "./core-search.js";

export interface SearchOptions {
  query: string;
  limit: number;
  project?: string;
  type?: string;
  showHistory?: boolean;
  fromHistory?: number;
  searchAll?: boolean;
}

interface SearchHistoryEntry {
  query: string;
  project?: string;
  type?: string;
  ts: string;
}

const MAX_HISTORY = 20;
const SEARCH_TYPE_ALIASES: Record<string, string> = {
  skills: "skill",
};
const SEARCH_TYPES = new Set([
  "claude",
  "summary",
  "findings",
  "reference",
  "task",
  "changelog",
  "canonical",
  "review-queue",
  "skill",
  "other",
]);

function historyFile(phrenPath: string): string {
  return runtimeFile(phrenPath, "search-history.jsonl");
}

export function readSearchHistory(phrenPath: string): SearchHistoryEntry[] {
  const file = historyFile(phrenPath);
  if (!fs.existsSync(file)) return [];
  try {
    return fs.readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SearchHistoryEntry);
  } catch (err: unknown) {
    if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG)) process.stderr.write(`[phren] readSearchHistory: ${errorMessage(err)}\n`);
    return [];
  }
}

function printSearchUsage() {
  console.error("Usage:");
  console.error("  phren search <query> [--project <name>] [--type <type>] [--limit <n>] [--all]");
  console.error("  phren search --project <name> [--type <type>] [--limit <n>] [--all]");
  console.error("  phren search --history                    Show recent searches");
  console.error("  phren search --from-history <n>           Re-run search #n from history");
  console.error("  type: claude|summary|findings|reference|task|changelog|canonical|review-queue|skill|other");
}

function validateAndNormalizeSearchOptions(
  phrenPath: string,
  queryParts: string[],
  project: string | undefined,
  type: string | undefined,
  limit: number,
  showHistory: boolean,
  fromHistory: number | undefined,
  searchAll: boolean,
): SearchOptions | null {
  if (showHistory) {
    return { query: "", limit, showHistory: true };
  }

  if (fromHistory !== undefined) {
    const history = readSearchHistory(phrenPath);
    if (fromHistory > history.length || fromHistory < 1) {
      console.error(`No search at position ${fromHistory}. History has ${history.length} entries.`);
      process.exit(1);
    }
    const entry = history[fromHistory - 1];
    return {
      query: entry.query,
      limit,
      project: entry.project,
      type: entry.type,
    };
  }

  if (project && !isValidProjectName(project)) {
    console.error(`Invalid project name: "${project}"`);
    process.exit(1);
  }

  let normalizedType: string | undefined;
  if (type) {
    normalizedType = SEARCH_TYPE_ALIASES[type.toLowerCase()] || type.toLowerCase();
    if (!SEARCH_TYPES.has(normalizedType)) {
      console.error(`Invalid --type value: "${type}"`);
      printSearchUsage();
      process.exit(1);
    }
  }

  const query = queryParts.join(" ").trim();
  if (!query && !project) {
    console.error("Provide a query, or pass --project to browse a project's indexed docs.");
    printSearchUsage();
    process.exit(1);
  }

  return {
    query,
    limit,
    project,
    type: normalizedType,
    searchAll,
  };
}

export function parseSearchArgs(phrenPath: string, args: string[]): SearchOptions | null {
  const queryParts: string[] = [];
  let project: string | undefined;
  let type: string | undefined;
  let limit = 10;
  let showHistory = false;
  let fromHistory: number | undefined;
  let searchAll = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      printSearchUsage();
      return null;
    }

    if (arg === "--history") {
      showHistory = true;
      continue;
    }

    if (arg === "--all") {
      limit = 100;
      searchAll = true;
      continue;
    }

    const [flag, inlineValue] = arg.startsWith("--") ? arg.split("=", 2) : [arg, undefined];
    const readValue = () => {
      if (inlineValue !== undefined) return inlineValue;
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        console.error(`Missing value for ${flag}`);
        printSearchUsage();
        process.exit(1);
      }
      i++;
      return next;
    };

    if (flag === "--project") {
      project = readValue();
      continue;
    }
    if (flag === "--type") {
      type = readValue();
      continue;
    }
    if (flag === "--limit") {
      const parsed = Number.parseInt(readValue(), 10);
      if (Number.isNaN(parsed) || parsed < 1 || parsed > 200) {
        console.error("Invalid --limit value. Use an integer between 1 and 200.");
        process.exit(1);
      }
      limit = parsed;
      continue;
    }
    if (flag === "--from-history") {
      const parsed = Number.parseInt(readValue(), 10);
      if (Number.isNaN(parsed) || parsed < 1) {
        console.error("Invalid --from-history value. Use a positive integer.");
        process.exit(1);
      }
      fromHistory = parsed;
      continue;
    }

    if (arg.startsWith("-")) {
      console.error(`Unknown search flag: ${arg}`);
      printSearchUsage();
      process.exit(1);
    }

    queryParts.push(arg);
  }

  return validateAndNormalizeSearchOptions(phrenPath, queryParts, project, type, limit, showHistory, fromHistory, searchAll);
}

function recordSearchQuery(phrenPath: string, opts: SearchOptions): void {
  if (!opts.query) return;
  const file = historyFile(phrenPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const entry: SearchHistoryEntry = {
    query: opts.query,
    ...(opts.project && { project: opts.project }),
    ...(opts.type && { type: opts.type }),
    ts: new Date().toISOString(),
  };
  let entries = readSearchHistory(phrenPath);
  entries.push(entry);
  if (entries.length > MAX_HISTORY) entries = entries.slice(-MAX_HISTORY);
  fs.writeFileSync(file, entries.map((item) => JSON.stringify(item)).join("\n") + "\n");
}

function formatSearchHistoryLines(phrenPath: string): string[] {
  const entries = readSearchHistory(phrenPath);
  if (!entries.length) return ["No search history."];

  const lines = ["Recent searches:", ""];
  entries.forEach((entry, index) => {
    const scope = [
      entry.project ? `--project ${entry.project}` : "",
      entry.type ? `--type ${entry.type}` : "",
    ].filter(Boolean).join(" ");
    const ts = entry.ts.slice(0, 16).replace("T", " ");
    lines.push(`  ${index + 1}. "${entry.query}"${scope ? " " + scope : ""}  (${ts})`);
  });
  return lines;
}

export async function runSearch(
  opts: SearchOptions,
  phrenPath: string,
  profile: string,
): Promise<{ lines: string[]; exitCode: number }> {
  if (opts.showHistory) {
    return { lines: formatSearchHistoryLines(phrenPath), exitCode: 0 };
  }

  recordSearchQuery(phrenPath, opts);
  const db = await buildIndex(phrenPath, profile);

  try {
    let sql = "SELECT project, filename, type, content, path FROM docs";
    const where: string[] = [];
    const params: Array<string | number> = [];
    let queryVariants: string[] = [];

    if (opts.query) {
      queryVariants = buildFtsQueryVariants(opts.query, opts.project, phrenPath);
      const safeQuery = queryVariants[0] ?? "";
      if (!safeQuery) {
        return { lines: ["Query empty after sanitization."], exitCode: 1 };
      }
      where.push("docs MATCH ?");
      params.push(safeQuery);
    }
    if (opts.project) {
      where.push("project = ?");
      params.push(opts.project);
    }
    if (opts.type) {
      where.push("type = ?");
      params.push(opts.type);
    }

    if (where.length > 0) {
      sql += ` WHERE ${where.join(" AND ")}`;
    }
    sql += opts.query ? " ORDER BY rank LIMIT ?" : " ORDER BY project, type, filename LIMIT ?";
    params.push(opts.limit);

    let rows = queryDocRows(db, sql, params);
    if ((!rows || rows.length === 0) && queryVariants.length > 1) {
      for (const variant of queryVariants.slice(1)) {
        const relaxedParams = [...params];
        relaxedParams[0] = variant;
        rows = queryDocRows(db, sql, relaxedParams);
        if (rows?.length) break;
      }
    }

    const lines: string[] = [];
    if (!rows && opts.query) {
      const fallbackRows = keywordFallbackSearch(db, opts.query, { project: opts.project, type: opts.type, limit: opts.limit });
      if (fallbackRows) {
        rows = fallbackRows;
        lines.push("(keyword fallback)");
      }
    }

    if (!rows) {
      if (opts.query) {
        try {
          const { logSearchMiss } = await import("./mcp-search.js");
          logSearchMiss(phrenPath, opts.query, opts.project);
        } catch (err: unknown) {
          if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG)) process.stderr.write(`[phren] search logSearchMiss: ${errorMessage(err)}\n`);
        }
      }
      const scope = [
        opts.query ? `query "${opts.query}"` : undefined,
        opts.project ? `project "${opts.project}"` : undefined,
        opts.type ? `type "${opts.type}"` : undefined,
      ].filter(Boolean).join(", ");
      return { lines: [scope ? `No results found for ${scope}.` : "No results found."], exitCode: 0 };
    }

    if (opts.project && !opts.query) {
      lines.push(`Browsing ${rows.length} document(s) in project "${opts.project}"`);
      if (opts.type) lines.push(`Type filter: ${opts.type}`);
      lines.push("");
    }

    for (const row of rows) {
      const snippet = extractSnippet(row.content, opts.query, 7);
      lines.push(`[${row.project}/${row.filename}] (${row.type})`);
      lines.push(snippet);
      lines.push("");
    }

    return { lines, exitCode: 0 };
  } catch (err: unknown) {
    return { lines: [`Search error: ${errorMessage(err)}`], exitCode: 1 };
  }
}

// ── Fragment search (parity with MCP search_fragments) ────────────────────

export async function runFragmentSearch(
  query: string,
  phrenPath: string,
  profile: string,
  opts: { project?: string; limit?: number },
): Promise<{ lines: string[]; exitCode: number }> {
  if (!query.trim()) {
    return { lines: ["Usage: phren search-fragments <query> [--project <name>] [--limit <n>]"], exitCode: 1 };
  }

  const db = await buildIndex(phrenPath, profile);
  const max = opts.limit ?? 10;
  const pattern = `%${query.toLowerCase()}%`;

  let sql: string;
  let params: (string | number)[];

  if (opts.project) {
    sql = `
      SELECT e.name, e.type, COUNT(el.source_id) as ref_count
      FROM entities e
      LEFT JOIN entity_links el ON el.target_id = e.id
      WHERE e.name LIKE ? AND el.source_doc LIKE ?
      GROUP BY e.id, e.name, e.type
      ORDER BY ref_count DESC
      LIMIT ?
    `;
    params = [pattern, `${opts.project}/%`, max];
  } else {
    sql = `
      SELECT e.name, e.type, COUNT(el.source_id) as ref_count
      FROM entities e
      LEFT JOIN entity_links el ON el.target_id = e.id
      WHERE e.name LIKE ?
      GROUP BY e.id, e.name, e.type
      ORDER BY ref_count DESC
      LIMIT ?
    `;
    params = [pattern, max];
  }

  const rows = queryRows(db, sql, params);
  if (!rows || rows.length === 0) {
    logEntityMiss(phrenPath, query, "cli_search_fragments", opts.project);
    return { lines: [`No fragments matching "${query}".`], exitCode: 0 };
  }

  const lines: string[] = [`Fragments matching "${query}" (${rows.length} result(s)):\n`];
  for (const r of rows) {
    const name = String(r[0]);
    const type = String(r[1]);
    const refCount = Number(r[2]);
    lines.push(`  ${name} (${type}) — ${refCount} reference(s)`);
  }

  return { lines, exitCode: 0 };
}

export function parseFragmentSearchArgs(args: string[]): { query: string; project?: string; limit?: number } | null {
  const queryParts: string[] = [];
  let project: string | undefined;
  let limit: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      console.error("Usage: phren search-fragments <query> [--project <name>] [--limit <n>]");
      return null;
    }
    if (arg === "--project" && args[i + 1]) {
      project = args[++i];
      continue;
    }
    if (arg === "--limit" && args[i + 1]) {
      limit = Number.parseInt(args[++i], 10);
      continue;
    }
    if (!arg.startsWith("-")) {
      queryParts.push(arg);
    }
  }

  return { query: queryParts.join(" "), project, limit };
}

// ── Related docs (parity with MCP get_related_docs) ───────────────────────

export async function runRelatedDocs(
  entity: string,
  phrenPath: string,
  profile: string,
  opts: { project?: string; limit?: number },
): Promise<{ lines: string[]; exitCode: number }> {
  if (!entity.trim()) {
    return { lines: ["Usage: phren related-docs <fragment-name> [--project <name>] [--limit <n>]"], exitCode: 1 };
  }

  const db = await buildIndex(phrenPath, profile);
  const max = opts.limit ?? 10;

  const links = queryEntityLinks(db, entity.toLowerCase());
  let relatedDocs = links.related.filter(r => r.includes("/"));

  if (opts.project) {
    relatedDocs = relatedDocs.filter(d => d.startsWith(`${opts.project}/`));
  }

  relatedDocs = relatedDocs.slice(0, max);

  if (relatedDocs.length === 0) {
    logEntityMiss(phrenPath, entity, "cli_related_docs", opts.project);
    return { lines: [`No docs found referencing fragment "${entity}".`], exitCode: 0 };
  }

  const lines: string[] = [`Docs referencing "${entity}" (${relatedDocs.length} result(s)):\n`];
  for (const doc of relatedDocs) {
    const docRow = queryDocBySourceKey(db, phrenPath, doc);
    const snippet = docRow?.content ? docRow.content.slice(0, 120).replace(/\n/g, " ").trim() : "";
    lines.push(`  [${doc}]`);
    if (snippet) lines.push(`    ${snippet}...`);
  }

  return { lines, exitCode: 0 };
}

export function parseRelatedDocsArgs(args: string[]): { entity: string; project?: string; limit?: number } | null {
  const entityParts: string[] = [];
  let project: string | undefined;
  let limit: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      console.error("Usage: phren related-docs <fragment-name> [--project <name>] [--limit <n>]");
      return null;
    }
    if (arg === "--project" && args[i + 1]) {
      project = args[++i];
      continue;
    }
    if (arg === "--limit" && args[i + 1]) {
      limit = Number.parseInt(args[++i], 10);
      continue;
    }
    if (!arg.startsWith("-")) {
      entityParts.push(arg);
    }
  }

  return { entity: entityParts.join(" "), project, limit };
}
