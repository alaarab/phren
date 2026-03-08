import {
  type RetentionPolicy,
  getRetentionPolicy,
  getQualityMultiplier,
  entryScoreKey,
} from "./shared-governance.js";
import {
  queryDocRows,
  type DocRow,
  type SqlJsDatabase,
  extractSnippet,
  getDocSourceKey,
  getEntityBoostDocs,
} from "./shared-index.js";
import {
  filterTrustedFindingsDetailed,
} from "./shared-content.js";
import { parseCitationComment } from "./content-citation.js";
import { STOP_WORDS, isFeatureEnabled, clampInt } from "./utils.js";
import * as fs from "fs";
import * as path from "path";
import { getProjectGlobBoost } from "./cli-hooks-globs.js";
import type { GitContext } from "./cli-hooks-session.js";
export type { GitContext } from "./cli-hooks-session.js";
import { vectorFallback } from "./shared-search-fallback.js";
import { getOllamaUrl, getCloudEmbeddingUrl } from "./shared-ollama.js";

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
  if (intent === "build" && (docType === "backlog" || docType === "reference")) return 2;
  if (intent === "docs" && (docType === "summary" || docType === "claude")) return 2;
  if (docType === "canonical") return 2;
  return 0;
}

function fileRelevanceBoost(filePath: string, changedFiles: Set<string>): number {
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

export function branchTokens(branch: string): string[] {
  return branch
    .split(/[\/._-]/g)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 2 && !["main", "master", "feature", "fix", "bugfix", "hotfix"].includes(s));
}

function branchMatchBoost(content: string, branch: string | undefined): number {
  if (!branch) return 0;
  const text = content.toLowerCase();
  const tokens = branchTokens(branch);
  let score = 0;
  for (const t of tokens) {
    if (text.includes(t)) score += 1;
  }
  return Math.min(3, score);
}

function lowValuePenalty(content: string, docType: string): number {
  if (docType !== "findings") return 0;
  const bullets = content.split("\n").filter((l) => l.startsWith("- "));
  if (bullets.length === 0) return 0;
  const defaults = ["fixed stuff", "updated things", "misc", "temp", "wip", "todo", "placeholder", "cleanup"];
  const configured = (process.env.CORTEX_LOW_VALUE_PATTERNS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const fragments = configured.length ? configured : defaults;
  const pattern = new RegExp(`(${fragments.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "i");
  const low = bullets.filter((b) => pattern.test(b) || b.length < 16).length;
  return low >= Math.ceil(bullets.length * 0.5) ? 2 : 0;
}

// ── Token and snippet helpers ────────────────────────────────────────────────

function normalizeToken(token: string): string {
  let t = token.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (t.length > 4 && t.endsWith("s") && !t.endsWith("ss")) t = t.slice(0, -1);
  return t;
}

function tokenizeForOverlap(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s]/g, " ")
    .split(/\s+/)
    .map(normalizeToken)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
  return [...new Set(tokens)].slice(0, 24);
}

function overlapScore(queryTokens: string[], content: string): number {
  if (!queryTokens.length) return 0;
  const contentTokens = new Set(tokenizeForOverlap(content));
  if (!contentTokens.size) return 0;
  let matched = 0;
  for (const t of queryTokens) {
    if (contentTokens.has(t)) matched += 1;
  }
  const denominator = Math.max(2, Math.min(queryTokens.length, 10));
  return matched / denominator;
}

/**
 * Item 4: Reciprocal Rank Fusion — merges ranked result lists from multiple search tiers.
 * Documents appearing in multiple tiers get a higher combined score.
 * Formula: score(d) = Σ 1/(k + rank_i) for each tier i containing d, where k=60 (standard).
 */
function rrfMerge(tiers: DocRow[][], k = 60): DocRow[] {
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
  const queryTokens = tokenizeForOverlap(prompt);
  if (!queryTokens.length) return [];
  const sampleLimit = 100;
  // ORDER BY RANDOM() avoids insertion-order bias — older docs get equal sampling probability.
  const docs = project
    ? queryDocRows(
      db,
      "SELECT project, filename, type, content, path FROM docs WHERE project = ? ORDER BY RANDOM() LIMIT ?",
      [project, sampleLimit]
    ) || []
    : queryDocRows(
      db,
      "SELECT project, filename, type, content, path FROM docs ORDER BY RANDOM() LIMIT ?",
      [sampleLimit]
    ) || [];

  const scored = docs
    .map((doc) => {
      const corpus = `${doc.project} ${doc.filename} ${doc.type} ${doc.path}\n${doc.content.slice(0, 5000)}`;
      const score = overlapScore(queryTokens, corpus);
      return { doc, score };
    })
    .filter((x) => x.score >= 0.25)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((x) => x.doc);

  return scored;
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

// ── Backlog priority filtering ───────────────────────────────────────────────

const PRIORITY_TAG_RE = /\[(high|medium|low)\]/i;

export function filterBacklogByPriority(items: string[], allowedPriorities?: string[]): string[] {
  const envPriorities = process.env.CORTEX_BACKLOG_PRIORITY;
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

  const addFtsRows = (rows: DocRow[] | null) => {
    if (!rows) return;
    for (const doc of rows) {
      const key = doc.path || `${doc.project}/${doc.filename}`;
      if (!ftsSeenKeys.has(key)) { ftsSeenKeys.add(key); ftsDocs.push(doc); }
    }
  };

  if (detectedProject) {
    addFtsRows(queryDocRows(
      db,
      "SELECT project, filename, type, content, path FROM docs WHERE docs MATCH ? AND project = ? ORDER BY rank LIMIT 7",
      [safeQuery, detectedProject]
    ));
  }

  if (searchAllProjects || !detectedProject) {
    addFtsRows(queryDocRows(
      db,
      "SELECT project, filename, type, content, path FROM docs WHERE docs MATCH ? ORDER BY rank LIMIT 10",
      [safeQuery]
    ));
  } else {
    const scopeProjects = [detectedProject, ...SHARED_PROJECTS];
    const placeholders = scopeProjects.map(() => "?").join(", ");
    addFtsRows(queryDocRows(
      db,
      `SELECT project, filename, type, content, path FROM docs WHERE docs MATCH ? AND project IN (${placeholders}) ORDER BY rank LIMIT 10`,
      [safeQuery, ...scopeProjects]
    ));
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
  const syncResult = searchDocuments(db, safeQuery, prompt, keywords, detectedProject, searchAllProjects, cortexPath);

  // Tier 3: Real vector search — only if embeddings are available and cortexPath provided
  const hasVectorBackend = Boolean(getCloudEmbeddingUrl() || getOllamaUrl());
  if (!cortexPath || !hasVectorBackend) {
    return syncResult;
  }

  try {
    const existingPaths = new Set<string>(
      (syncResult ?? []).map((d) => d.path || `${d.project}/${d.filename}`)
    );
    const vectorDocs = await vectorFallback(cortexPath, `${prompt}\n${keywords}`, existingPaths, 8);
    if (vectorDocs.length === 0) return syncResult;

    // RRF-merge all three tiers
    const tiers: DocRow[][] = [syncResult ?? [], vectorDocs];
    const merged = rrfMerge(tiers);
    if (merged.length === 0) return syncResult;
    return merged.slice(0, 12);
  } catch {
    // Vector search failure is non-fatal — return sync result
    return syncResult;
  }
}

// ── Trust filter ─────────────────────────────────────────────────────────────

const TRUST_FILTERED_TYPES = new Set(["findings", "reference", "knowledge"]);

export type TrustFilterQueueItem = { project: string; section: "Stale" | "Conflicts"; items: string[] };

export type TrustFilterResult = { rows: DocRow[]; queueItems: TrustFilterQueueItem[]; auditEntries: string[] };

/** Apply trust filter to rows. Returns filtered rows plus any queue/audit items to be written
 * by the caller — retrieval itself should remain side-effect-free. */
export function applyTrustFilter(
  rows: DocRow[],
  cortexPathLocal: string,
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
function recencyBoost(docType: string, latestDate: string): number {
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
  query?: string
): DocRow[] {
  let ranked = [...rows];

  if (detectedProject) {
    const localByType = new Set(
      ranked.filter((r) => r.project === detectedProject).map((r) => r.type)
    );
    ranked = ranked.filter((r) => {
      if (r.project === detectedProject) return true;
      return !localByType.has(r.type);
    });

    const canonicalRows = queryDocRows(
      db,
      "SELECT project, filename, type, content, path FROM docs WHERE project = ? AND type = 'canonical' LIMIT 1",
      [detectedProject]
    );
    if (canonicalRows) ranked = [...canonicalRows, ...ranked];
  }

  const entityBoost = query ? getEntityBoostDocs(db, query, cortexPathLocal) : new Set<string>();
  const entityBoostPaths = new Set<string>();
  for (const doc of ranked) {
    const docKey = `${doc.project}/${doc.filename}`;
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

  // Single composite sort — file-match boost is highest priority so relevant files
  // are not excluded by the slice. All criteria in one pass for deterministic ordering.
  const FILE_MATCH_BOOST = 1.5;
  ranked.sort((a, b) => {
    // Highest priority: currently-changed files / branch-matching docs
    // Only apply git-context filtering when explicitly opted in
    if (process.env.CORTEX_FEATURE_GIT_CONTEXT_FILTER === 'true') {
      if (gitCtx && gitCtx.changedFiles.size > 0) {
        const aMatch = fileRelevanceBoost(a.path, gitCtx.changedFiles) > 0 || branchMatchBoost(a.content, gitCtx.branch) > 0;
        const bMatch = fileRelevanceBoost(b.path, gitCtx.changedFiles) > 0 || branchMatchBoost(b.content, gitCtx.branch) > 0;
        const scoreDiff = (bMatch ? FILE_MATCH_BOOST : 1) - (aMatch ? FILE_MATCH_BOOST : 1);
        if (scoreDiff !== 0) return scoreDiff;
      }
    }

    const isFindingsA = a.type === "findings";
    const isFindingsB = b.type === "findings";
    if (isFindingsA !== isFindingsB) return isFindingsA ? -1 : 1;
    if (isFindingsA && isFindingsB) {
      const byDate = getRecentDate(b).localeCompare(getRecentDate(a));
      if (byDate !== 0) return byDate;
    }

    const changedFiles = gitCtx?.changedFiles || new Set<string>();
    const globBoostA = getProjectGlobBoost(cortexPathLocal, a.project, cwd, gitCtx?.changedFiles);
    const globBoostB = getProjectGlobBoost(cortexPathLocal, b.project, cwd, gitCtx?.changedFiles);
    const keyA = entryScoreKey(a.project, a.filename, a.content);
    const keyB = entryScoreKey(b.project, b.filename, b.content);
    const entityA = entityBoostPaths.has(a.path) ? 1.3 : 1;
    const entityB = entityBoostPaths.has(b.path) ? 1.3 : 1;
    const dateA = getRecentDate(a);
    const dateB = getRecentDate(b);
    const scoreA = (
      intentBoost(intent, a.type) +
      fileRelevanceBoost(a.path, changedFiles) +
      branchMatchBoost(a.content, gitCtx?.branch) +
      globBoostA +
      getQualityMultiplier(cortexPathLocal, keyA) +
      entityA +
      recencyBoost(a.type, dateA) -
      lowValuePenalty(a.content, a.type)
    ) * crossProjectAgeMultiplier(a, detectedProject, dateA);
    const scoreB = (
      intentBoost(intent, b.type) +
      fileRelevanceBoost(b.path, changedFiles) +
      branchMatchBoost(b.content, gitCtx?.branch) +
      globBoostB +
      getQualityMultiplier(cortexPathLocal, keyB) +
      entityB +
      recencyBoost(b.type, dateB) -
      lowValuePenalty(b.content, b.type)
    ) * crossProjectAgeMultiplier(b, detectedProject, dateB);
    // Round scores to avoid floating-point comparison instability
    const roundedA = Math.round(scoreA * 10000) / 10000;
    const roundedB = Math.round(scoreB * 10000) / 10000;
    const scoreDelta = roundedB - roundedA;
    if (Math.abs(scoreDelta) > 0.01) return scoreDelta;

    const intentDelta = intentBoost(intent, b.type) - intentBoost(intent, a.type);
    if (intentDelta !== 0) return intentDelta;

    const fileDelta = fileRelevanceBoost(b.path, changedFiles) - fileRelevanceBoost(a.path, changedFiles);
    if (fileDelta !== 0) return fileDelta;

    const branchDelta = branchMatchBoost(b.content, gitCtx?.branch) - branchMatchBoost(a.content, gitCtx?.branch);
    if (branchDelta !== 0) return branchDelta;

    const globDelta = globBoostB - globBoostA;
    if (Math.abs(globDelta) > 0.01) return globDelta;

    const qualityDelta = getQualityMultiplier(cortexPathLocal, keyB) - getQualityMultiplier(cortexPathLocal, keyA);
    if (qualityDelta !== 0) return qualityDelta;

    const penaltyDelta = lowValuePenalty(a.content, a.type) - lowValuePenalty(b.content, b.type);
    if (penaltyDelta !== 0) return penaltyDelta;

    if (entityB !== entityA) return entityB - entityA;

    // Stable secondary sort: deterministic ordering for identical scores
    return (a.path || `${a.project}/${a.filename}`).localeCompare(b.path || `${b.project}/${b.filename}`);
  });

  ranked = ranked.slice(0, 8);

  if (intent !== "build") {
    ranked = ranked.filter((r) => r.type !== "backlog");
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
            } catch {
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
  for (const doc of rows) {
    let snippet = compactSnippet(extractSnippet(doc.content, keywords, 8), lineBudget, charBudget);
    if (!snippet.trim()) continue;
    // Mark findings with stale citations before injection
    if (TRUST_FILTERED_TYPES.has(doc.type)) {
      snippet = markStaleCitations(snippet);
    }
    let est = approximateTokens(snippet) + 14;
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
