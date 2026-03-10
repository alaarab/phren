import * as path from "path";
import { debugLog } from "./shared.js";

export type SqlValue = string | number | null | Uint8Array;
export type DbRow = SqlValue[];

export interface SqlJsDatabase {
  run(sql: string, params?: SqlValue[]): void;
  exec(sql: string, params?: SqlValue[]): { columns: string[]; values: DbRow[] }[];
  export(): Uint8Array;
  close(): void;
}

export interface DocRow {
  project: string;
  filename: string;
  type: string;
  content: string;
  path: string;
}

function describeSqlValue(value: SqlValue | undefined): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (value instanceof Uint8Array) return "Uint8Array";
  return typeof value;
}

function expectRowWidth(row: DbRow, minColumns: number, context: string): void {
  if (!Array.isArray(row) || row.length < minColumns) {
    throw new Error(`${context}: expected at least ${minColumns} columns, got ${Array.isArray(row) ? row.length : typeof row}`);
  }
}

function normalizeDocSegment(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

function getProjectRoot(cortexPath: string, project: string): string {
  return path.join(path.resolve(cortexPath), project);
}

export function buildSourceDocKey(project: string, docPath: string, cortexPath: string, fallbackFilename?: string): string {
  const normalizedProject = normalizeDocSegment(project);
  const normalizedDocPath = path.resolve(docPath);
  const projectRoot = getProjectRoot(cortexPath, project);
  if (normalizedDocPath.startsWith(projectRoot + path.sep) || normalizedDocPath === projectRoot) {
    const relPath = normalizeDocSegment(path.relative(projectRoot, normalizedDocPath));
    if (relPath) return `${normalizedProject}/${relPath}`;
  }
  const fallback = fallbackFilename ?? path.basename(docPath);
  return `${normalizedProject}/${normalizeDocSegment(fallback)}`;
}

export function decodeStringRow(row: DbRow, width: number, context: string): string[] {
  expectRowWidth(row, width, context);
  return row.slice(0, width).map((value, index) => {
    if (typeof value !== "string") {
      throw new Error(`${context}: expected column ${index} to be string, got ${describeSqlValue(value)}`);
    }
    return value;
  });
}

export function decodeFiniteNumber(value: SqlValue | undefined, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${context}: expected finite number, got ${describeSqlValue(value)}`);
  }
  return value;
}

export function getDocSourceKey(doc: Pick<DocRow, "project" | "filename" | "path">, cortexPath: string): string {
  return buildSourceDocKey(doc.project, doc.path, cortexPath, doc.filename);
}

/** Normalize a memory ID to canonical format: `mem:project/path/to/file.md`. */
export function normalizeMemoryId(rawId: string): string {
  let id = decodeURIComponent(rawId).replace(/\\/g, "/");
  if (!id.startsWith("mem:")) id = `mem:${id}`;
  return id;
}

export function rowToDoc(row: DbRow): DocRow {
  const [project, filename, type, content, filePath] = decodeStringRow(row, 5, "rowToDoc");
  return { project, filename, type, content, path: filePath };
}

export function rowToDocWithRowid(row: DbRow): { rowid: number; doc: DocRow } {
  expectRowWidth(row, 6, "rowToDocWithRowid");
  const rowid = decodeFiniteNumber(row[0], "rowToDocWithRowid");
  const [project, filename, type, content, filePath] = decodeStringRow(row.slice(1), 5, "rowToDocWithRowid.doc");
  return {
    rowid,
    doc: { project, filename, type, content, path: filePath },
  };
}

export function queryRows(db: SqlJsDatabase, sql: string, params: (string | number)[]): DbRow[] | null {
  try {
    const results = db.exec(sql, params);
    if (!Array.isArray(results) || !results.length || !results[0]?.values?.length) return null;
    return results[0].values;
  } catch (err: unknown) {
    debugLog(`queryRows failed: ${err instanceof Error ? err.message : "unknown error"}`);
    return null;
  }
}

export function queryDocRows(db: SqlJsDatabase, sql: string, params: (string | number)[]): DocRow[] | null {
  const raw = queryRows(db, sql, params);
  if (!raw) return null;
  return raw.map(rowToDoc);
}

export function queryDocBySourceKey(db: SqlJsDatabase, cortexPath: string, sourceKey: string): DocRow | null {
  const match = sourceKey.match(/^([^/]+)\/(.+)$/);
  if (!match) return null;
  const [, project, rest] = match;
  const filename = rest.includes("/") ? path.basename(rest) : rest;
  const rows = queryDocRows(
    db,
    "SELECT project, filename, type, content, path FROM docs WHERE project = ? AND filename = ?",
    [project, filename]
  );
  if (!rows) return null;
  return rows.find((row) => getDocSourceKey(row, cortexPath) === sourceKey) ?? null;
}

export function extractSnippet(content: string, query: string, lines: number = 5): string {
  const terms = query.replace(/\b(AND|OR|NOT|NEAR)\b/gi, "")
    .replace(/['"]/g, "")
    .split(/\s+/)
    .filter((term) => term.length > 1)
    .map((term) => term.toLowerCase());

  if (terms.length === 0) {
    return content.split("\n").slice(0, lines).join("\n");
  }

  const contentLines = content.split("\n");

  const headingIndices: number[] = [];
  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trimStart().startsWith("#")) headingIndices.push(i);
  }

  function nearestHeadingDist(idx: number): number {
    let min = Infinity;
    for (const headingIndex of headingIndices) {
      const distance = Math.abs(idx - headingIndex);
      if (distance < min) min = distance;
    }
    return min;
  }

  function sectionMiddle(idx: number): number {
    let sectionStart = 0;
    let sectionEnd = contentLines.length;
    for (const headingIndex of headingIndices) {
      if (headingIndex <= idx) sectionStart = headingIndex;
      else {
        sectionEnd = headingIndex;
        break;
      }
    }
    return (sectionStart + sectionEnd) / 2;
  }

  let bestIdx = 0;
  let bestScore = 0;
  let bestHeadingDist = Infinity;
  let bestMidDist = Infinity;

  for (let i = 0; i < contentLines.length; i++) {
    const lineLower = contentLines[i].toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (lineLower.includes(term)) score++;
    }
    if (score === 0) continue;

    const headingDist = nearestHeadingDist(i);
    const nearHeading = headingDist <= 3;
    const midDist = Math.abs(i - sectionMiddle(i));

    const better =
      score > bestScore ||
      (score === bestScore && nearHeading && bestHeadingDist > 3) ||
      (score === bestScore && nearHeading === (bestHeadingDist <= 3) && midDist < bestMidDist);

    if (better) {
      bestScore = score;
      bestIdx = i;
      bestHeadingDist = headingDist;
      bestMidDist = midDist;
    }
  }

  const start = Math.max(0, bestIdx - 1);
  const end = Math.min(contentLines.length, bestIdx + lines - 1);
  return contentLines.slice(start, end).join("\n");
}
