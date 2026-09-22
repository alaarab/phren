import * as fs from "node:fs";
import * as path from "node:path";
import type { SqlJsDatabase, SqlValue } from "@phren/cli/code-host/index-query";
import { getProjectSourcePath, readProjectConfig } from "@phren/cli/code-host/project-config";
import { blameFor, codeDatabasePath, getMeta, openCodeDatabase, rowsOf, numberAt, stringAt } from "./store.js";

/**
 * Read-side queries over the code index.
 *
 * Everything here opens the project's SQLite read-only and returns plain
 * objects; the MCP tools and the `phren code` subcommands are thin formatters
 * on top. Ranking and name resolution live here rather than in SQL so a query
 * is one place to change.
 *
 * Every function takes the store and the project first, matching the
 * `codeIndexStatus(store, project, top)` shape. `available: false` means the
 * project has no index yet and the caller should tell the user to run
 * `phren code index`.
 */

export interface QueryResult<T> {
  available: boolean;
  databasePath: string;
  value: T;
}

export interface SymbolHit {
  id: number;
  name: string;
  kind: string;
  file: string;
  line: number;
  endLine: number;
  signature: string;
  doc: string;
  parent: string | null;
  exported: boolean;
  uses: number;
  /** FTS5 bm25 score when the symbol matched the full-text query, else undefined. */
  rank?: number;
}

export interface SymbolDefinition {
  symbol: SymbolHit;
  /** How many symbols shared the resolved name; more than one is common-name noise. */
  candidates: number;
  /** The definition's own lines (at most 40), when the source checkout is reachable. */
  snippet: string;
  blame?: { authorHash: string; at: string };
}

export interface ReferenceGroup {
  file: string;
  references: Array<{ line: number; kind: string }>;
}

export interface ReferenceResult {
  symbol: SymbolHit;
  candidates: number;
  groups: ReferenceGroup[];
  total: number;
}

export interface OutlineEntry {
  name: string;
  kind: string;
  line: number;
  endLine: number;
  signature: string;
  doc: string;
  exported: boolean;
  uses: number;
  children: OutlineEntry[];
}

export interface UsageEntry {
  name: string;
  kind: string;
  file: string;
  line: number;
  exported: boolean;
  uses: number;
}

export interface UsageResult {
  top: UsageEntry[];
  bottom: UsageEntry[];
}

const MAX_SNIPPET_LINES = 40;

// ── sql.js row helpers ───────────────────────────────────────────────────────

function boolAt(row: SqlValue[], index: number): boolean {
  return numberAt(row, index) !== 0;
}

// `s.` prefix so the same projection composes with joins and subqueries.
const SYMBOL_COLUMNS =
  `s.id, s.name, s.kind, s.file, s.line, s.end_line, s.signature, s.doc, s.parent, s.exported,
   (SELECT COUNT(*) FROM "references" r WHERE r.symbol_id = s.id) AS uses`;

function mapSymbol(row: SqlValue[], rank?: number): SymbolHit {
  return {
    id: numberAt(row, 0),
    name: stringAt(row, 1),
    kind: stringAt(row, 2),
    file: stringAt(row, 3),
    line: numberAt(row, 4),
    endLine: numberAt(row, 5),
    signature: stringAt(row, 6),
    doc: stringAt(row, 7),
    parent: row[8] === null || row[8] === undefined ? null : stringAt(row, 8),
    exported: boolAt(row, 9),
    uses: numberAt(row, 10),
    ...(rank === undefined ? {} : { rank }),
  };
}

function mapUsage(row: SqlValue[]): UsageEntry {
  return {
    name: stringAt(row, 0),
    file: stringAt(row, 1),
    kind: stringAt(row, 2),
    line: numberAt(row, 3),
    exported: boolAt(row, 4),
    uses: numberAt(row, 5),
  };
}

const USAGE_COLUMNS =
  `s.name, s.file, s.kind, s.line, s.exported,
   (SELECT COUNT(*) FROM "references" r WHERE r.symbol_id = s.id) AS uses`;

// ── Name matching ────────────────────────────────────────────────────────────

/**
 * `Foo`, `Foo.bar` and `bar()` all name a symbol. A dotted name means the
 * symbol is a member of `Foo`, which narrows resolution to that container.
 */
export function parseSymbolQuery(symbol: string): { name: string; container?: string } {
  let text = symbol.trim();
  text = text.replace(/\(\)$/, "");
  const dot = text.lastIndexOf(".");
  if (dot > 0) return { container: text.slice(0, dot), name: text.slice(dot + 1) };
  return { name: text };
}

function symbolRowsByName(db: SqlJsDatabase, name: string): SymbolHit[] {
  return rowsOf(
    db,
    `SELECT ${SYMBOL_COLUMNS} FROM symbols s WHERE s.name = ? COLLATE NOCASE`,
    [name],
  ).map(row => mapSymbol(row));
}

/**
 * Pick one symbol out of the candidates that share a name.
 *
 * A common name belongs to several symbols; the useful answer prefers an
 * exported declaration and a callable kind over a private local variable, then
 * the most-used, and only then falls back to file order so the result is
 * stable. The caller reports how many candidates there were.
 */
export function pickSymbol(rows: SymbolHit[], container?: string): { chosen?: SymbolHit; candidates: number } {
  let pool = rows;
  if (container) {
    const inContainer = rows.filter(row => row.parent === container);
    pool = inContainer;
  }
  const sorted = [...pool].sort((a, b) => {
    if (a.exported !== b.exported) return Number(b.exported) - Number(a.exported);
    const aVariable = a.kind === "variable" ? 1 : 0;
    const bVariable = b.kind === "variable" ? 1 : 0;
    if (aVariable !== bVariable) return aVariable - bVariable;
    if (a.uses !== b.uses) return b.uses - a.uses;
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    return a.line - b.line;
  });
  return { chosen: sorted[0], candidates: pool.length };
}

/**
 * Resolve one symbol name against an already-open index.
 *
 * Used by the memory link to turn a finding's text (or an explicit citation)
 * into a symbol without opening the database per candidate. Returns the chosen
 * hit and how many symbols shared the name, exactly as `definition` does.
 */
export function resolveSymbol(db: SqlJsDatabase, symbol: string): { chosen?: SymbolHit; candidates: number } {
  const separator = symbol.lastIndexOf("::");
  const file = separator < 0 ? undefined : symbol.slice(0, separator);
  const parsed = parseSymbolQuery(separator < 0 ? symbol : symbol.slice(separator + 2));
  const rows = symbolRowsByName(db, parsed.name).filter(row => file === undefined || row.file === file);
  return pickSymbol(rows, parsed.container);
}

// ── SQLite plumbing ──────────────────────────────────────────────────────────

async function withCodeDb<T>(
  store: string,
  project: string,
  fn: (db: SqlJsDatabase) => T,
): Promise<QueryResult<T | undefined>> {
  const databasePath = codeDatabasePath(store, project);
  const database = await openCodeDatabase(store, project, false);
  if (!database) return { available: false, databasePath, value: undefined };
  try {
    return { available: true, databasePath, value: fn(database.db) };
  } finally {
    database.close();
  }
}

function resolveQueryRepoRoot(db: SqlJsDatabase, store: string, project: string): string | undefined {
  const recorded = getMeta(db, "repo_root");
  if (recorded) return recorded;
  try {
    return getProjectSourcePath(store, project, readProjectConfig(store, project));
  } catch {
    return undefined;
  }
}

function readSnippet(repoRoot: string | undefined, file: string, line: number, endLine: number): string {
  if (!repoRoot) return "";
  try {
    const lines = fs.readFileSync(path.join(repoRoot, file), "utf8").split("\n");
    const start = Math.max(0, line - 1);
    const last = Math.min(endLine, line + MAX_SNIPPET_LINES - 1);
    return lines.slice(start, Math.min(lines.length, last)).join("\n");
  } catch {
    return "";
  }
}

// ── Search ───────────────────────────────────────────────────────────────────

/** Split a user query into FTS5 prefix terms; returns "" when nothing usable remains. */
function ftsQuery(text: string): string {
  return (text.match(/[A-Za-z0-9_$]+/g) ?? []).map(token => `"${token}"*`).join(" ");
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, match => `\\${match}`);
}

/**
 * Ranked symbol search.
 *
 * Order is exact name, then prefix, then FTS5 bm25 over name/signature/doc,
 * then usage count, exactly as docs/code-index.md specifies. FTS scoring
 * is optional so a query with no usable tokens still matches by name.
 */
export async function search(
  store: string,
  project: string,
  query: string,
  kind?: string,
  limit = 20,
  directory?: string,
): Promise<QueryResult<SymbolHit[]>> {
  const trimmed = query.trim();
  const result = await withCodeDb(store, project, db => {
    if (!trimmed) return [] as SymbolHit[];
    const fts = ftsQuery(trimmed);
    const params: SqlValue[] = [];
    // Score the FTS result set once. A correlated bm25 subquery repeats
    // the match work for every candidate, quadratic on broad prefixes.
    // Keep final locale-aware ordering below, including non-ASCII names.
    const ranks = new Map<number, number>();
    const conditions: string[] = [];
    if (fts) {
      for (const row of rowsOf(db, "SELECT rowid, bm25(symbols_fts) FROM symbols_fts WHERE symbols_fts MATCH ?", [fts])) {
        ranks.set(numberAt(row, 0), numberAt(row, 1));
      }
      conditions.push(`(LOWER(s.name) = LOWER(?) OR LOWER(s.name) LIKE LOWER(?) ESCAPE '\\' OR s.id IN (SELECT rowid FROM symbols_fts WHERE symbols_fts MATCH ?))`);
      params.push(trimmed, `${escapeLike(trimmed.toLowerCase())}%`, fts);
    } else {
      conditions.push(`(LOWER(s.name) = LOWER(?) OR LOWER(s.name) LIKE LOWER(?) ESCAPE '\\')`);
      params.push(trimmed, `${escapeLike(trimmed.toLowerCase())}%`);
    }
    addCodeFilters(conditions, params, { kind, directory });
    const rows = rowsOf(db, `SELECT ${SYMBOL_COLUMNS} FROM symbols s WHERE ${conditions.join(" AND ")}`, params);
    const hits = rows.map(row => mapSymbol(row, ranks.get(numberAt(row, 0))));
    const lowered = trimmed.toLowerCase();
    hits.sort((a, b) => {
      const aExact = a.name.toLowerCase() === lowered ? 1 : 0;
      const bExact = b.name.toLowerCase() === lowered ? 1 : 0;
      if (aExact !== bExact) return bExact - aExact;
      const aPrefix = a.name.toLowerCase().startsWith(lowered) ? 1 : 0;
      const bPrefix = b.name.toLowerCase().startsWith(lowered) ? 1 : 0;
      if (aPrefix !== bPrefix) return bPrefix - aPrefix;
      const aRank = a.rank ?? Number.POSITIVE_INFINITY;
      const bRank = b.rank ?? Number.POSITIVE_INFINITY;
      if (aRank !== bRank) return aRank - bRank;
      if (a.uses !== b.uses) return b.uses - a.uses;
      if (a.name !== b.name) return a.name.localeCompare(b.name);
      if (a.file !== b.file) return a.file.localeCompare(b.file);
      return a.line - b.line;
    });
    return hits.slice(0, Math.max(1, limit));
  });
  return { available: result.available, databasePath: result.databasePath, value: result.value ?? [] };
}

// ── Definition ───────────────────────────────────────────────────────────────

export async function definition(
  store: string,
  project: string,
  symbol: string,
): Promise<QueryResult<SymbolDefinition | undefined>> {
  return withCodeDb(store, project, db => {
    const { chosen, candidates } = resolveSymbol(db, symbol);
    if (!chosen) return undefined;
    const repoRoot = resolveQueryRepoRoot(db, store, project);
    return {
      symbol: chosen,
      candidates,
      snippet: readSnippet(repoRoot, chosen.file, chosen.line, chosen.endLine),
      blame: blameFor(db, chosen.file, chosen.line),
    };
  });
}

// ── References ───────────────────────────────────────────────────────────────

export async function references(
  store: string,
  project: string,
  symbol: string,
  limit = 200,
): Promise<QueryResult<ReferenceResult | undefined>> {
  return withCodeDb(store, project, db => {
    const { chosen, candidates } = resolveSymbol(db, symbol);
    if (!chosen) return undefined;
    const total = rowsOf(db, `SELECT COUNT(*) FROM "references" WHERE symbol_id = ?`, [chosen.id]);
    const refs = rowsOf(
      db,
      `SELECT file, line, kind FROM "references" WHERE symbol_id = ? ORDER BY file ASC, line ASC LIMIT ?`,
      [chosen.id, limit],
    );
    const groups = new Map<string, ReferenceGroup>();
    for (const row of refs) {
      const file = stringAt(row, 0);
      const group = groups.get(file) ?? { file, references: [] };
      group.references.push({ line: numberAt(row, 1), kind: stringAt(row, 2) });
      groups.set(file, group);
    }
    return {
      symbol: chosen,
      candidates,
      groups: [...groups.values()],
      total: total.length > 0 ? numberAt(total[0], 0) : 0,
    };
  });
}

// ── Outline ──────────────────────────────────────────────────────────────────

function outlineRows(db: SqlJsDatabase, file: string): SymbolHit[] {
  return rowsOf(
    db,
    `SELECT ${SYMBOL_COLUMNS} FROM symbols s WHERE s.file = ? ORDER BY s.line ASC, s.id ASC`,
    [file],
  ).map(row => mapSymbol(row));
}

/** A file's symbols in source order, nested under the first symbol whose name matches `parent`. */
export function buildOutline(rows: SymbolHit[]): OutlineEntry[] {
  const entries = new Map<string, OutlineEntry>();
  const roots: OutlineEntry[] = [];
  const firstByName = new Map<string, OutlineEntry>();
  for (const row of rows) {
    const entry: OutlineEntry = {
      name: row.name,
      kind: row.kind,
      line: row.line,
      endLine: row.endLine,
      signature: row.signature,
      doc: row.doc,
      exported: row.exported,
      uses: row.uses,
      children: [],
    };
    entries.set(`${row.name}\u0000${row.line}`, entry);
    if (!firstByName.has(row.name)) firstByName.set(row.name, entry);
  }
  for (const row of rows) {
    const entry = entries.get(`${row.name}\u0000${row.line}`)!;
    const parent = row.parent ? firstByName.get(row.parent) : undefined;
    if (parent && parent !== entry) parent.children.push(entry);
    else roots.push(entry);
  }
  return roots;
}

export async function outline(
  store: string,
  project: string,
  filePath: string,
): Promise<QueryResult<OutlineEntry[]>> {
  const result = await withCodeDb(store, project, db => buildOutline(outlineRows(db, filePath)));
  return { available: result.available, databasePath: result.databasePath, value: result.value ?? [] };
}

// ── Usage ────────────────────────────────────────────────────────────────────

// The hot list is about callable structure. A local variable's reference count
// measures how busy one function is, not how central the code is, and short
// names (`z`) or ubiquitous locals (`buttons`) otherwise dominate it while
// telling an agent nothing. Cold code keeps every symbol so nothing is hidden.
const HOT_FILTER = `s.kind <> 'variable' AND LENGTH(s.name) >= 3`;

export async function usage(
  store: string,
  project: string,
  top = 10,
): Promise<QueryResult<UsageResult>> {
  const limit = Math.max(1, top);
  const empty: UsageResult = { top: [], bottom: [] };
  const result = await withCodeDb(store, project, db => {
    const hot = rowsOf(
      db,
      `SELECT ${USAGE_COLUMNS} FROM symbols s WHERE ${HOT_FILTER}
       ORDER BY uses DESC, s.name ASC, s.file ASC LIMIT ?`,
      [limit],
    ).map(mapUsage);
    const cold = rowsOf(
      db,
      `SELECT ${USAGE_COLUMNS} FROM symbols s
       ORDER BY uses ASC, s.name ASC, s.file ASC LIMIT ?`,
      [limit],
    ).map(mapUsage);
    return { top: hot, bottom: cold };
  });
  return { available: result.available, databasePath: result.databasePath, value: result.value ?? empty };
}

// ── Formatting shared by the MCP tools and the CLI ───────────────────────────

/** One compact line per hit: `path:line kind name signature`, then doc when present. */
export function formatSymbolLine(hit: SymbolHit): string {
  const signature = hit.signature ? ` ${hit.signature}` : "";
  const doc = hit.doc ? ` | ${hit.doc.split("\n")[0]}` : "";
  return `${hit.file}:${hit.line} ${hit.kind} ${hit.name}${signature}${doc}`;
}


export interface OutlineSummary {
  path: string;
  symbols: number;
  kinds: Array<{ kind: string; count: number }>;
  /** First declaration in source order, qualified to its exact file. */
  symbol?: string;
}

/** One database open for a visible directory's grouped counts and first declarations.
 * Directories aggregate descendants; files include every nested declaration. */
export async function outlineSummary(store: string, project: string, paths: string[]): Promise<QueryResult<OutlineSummary[]>> {
  const result = await withCodeDb(store, project, db => {
    const grouped = rowsOf(db, "SELECT file, kind, COUNT(*) FROM symbols GROUP BY file, kind");
    return paths.map(file => {
      const kinds = new Map<string, number>();
      for (const row of grouped) {
        const source = stringAt(row, 0);
        if (source !== file && !source.startsWith(file + "/")) continue;
        const kind = stringAt(row, 1);
        kinds.set(kind, (kinds.get(kind) ?? 0) + numberAt(row, 2));
      }
      const first = rowsOf(db, "SELECT name, parent FROM symbols WHERE file = ? ORDER BY line, id LIMIT 1", [file])[0];
      return { path: file, symbols: [...kinds.values()].reduce((a, b) => a + b, 0),
        kinds: [...kinds].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind)).slice(0, 3),
        ...(first ? { symbol: `${file}::${stringAt(first, 1) ? stringAt(first, 1) + "." : ""}${stringAt(first, 0)}` } : {}) };
    });
  });
  return { available: result.available, databasePath: result.databasePath, value: result.value ?? [] };
}


export interface CodeFilters { kind?: string; file?: string; directory?: string }

/** `types` is the UI family; `type` retains its existing exact-kind meaning. */
function addCodeFilters(conditions: string[], params: SqlValue[], filters: CodeFilters): void {
  if (filters.kind === "types") conditions.push("s.kind IN ('class', 'struct', 'enum', 'interface', 'type')");
  else if (filters.kind) { conditions.push("s.kind = ?"); params.push(filters.kind); }
  if (filters.file) { conditions.push("s.file = ?"); params.push(filters.file); }
  if (filters.directory) {
    conditions.push("substr(s.file, 1, ?) = ?");
    params.push([...filters.directory].length + 1, filters.directory + "/");
  }
}

export interface UsagePage {
  entries: SymbolHit[];
  total: number;
  offset: number;
  limit: number;
  maxUses: number;
}

/** Every symbol, including locals and zero uses, in one stable ranked sequence.
 * The database sorts and pages; the phone never downloads the full distribution.
 * `end` addresses the final page without first fetching every preceding page. */
export async function usagePage(store: string, project: string,
  options: CodeFilters & { offset?: number; limit?: number; end?: boolean } = {}): Promise<QueryResult<UsagePage>> {
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 50)));
  const result = await withCodeDb(store, project, db => {
    const conditions = ["1 = 1"];
    const params: SqlValue[] = [];
    addCodeFilters(conditions, params, options);
    const source = `FROM symbols s WHERE ${conditions.join(" AND ")}`;
    const total = numberAt(rowsOf(db, `SELECT COUNT(*) ${source}`, params)[0], 0);
    const offset = options.end ? Math.max(0, total - limit) : Math.max(0, Math.trunc(options.offset ?? 0));
    const maxUses = numberAt(rowsOf(db, `SELECT COALESCE(MAX(uses), 0) FROM (SELECT ${SYMBOL_COLUMNS} ${source})`, params)[0], 0);
    const entries = rowsOf(db, `SELECT ${SYMBOL_COLUMNS} ${source}
      ORDER BY uses DESC, s.name ASC, s.file ASC, s.line ASC, s.id ASC LIMIT ? OFFSET ?`, [...params, limit, offset]).map(row => mapSymbol(row));
    return { entries, total, offset, limit, maxUses };
  });
  return { ...result, value: result.value ?? { entries: [], total: 0, offset: 0, limit, maxUses: 0 } };
}

export interface CodeTreeEntry {
  path: string;
  directory: boolean;
  files: number;
  symbols: number;
  languages: string[];
}

/** Immediate indexed children only, including files with no declarations.
 * Counts describe all descendants. Literal prefix matching treats % and _ as paths. */
export async function treeSummary(store: string, project: string, directory = ""): Promise<QueryResult<CodeTreeEntry[]>> {
  const result = await withCodeDb(store, project, db => {
    const prefix = directory ? directory + "/" : "";
    const rows = rowsOf(db, `SELECT f.path, f.language, COUNT(s.id) FROM files f
      LEFT JOIN symbols s ON s.file = f.path WHERE substr(f.path, 1, ?) = ?
      GROUP BY f.path, f.language ORDER BY f.path`, [[...prefix].length, prefix]);
    const entries = new Map<string, CodeTreeEntry>();
    for (const row of rows) {
      const relative = stringAt(row, 0).slice(prefix.length);
      const slash = relative.indexOf("/");
      const path = prefix + (slash < 0 ? relative : relative.slice(0, slash));
      const entry = entries.get(path) ?? { path, directory: slash >= 0, files: 0, symbols: 0, languages: [] };
      entry.files++;
      entry.symbols += numberAt(row, 2);
      const language = stringAt(row, 1);
      if (!entry.languages.includes(language)) entry.languages.push(language);
      entries.set(path, entry);
    }
    return [...entries.values()].map(entry => ({ ...entry, languages: entry.languages.sort() }))
      .sort((a, b) => Number(b.directory) - Number(a.directory) || a.path.localeCompare(b.path));
  });
  return { ...result, value: result.value ?? [] };
}

/** Symbols ordered by the last index run that observed a declaration or body
 * change. Old indexes fall back to file observation time until their next scan. */
export async function recentSymbols(store: string, project: string, directory?: string, limit = 30) {
  const result = await withCodeDb(store, project, db => {
    const conditions = ["1 = 1"];
    const params: SqlValue[] = [];
    addCodeFilters(conditions, params, { directory });
    return rowsOf(db, `SELECT ${SYMBOL_COLUMNS}, COALESCE(c.indexed_at, f.indexed_at) AS changed_at FROM symbols s
      JOIN files f ON f.path = s.file LEFT JOIN symbol_changes c ON c.symbol_id = s.id WHERE ${conditions.join(" AND ")}
      ORDER BY changed_at DESC, s.file ASC, s.line ASC, s.id ASC LIMIT ?`, [...params, Math.max(1, Math.min(100, limit))])
      .map(row => ({ ...mapSymbol(row), indexedAt: numberAt(row, 11) }));
  });
  return { ...result, value: result.value ?? [] };
}
