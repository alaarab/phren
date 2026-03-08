import { debugLog } from "./shared.js";
import { STOP_WORDS } from "./utils.js";
import { porterStem } from "./shared-stemmer.js";
import type { SqlJsDatabase, DbRow, DocRow } from "./shared-index.js";

const HYBRID_SEARCH_FLAG = "CORTEX_FEATURE_HYBRID_SEARCH";
const COSINE_SIMILARITY_MIN = 0.15;
const COSINE_MAX_CORPUS = 10000;
export const COSINE_CANDIDATE_CAP = 500; // max docs loaded into memory for cosine scoring

// Module-level cache for TF-IDF document frequencies.
// Keyed by a fingerprint of the candidate doc IDs so that different candidate subsets and
// incremental index mutations produce distinct cache entries rather than reusing stale counts.
// Intentionally not locked: single-threaded JS event loop, cache is eventually consistent,
// worst case is a redundant recompute. No data loss is possible since this is a pure computation cache.
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
  // Use prefix + length + suffix as a cheap key that avoids collisions
  const key = `${text.slice(0, 64)}|${text.length}|${text.slice(-32)}`;
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
  if (!cachedDf) dfCache.set(cacheKey, df);

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

  // Load docs with candidate capping to bound memory usage.
  // If corpus fits in cap, load all; otherwise use FTS5 keyword pre-filter to get relevant candidates.
  let allRows: DbRow[] | null = null;
  try {
    if (totalDocs <= COSINE_CANDIDATE_CAP) {
      const results = db.exec("SELECT rowid, project, filename, type, content, path FROM docs");
      if (!Array.isArray(results) || !results.length || !results[0]?.values?.length) return [];
      allRows = results[0].values;
    } else {
      // Pre-filter: use FTS5 to get top candidates, then fill to cap with random sample
      const safeQ = query.replace(/[^\w\s]/g, " ").trim().split(/\s+/).filter(w => w.length > 2).slice(0, 5).join(" OR ");
      const ftsRows: DbRow[] = [];
      if (safeQ) {
        try {
          const ftsRes = db.exec(`SELECT rowid, project, filename, type, content, path FROM docs WHERE docs MATCH ? ORDER BY rank LIMIT ${COSINE_CANDIDATE_CAP}`, [safeQ]);
          if (ftsRes?.length && ftsRes[0]?.values?.length) ftsRows.push(...ftsRes[0].values);
        } catch { /* FTS pre-filter optional */ }
      }
      // If FTS gave fewer than cap, supplement with random sample of remaining docs
      if (ftsRows.length < COSINE_CANDIDATE_CAP) {
        const ftsRowIds = new Set(ftsRows.map(r => Number(r[0])));
        const remaining = COSINE_CANDIDATE_CAP - ftsRows.length;
        try {
          const sampleRes = db.exec(`SELECT rowid, project, filename, type, content, path FROM docs ORDER BY RANDOM() LIMIT ${remaining}`);
          if (sampleRes?.length && sampleRes[0]?.values?.length) {
            for (const r of sampleRes[0].values) {
              if (!ftsRowIds.has(Number(r[0]))) ftsRows.push(r);
            }
          }
        } catch { /* sample optional */ }
      }
      if (ftsRows.length === 0) return [];
      allRows = ftsRows;
      debugLog(`cosineFallback: pre-filtered ${totalDocs} docs to ${allRows.length} candidates`);
    }
  } catch {
    return [];
  }

  // Separate rowids, DocRows, and content strings for scoring
  const docContents: string[] = [];
  const docMeta: { project: string; filename: string; type: string; content: string; path: string }[] = [];

  for (const row of allRows ?? []) {
    const rowid = Number(row[0]);
    if (excludeRowids.has(rowid)) continue;
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
