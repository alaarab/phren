import { isValidProjectName } from "@phren/cli/code-host/utils-paths";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import * as path from "node:path";
import type { SqlJsDatabase, SqlValue } from "@phren/cli/code-host/index-query";
import { bootstrapSqlJs } from "@phren/cli/code-host/shared/sqljs";
import { atomicWriteText, ensurePrivateDir, runtimeDir } from "@phren/cli/code-host/phren-paths";

/**
 * On-disk shape of the code index.
 *
 * One sql.js-fts5 database per project, under `<store>/.runtime/code/`. The
 * index is machine-local runtime state: it is never written into the synced
 * store, and losing it only costs a cold re-index.
 *
 * The schema follows docs/code-index.md. `references` and `blame` are quoted
 * because both are SQL keywords.
 */

export interface CodeSqlDatabase extends SqlJsDatabase {
  prepare(sql: string): { run(params: SqlValue[]): void; free(): boolean };
}

export interface CodeDatabase {
  db: CodeSqlDatabase;
  path: string;
  /** Flush the in-memory database back to the `.sqlite` file. */
  persist(): void;
  close(): void;
}

interface SqlJsStatic {
  Database: new (data?: ArrayLike<number>) => CodeSqlDatabase;
}

// sql.js initialises its WASM module per call. The code index opens the
// database on every invocation, so the module is cached for the process; the
// incremental path has to stay inside its time budget.
let sqlJsPromise: Promise<SqlJsStatic> | undefined;

function loadSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJsPromise) sqlJsPromise = bootstrapSqlJs() as Promise<SqlJsStatic>;
  return sqlJsPromise;
}

export interface CodeFileRow {
  path: string;
  hash: string;
  language: string;
  mtime: number;
}

export interface IndexedFile extends CodeFileRow {
  indexedAt: number;
}

export interface CodeCounts {
  files: number;
  symbols: number;
  references: number;
}

export function codeRuntimeDir(store: string): string {
  return path.join(runtimeDir(store), "code");
}

export function codeDatabasePath(store: string, project: string): string {
  if (!isValidProjectName(project)) throw new Error("Choose a valid project name.");
  return path.join(codeRuntimeDir(store), `${project}.sqlite`);
}

function createSchema(db: SqlJsDatabase): void {
  db.run(
    `CREATE TABLE IF NOT EXISTS files (
       path TEXT PRIMARY KEY,
       hash TEXT NOT NULL,
       language TEXT NOT NULL,
       mtime INTEGER NOT NULL,
       indexed_at INTEGER NOT NULL
     )`,
  );
  db.run(
    `CREATE TABLE IF NOT EXISTS symbols (
       id INTEGER PRIMARY KEY,
       file TEXT NOT NULL,
       name TEXT NOT NULL,
       kind TEXT NOT NULL,
       line INTEGER NOT NULL,
       end_line INTEGER NOT NULL,
       signature TEXT NOT NULL,
       doc TEXT NOT NULL,
       parent TEXT,
       exported INTEGER NOT NULL
     )`,
  );
  db.run(`CREATE TABLE IF NOT EXISTS "references" (symbol_id INTEGER NOT NULL, file TEXT NOT NULL, line INTEGER NOT NULL, kind TEXT NOT NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS blame (file TEXT NOT NULL, line INTEGER NOT NULL, author_hash TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (file, line))`);
  db.run(
    `CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
       name, signature, doc,
       tokenize = "porter unicode61"
     )`,
  );
  db.run(`CREATE TABLE IF NOT EXISTS reference_names (file TEXT NOT NULL, name TEXT NOT NULL, line INTEGER NOT NULL, kind TEXT NOT NULL)`);
  db.run(`CREATE INDEX IF NOT EXISTS reference_names_file ON reference_names(file)`);
  db.run(`CREATE INDEX IF NOT EXISTS symbols_name_nocase ON symbols(name COLLATE NOCASE)`);
  db.run(`CREATE INDEX IF NOT EXISTS symbols_file_name ON symbols(file, name)`);
  db.run(`CREATE TABLE IF NOT EXISTS symbol_changes (symbol_id INTEGER PRIMARY KEY, hash TEXT NOT NULL, indexed_at INTEGER NOT NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.run(`CREATE INDEX IF NOT EXISTS symbols_file ON symbols(file)`);
  db.run(`CREATE INDEX IF NOT EXISTS symbols_name ON symbols(name)`);
  db.run(`CREATE INDEX IF NOT EXISTS references_symbol ON "references"(symbol_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS references_file ON "references"(file)`);
}

/** Open (or create) a project's code index. Returns undefined when creating is off and the file is missing. */
export async function openCodeDatabase(store: string, project: string, create = true): Promise<CodeDatabase | undefined> {
  const SQL = await loadSqlJs();
  const filePath = codeDatabasePath(store, project);
  let db: CodeSqlDatabase;
  if (fs.existsSync(filePath)) {
    db = new SQL.Database(fs.readFileSync(filePath));
  } else if (create) {
    ensurePrivateDir(codeRuntimeDir(store));
    db = new SQL.Database();
  } else {
    return undefined;
  }
  createSchema(db);
  return {
    db,
    path: filePath,
    persist(): void {
      ensurePrivateDir(path.dirname(filePath));
      atomicWriteText(filePath, db.export(), { mode: 0o600 });
    },
    close(): void {
      db.close();
    },
  };
}

export function rowsOf(db: SqlJsDatabase, sql: string, params: SqlValue[] = []): SqlValue[][] {
  const result = db.exec(sql, params);
  return result[0]?.values ?? [];
}

export function numberAt(row: SqlValue[], index: number): number {
  const value = row[index];
  return typeof value === "number" ? value : Number(value);
}

export function stringAt(row: SqlValue[], index: number): string {
  const value = row[index];
  return value === null || value === undefined ? "" : String(value);
}

export function listIndexedFiles(db: SqlJsDatabase): Map<string, IndexedFile> {
  const files = new Map<string, IndexedFile>();
  for (const row of rowsOf(db, `SELECT path, hash, language, mtime, indexed_at FROM files`)) {
    const file = stringAt(row, 0);
    files.set(file, {
      path: file,
      hash: stringAt(row, 1),
      language: stringAt(row, 2),
      mtime: numberAt(row, 3),
      indexedAt: numberAt(row, 4),
    });
  }
  return files;
}

export function upsertFileRow(db: SqlJsDatabase, file: CodeFileRow, indexedAt = Date.now()): void {
  db.run(
    `INSERT INTO files (path, hash, language, mtime, indexed_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET hash = excluded.hash, language = excluded.language, mtime = excluded.mtime, indexed_at = excluded.indexed_at`,
    [file.path, file.hash, file.language, file.mtime, indexedAt],
  );
}

export function deleteFileRow(db: SqlJsDatabase, file: string): void {
  db.run(`DELETE FROM files WHERE path = ?`, [file]);
  db.run(`DELETE FROM reference_names WHERE file = ?`, [file]);
}

/** Remove a file that vanished from the working tree: its rows and every reference to it. */
export function purgeFile(db: SqlJsDatabase, file: string): void {
  const ids = rowsOf(db, `SELECT id FROM symbols WHERE file = ?`, [file]).map(row => numberAt(row, 0));
  for (const id of ids) {
    db.run(`DELETE FROM symbol_changes WHERE symbol_id = ?`, [id]);
    db.run(`DELETE FROM symbols_fts WHERE rowid = ?`, [id]);
    db.run(`DELETE FROM "references" WHERE symbol_id = ?`, [id]);
  }
  db.run(`DELETE FROM symbols WHERE file = ?`, [file]);
  db.run(`DELETE FROM blame WHERE file = ?`, [file]);
  db.run(`DELETE FROM "references" WHERE file = ?`, [file]);
  db.run(`DELETE FROM files WHERE path = ?`, [file]);
  db.run(`DELETE FROM reference_names WHERE file = ?`, [file]);
}

interface OldSymbol {
  id: number;
  key: string;
}

function symbolKey(name: string, line: number): string {
  return `${name}\u0000${line}`;
}

export interface SymbolInput {
  name: string;
  kind: string;
  line: number;
  endLine: number;
  signature: string;
  doc: string;
  parent: string | null;
  exported: boolean;
}

export interface BlameInput {
  line: number;
  authorHash: string;
  at: string;
}

/** Replace a file's symbols while preserving surviving (name, line) IDs. */
export function replaceFileSymbols(
  db: CodeSqlDatabase,
  file: string,
  symbols: SymbolInput[],
  blame: BlameInput[],
  source?: string,
): Map<string, number> {
  const oldSymbols: OldSymbol[] = rowsOf(db, `SELECT id, name, line FROM symbols WHERE file = ?`, [file]).map(row => ({
    id: numberAt(row, 0), key: symbolKey(stringAt(row, 1), numberAt(row, 2)),
  }));
  const oldIds = new Map(oldSymbols.map(old => [old.key, old.id]));
  let nextId = numberAt(rowsOf(db, `SELECT COALESCE(MAX(id), 0) FROM symbols`)[0], 0) + 1;
  db.run(`DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE file = ?)`, [file]);
  db.run(`DELETE FROM symbols WHERE file = ?`, [file]);
  db.run(`DELETE FROM blame WHERE file = ?`, [file]);
  db.run(`DELETE FROM "references" WHERE file = ?`, [file]);

  const sourceLines = source?.split("\n");
  const observedAt = Date.now();
  const newIdsByKey = new Map<string, number>();
  const insert = db.prepare(`INSERT INTO symbols (id, file, name, kind, line, end_line, signature, doc, parent, exported) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const fts = db.prepare(`INSERT INTO symbols_fts (rowid, name, signature, doc) VALUES (?, ?, ?, ?)`);
  const insertBlame = db.prepare(`INSERT OR REPLACE INTO blame (file, line, author_hash, at) VALUES (?, ?, ?, ?)`);
  try {
    for (const symbol of symbols) {
      const key = symbolKey(symbol.name, symbol.line);
      const id = oldIds.get(key) ?? nextId++;
      oldIds.delete(key);
      insert.run([id, file, symbol.name, symbol.kind, symbol.line, symbol.endLine, symbol.signature, symbol.doc, symbol.parent, symbol.exported ? 1 : 0]);
      fts.run([id, symbol.name, symbol.signature, symbol.doc]);
      const hash = createHash("sha256").update(JSON.stringify(symbol))
        .update(sourceLines?.slice(Math.max(0, symbol.line - 1), symbol.endLine).join("\n") ?? "").digest("hex");
      db.run(`INSERT INTO symbol_changes (symbol_id, hash, indexed_at) VALUES (?, ?, ?)
        ON CONFLICT(symbol_id) DO UPDATE SET hash = excluded.hash,
        indexed_at = CASE WHEN symbol_changes.hash = excluded.hash THEN symbol_changes.indexed_at ELSE excluded.indexed_at END`, [id, hash, observedAt]);
      newIdsByKey.set(key, id);
    }
    for (const entry of blame) insertBlame.run([file, entry.line, entry.authorHash, entry.at]);
  } finally {
    insert.free();
    fts.free();
    insertBlame.free();
  }
  for (const id of oldIds.values()) {
    db.run(`DELETE FROM "references" WHERE symbol_id = ?`, [id]);
    db.run(`DELETE FROM symbol_changes WHERE symbol_id = ?`, [id]);
  }
  return newIdsByKey;
}

/** Keep unresolved names so edits to definitions also refresh unchanged callers. */
export function replaceReferenceNames(db: CodeSqlDatabase, file: string, references: Array<{ name: string; line: number; kind: string }>): void {
  db.run(`DELETE FROM reference_names WHERE file = ?`, [file]);
  const insert = db.prepare(`INSERT INTO reference_names (file, name, line, kind) VALUES (?, ?, ?, ?)`);
  try {
    for (const reference of references) insert.run([file, reference.name, reference.line, reference.kind]);
  } finally { insert.free(); }
}

/** Aggregate names once, including ambiguous common names, before resolving callers. */
export function resolveReferences(db: SqlJsDatabase): void {
  db.run(`DELETE FROM "references"`);
  db.run(`INSERT INTO "references" (symbol_id, file, line, kind)
    WITH local AS (SELECT file, name, MIN(id) AS id, COUNT(*) AS n FROM symbols GROUP BY file, name),
         global AS (SELECT name, MIN(id) AS id, COUNT(*) AS n FROM symbols GROUP BY name)
    SELECT CASE WHEN local.n = 1 THEN local.id ELSE global.id END, r.file, r.line, r.kind
    FROM reference_names r
    LEFT JOIN local ON local.file = r.file AND local.name = r.name
    LEFT JOIN global ON global.name = r.name
    WHERE local.n = 1 OR (local.n IS NULL AND global.n = 1)`);
}

/**
 * Small key/value side table. It carries facts about the index itself rather
 * than its contents; `repo_root` lets definition queries read
 * the source snippet after an index built with `--repo`.
 */
export function setMeta(db: SqlJsDatabase, key: string, value: string): void {
  db.run(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}

export function getMeta(db: SqlJsDatabase, key: string): string | undefined {
  const row = rowsOf(db, `SELECT value FROM meta WHERE key = ?`, [key])[0];
  return row ? stringAt(row, 0) : undefined;
}

export function counts(db: SqlJsDatabase): CodeCounts {
  return {
    files: numberAt(rowsOf(db, `SELECT COUNT(*) FROM files`)[0] ?? [0], 0),
    symbols: numberAt(rowsOf(db, `SELECT COUNT(*) FROM symbols`)[0] ?? [0], 0),
    references: numberAt(rowsOf(db, `SELECT COUNT(*) FROM "references"`)[0] ?? [0], 0),
  };
}

export function lastIndexedAt(db: SqlJsDatabase): number | null {
  const run = Number(getMeta(db, "last_run_at"));
  if (Number.isFinite(run) && run > 0) return run;
  const row = rowsOf(db, `SELECT MAX(indexed_at) FROM files`)[0];
  if (!row || row[0] === null || row[0] === undefined) return null;
  return numberAt(row, 0);
}

export function languageFileCounts(db: SqlJsDatabase): Array<{ language: string; files: number }> {
  return rowsOf(db, `SELECT language, COUNT(*) AS n FROM files GROUP BY language ORDER BY n DESC, language`).map(row => ({
    language: stringAt(row, 0),
    files: numberAt(row, 1),
  }));
}

export function symbolKindCounts(db: SqlJsDatabase): Array<{ kind: string; symbols: number }> {
  return rowsOf(db, `SELECT kind, COUNT(*) AS n FROM symbols GROUP BY kind ORDER BY n DESC, kind`).map(row => ({
    kind: stringAt(row, 0),
    symbols: numberAt(row, 1),
  }));
}

/** Top symbols by resolved-reference count. Ties break on name for determinism. */
export function topSymbolsByUsage(db: SqlJsDatabase, limit: number): Array<{ name: string; file: string; kind: string; uses: number }> {
  return rowsOf(
    db,
    `SELECT s.name, s.file, s.kind, COUNT(r.symbol_id) AS uses
       FROM symbols s
       JOIN "references" r ON r.symbol_id = s.id
       GROUP BY s.id
       ORDER BY uses DESC, s.name ASC, s.file ASC
       LIMIT ?`,
    [limit],
  ).map(row => ({
    name: stringAt(row, 0),
    file: stringAt(row, 1),
    kind: stringAt(row, 2),
    uses: numberAt(row, 3),
  }));
}

/** Blame metadata for a symbol's defining line, if the index recorded any. */
export function blameFor(db: SqlJsDatabase, file: string, line: number): { authorHash: string; at: string } | undefined {
  const row = rowsOf(db, `SELECT author_hash, at FROM blame WHERE file = ? AND line = ?`, [file, line])[0];
  if (!row) return undefined;
  return { authorHash: stringAt(row, 0), at: stringAt(row, 1) };
}
