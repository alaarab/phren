import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { fileURLToPath } from "url";
import { globSync } from "glob";
import { createRequire } from "module";
import {
  debugLog,
  appendIndexEvent,
  getProjectDirs,
  collectNativeMemoryFiles,
} from "./shared.js";
import { getIndexPolicy } from "./shared-governance.js";
import { stripBacklogDoneSection } from "./shared-content.js";
import { STOP_WORDS } from "./utils.js";

const require = createRequire(import.meta.url);
const initSqlJs = require("sql.js-fts5") as (config?: Record<string, unknown>) => Promise<any>;

const FILE_TYPE_MAP: Record<string, string> = {
  "claude.md": "claude",
  "summary.md": "summary",
  "learnings.md": "learnings",
  "knowledge.md": "knowledge",
  "backlog.md": "backlog",
  "changelog.md": "changelog",
  "canonical_memories.md": "canonical",
  "memory_queue.md": "memory-queue",
};

function classifyFile(filename: string, relPath: string): string {
  const mapped = FILE_TYPE_MAP[filename.toLowerCase()];
  if (mapped) return mapped;
  if (relPath.includes("knowledge/") || relPath.includes("knowledge\\")) return "knowledge";
  if (relPath.includes("skills/") || relPath.includes("skills\\")) return "skill";
  return "other";
}

const IMPORT_RE = /^@import\s+(.+)$/gm;
const MAX_IMPORT_DEPTH = 5;

/**
 * Resolve `@import shared/file.md` directives in document content.
 * The import path is resolved relative to the cortex root (e.g. `shared/foo.md` -> `~/.cortex/global/shared/foo.md`).
 * Circular imports are detected and skipped. Depth is capped to prevent runaway recursion.
 */
export function resolveImports(
  content: string,
  cortexPath: string,
  seen?: Set<string>,
  depth?: number,
): string {
  const currentSeen = seen ?? new Set<string>();
  const currentDepth = depth ?? 0;
  if (currentDepth >= MAX_IMPORT_DEPTH) return content;

  return content.replace(IMPORT_RE, (_match, importPath: string) => {
    const trimmed = importPath.trim();
    const resolved = path.join(cortexPath, "global", trimmed);
    const normalized = path.resolve(resolved);

    if (currentSeen.has(normalized)) {
      return `<!-- @import cycle: ${trimmed} -->`;
    }

    if (!normalized.startsWith(path.resolve(cortexPath))) {
      return `<!-- @import blocked: path traversal -->`;
    }

    try {
      if (!fs.existsSync(normalized)) {
        return `<!-- @import not found: ${trimmed} -->`;
      }
      currentSeen.add(normalized);
      const imported = fs.readFileSync(normalized, "utf-8");
      return resolveImports(imported, cortexPath, currentSeen, currentDepth + 1);
    } catch {
      return `<!-- @import error: ${trimmed} -->`;
    }
  });
}

function findWasmBinary(): Buffer | undefined {
  try {
    const resolved = require.resolve("sql.js-fts5/dist/sql-wasm.wasm") as string;
    if (fs.existsSync(resolved)) return fs.readFileSync(resolved);
  } catch {
    // fall through to path probing
  }

  const __filename = fileURLToPath(import.meta.url);
  let dir = path.dirname(__filename);
  for (let i = 0; i < 5; i++) {
    const candidateA = path.join(dir, "node_modules", "sql.js-fts5", "dist", "sql-wasm.wasm");
    if (fs.existsSync(candidateA)) return fs.readFileSync(candidateA);
    const candidateB = path.join(dir, "sql.js-fts5", "dist", "sql-wasm.wasm");
    if (fs.existsSync(candidateB)) return fs.readFileSync(candidateB);
    dir = path.dirname(dir);
  }
  return undefined;
}

function computeCortexHash(cortexPath: string, profile?: string): string {
  const projectDirs = getProjectDirs(cortexPath, profile);
  const policy = getIndexPolicy(cortexPath);
  const files: string[] = [];
  for (const dir of projectDirs) {
    try {
      const matched = new Set<string>();
      for (const pattern of policy.includeGlobs) {
        const dot = policy.includeHidden || pattern.startsWith(".") || pattern.includes("/.");
        const mdFiles = globSync(pattern, { cwd: dir, nodir: true, dot, ignore: policy.excludeGlobs });
        for (const f of mdFiles) matched.add(f);
      }
      for (const f of matched) files.push(path.join(dir, f));
    } catch { /* skip unreadable dirs */ }
  }
  files.sort();
  const hash = crypto.createHash("sha1");
  for (const f of files) {
    try {
      const stat = fs.statSync(f);
      hash.update(`${f}:${stat.mtimeMs}:${stat.size}`);
    } catch { /* skip */ }
  }
  for (const mem of collectNativeMemoryFiles()) {
    try {
      const stat = fs.statSync(mem.fullPath);
      hash.update(`native:${mem.fullPath}:${stat.mtimeMs}:${stat.size}`);
    } catch { /* skip */ }
  }
  if (profile) hash.update(`profile:${profile}`);
  hash.update(`index-policy:${JSON.stringify(policy)}`);
  return hash.digest("hex").slice(0, 16);
}

async function buildIndexImpl(cortexPath: string, profile?: string): Promise<any> {
  const t0 = Date.now();
  let userSuffix: string;
  try {
    userSuffix = String(os.userInfo().uid);
  } catch {
    userSuffix = crypto.createHash("sha1").update(os.homedir()).digest("hex").slice(0, 12);
  }
  const cacheDir = path.join(os.tmpdir(), `cortex-fts-${userSuffix}`);
  const hash = computeCortexHash(cortexPath, profile);
  const cacheFile = path.join(cacheDir, `${hash}.db`);

  const wasmBinary = findWasmBinary();
  const SQL = await initSqlJs(wasmBinary ? { wasmBinary } : {});

  if (fs.existsSync(cacheFile)) {
    try {
      const cached = fs.readFileSync(cacheFile);
      const db = new SQL.Database(cached);
      debugLog(`Loaded FTS index from cache (${hash.slice(0, 8)}) in ${Date.now() - t0}ms`);
      appendIndexEvent(cortexPath, {
        event: "build_index",
        cache: "hit",
        hash: hash.slice(0, 12),
        elapsedMs: Date.now() - t0,
        profile: profile || "",
      });
      return db;
    } catch {
      debugLog(`Cache load failed, rebuilding index`);
    }
  }

  const db = new SQL.Database();
  db.run(`
    CREATE VIRTUAL TABLE docs USING fts5(
      project, filename, type, content, path
    );
  `);

  const projectDirs = getProjectDirs(cortexPath, profile);
  const indexPolicy = getIndexPolicy(cortexPath);
  let fileCount = 0;

  for (const dir of projectDirs) {
    const projectName = path.basename(dir);
    const mdFilesSet = new Set<string>();
    for (const pattern of indexPolicy.includeGlobs) {
      const dot = indexPolicy.includeHidden || pattern.startsWith(".") || pattern.includes("/.");
      const matched = globSync(pattern, {
        cwd: dir,
        nodir: true,
        dot,
        ignore: indexPolicy.excludeGlobs,
      });
      for (const rel of matched) mdFilesSet.add(rel);
    }
    const mdFiles = [...mdFilesSet].sort();

    for (const relFile of mdFiles) {
      const fullPath = path.join(dir, relFile);
      const filename = path.basename(relFile);
      const type = classifyFile(filename, relFile);

      try {
        const raw = fs.readFileSync(fullPath, "utf-8");
        let content = raw.replace(/<details>[\s\S]*?<\/details>/gi, "");
        content = resolveImports(content, cortexPath);
        if (type === "backlog") {
          content = stripBacklogDoneSection(content);
        }
        db.run(
          "INSERT INTO docs (project, filename, type, content, path) VALUES (?, ?, ?, ?, ?)",
          [projectName, filename, type, content, fullPath]
        );
        fileCount++;
      } catch {
        // Skip files we can't read
      }
    }
  }

  const nativeMemFiles = collectNativeMemoryFiles();
  for (const mem of nativeMemFiles) {
    try {
      const content = fs.readFileSync(mem.fullPath, "utf-8");
      db.run(
        "INSERT INTO docs (project, filename, type, content, path) VALUES (?, ?, ?, ?, ?)",
        [mem.project, mem.file, "learnings", content, mem.fullPath]
      );
      fileCount++;
    } catch {
      // Skip files we can't read
    }
  }

  const buildMs = Date.now() - t0;
  debugLog(`Built FTS index: ${fileCount} files from ${projectDirs.length} projects in ${buildMs}ms`);
  if (process.env.CORTEX_DEBUG) console.error(`Indexed ${fileCount} files from ${projectDirs.length} projects`);
  appendIndexEvent(cortexPath, {
    event: "build_index",
    cache: "miss",
    hash: hash.slice(0, 12),
    files: fileCount,
    projects: projectDirs.length,
    elapsedMs: buildMs,
    profile: profile || "",
  });

  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cacheFile, db.export());
    for (const f of fs.readdirSync(cacheDir)) {
      if (!f.endsWith(".db") || f === `${hash}.db`) continue;
      try { fs.unlinkSync(path.join(cacheDir, f)); } catch { /* stale cache cleanup is best-effort */ }
    }
    debugLog(`Saved FTS index cache (${hash.slice(0, 8)}) — total ${Date.now() - t0}ms`);
  } catch {
    debugLog(`Failed to save FTS index cache`);
  }

  return db;
}

export async function buildIndex(cortexPath: string, profile?: string): Promise<any> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("buildIndex timed out after 30s")), 30000);
  });
  try {
    return await Promise.race([buildIndexImpl(cortexPath, profile), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export interface DocRow {
  project: string;
  filename: string;
  type: string;
  content: string;
  path: string;
}

export function rowToDoc(row: any[]): DocRow {
  return {
    project: row[0] as string,
    filename: row[1] as string,
    type: row[2] as string,
    content: row[3] as string,
    path: row[4] as string,
  };
}

export function queryDocRows(db: any, sql: string, params: (string | number)[]): DocRow[] | null {
  const raw = queryRows(db, sql, params);
  if (!raw) return null;
  return raw.map(rowToDoc);
}

export function queryRows(db: any, sql: string, params: (string | number)[]): any[][] | null {
  try {
    const results = db.exec(sql, params);
    if (!Array.isArray(results) || !results.length || !results[0]?.values?.length) return null;
    return results[0].values;
  } catch (err: any) {
    debugLog(`queryRows failed: ${err?.message || "unknown error"}`);
    return null;
  }
}

const HYBRID_SEARCH_FLAG = "CORTEX_FEATURE_HYBRID_SEARCH";
const COSINE_FALLBACK_THRESHOLD = 3;
const COSINE_SIMILARITY_MIN = 0.05;
const COSINE_MAX_CORPUS = 10000;

/**
 * Tokenize text into non-stop-word tokens for TF-IDF computation.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w));
}

/**
 * Compute TF-IDF cosine similarity scores for a query against a corpus of documents.
 * Returns an array of similarity scores in the same order as docs.
 */
function tfidfCosine(docs: string[], query: string): number[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return docs.map(() => 0);

  // Collect all unique terms from query + all docs
  const allTokens = new Set<string>(queryTokens);
  const docTokenLists: string[][] = docs.map(d => {
    const tokens = tokenize(d);
    for (const t of tokens) allTokens.add(t);
    return tokens;
  });

  const terms = [...allTokens];
  const N = docs.length;

  // Compute document frequency for each term
  const df = new Map<string, number>();
  for (const term of terms) {
    let count = 0;
    for (const docTokens of docTokenLists) {
      if (docTokens.includes(term)) count++;
    }
    df.set(term, count);
  }

  function buildVector(tokens: string[]): number[] {
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    return terms.map(term => {
      const termTf = (tf.get(term) ?? 0) / (tokens.length || 1);
      const idf = Math.log((N + 1) / ((df.get(term) ?? 0) + 1)) + 1;
      return termTf * idf;
    });
  }

  function cosine(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  const queryVec = buildVector(queryTokens);
  return docTokenLists.map(docTokens => cosine(queryVec, buildVector(docTokens)));
}

/**
 * Cosine fallback search: when FTS5 returns fewer than COSINE_FALLBACK_THRESHOLD results,
 * load all docs and rank by TF-IDF cosine similarity.
 * Only activated when CORTEX_FEATURE_HYBRID_SEARCH=1 and corpus size <= COSINE_MAX_CORPUS.
 * Returns DocRow[] ranked by similarity (threshold > COSINE_SIMILARITY_MIN), excluding already-found rowids.
 */
export function cosineFallback(
  db: any,
  query: string,
  excludeRowids: Set<number>,
  limit: number
): DocRow[] {
  // Feature flag guard — default off
  const flagVal = process.env[HYBRID_SEARCH_FLAG];
  if (!flagVal || ["0", "false", "off", "no"].includes(flagVal.trim().toLowerCase())) {
    return [];
  }

  // Count total docs to guard against large corpora
  let totalDocs = 0;
  try {
    const countResult = db.exec("SELECT COUNT(*) FROM docs");
    if (countResult?.length && countResult[0]?.values?.length) {
      totalDocs = Number(countResult[0].values[0][0]);
    }
  } catch {
    return [];
  }

  if (totalDocs > COSINE_MAX_CORPUS) {
    debugLog(`cosineFallback: corpus size ${totalDocs} exceeds ${COSINE_MAX_CORPUS}, skipping`);
    return [];
  }

  // Load all docs
  let allRows: any[][] | null = null;
  try {
    const results = db.exec("SELECT rowid, project, filename, type, content, path FROM docs");
    if (!Array.isArray(results) || !results.length || !results[0]?.values?.length) return [];
    allRows = results[0].values;
  } catch {
    return [];
  }

  // Separate rowids, DocRows, and content strings for scoring
  const rowids: number[] = [];
  const docContents: string[] = [];
  const docMeta: { project: string; filename: string; type: string; content: string; path: string }[] = [];

  for (const row of allRows ?? []) {
    const rowid = Number(row[0]);
    if (excludeRowids.has(rowid)) continue;
    rowids.push(rowid);
    const content = String(row[4]);
    docContents.push(content);
    docMeta.push({
      project: String(row[1]),
      filename: String(row[2]),
      type: String(row[3]),
      content,
      path: String(row[5]),
    });
  }

  if (docContents.length === 0) return [];

  const scores = tfidfCosine(docContents, query);

  // Collect scored results above threshold
  const scored: { score: number; doc: DocRow }[] = [];
  for (let i = 0; i < scores.length; i++) {
    if (scores[i] > COSINE_SIMILARITY_MIN) {
      scored.push({ score: scores[i], doc: docMeta[i] });
    }
  }

  // Sort descending by score and return top-limit
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(s => s.doc);
}

export function extractSnippet(content: string, query: string, lines: number = 5): string {
  const terms = query.replace(/\b(AND|OR|NOT|NEAR)\b/gi, "")
    .replace(/['"]/g, "")
    .split(/\s+/)
    .filter(t => t.length > 1)
    .map(t => t.toLowerCase());

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
    for (const h of headingIndices) {
      const d = Math.abs(idx - h);
      if (d < min) min = d;
    }
    return min;
  }

  function sectionMiddle(idx: number): number {
    let sectionStart = 0;
    let sectionEnd = contentLines.length;
    for (const h of headingIndices) {
      if (h <= idx) sectionStart = h;
      else { sectionEnd = h; break; }
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

    const hDist = nearestHeadingDist(i);
    const nearHeading = hDist <= 3;
    const mDist = Math.abs(i - sectionMiddle(i));

    const better =
      score > bestScore ||
      (score === bestScore && nearHeading && bestHeadingDist > 3) ||
      (score === bestScore && nearHeading === (bestHeadingDist <= 3) && mDist < bestMidDist);

    if (better) {
      bestScore = score;
      bestIdx = i;
      bestHeadingDist = hDist;
      bestMidDist = mDist;
    }
  }

  const start = Math.max(0, bestIdx - 1);
  const end = Math.min(contentLines.length, bestIdx + lines - 1);
  return contentLines.slice(start, end).join("\n");
}

export function detectProject(cortexPath: string, cwd: string, profile?: string): string | null {
  const projectDirs = getProjectDirs(cortexPath, profile);
  const cwdSegments = cwd.toLowerCase().split(/[/\\]/);

  const lastSegment = cwdSegments[cwdSegments.length - 1];
  for (const dir of projectDirs) {
    const projectName = path.basename(dir).toLowerCase();
    if (projectName.length <= 3) {
      if (lastSegment === projectName) return path.basename(dir);
    } else {
      if (cwdSegments.includes(projectName)) return path.basename(dir);
    }
  }
  return null;
}
