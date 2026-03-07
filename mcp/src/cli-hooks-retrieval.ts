import {
  type RetentionPolicy,
  getRetentionPolicy,
  appendReviewQueue,
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
import { STOP_WORDS, isFeatureEnabled, clampInt } from "./utils.js";
import { appendAuditLog } from "./shared.js";
import { getProjectGlobBoost } from "./cli-hooks-globs.js";

// ── Git context types ────────────────────────────────────────────────────────

export interface GitContext {
  branch: string;
  changedFiles: Set<string>;
}

// ── Intent and scoring helpers ───────────────────────────────────────────────

export function detectTaskIntent(prompt: string): "debug" | "review" | "build" | "docs" | "general" {
  const p = prompt.toLowerCase();
  if (/(bug|error|fix|broken|regression|fail|stack trace)/.test(p)) return "debug";
  if (/(review|audit|pr|pull request|nit|refactor)/.test(p)) return "review";
  if (/(build|deploy|release|ci|workflow|pipeline|test)/.test(p)) return "build";
  if (/(doc|readme|explain|guide|instruction)/.test(p)) return "docs";
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
  for (const cf of changedFiles) {
    const n = cf.replace(/\\/g, "/");
    if (normalized.endsWith(n) || normalized.includes(`/${n}`)) return 3;
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

function mergeUniqueDocs(primary: DocRow[] | null, secondary: DocRow[]): DocRow[] | null {
  if (!primary || !primary.length) return secondary.length ? secondary : null;
  const seen = new Set(primary.map((r) => r.path || `${r.project}/${r.filename}`));
  for (const doc of secondary) {
    const key = doc.path || `${doc.project}/${doc.filename}`;
    if (seen.has(key)) continue;
    seen.add(key);
    primary.push(doc);
  }
  return primary;
}

function semanticFallbackDocs(db: SqlJsDatabase, prompt: string, project?: string | null): DocRow[] {
  const queryTokens = tokenizeForOverlap(prompt);
  if (!queryTokens.length) return [];
  const sampleLimit = project ? 180 : 260;
  const docs = project
    ? queryDocRows(
      db,
      "SELECT project, filename, type, content, path FROM docs WHERE project = ? LIMIT ?",
      [project, sampleLimit]
    ) || []
    : queryDocRows(
      db,
      "SELECT project, filename, type, content, path FROM docs LIMIT ?",
      [sampleLimit]
    ) || [];

  const scored = docs
    .map((doc) => {
      const corpus = `${doc.project} ${doc.filename} ${doc.type} ${doc.path}\n${doc.content.slice(0, 5000)}`;
      const score = overlapScore(queryTokens, corpus);
      return { doc, score };
    })
    .filter((x) => x.score >= 0.15)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((x) => x.doc);

  return scored;
}

function approximateTokens(text: string): number {
  return Math.ceil(text.length / 4);
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
  searchAllProjects = false
): DocRow[] | null {
  let rows: DocRow[] | null = null;

  if (detectedProject) {
    rows = queryDocRows(
      db,
      "SELECT project, filename, type, content, path FROM docs WHERE docs MATCH ? AND project = ? ORDER BY rank LIMIT 7",
      [safeQuery, detectedProject]
    );
  }

  if (!rows || rows.length < 3) {
    let globalRows: DocRow[] | null;
    if (searchAllProjects || !detectedProject) {
      globalRows = queryDocRows(
        db,
        "SELECT project, filename, type, content, path FROM docs WHERE docs MATCH ? ORDER BY rank LIMIT 10",
        [safeQuery]
      );
    } else {
      const scopeProjects = [detectedProject, ...SHARED_PROJECTS];
      const placeholders = scopeProjects.map(() => "?").join(", ");
      globalRows = queryDocRows(
        db,
        `SELECT project, filename, type, content, path FROM docs WHERE docs MATCH ? AND project IN (${placeholders}) ORDER BY rank LIMIT 10`,
        [safeQuery, ...scopeProjects]
      );
    }
    rows = mergeUniqueDocs(rows, globalRows || []);
  }

  if (!rows || rows.length < 2) {
    const semanticRows = semanticFallbackDocs(db, `${prompt}\n${keywords}`, detectedProject);
    rows = mergeUniqueDocs(rows, semanticRows);
  }

  return rows;
}

// ── Trust filter ─────────────────────────────────────────────────────────────

export function applyTrustFilter(
  rows: DocRow[],
  cortexPathLocal: string,
  ttlDays: number,
  minConfidence: number,
  decay: Partial<RetentionPolicy["decay"]>
): DocRow[] {
  return rows
    .map((doc) => {
      if (doc.type !== "findings") return doc;
      const trust = filterTrustedFindingsDetailed(doc.content, { ttlDays, minConfidence, decay });
      if (trust.issues.length > 0) {
        const stale = trust.issues.filter((i) => i.reason === "stale").map((i) => i.bullet);
        const conflicts = trust.issues.filter((i) => i.reason === "invalid_citation").map((i) => i.bullet);
        if (stale.length) appendReviewQueue(cortexPathLocal, doc.project, "Stale", stale);
        if (conflicts.length) appendReviewQueue(cortexPathLocal, doc.project, "Conflicts", conflicts);
        appendAuditLog(
          cortexPathLocal,
          "trust_filter",
          `project=${doc.project} stale=${stale.length} invalid_citation=${conflicts.length}`
        );
      }
      return { ...doc, content: trust.content };
    })
    .filter((doc) => {
      return doc.type !== "findings" || Boolean(doc.content.trim());
    });
}

// ── Ranking ──────────────────────────────────────────────────────────────────

function mostRecentDate(content: string): string {
  const matches = content.match(/^## (\d{4}-\d{2}-\d{2})/gm);
  if (!matches || matches.length === 0) return "0000-00-00";
  return matches.map((m) => m.slice(3)).sort().reverse()[0];
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

  ranked.sort((a, b) => {
    const isFindingsA = a.type === "findings";
    const isFindingsB = b.type === "findings";
    if (isFindingsA !== isFindingsB) return isFindingsA ? 1 : -1;
    if (isFindingsA && isFindingsB) {
      const byDate = mostRecentDate(b.content).localeCompare(mostRecentDate(a.content));
      if (byDate !== 0) return byDate;
    }

    const intentDelta = intentBoost(intent, b.type) - intentBoost(intent, a.type);
    if (intentDelta !== 0) return intentDelta;

    const changedFiles = gitCtx?.changedFiles || new Set<string>();
    const fileDelta = fileRelevanceBoost(b.path, changedFiles) - fileRelevanceBoost(a.path, changedFiles);
    if (fileDelta !== 0) return fileDelta;

    const branchDelta = branchMatchBoost(b.content, gitCtx?.branch) - branchMatchBoost(a.content, gitCtx?.branch);
    if (branchDelta !== 0) return branchDelta;

    const globBoostA = getProjectGlobBoost(cortexPathLocal, a.project, cwd, gitCtx?.changedFiles);
    const globBoostB = getProjectGlobBoost(cortexPathLocal, b.project, cwd, gitCtx?.changedFiles);
    const globDelta = globBoostB - globBoostA;
    if (Math.abs(globDelta) > 0.01) return globDelta;

    const keyA = entryScoreKey(a.project, a.filename, a.content);
    const keyB = entryScoreKey(b.project, b.filename, b.content);
    const qualityDelta = getQualityMultiplier(cortexPathLocal, keyB) - getQualityMultiplier(cortexPathLocal, keyA);
    if (qualityDelta !== 0) return qualityDelta;

    const penaltyDelta = lowValuePenalty(a.content, a.type) - lowValuePenalty(b.content, b.type);
    if (penaltyDelta !== 0) return penaltyDelta;

    const entityA = entityBoostPaths.has(a.path) ? 1.3 : 1;
    const entityB = entityBoostPaths.has(b.path) ? 1.3 : 1;
    if (entityB !== entityA) return entityB - entityA;

    return 0;
  });

  ranked = ranked.slice(0, 8);

  if (intent !== "build") {
    ranked = ranked.filter((r) => r.type !== "backlog");
  }

  if (gitCtx && gitCtx.changedFiles.size > 0) {
    const FILE_MATCH_BOOST = 1.5;
    ranked.sort((a, b) => {
      const aMatch = fileRelevanceBoost(a.path, gitCtx.changedFiles) > 0 || branchMatchBoost(a.content, gitCtx.branch) > 0;
      const bMatch = fileRelevanceBoost(b.path, gitCtx.changedFiles) > 0 || branchMatchBoost(b.content, gitCtx.branch) > 0;
      const aScore = aMatch ? FILE_MATCH_BOOST : 1;
      const bScore = bMatch ? FILE_MATCH_BOOST : 1;
      return bScore - aScore;
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
    let est = approximateTokens(snippet) + 14;
    if (selected.length > 0 && usedTokens + est > tokenBudget) continue;
    if (selected.length === 0 && usedTokens + est > tokenBudget) {
      snippet = compactSnippet(snippet, 3, Math.floor(charBudget * 0.55));
      est = approximateTokens(snippet) + 14;
    }
    const key = entryScoreKey(doc.project, doc.filename, snippet);
    selected.push({ doc, snippet, key });
    usedTokens += est;
    if (selected.length >= 3) break;
  }
  return { selected, usedTokens };
}

// Re-export approximateTokens for use in output module
export { approximateTokens };
