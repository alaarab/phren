import { createHash } from "crypto";
import { debugLog } from "./shared.js";
import { STOP_WORDS } from "./utils.js";
import { porterStem } from "./shared-stemmer.js";
import type { SqlJsDatabase, DbRow, DocRow } from "./shared-index.js";
import { classifyFile, normalizeIndexedContent, rowToDocWithRowid } from "./shared-index.js";
import { embedText, cosineSimilarity, getEmbeddingModel, getOllamaUrl, getCloudEmbeddingUrl } from "./shared-ollama.js";
import { getEmbeddingCache } from "./shared-embedding-cache.js";
import { getPersistentVectorIndex } from "./shared-vector-index.js";
import * as fs from "fs";
import * as path from "path";

const HYBRID_SEARCH_FLAG = "CORTEX_FEATURE_HYBRID_SEARCH";
const COSINE_SIMILARITY_MIN = 0.15;
const COSINE_MAX_CORPUS = 10000;
export const COSINE_CANDIDATE_CAP = 500; // max docs loaded into memory for cosine scoring
const COSINE_WINDOW_COUNT = 4;

// Module-level cache for TF-IDF document frequencies.
// Keyed by a fingerprint of the candidate doc IDs so that different candidate subsets and
// incremental index mutations produce distinct cache entries rather than reusing stale counts.
// Intentionally not locked: single-threaded JS event loop, cache is eventually consistent,
// worst case is a redundant recompute. No data loss is possible since this is a pure computation cache.
// Max 100 entries to bound memory (LRU-style: oldest key evicted on overflow).
const MAX_DF_CACHE_SIZE = 100;
const dfCache = new Map<string, Map<string, number>>();

/** Invalidate the DF cache. Call after a full index rebuild. */
export function invalidateDfCache(): void {
  dfCache.clear();
  tokenCache.clear();
}

// Module-level cache for tokenized document content.
// Keyed by a short content hash so the same document content is only tokenized once per server lifetime.
// Cleared on full rebuild (same lifecycle as dfCache). Max 2000 entries to bound memory.
// Intentionally not locked: single-threaded JS event loop, cache is eventually consistent,
// worst case is a redundant recompute. No data loss is possible since this is a pure computation cache.
const MAX_TOKEN_CACHE = 2000;
const tokenCache = new Map<string, string[]>();

function cachedTokenize(text: string): string[] {
  const key = createHash("sha256").update(text).digest("hex").slice(0, 16);
  const hit = tokenCache.get(key);
  if (hit) return hit;
  const tokens = tokenize(text);
  if (tokenCache.size >= MAX_TOKEN_CACHE) {
    // Evict oldest entry
    tokenCache.delete(tokenCache.keys().next().value ?? "");
  }
  tokenCache.set(key, tokens);
  return tokens;
}

function deterministicSeed(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function loadCosineFallbackWindow(
  db: SqlJsDatabase,
  startRowid: number,
  limit: number,
  wrapBefore?: number,
): DbRow[] {
  const where = wrapBefore === undefined ? "rowid >= ?" : "rowid < ?";
  const params = [wrapBefore ?? startRowid, limit];
  const rows = db.exec(
    `SELECT rowid, project, filename, type, content, path FROM docs WHERE ${where} ORDER BY rowid LIMIT ?`,
    params
  );
  return rows?.[0]?.values ?? [];
}

/**
 * Tokenize text into non-stop-word tokens for TF-IDF computation, with stemming.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w))
    .map(w => porterStem(w));
}

/**
 * Compute TF-IDF cosine similarity scores for a query against a corpus of documents.
 * Returns an array of similarity scores in the same order as docs.
 * @param corpusN - Total number of documents in the full corpus (for IDF denominator).
 *   Defaults to docs.length, which is correct when docs IS the full corpus.
 *   Pass the real total when docs is a pre-filtered subset so IDF scores are not inflated.
 */
function tfidfCosine(docs: string[], query: string, corpusN?: number): number[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return docs.map(() => 0);

  // Collect all unique terms from query + all docs (use cached tokenization for repeated content)
  const allTokens = new Set<string>(queryTokens);
  const docTokenLists: string[][] = docs.map(d => {
    const tokens = cachedTokenize(d);
    for (const t of tokens) allTokens.add(t);
    return tokens;
  });

  // Build a Set per document for O(1) term lookups
  const docTokenSets: Set<string>[] = docTokenLists.map(tokens => new Set(tokens));

  const terms = [...allTokens];
  // Use the full corpus N for IDF so scores are comparable even when docs is a subset.
  const N = corpusN ?? docs.length;

  // Compute document frequency for each term, keyed by a fingerprint of the candidate doc set
  // so that different subsets and incremental index mutations get distinct cache entries.
  const candidateFingerprint = docTokenLists.map(tl => tl.slice(0, 4).join(",")).join("|").slice(0, 128);
  const cacheKey = `fp:${candidateFingerprint}`;
  const cachedDf = dfCache.get(cacheKey);
  const df: Map<string, number> = cachedDf ?? new Map<string, number>();
  // Compute DF for any terms not yet in cache
  for (const term of terms) {
    if (!df.has(term)) {
      let count = 0;
      for (const docSet of docTokenSets) {
        if (docSet.has(term)) count++;
      }
      df.set(term, count);
    }
  }
  if (!cachedDf) {
    if (dfCache.size >= MAX_DF_CACHE_SIZE) dfCache.delete(dfCache.keys().next().value ?? "");
    dfCache.set(cacheKey, df);
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
  db: SqlJsDatabase,
  query: string,
  excludeRowids: Set<number>,
  limit: number
): DocRow[] {
  // Feature flag guard — default ON; set CORTEX_FEATURE_HYBRID_SEARCH=0 to disable
  const flagVal = process.env[HYBRID_SEARCH_FLAG];
  if (flagVal !== undefined && ["0", "false", "off", "no"].includes(flagVal.trim().toLowerCase())) {
    return [];
  }

  // Count total docs to guard against large corpora
  let totalDocs = 0;
  let minRowid = 0;
  let maxRowid = 0;
  try {
    const statsResult = db.exec("SELECT MIN(rowid), MAX(rowid), COUNT(*) FROM docs");
    if (statsResult?.length && statsResult[0]?.values?.length) {
      minRowid = Number(statsResult[0].values[0][0] ?? 0);
      maxRowid = Number(statsResult[0].values[0][1] ?? 0);
      totalDocs = Number(statsResult[0].values[0][2] ?? 0);
    }
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] cosineFallback count: ${err instanceof Error ? err.message : String(err)}\n`);
    return [];
  }

  if (totalDocs > COSINE_MAX_CORPUS) {
    debugLog(`cosineFallback: corpus size ${totalDocs} exceeds ${COSINE_MAX_CORPUS}, skipping`);
    return [];
  }

  // Load docs with candidate capping to bound memory usage.
  // If corpus fits in cap, load all; otherwise use FTS5 keyword pre-filter to get relevant candidates.
  let allRows: DbRow[] | null = null;
  try {
    if (totalDocs <= COSINE_CANDIDATE_CAP) {
      const results = db.exec("SELECT rowid, project, filename, type, content, path FROM docs");
      if (!Array.isArray(results) || !results.length || !results[0]?.values?.length) return [];
      allRows = results[0].values;
    } else {
      // Pre-filter: use FTS5 to get top candidates, then fill to cap with deterministic rowid windows
      const safeQ = query.replace(/[^\w\s]/g, " ").trim().split(/\s+/).filter(w => w.length > 2).slice(0, 5).join(" OR ");
      const ftsRows: DbRow[] = [];
      if (safeQ) {
        try {
          const ftsRes = db.exec(`SELECT rowid, project, filename, type, content, path FROM docs WHERE docs MATCH ? ORDER BY rank LIMIT ${COSINE_CANDIDATE_CAP}`, [safeQ]);
          if (ftsRes?.length && ftsRes[0]?.values?.length) ftsRows.push(...ftsRes[0].values);
        } catch (err: unknown) {
          if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] cosineFallback FTS pre-filter: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }
      // If FTS gave fewer than cap, supplement with deterministic rowid windows.
      if (ftsRows.length < COSINE_CANDIDATE_CAP && totalDocs > 0 && maxRowid >= minRowid) {
        const ftsRowIds = new Set(ftsRows.map(r => Number(r[0])));
        const remaining = COSINE_CANDIDATE_CAP - ftsRows.length;
        const span = Math.max(1, maxRowid - minRowid + 1);
        const windowCount = Math.min(COSINE_WINDOW_COUNT, remaining);
        const perWindow = Math.max(1, Math.ceil(remaining / Math.max(1, windowCount)));
        const stride = Math.max(1, Math.floor(span / Math.max(1, windowCount)));
        const seed = deterministicSeed(query);
        const pushRows = (rows: DbRow[]) => {
          for (const row of rows) {
            const rowid = Number(row[0]);
            if (ftsRowIds.has(rowid)) continue;
            ftsRowIds.add(rowid);
            ftsRows.push(row);
            if (ftsRows.length >= COSINE_CANDIDATE_CAP) break;
          }
        };
        try {
          for (let i = 0; i < windowCount && ftsRows.length < COSINE_CANDIDATE_CAP; i++) {
            const offset = (seed + i * stride) % span;
            const startRowid = minRowid + offset;
            pushRows(loadCosineFallbackWindow(db, startRowid, perWindow));
            if (ftsRows.length >= COSINE_CANDIDATE_CAP) break;
            pushRows(loadCosineFallbackWindow(db, startRowid, perWindow, startRowid));
          }
          if (ftsRows.length < COSINE_CANDIDATE_CAP) {
            pushRows(loadCosineFallbackWindow(db, minRowid, COSINE_CANDIDATE_CAP - ftsRows.length));
          }
        } catch (err: unknown) {
          if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] cosineFallback deterministicSample: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }
      if (ftsRows.length === 0) return [];
      allRows = ftsRows;
      debugLog(`cosineFallback: pre-filtered ${totalDocs} docs to ${allRows.length} candidates`);
    }
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] cosineFallback loadDocs: ${err instanceof Error ? err.message : String(err)}\n`);
    return [];
  }

  // Separate rowids, DocRows, and content strings for scoring
  const docContents: string[] = [];
  const docMeta: { project: string; filename: string; type: string; content: string; path: string }[] = [];

  for (const row of allRows ?? []) {
    const { rowid, doc } = rowToDocWithRowid(row);
    if (excludeRowids.has(rowid)) continue;
    docContents.push(doc.content);
    docMeta.push(doc);
  }

  if (docContents.length === 0) return [];

  // Pass totalDocs so IDF denominators reflect the full corpus, not just the candidate subset.
  const scores = tfidfCosine(docContents, query, totalDocs);

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

/**
 * Vector-based semantic search fallback using pre-computed Ollama embeddings.
 * Only runs when Ollama is configured (CORTEX_OLLAMA_URL is set or defaults).
 * Returns DocRow[] sorted by cosine similarity, above 0.5 threshold.
 */
export async function vectorFallback(
  cortexPath: string,
  query: string,
  excludePaths: Set<string>,
  limit: number,
  project?: string | null
): Promise<DocRow[]> {
  // Run when either Ollama or a cloud embedding endpoint is available
  if (!getOllamaUrl() && !getCloudEmbeddingUrl()) return [];
  const cache = getEmbeddingCache(cortexPath);
  // Ensure the cache is loaded from disk — in hook subprocesses the singleton
  // starts empty because load() is only called in the MCP server / CLI entry.
  if (cache.size() === 0) {
    try { await cache.load(); } catch (err: unknown) {
      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] vectorFallback cacheLoad: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  if (cache.size() === 0) return [];

  const queryVec = await embedText(query);
  if (!queryVec || queryVec.length === 0) return [];

  const model = getEmbeddingModel();
  const normalizedCortexPath = cortexPath.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  const normalizeRelativePath = (fullPath: string): string => {
    const normalizedFullPath = fullPath.replace(/[\\/]+/g, "/");
    if (normalizedFullPath === normalizedCortexPath) return "";
    if (normalizedFullPath.startsWith(`${normalizedCortexPath}/`)) {
      return normalizedFullPath.slice(normalizedCortexPath.length + 1);
    }
    const rel = path.relative(cortexPath, fullPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return fullPath;
    return rel;
  };
  const splitPathSegments = (filePath: string): string[] =>
    filePath.split(/[\\/]+/).filter(Boolean);
  // Apply project scoping: when a project is detected, restrict vector results to that
  // project and the global project to prevent cross-project memory injection.
  const entries = cache.getAllEntries().filter(e => {
    if (e.model !== model) return false;
    if (excludePaths.has(e.path)) return false;
    if (project) {
      // Allow global docs and docs from the active project
      const rel = normalizeRelativePath(e.path);
      const relParts = splitPathSegments(rel);
      const entryProject = relParts[0] ?? "";
      if (entryProject !== project && entryProject !== "global") return false;
    }
    return true;
  });
  if (entries.length === 0) return [];

  const eligiblePaths = new Set(entries.map((entry) => entry.path));
  const vectorIndex = getPersistentVectorIndex(cortexPath);
  vectorIndex.ensure(cache.getAllEntries());
  const indexedPaths = vectorIndex.query(model, queryVec, limit, eligiblePaths);
  const candidatePaths = indexedPaths.length > 0 ? new Set(indexedPaths) : eligiblePaths;

  const scored = entries
    .filter((entry) => candidatePaths.has(entry.path))
    .map(e => ({ path: e.path, score: cosineSimilarity(queryVec, e.vec) }))
    .filter(e => e.score > 0.50)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored.map(e => {
    const filename = splitPathSegments(e.path).at(-1) ?? "";
    // Derive project and relative path from absolute path
    const rel = normalizeRelativePath(e.path);
    const relParts = splitPathSegments(rel);
    const entryProject = relParts[0] ?? "";
    const relFile = relParts.slice(1).join("/");
    // Use the same path-aware classifyFile logic as the indexer so reference/skills/etc.
    // get their correct type instead of always falling back to "other".
    const type = classifyFile(filename, relFile);

    // Hydrate and normalize content from disk with the same pipeline as the indexer.
    let content = "";
    try {
      if (e.path && fs.existsSync(e.path)) {
        const raw = fs.readFileSync(e.path, "utf-8");
        content = normalizeIndexedContent(raw, type, cortexPath, 10000);
      }
    } catch (err: unknown) {
      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] vectorFallback fileRead: ${err instanceof Error ? err.message : String(err)}\n`);
    }

    return { project: entryProject, filename, type, content, path: e.path };
  });
}
