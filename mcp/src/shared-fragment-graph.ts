import { decodeStringRow } from "./shared-index.js";
import type { SqlJsDatabase } from "./shared-index.js";
import * as fs from "fs";
import { runtimeFile } from "./shared.js";
import { UNIVERSAL_TECH_TERMS_RE } from "./phren-core.js";
import { errorMessage } from "./utils.js";
import { logDebug } from "./logger.js";

export function escapeRegex(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Escape SQL LIKE wildcard characters so user input is treated literally. */
export function escapeLike(s: string): string { return s.replace(/[%_\\]/g, '\\$&'); }

/**
 * Log fragment resolution misses to .runtime/fragment-misses.jsonl.
 *
 * Judgment criteria — what's worth capturing vs noise:
 * - Worth capturing: repeated lookups for the same fragment name (indicates a gap
 *   in the fragment graph that the user keeps hitting), fragment names that look like
 *   real library/tool names (not random query fragments).
 * - Noise: single one-off lookups for short generic terms, lookups that fail
 *   because the query was malformed. We filter these by requiring name.length > 2.
 *
 * Gated by PHREN_DEBUG (or PHREN_DEBUG for compat) to avoid disk writes for
 * regular users. The miss log is append-only JSONL so downstream tooling can
 * detect repeated patterns (e.g. "fragment X was looked up 5 times but never
 * found" -> suggest adding it).
 */
export function logFragmentMiss(phrenPath: string, name: string, context: string, project?: string): void {
  if (!process.env.PHREN_DEBUG) return;
  if (!name || name.length <= 2) return;
  try {
    const entry = JSON.stringify({
      fragment: name,
      context,
      ts: Date.now(),
      project: project ?? null,
    });
    const missFile = runtimeFile(phrenPath, "fragment-misses.jsonl");
    fs.appendFileSync(missFile, entry + "\n");
  } catch {
    // Best-effort logging; don't let miss tracking break the caller.
  }
}

/** @deprecated Use logFragmentMiss instead */
export const logEntityMiss = logFragmentMiss;

// Use the shared universal starter set. Framework/tool specifics are learned
// dynamically per project via extractDynamicFragments() in content-dedup.ts.
const PROSE_FRAGMENT_PATTERN = UNIVERSAL_TECH_TERMS_RE;

const FRAGMENT_PATTERNS = [
  // import/require patterns: import X from 'pkg' or require('pkg')
  /(?:import\s+.*?\s+from\s+['"])(@?[\w\-/]+)(?:['"])/g,
  /(?:require\s*\(\s*['"])(@?[\w\-/]+)(?:['"]\s*\))/g,
  // @scope/package patterns in text
  /@[\w-]+\/[\w-]+/g,
  // Known library/tool names mentioned in prose (case-insensitive word boundaries)
  PROSE_FRAGMENT_PATTERN,
  // Backtick-quoted identifiers: `word` or `word-with-dashes`
  /`([\w][\w\-\.\/]{1,48}[\w])`/g,
  // Double-quoted short identifiers (tool/package names, not full sentences)
  /"([\w][\w\-]{1,30}[\w])"/g,
];

function isAllowedFragmentName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length <= 1 || trimmed.length >= 100) return false;
  // Skip version strings (e.g. "1.2.3", "v2.0.0-beta")
  if (/^v?\d+\.\d+/.test(trimmed)) return false;
  // Skip file paths and file-like names (e.g. "src/utils.ts", "./config.json")
  if (
    /^\.?\//.test(trimmed) ||
    /\.(ts|js|json|md|yaml|yml|py|go|rs|java|tsx|jsx|css|html|txt|sh|toml|cfg|ini|env|lock)$/i.test(trimmed)
  ) {
    return false;
  }

  if (!/\s/.test(trimmed)) {
    const normalized = trimmed.replace(/^[@#]/, "").toLowerCase();
    if (COMMON_SINGLE_WORD_FRAGMENTS.has(normalized)) return false;
  }

  return true;
}

/**
 * Lightweight synchronous fragment extraction from text — regex only, no DB writes.
 * Used by add_finding to surface detected fragments in the MCP response without
 * requiring a DB reference in the write path. Full DB linking happens on the next
 * index rebuild, which is triggered automatically after every add_finding call via
 * updateFileInIndex -> extractAndLinkFragments.
 */
export function extractFragmentNames(content: string): string[] {
  const found = new Set<string>();
  for (const pattern of FRAGMENT_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const name = match[1] || match[0];
      if (!isAllowedFragmentName(name)) continue;
      found.add(name.toLowerCase());
    }
  }

  // Extract explicit fragment annotations: <!-- fragment: Foo,Bar --> (also supports legacy <!-- entity: ... -->)
  const annotationRe = /<!--\s*(?:fragment|entity):\s*([^-]+)-->/gi;
  let m: RegExpExecArray | null;
  while ((m = annotationRe.exec(content)) !== null) {
    for (const part of m[1].split(",")) {
      const name = part.trim();
      if (isAllowedFragmentName(name)) {
        found.add(name.toLowerCase());
      }
    }
  }

  return [...found];
}

/** @deprecated Use extractFragmentNames instead */
export const extractEntityNames = extractFragmentNames;

function getOrCreateFragment(db: SqlJsDatabase, name: string, type: string): number {
  try {
    db.run("INSERT OR IGNORE INTO entities (name, type, first_seen_at) VALUES (?, ?, ?)", [name, type, new Date().toISOString().slice(0, 10)]);
  } catch (err: unknown) {
    logDebug("fragmentInsert", errorMessage(err));
  }
  const result = db.exec("SELECT id FROM entities WHERE name = ? AND type = ?", [name, type]);
  if (result?.length && result[0]?.values?.length) {
    return Number(result[0].values[0][0]);
  }
  return -1;
}

/**
 * Ensure the global_entities cross-project index table exists.
 * Called during buildIndex to enable cross-project fragment queries.
 */
export function ensureGlobalEntitiesTable(db: SqlJsDatabase): void {
  try {
    db.run(
      `CREATE TABLE IF NOT EXISTS global_entities (
        entity TEXT NOT NULL,
        project TEXT NOT NULL,
        doc_key TEXT NOT NULL,
        PRIMARY KEY (entity, project, doc_key)
      )`
    );
  } catch (err: unknown) {
    logDebug("ensureGlobalEntitiesTable", errorMessage(err));
  }
}

/**
 * Parse user-defined fragment names from CLAUDE.md frontmatter.
 * Looks for: <!-- phren:fragments: Redis,MyService,InternalAPI -->
 * Also supports legacy: <!-- phren:entities: ... -->
 *
 * Results are cached per project+mtime to avoid repeated sync readFileSync calls
 * during a single index build that processes many docs for the same project.
 */
const _userFragmentCache = new Map<string, { mtime: number; fragments: string[] }>();
const _buildUserFragmentCache = new Map<string, string[]>();
let _activeBuildCacheKeyPrefix: string | null = null;

function readUserDefinedFragmentsFromDisk(claudeMdPath: string): { mtime: number; fragments: string[] } | null {
  if (!fs.existsSync(claudeMdPath)) return null;
  const stat = fs.statSync(claudeMdPath);
  const content = fs.readFileSync(claudeMdPath, "utf-8");
  // Support both new phren:fragments and legacy phren:entities annotations
  const match = content.match(/<!--\s*(?:phren:fragments|phren:entities):\s*(.+?)\s*-->/);
  const fragments = match
    ? match[1].split(",").map(s => s.trim()).filter(s => s.length > 0)
    : [];
  return { mtime: stat.mtimeMs, fragments };
}

/**
 * Prime CLAUDE.md fragments per project for a single build pass.
 * During an active build, extractAndLinkFragments resolves user fragments from this
 * in-memory map and avoids per-file sync stat/read calls.
 */
export function beginUserFragmentBuildCache(phrenPath: string, projects: Iterable<string>): void {
  _activeBuildCacheKeyPrefix = `${phrenPath}/`;
  for (const project of projects) {
    const cacheKey = `${phrenPath}/${project}`;
    const claudeMdPath = `${phrenPath}/${project}/CLAUDE.md`;
    try {
      const loaded = readUserDefinedFragmentsFromDisk(claudeMdPath);
      if (!loaded) {
        _buildUserFragmentCache.set(cacheKey, []);
        continue;
      }
      _userFragmentCache.set(cacheKey, loaded);
      _buildUserFragmentCache.set(cacheKey, loaded.fragments);
    } catch (err: unknown) {
      logDebug("beginUserFragmentBuildCache", errorMessage(err));
      _buildUserFragmentCache.set(cacheKey, []);
    }
  }
}

/** @deprecated Use beginUserFragmentBuildCache instead */
export const beginUserEntityBuildCache = beginUserFragmentBuildCache;

/** End a build-scoped cache created by beginUserFragmentBuildCache(). */
export function endUserFragmentBuildCache(phrenPath: string): void {
  const prefix = `${phrenPath}/`;
  for (const key of [..._buildUserFragmentCache.keys()]) {
    if (key.startsWith(prefix)) _buildUserFragmentCache.delete(key);
  }
  if (_activeBuildCacheKeyPrefix === prefix) _activeBuildCacheKeyPrefix = null;
}

/** @deprecated Use endUserFragmentBuildCache instead */
export const endUserEntityBuildCache = endUserFragmentBuildCache;

function parseUserDefinedFragments(phrenPath: string, project: string): string[] {
  const claudeMdPath = `${phrenPath}/${project}/CLAUDE.md`;
  const cacheKey = `${phrenPath}/${project}`;
  try {
    // Active build path: no sync I/O in per-file extraction.
    if (_activeBuildCacheKeyPrefix === `${phrenPath}/`) {
      if (_buildUserFragmentCache.has(cacheKey)) return _buildUserFragmentCache.get(cacheKey) ?? [];
      _buildUserFragmentCache.set(cacheKey, []);
      return [];
    }

    const cached = _userFragmentCache.get(cacheKey);
    if (cached) {
      try {
        if (fs.existsSync(claudeMdPath) && fs.statSync(claudeMdPath).mtimeMs === cached.mtime) {
          return cached.fragments;
        }
      } catch (err: unknown) {
        logDebug("parseUserDefinedFragments statCheck", errorMessage(err));
      }
    }

    const loaded = readUserDefinedFragmentsFromDisk(claudeMdPath);
    if (!loaded) return [];
    _userFragmentCache.set(cacheKey, loaded);
    return loaded.fragments;
  } catch (err: unknown) {
    logDebug("parseUserDefinedFragments", errorMessage(err));
    return [];
  }
}

/** Clear the user fragment cache (call between index builds). */
export function clearUserFragmentCache(): void {
  _userFragmentCache.clear();
  _buildUserFragmentCache.clear();
  _activeBuildCacheKeyPrefix = null;
}

/** @deprecated Use clearUserFragmentCache instead */
export const clearUserEntityCache = clearUserFragmentCache;

// Words that commonly start sentences or appear in titles — not fragment names
const SENTENCE_START_WORDS = new Set([
  "the", "this", "that", "these", "those", "when", "where", "which", "while",
  "what", "with", "will", "would", "should", "could", "have", "has", "had",
  "been", "being", "before", "after", "about", "above", "below", "between",
  "only", "also", "even", "just", "like", "make", "made", "many", "more",
  "most", "much", "must", "need", "never", "note", "once", "other", "over",
  "same", "some", "such", "sure", "take", "than", "them", "then", "they",
  "each", "every", "both", "either", "neither", "here", "there", "first",
  "second", "third", "next", "last", "new", "old", "good", "bad", "best",
  "however", "therefore", "because", "although", "since", "unless", "until",
  "instead", "rather", "already", "always", "never", "sometimes", "often",
]);

const COMMON_SINGLE_WORD_FRAGMENTS = new Set([
  ...SENTENCE_START_WORDS,
  "agent", "analysis", "app", "approach", "artifact", "branch", "build", "cache",
  "change", "changes", "check", "cli", "code", "command", "config", "context",
  "data", "debug", "detail", "doc", "docs", "document", "entity", "error",
  "example", "extract", "feature", "file", "files", "fix", "flow", "hook", "idea",
  "index", "info", "issue", "item", "key", "log", "memory", "message", "model",
  "note", "output", "path", "pattern", "policy", "process", "profile", "project",
  "query", "repo", "result", "rule", "search", "session", "setting", "state",
  "step", "summary", "system", "task", "tasks", "test", "tool", "tools", "type",
  "update", "user", "value", "version", "workflow", "write",
]);

// Patterns that look like version strings, file paths, or dates — not fragments
const FALSE_POSITIVE_PATTERNS = [
  /^v?\d+\.\d+/,              // version strings: 1.2.3, v2.0
  /^[A-Z]:\\/,                // Windows paths: C:\
  /^\//,                       // Unix paths: /usr/bin
  /^\d{4}-\d{2}/,             // ISO dates: 2026-03
  /^[A-Z]{2,6}$/,             // All-caps abbreviations shorter than 7 chars (OK, API, etc.)
  /^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i, // Month names
];

/**
 * Extract capitalized noun phrases (2+ words starting with uppercase) as candidate fragments.
 * e.g. "Auth Service", "Data Pipeline", "Internal API"
 *
 * Filters out common false positives: sentence-start capitalization, version strings,
 * file paths, and single-word abbreviations.
 */
function extractCapitalizedPhrases(content: string): string[] {
  const found = new Set<string>();
  const pattern = /\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)+)\b/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const phrase = match[1];
    if (phrase.length < 4 || phrase.length >= 60) continue;

    // Check if first word is a common sentence-start word
    const firstWord = phrase.split(/\s+/)[0].toLowerCase();
    if (SENTENCE_START_WORDS.has(firstWord)) continue;

    // Check if it looks like a false positive pattern
    if (FALSE_POSITIVE_PATTERNS.some(p => p.test(phrase))) continue;

    found.add(phrase.toLowerCase());
  }
  return [...found];
}

export function extractAndLinkFragments(db: SqlJsDatabase, content: string, sourceDoc: string, phrenPath?: string): void {
  const fragmentNames = extractFragmentNames(content);

  // Extract capitalized noun phrases as candidate fragments
  const capitalizedPhrases = extractCapitalizedPhrases(content);
  for (const phrase of capitalizedPhrases) {
    fragmentNames.push(phrase);
  }

  // Add user-defined fragments from CLAUDE.md frontmatter
  if (phrenPath) {
    const projectMatch = sourceDoc.match(/^([^/]+)\//);
    if (projectMatch) {
      const project = projectMatch[1];
      const userFragments = parseUserDefinedFragments(phrenPath, project);
      for (const uf of userFragments) {
        const lower = uf.toLowerCase();
        // Check if user-defined fragment appears in content (use escaped regex for safe matching)
        const safePattern = new RegExp(`\\b${escapeRegex(lower)}\\b`, "i");
        if (safePattern.test(content)) {
          fragmentNames.push(lower);
        }
      }
    }
  }

  // Deduplicate
  const uniqueNames = [...new Set(fragmentNames)];
  if (uniqueNames.length === 0) return;

  const docFragmentId = getOrCreateFragment(db, sourceDoc, "document");
  if (docFragmentId === -1) return;

  // Ensure global_entities table exists
  ensureGlobalEntitiesTable(db);

  // Extract project from sourceDoc for global_entities
  const projectMatch = sourceDoc.match(/^([^/]+)\//);
  const project = projectMatch ? projectMatch[1] : null;

  for (const name of uniqueNames) {
    const fragmentType = name.includes(" ") ? "concept" : "library";
    const fragmentId = getOrCreateFragment(db, name, fragmentType);
    if (fragmentId === -1) continue;
    try {
      db.run(
        "INSERT OR IGNORE INTO entity_links (source_id, target_id, rel_type, source_doc) VALUES (?, ?, ?, ?)",
        [docFragmentId, fragmentId, "mentions", sourceDoc]
      );
    } catch (err: unknown) {
      logDebug("fragmentLinksInsert", errorMessage(err));
    }

    // Write to global_entities for cross-project queries
    if (project) {
      try {
        db.run(
          "INSERT OR IGNORE INTO global_entities (entity, project, doc_key) VALUES (?, ?, ?)",
          [name, project, sourceDoc]
        );
      } catch (err: unknown) {
        logDebug("globalFragmentsInsert", errorMessage(err));
      }
    }
  }
}

/** @deprecated Use extractAndLinkFragments instead */
export const extractAndLinkEntities = extractAndLinkFragments;

/**
 * Query related fragments for a given name.
 */
export function queryFragmentLinks(db: SqlJsDatabase, name: string): { related: string[] } {
  const related: string[] = [];
  try {
    // Find the fragment
    const fragmentResult = db.exec("SELECT id FROM entities WHERE name = ?", [name.toLowerCase()]);
    if (!fragmentResult?.length || !fragmentResult[0]?.values?.length) return { related };
    const fragmentId = Number(fragmentResult[0].values[0][0]);

    // Find related fragments through links (both directions)
    const links = db.exec(
      `SELECT DISTINCT e.name FROM entity_links el JOIN entities e ON (el.target_id = e.id OR el.source_id = e.id)
       WHERE (el.source_id = ? OR el.target_id = ?) AND e.id != ?`,
      [fragmentId, fragmentId, fragmentId]
    );
    if (links?.length && links[0]?.values?.length) {
      for (const row of links[0].values) {
        related.push(decodeStringRow(row, 1, "queryFragmentLinks")[0]);
      }
    }
  } catch (err: unknown) {
    logDebug("queryFragmentLinks", errorMessage(err));
  }
  return { related };
}

/** @deprecated Use queryFragmentLinks instead */
export const queryEntityLinks = queryFragmentLinks;

/**
 * Query cross-project fragment relationships.
 * Returns projects and docs that share fragments with the given query.
 */
export function queryCrossProjectFragments(
  db: SqlJsDatabase,
  fragmentName: string,
  excludeProject?: string
): Array<{ fragment: string; project: string; docKey: string }> {
  const results: Array<{ fragment: string; project: string; docKey: string }> = [];
  try {
    ensureGlobalEntitiesTable(db);
    const pattern = `%${escapeLike(fragmentName.toLowerCase())}%`;
    let sql = "SELECT entity, project, doc_key FROM global_entities WHERE entity LIKE ? ESCAPE '\\'";
    const params: (string | number)[] = [pattern];
    if (excludeProject) {
      sql += " AND project != ?";
      params.push(excludeProject);
    }
    sql += " ORDER BY entity LIMIT 50";
    const rows = db.exec(sql, params);
    if (rows?.length && rows[0]?.values?.length) {
      for (const row of rows[0].values) {
        const [fragment, project, docKey] = decodeStringRow(row, 3, "queryCrossProjectFragments");
        results.push({
          fragment,
          project,
          docKey,
        });
      }
    }
  } catch (err: unknown) {
    logDebug("queryCrossProjectFragments", errorMessage(err));
  }
  return results;
}

export function getFragmentBoostDocs(db: SqlJsDatabase, query: string): Set<string> {
  const normalizedQuery = query.toLowerCase();
  try {
    const rows = db.exec(
      `SELECT DISTINCT el.source_doc
       FROM entity_links el
       JOIN entities e ON el.target_id = e.id
       WHERE length(e.name) > 2
         AND ? LIKE '%' || lower(e.name) || '%'`,
      [normalizedQuery]
    )[0]?.values ?? [];

    const boostDocs = new Set<string>();
    for (const [doc] of rows) {
      if (typeof doc === "string") boostDocs.add(doc);
    }
    return boostDocs;
  } catch (err: unknown) {
    logDebug("getFragmentBoostDocs", errorMessage(err));
    return new Set();
  }
}

/** @deprecated Use getFragmentBoostDocs instead */
export const getEntityBoostDocs = getFragmentBoostDocs;
