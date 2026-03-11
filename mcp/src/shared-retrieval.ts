// shared-retrieval.ts — shared retrieval core used by hooks and MCP search.
import {
  type RetentionPolicy,
  getQualityMultiplier,
  entryScoreKey,
} from "./shared-governance.js";
import {
  queryDocRows,
  queryRows,
  type DocRow,
  type SqlJsDatabase,
  cosineFallback,
  extractSnippet,
  getDocSourceKey,
  getEntityBoostDocs,
  decodeFiniteNumber,
  rowToDocWithRowid,
} from "./shared-index.js";
import {
  filterTrustedFindingsDetailed,
} from "./shared-content.js";
import { parseCitationComment } from "./content-citation.js";
import { buildFtsQueryVariants, buildRelaxedFtsQuery, isFeatureEnabled, STOP_WORDS } from "./utils.js";
import * as fs from "fs";
import * as path from "path";
import { getProjectGlobBoost } from "./cli-hooks-globs.js";
import type { GitContext } from "./cli-hooks-session.js";
export type { GitContext } from "./cli-hooks-session.js";
import { vectorFallback } from "./shared-search-fallback.js";
import { getOllamaUrl, getCloudEmbeddingUrl } from "./shared-ollama.js";
import { keywordFallbackSearch } from "./core-search.js";
import { debugLog } from "./shared.js";

// ── Scoring constants ─────────────────────────────────────────────────────────

/** Number of docs sampled for token-overlap semantic fallback search. */
const SEMANTIC_FALLBACK_SAMPLE_LIMIT = 100;
const SEMANTIC_FALLBACK_WINDOW_COUNT = 4;

/** Minimum overlap score for a doc to be included in semantic fallback results. */
const SEMANTIC_OVERLAP_MIN_SCORE = 0.25;
const VECTOR_FALLBACK_SKIP_COUNT = 3;
const VECTOR_FALLBACK_STRONG_MATCH_SCORE = 0.2;
const LOCAL_QUERY_OVERLAP_WEIGHT = 3.5;
const CROSS_PROJECT_QUERY_OVERLAP_WEIGHT = 1.35;
const WEAK_CROSS_PROJECT_OVERLAP_MAX = 0.18;
const WEAK_CROSS_PROJECT_OVERLAP_PENALTY = 0.75;
const LOW_FOCUS_SNIPPET_SCORE = 0.3;
const VERY_LOW_FOCUS_SNIPPET_SCORE = 0.14;
const LOW_FOCUS_SNIPPET_LINE_CAP = 3;
const LOW_FOCUS_SNIPPET_CHAR_FRACTION = 0.55;
const TASK_RESCUE_MIN_OVERLAP = 0.3;
const TASK_RESCUE_OVERLAP_MARGIN = 0.12;
const TASK_RESCUE_SCORE_MARGIN = 0.6;

/** Fraction of bullets that must be low-value before applying the low-value penalty. */
const LOW_VALUE_BULLET_FRACTION = 0.5;

// ── Intent and scoring helpers ───────────────────────────────────────────────

export function detectTaskIntent(prompt: string): "debug" | "review" | "build" | "docs" | "general" {
  const p = prompt.toLowerCase();
  if (/(bug|error|fix|broken|regression|fail|stack trace)/.test(p)) return "debug";
  if (/(review|audit|pr|pull request|nit|refactor)/.test(p)) return "review";
  if (/(build|deploy|release|ci|workflow|pipeline|test)/.test(p)) return "build";
  if (/\b(doc|docs|readme|explain|guide|instructions?)\b/.test(p)) return "docs";
  return "general";
}

function intentBoost(intent: string, docType: string): number {
  if (intent === "debug" && (docType === "findings" || docType === "reference")) return 3;
  if (intent === "review" && (docType === "canonical" || docType === "changelog")) return 3;
  if (intent === "build" && (docType === "task" || docType === "reference")) return 2;
  if (intent === "docs" && (docType === "summary" || docType === "claude")) return 2;
  if (docType === "canonical") return 2;
  return 0;
}

export function fileRelevanceBoost(filePath: string, changedFiles: Set<string>): number {
  if (changedFiles.size === 0) return 0;
  const normalized = filePath.replace(/\\/g, "/");
  const docBasename = path.basename(normalized);
  for (const cf of changedFiles) {
    const n = cf.replace(/\\/g, "/");
    // Exact basename match to avoid 'index.ts' matching 'shared-index.ts'
    if (path.basename(n) === docBasename) return 3;
    // Also match if the full changed-file path is a suffix of the doc path
    if (normalized.endsWith(`/${n}`)) return 3;
  }
  return 0;
}

function branchTokens(branch: string): string[] {
  return branch
    .split(/[\/._-]/g)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 2 && !["main", "master", "feature", "fix", "bugfix", "hotfix"].includes(s));
}

export function branchMatchBoost(content: string, branch: string | undefined): number {
  if (!branch) return 0;
  const text = content.toLowerCase();
  const tokens = branchTokens(branch);
  let score = 0;
  for (const token of tokens) {
    if (text.includes(token)) score += 1;
  }
  return Math.min(3, score);
}

let _lowValueRegex: RegExp | null = null;
let _lowValuePatternKey = "";
function getLowValuePattern(): RegExp {
  const key = process.env.CORTEX_LOW_VALUE_PATTERNS || "";
  if (_lowValueRegex && _lowValuePatternKey === key) return _lowValueRegex;
  const defaults = ["fixed stuff", "updated things", "misc", "temp", "wip", "todo", "placeholder", "cleanup"];
  const configured = key.split(",").map((s) => s.trim()).filter(Boolean);
  const fragments = configured.length ? configured : defaults;
  _lowValueRegex = new RegExp(`(${fragments.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "i");
  _lowValuePatternKey = key;
  return _lowValueRegex;
}

function lowValuePenalty(content: string, docType: string): number {
  if (docType !== "findings") return 0;
  const bullets = content.split("\n").filter((l) => l.startsWith("- "));
  if (bullets.length === 0) return 0;
  const pattern = getLowValuePattern();
  const low = bullets.filter((b) => pattern.test(b) || b.length < 16).length;
  return low >= Math.ceil(bullets.length * LOW_VALUE_BULLET_FRACTION) ? 2 : 0;
}

// ── Token and snippet helpers ────────────────────────────────────────────────

function normalizeToken(token: string): string {
  let normalized = token.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (normalized.length > 4 && normalized.endsWith("s") && !normalized.endsWith("ss")) normalized = normalized.slice(0, -1);
  return normalized;
}

function tokenizeForOverlap(text: string, maxTokens = 24): string[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s]/g, " ")
    .split(/\s+/)
    .map(normalizeToken)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
  const uniqueTokens = [...new Set(tokens)];
  if (!Number.isFinite(maxTokens) || maxTokens < 1) return uniqueTokens;
  return uniqueTokens.slice(0, maxTokens);
}

function overlapScore(queryTokens: string[], content: string): number {
  if (!queryTokens.length) return 0;
  const contentTokens = new Set(tokenizeForOverlap(content, Number.POSITIVE_INFINITY));
  if (!contentTokens.size) return 0;
  let matched = 0;
  for (const token of queryTokens) {
    if (contentTokens.has(token)) matched += 1;
  }
  const denominator = Math.max(2, Math.min(queryTokens.length, 10));
  return matched / denominator;
}

function docOverlapScore(queryTokens: string[], doc: DocRow): number {
  const corpus = `${doc.project} ${doc.filename} ${doc.type} ${doc.path}\n${doc.content.slice(0, 5000)}`;
  return overlapScore(queryTokens, corpus);
}

function semanticFallbackSeed(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function loadSemanticFallbackWindow(
  db: SqlJsDatabase,
  startRowid: number,
  limit: number,
  project?: string | null,
  wrapBefore?: number,
): Array<{ rowid: number; doc: DocRow }> {
  const where = [
    project ? "project = ?" : "",
    wrapBefore === undefined ? "rowid >= ?" : "rowid < ?",
  ].filter(Boolean).join(" AND ");
  const params = [
    ...(project ? [project] : []),
    wrapBefore ?? startRowid,
    limit,
  ];
  const rows = queryRows(
    db,
    `SELECT rowid, project, filename, type, content, path FROM docs WHERE ${where} ORDER BY rowid LIMIT ?`,
    params
  ) || [];
  return rows.map((row) => rowToDocWithRowid(row));
}

// k=60 is the standard RRF constant from Cormack et al. (2009); higher values reduce
// the impact of top-ranked results, lower values amplify them. 60 is the community default.
const RRF_K = 60;

/**
 * Item 4: Reciprocal Rank Fusion — merges ranked result lists from multiple search tiers.
 * Documents appearing in multiple tiers get a higher combined score.
 * Formula: score(d) = Σ 1/(k + rank_i) for each tier i containing d, where k=60 (standard).
 */
export function rrfMerge(tiers: DocRow[][], k = RRF_K): DocRow[] {
  const scores = new Map<string, number>();
  const docs = new Map<string, DocRow>();
  for (const tier of tiers) {
    for (let rank = 0; rank < tier.length; rank++) {
      const doc = tier[rank];
      const key = doc.path || `${doc.project}/${doc.filename}`;
      if (!docs.has(key)) docs.set(key, doc);
      scores.set(key, (scores.get(key) ?? 0) + 1 / (k + rank + 1));
    }
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key]) => docs.get(key)!);
}

function semanticFallbackDocs(db: SqlJsDatabase, prompt: string, project?: string | null): DocRow[] {
  const terms = tokenizeForOverlap(prompt);
  if (!terms.length) return [];
  const sampleLimit = SEMANTIC_FALLBACK_SAMPLE_LIMIT;
  const statsRows = queryRows(
    db,
    project
      ? "SELECT MIN(rowid), MAX(rowid), COUNT(*) FROM docs WHERE project = ?"
      : "SELECT MIN(rowid), MAX(rowid), COUNT(*) FROM docs",
    project ? [project] : []
  );
  if (!statsRows?.length) return [];

  let minRowid = 0;
  let maxRowid = 0;
  let rowCount = 0;
  try {
    minRowid = decodeFiniteNumber(statsRows[0][0], "semanticFallbackDocs.minRowid");
    maxRowid = decodeFiniteNumber(statsRows[0][1], "semanticFallbackDocs.maxRowid");
    rowCount = decodeFiniteNumber(statsRows[0][2], "semanticFallbackDocs.rowCount");
  } catch {
    return [];
  }
  if (rowCount <= 0 || maxRowid < minRowid) return [];

  const cappedLimit = Math.min(sampleLimit, rowCount);
  const docs: DocRow[] = [];
  const seenRowids = new Set<number>();
  const pushRows = (rows: Array<{ rowid: number; doc: DocRow }>) => {
    for (const row of rows) {
      if (seenRowids.has(row.rowid)) continue;
      seenRowids.add(row.rowid);
      docs.push(row.doc);
      if (docs.length >= cappedLimit) break;
    }
  };

  if (rowCount <= cappedLimit) {
    pushRows(loadSemanticFallbackWindow(db, minRowid, cappedLimit, project));
  } else {
    const span = Math.max(1, maxRowid - minRowid + 1);
    const windowCount = Math.min(SEMANTIC_FALLBACK_WINDOW_COUNT, cappedLimit);
    const perWindow = Math.max(1, Math.ceil(cappedLimit / windowCount));
    const stride = Math.max(1, Math.floor(span / windowCount));
    const seed = semanticFallbackSeed(`${project ?? "*"}\n${terms.join(" ")}`);
    for (let i = 0; i < windowCount && docs.length < cappedLimit; i++) {
      const offset = (seed + i * stride) % span;
      const startRowid = minRowid + offset;
      pushRows(loadSemanticFallbackWindow(db, startRowid, perWindow, project));
      if (docs.length >= cappedLimit) break;
      pushRows(loadSemanticFallbackWindow(db, startRowid, perWindow, project, startRowid));
    }
  }

  if (docs.length < cappedLimit) {
    pushRows(loadSemanticFallbackWindow(db, minRowid, cappedLimit - docs.length, project));
  }

  const scored = docs
    .map((doc) => {
      const score = docOverlapScore(terms, doc);
      return { doc, score };
    })
    .filter((x) => x.score >= SEMANTIC_OVERLAP_MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((x) => x.doc);

  return scored;
}

export function shouldRunVectorExpansion(
  rows: DocRow[] | null,
  prompt: string,
  desiredResults = VECTOR_FALLBACK_SKIP_COUNT
): boolean {
  if (!rows || rows.length === 0) return true;
  const targetCount = Math.max(2, Math.min(VECTOR_FALLBACK_SKIP_COUNT, desiredResults));
  if (rows.length >= targetCount) return false;

  const queryTokens = tokenizeForOverlap(prompt);
  if (queryTokens.length === 0) return false;

  const bestOverlap = rows
    .slice(0, 2)
    .reduce((maxScore, doc) => Math.max(maxScore, docOverlapScore(queryTokens, doc)), 0);

  return bestOverlap < VECTOR_FALLBACK_STRONG_MATCH_SCORE;
}

function approximateTokens(text: string): number {
  return Math.ceil(text.length / 3.5 + (text.match(/\s+/g) || []).length * 0.1);
}

function compactSnippet(snippet: string, maxLines: number, maxChars: number): string {
  const lines = snippet
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
    .slice(0, Math.max(1, maxLines));
  let out = lines.join("\n");
  if (out.length > maxChars) out = out.slice(0, Math.max(24, maxChars - 1)).trimEnd() + "\u2026";
  return out;
}

// ── Task priority filtering ───────────────────────────────────────────────

const PRIORITY_TAG_RE = /\[(high|medium|low)\]/i;

export function filterTaskByPriority(items: string[], allowedPriorities?: string[]): string[] {
  const envPriorities = process.env.CORTEX_TASK_PRIORITY;
  const allowed = new Set(
    (allowedPriorities || (envPriorities ? envPriorities.split(",").map(s => s.trim().toLowerCase()) : ["high", "medium"]))
  );

  return items.filter(item => {
    const match = item.match(PRIORITY_TAG_RE);
    if (!match) {
      return allowed.has("high") || allowed.has("medium");
    }
    return allowed.has(match[1].toLowerCase());
  });
}

// ── Search ───────────────────────────────────────────────────────────────────

const SHARED_PROJECTS = ["shared", "org"];

export function searchDocuments(
  db: SqlJsDatabase,
  safeQuery: string,
  prompt: string,
  keywords: string,
  detectedProject: string | null,
  searchAllProjects = false,
  cortexPath?: string
): DocRow[] | null {
  // Tier 1: FTS5 — run project-scoped and global in one pass, dedup
  const ftsDocs: DocRow[] = [];
  const ftsSeenKeys = new Set<string>();
  const relaxedQuery = buildRelaxedFtsQuery(keywords || prompt, detectedProject, cortexPath);

  const addFtsRows = (rows: DocRow[] | null) => {
    if (!rows) return;
    for (const doc of rows) {
      const key = doc.path || `${doc.project}/${doc.filename}`;
      if (!ftsSeenKeys.has(key)) { ftsSeenKeys.add(key); ftsDocs.push(doc); }
    }
  };
  const runScopedFtsQuery = (query: string) => {
    if (!query) return;
    if (detectedProject) {
      addFtsRows(queryDocRows(
        db,
        "SELECT project, filename, type, content, path FROM docs WHERE docs MATCH ? AND project = ? ORDER BY rank LIMIT 7",
        [query, detectedProject]
      ));
    }

    if (searchAllProjects || !detectedProject) {
      addFtsRows(queryDocRows(
        db,
        "SELECT project, filename, type, content, path FROM docs WHERE docs MATCH ? ORDER BY rank LIMIT 10",
        [query]
      ));
      return;
    }

    const scopeProjects = [detectedProject, ...SHARED_PROJECTS];
    const placeholders = scopeProjects.map(() => "?").join(", ");
    addFtsRows(queryDocRows(
      db,
      `SELECT project, filename, type, content, path FROM docs WHERE docs MATCH ? AND project IN (${placeholders}) ORDER BY rank LIMIT 10`,
      [query, ...scopeProjects]
    ));
  };

  runScopedFtsQuery(safeQuery);
  if (ftsDocs.length === 0 && relaxedQuery && relaxedQuery !== safeQuery) {
    runScopedFtsQuery(relaxedQuery);
  }

  // Tier 2: Token-overlap semantic — always run, scored independently
  const semanticDocs = semanticFallbackDocs(db, `${prompt}\n${keywords}`, detectedProject);

  // Merge with Reciprocal Rank Fusion so documents found by both tiers rank highest
  const merged = rrfMerge([ftsDocs, semanticDocs]);
  if (merged.length === 0) return null;
  return merged.slice(0, 12);
}

/**
 * Async variant of searchDocuments that also runs real vector search (Tier 3)
 * when cloud embeddings (CORTEX_EMBEDDING_API_URL) or Ollama are available.
 * Falls back to the sync result if vector search is unavailable or fails.
 */
export async function searchDocumentsAsync(
  db: SqlJsDatabase,
  safeQuery: string,
  prompt: string,
  keywords: string,
  detectedProject: string | null,
  searchAllProjects = false,
  cortexPath?: string
): Promise<DocRow[] | null> {
  // Sync result (Tier 1 + Tier 2)
  let syncResult = searchDocuments(db, safeQuery, prompt, keywords, detectedProject, searchAllProjects, cortexPath);
  if (!syncResult || syncResult.length === 0) {
    const keywordRows = keywordFallbackSearch(
      db,
      prompt,
      { project: detectedProject ?? undefined, limit: 8 }
    );
    if (keywordRows?.length) syncResult = keywordRows;
  }

  // Tier 3: Real vector search — only if embeddings are available and cortexPath provided
  const hasVectorBackend = Boolean(getCloudEmbeddingUrl() || getOllamaUrl());
  if (!cortexPath || !hasVectorBackend || !shouldRunVectorExpansion(syncResult, `${prompt}\n${keywords}`)) {
    return syncResult;
  }

  try {
    const existingPaths = new Set<string>(
      (syncResult ?? []).map((d) => d.path || `${d.project}/${d.filename}`)
    );
    const vectorDocs = await vectorFallback(cortexPath, `${prompt}\n${keywords}`, existingPaths, 8, detectedProject);
    if (vectorDocs.length === 0) return syncResult;

    // RRF-merge all three tiers
    const tiers: DocRow[][] = [syncResult ?? [], vectorDocs];
    const merged = rrfMerge(tiers);
    if (merged.length === 0) return syncResult;
    return merged.slice(0, 12);
  } catch (err: unknown) {
    // Vector search failure is non-fatal — return sync result
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] hybridSearch vectorFallback: ${err instanceof Error ? err.message : String(err)}\n`);
    return syncResult;
  }
}

export interface SearchKnowledgeRowsOptions {
  query: string;
  maxResults: number;
  fetchLimit?: number;
  filterProject?: string | null;
  filterType?: string | null;
  cortexPath: string;
}

export interface SearchKnowledgeRowsResult {
  safeQuery: string;
  rows: DocRow[] | null;
  usedFallback: boolean;
}

export async function searchKnowledgeRows(
  db: SqlJsDatabase,
  options: SearchKnowledgeRowsOptions,
): Promise<SearchKnowledgeRowsResult> {
  const {
    query,
    maxResults,
    fetchLimit = maxResults,
    filterProject,
    filterType,
    cortexPath,
  } = options;
  const queryVariants = buildFtsQueryVariants(query, filterProject, cortexPath);
  const safeQuery = queryVariants[0] ?? "";
  if (!safeQuery) return { safeQuery, rows: null, usedFallback: false };

  let sql = "SELECT project, filename, type, content, path FROM docs WHERE docs MATCH ?";
  const params: Array<string | number> = [safeQuery];
  if (filterProject) {
    sql += " AND project = ?";
    params.push(filterProject);
  }
  if (filterType) {
    sql += " AND type = ?";
    params.push(filterType);
  }
  sql += " ORDER BY rank LIMIT ?";
  params.push(fetchLimit);

  let activeFtsQuery = safeQuery;
  let rows = queryDocRows(db, sql, params);
  if ((!rows || rows.length === 0) && queryVariants.length > 1) {
    for (const variant of queryVariants.slice(1)) {
      const relaxedParams = [...params];
      relaxedParams[0] = variant;
      rows = queryDocRows(db, sql, relaxedParams);
      if (rows?.length) {
        activeFtsQuery = variant;
        break;
      }
    }
  }

  let usedFallback = false;

  if (rows && rows.length < 3) {
    const ftsRowids = new Set<number>();
    try {
      let rowidSql = "SELECT rowid, project, filename, type, content, path FROM docs WHERE docs MATCH ?";
      const rowidParams: Array<string | number> = [activeFtsQuery];
      if (filterProject) {
        rowidSql += " AND project = ?";
        rowidParams.push(filterProject);
      }
      if (filterType) {
        rowidSql += " AND type = ?";
        rowidParams.push(filterType);
      }
      rowidSql += " ORDER BY rank LIMIT ?";
      rowidParams.push(maxResults);
      const rowidResult = db.exec(rowidSql, rowidParams);
      if (rowidResult?.length && rowidResult[0]?.values?.length) {
        for (const row of rowidResult[0].values) {
          ftsRowids.add(rowToDocWithRowid(row).rowid);
        }
      }
    } catch (err: unknown) {
      debugLog(`rowid dedup query failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const cosineResults = cosineFallback(db, query, ftsRowids, maxResults - rows.length)
      .filter((doc) => (!filterProject || doc.project === filterProject) && (!filterType || doc.type === filterType));
    if (cosineResults.length > 0) {
      rows = [...rows, ...cosineResults];
      usedFallback = true;
    }
  }

  if (!rows) {
    const cosineResults = cosineFallback(db, query, new Set<number>(), maxResults)
      .filter((doc) => (!filterProject || doc.project === filterProject) && (!filterType || doc.type === filterType));
    if (cosineResults.length > 0) {
      rows = cosineResults;
      usedFallback = true;
    }
  }

  if (!rows) {
    const fallbackRows = keywordFallbackSearch(db, query, {
      project: filterProject ?? undefined,
      type: filterType ?? undefined,
      limit: maxResults,
    });
    if (fallbackRows) {
      rows = fallbackRows;
      usedFallback = true;
    }
  }

  if (shouldRunVectorExpansion(rows, query, maxResults)) {
    try {
      const existingRows = rows ?? [];
      const alreadyFoundPaths = new Set(existingRows.map((row) => row.path));
      const vecRows = await vectorFallback(
        cortexPath,
        query,
        alreadyFoundPaths,
        Math.max(0, maxResults - existingRows.length),
        filterProject ?? undefined,
      );
      const filteredVecRows = filterType ? vecRows.filter((row) => row.type === filterType) : vecRows;
      if (filteredVecRows.length > 0) {
        rows = [...existingRows, ...filteredVecRows];
        usedFallback = true;
      }
    } catch (err: unknown) {
      if (process.env.CORTEX_DEBUG) {
        process.stderr.write(`[cortex] vectorFallback: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  }

  return { safeQuery, rows, usedFallback };
}

// ── Trust filter ─────────────────────────────────────────────────────────────

const TRUST_FILTERED_TYPES = new Set(["findings", "reference", "knowledge"]);

export type TrustFilterQueueItem = { project: string; section: "Stale" | "Conflicts"; items: string[] };

export type TrustFilterResult = { rows: DocRow[]; queueItems: TrustFilterQueueItem[]; auditEntries: string[] };

/** Apply trust filter to rows. Returns filtered rows plus any queue/audit items to be written
 * by the caller — retrieval itself should remain side-effect-free. */
export function applyTrustFilter(
  rows: DocRow[],
  ttlDays: number,
  minConfidence: number,
  decay: Partial<RetentionPolicy["decay"]>
): TrustFilterResult {
  const queueItems: TrustFilterQueueItem[] = [];
  const auditEntries: string[] = [];

  const filtered = rows
    .map((doc) => {
      if (!TRUST_FILTERED_TYPES.has(doc.type)) return doc;
      const trust = filterTrustedFindingsDetailed(doc.content, { ttlDays, minConfidence, decay });
      if (trust.issues.length > 0) {
        const stale = trust.issues.filter((i) => i.reason === "stale").map((i) => i.bullet);
        const conflicts = trust.issues.filter((i) => i.reason === "invalid_citation").map((i) => i.bullet);
        if (stale.length) queueItems.push({ project: doc.project, section: "Stale", items: stale });
        if (conflicts.length) queueItems.push({ project: doc.project, section: "Conflicts", items: conflicts });
        auditEntries.push(`project=${doc.project} type=${doc.type} stale=${stale.length} invalid_citation=${conflicts.length}`);
      }
      return { ...doc, content: trust.content };
    })
    .filter((doc) => {
      return !TRUST_FILTERED_TYPES.has(doc.type) || Boolean(doc.content.trim());
    });

  return { rows: filtered, queueItems, auditEntries };
}

// ── Ranking ──────────────────────────────────────────────────────────────────

function mostRecentDate(content: string): string {
  const matches = content.match(/^## (\d{4}-\d{2}-\d{2})/gm);
  if (!matches || matches.length === 0) return "0000-00-00";
  return matches.map((m) => m.slice(3)).sort().reverse()[0];
}

/** Shared helper: compute age in days from a YYYY-MM-DD date string. Returns Infinity for invalid/missing dates. */
function ageInDaysFromDate(dateStr: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || dateStr === "0000-00-00") return Infinity;
  const todayUtc = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  const entryUtc = Date.parse(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(entryUtc)) return Infinity;
  return Math.max(0, Math.floor((todayUtc - entryUtc) / 86_400_000));
}

/** Item 3: Recency boost for findings. Recent findings rank higher. Accepts pre-computed date string. */
export function recencyBoost(docType: string, latestDate: string): number {
  if (docType !== "findings") return 0;
  const age = ageInDaysFromDate(latestDate);
  if (age <= 7) return 0.3;
  if (age <= 30) return 0.15;
  return 0;
}

function crossProjectAgeMultiplier(doc: DocRow, detectedProject: string | null, latestDate: string): number {
  if (doc.type !== "findings" || !detectedProject || doc.project === detectedProject) return 1;
  const decayDaysRaw = Number.parseInt(process.env.CORTEX_CROSS_PROJECT_DECAY_DAYS ?? "30", 10);
  const decayDays = Number.isFinite(decayDaysRaw) && decayDaysRaw > 0 ? decayDaysRaw : 30;
  const age = ageInDaysFromDate(latestDate);
  const ageInDays = Number.isFinite(age) ? age : 90;
  return Math.max(0.1, 1 - (ageInDays / decayDays));
}

export function rankResults(
  rows: DocRow[],
  intent: string,
  gitCtx: GitContext | null,
  detectedProject: string | null,
  cortexPathLocal: string,
  db: SqlJsDatabase,
  cwd?: string,
  query?: string,
  opts?: { filterType?: string | null; skipTaskFilter?: boolean }
): DocRow[] {
  let ranked = [...rows];
  const queryTokens = query ? tokenizeForOverlap(query) : [];

  if (detectedProject) {
    const localByType = new Set(
      ranked.filter((r) => r.project === detectedProject).map((r) => r.type)
    );
    // Keep all local docs, and allow up to 2 shared/org docs per type even if
    // that type exists locally — avoids suppressing cross-project knowledge.
    const sharedCountByType = new Map<string, number>();
    const MAX_SHARED_PER_TYPE = 2;
    ranked = ranked.filter((r) => {
      if (r.project === detectedProject) return true;
      if (!localByType.has(r.type)) return true;
      const count = sharedCountByType.get(r.type) ?? 0;
      if (count < MAX_SHARED_PER_TYPE) {
        sharedCountByType.set(r.type, count + 1);
        return true;
      }
      return false;
    });

    const canonicalRows = queryDocRows(
      db,
      "SELECT project, filename, type, content, path FROM docs WHERE project = ? AND type = 'canonical' LIMIT 1",
      [detectedProject]
    );
    if (canonicalRows) ranked = [...canonicalRows, ...ranked];
  }

  const entityBoost = query ? getEntityBoostDocs(db, query) : new Set<string>();
  const entityBoostPaths = new Set<string>();
  for (const doc of ranked) {
    // Use getDocSourceKey to build the full project/relFile key, matching what
    // entity_links stores (e.g. project/reference/arch.md, not project/arch.md).
    const docKey = getDocSourceKey(doc, cortexPathLocal);
    if (entityBoost.has(docKey)) entityBoostPaths.add(doc.path);
  }

  // Pre-compute mostRecentDate once per findings doc to avoid O(n log n) regex rescans in sort.
  const recentDateCache = new Map<string, string>();
  for (const doc of ranked) {
    if (doc.type === "findings") {
      const key = doc.path || `${doc.project}/${doc.filename}`;
      recentDateCache.set(key, mostRecentDate(doc.content));
    }
  }
  const getRecentDate = (doc: DocRow): string =>
    recentDateCache.get(doc.path || `${doc.project}/${doc.filename}`) ?? "0000-00-00";

  // Precompute per-doc ranking metadata once — avoids recomputing inside sort comparator.
  const changedFiles = gitCtx?.changedFiles || new Set<string>();
  const FILE_MATCH_BOOST = 1.5;
  type ScoredDoc = {
    doc: DocRow;
    score: number;
    fileMatch: boolean;
    globBoost: number;
    qualityMult: number;
    entity: number;
    date: string;
    queryOverlap: number;
  };
  const scored: ScoredDoc[] = ranked.map((doc) => {
    const globBoost = getProjectGlobBoost(cortexPathLocal, doc.project, cwd, gitCtx?.changedFiles);
    const key = entryScoreKey(doc.project, doc.filename, doc.content);
    const entity = entityBoostPaths.has(doc.path) ? 1.3 : 1;
    const date = getRecentDate(doc);
    const fileRel = fileRelevanceBoost(doc.path, changedFiles);
    const branchMat = branchMatchBoost(doc.content, gitCtx?.branch);
    const qualityMult = getQualityMultiplier(cortexPathLocal, key);
    const queryOverlap = queryTokens.length > 0 ? docOverlapScore(queryTokens, doc) : 0;
    const queryOverlapWeight = detectedProject && doc.project === detectedProject
      ? LOCAL_QUERY_OVERLAP_WEIGHT
      : CROSS_PROJECT_QUERY_OVERLAP_WEIGHT;
    const weakCrossProjectPenalty = detectedProject
      && doc.project !== detectedProject
      && queryTokens.length > 0
      && queryOverlap < WEAK_CROSS_PROJECT_OVERLAP_MAX
      ? WEAK_CROSS_PROJECT_OVERLAP_PENALTY
      : 0;
    const score = Math.round((
      intentBoost(intent, doc.type) +
      fileRel +
      branchMat +
      globBoost +
      qualityMult +
      entity +
      queryOverlap * queryOverlapWeight +
      recencyBoost(doc.type, date) -
      weakCrossProjectPenalty -
      lowValuePenalty(doc.content, doc.type)
    ) * crossProjectAgeMultiplier(doc, detectedProject, date) * 10000) / 10000;
    const fileMatch = fileRel > 0 || branchMat > 0;
    return { doc, score, fileMatch, globBoost, qualityMult, entity, date, queryOverlap };
  });

  // Single composite sort on cached values.
  scored.sort((a, b) => {
    if (isFeatureEnabled("CORTEX_FEATURE_GIT_CONTEXT_FILTER", false)) {
      if (gitCtx && gitCtx.changedFiles.size > 0) {
        const scoreDiff = (b.fileMatch ? FILE_MATCH_BOOST : 1) - (a.fileMatch ? FILE_MATCH_BOOST : 1);
        if (scoreDiff !== 0) return scoreDiff;
      }
    }

    const isFindingsA = a.doc.type === "findings";
    const isFindingsB = b.doc.type === "findings";
    if (isFindingsA !== isFindingsB) return isFindingsA ? -1 : 1;
    if (isFindingsA && isFindingsB) {
      const byDate = b.date.localeCompare(a.date);
      if (byDate !== 0) return byDate;
    }

    const scoreDelta = b.score - a.score;
    if (Math.abs(scoreDelta) > 0.01) return scoreDelta;

    const overlapDelta = b.queryOverlap - a.queryOverlap;
    if (Math.abs(overlapDelta) > 0.01) return overlapDelta;

    const globDelta = b.globBoost - a.globBoost;
    if (Math.abs(globDelta) > 0.01) return globDelta;

    const qualityDelta = b.qualityMult - a.qualityMult;
    if (qualityDelta !== 0) return qualityDelta;

    if (b.entity !== a.entity) return b.entity - a.entity;

    return (a.doc.path || `${a.doc.project}/${a.doc.filename}`).localeCompare(b.doc.path || `${b.doc.project}/${b.doc.filename}`);
  });

  const shouldFilterTask = intent !== "build" && !opts?.skipTaskFilter && opts?.filterType !== "task";
  const rescuedTaskPaths = new Set<string>();
  if (shouldFilterTask && queryTokens.length > 0) {
    const bestTask = scored.find((entry) => entry.doc.type === "task");
    if (bestTask && bestTask.queryOverlap >= TASK_RESCUE_MIN_OVERLAP) {
      const bestNonTask = scored.find((entry) => entry.doc.type !== "task");
      if (
        !bestNonTask
        || bestTask.queryOverlap >= bestNonTask.queryOverlap + TASK_RESCUE_OVERLAP_MARGIN
        || bestTask.score >= bestNonTask.score + TASK_RESCUE_SCORE_MARGIN
      ) {
        rescuedTaskPaths.add(bestTask.doc.path || `${bestTask.doc.project}/${bestTask.doc.filename}`);
      }
    }
  }
  ranked = scored.map((s) => s.doc);

  ranked = ranked.slice(0, 8);

  if (shouldFilterTask) {
    ranked = ranked.filter((r) => {
      if (r.type !== "task") return true;
      const key = r.path || `${r.project}/${r.filename}`;
      return rescuedTaskPaths.has(key);
    });
  }

  return ranked;
}

// ── Snippet selection ────────────────────────────────────────────────────────

export interface SelectedSnippet {
  doc: DocRow;
  snippet: string;
  key: string;
}

/** Mark snippet lines with stale citations (cited file missing or line content changed). */
export function markStaleCitations(snippet: string): string {
  const lines = snippet.split("\n");
  const result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Check if the next line is a citation comment
    const nextLine = lines[i + 1];
    if (nextLine) {
      const citation = parseCitationComment(nextLine);
      if (citation && citation.file) {
        const resolvedFile = citation.repo
          ? path.resolve(citation.repo, citation.file)
          : (path.isAbsolute(citation.file) ? citation.file : null);
        if (resolvedFile) {
          let stale = false;
          if (!fs.existsSync(resolvedFile)) {
            stale = true;
          } else if (citation.line !== undefined && citation.line >= 1) {
            // Verify the cited line still has content (not beyond EOF)
            try {
              const fileLines = fs.readFileSync(resolvedFile, "utf8").split("\n");
              if (citation.line > fileLines.length) {
                stale = true;
              } else if (fileLines[citation.line - 1].trim() === "") {
                // Line exists but is now empty — content has drifted
                stale = true;
              }
            } catch (err: unknown) {
              if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] applyCitationAnnotations fileRead: ${err instanceof Error ? err.message : String(err)}\n`);
              stale = true;
            }
          }
          if (stale) {
            result.push(line + " [stale citation]");
            i++; // skip the citation comment line
            continue;
          }
        }
      }
    }
    result.push(line);
  }
  return result.join("\n");
}

export function selectSnippets(
  rows: DocRow[],
  keywords: string,
  tokenBudget: number,
  lineBudget: number,
  charBudget: number
): { selected: SelectedSnippet[]; usedTokens: number } {
  const selected: SelectedSnippet[] = [];
  let usedTokens = 36;
  const queryTokens = tokenizeForOverlap(keywords);
  for (const doc of rows) {
    let snippet = compactSnippet(extractSnippet(doc.content, keywords, 8), lineBudget, charBudget);
    if (!snippet.trim()) continue;
    // Mark findings with stale citations before injection
    if (TRUST_FILTERED_TYPES.has(doc.type)) {
      snippet = markStaleCitations(snippet);
    }
    let focusScore = queryTokens.length > 0
      ? overlapScore(queryTokens, `${doc.filename}\n${snippet}`)
      : 1;
    if (focusScore < LOW_FOCUS_SNIPPET_SCORE) {
      snippet = compactSnippet(
        snippet,
        Math.min(lineBudget, LOW_FOCUS_SNIPPET_LINE_CAP),
        Math.max(120, Math.floor(charBudget * LOW_FOCUS_SNIPPET_CHAR_FRACTION))
      );
      focusScore = queryTokens.length > 0
        ? overlapScore(queryTokens, `${doc.filename}\n${snippet}`)
        : focusScore;
    }
    let est = approximateTokens(snippet) + 14;
    if (selected.length > 0 && focusScore < VERY_LOW_FOCUS_SNIPPET_SCORE && usedTokens + est > Math.floor(tokenBudget * 0.8)) {
      continue;
    }
    if (selected.length > 0 && usedTokens + est > tokenBudget) break;
    if (selected.length === 0 && usedTokens + est > tokenBudget) {
      snippet = compactSnippet(snippet, 3, Math.floor(charBudget * 0.55));
      est = approximateTokens(snippet) + 14;
    }
    const key = entryScoreKey(doc.project, doc.filename, doc.content);
    selected.push({ doc, snippet, key });
    usedTokens += est;
    if (selected.length >= 3) break;
  }
  // Final pass: trim from the end if token budget is exceeded (guards against
  // rounding / compaction producing more tokens than estimated during selection)
  while (selected.length > 1 && usedTokens > tokenBudget) {
    const removed = selected.pop()!;
    usedTokens -= approximateTokens(removed.snippet) + 14;
  }
  return { selected, usedTokens };
}

// Re-export approximateTokens for use in output module
export { approximateTokens };
