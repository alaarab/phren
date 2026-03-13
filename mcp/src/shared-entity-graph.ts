import { decodeStringRow } from "./shared-index.js";
import type { SqlJsDatabase } from "./shared-index.js";
import * as fs from "fs";
import { runtimeFile } from "./shared.js";
import { UNIVERSAL_TECH_TERMS_RE } from "./cortex-core.js";

export function escapeRegex(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Escape SQL LIKE wildcard characters so user input is treated literally. */
export function escapeLike(s: string): string { return s.replace(/[%_\\]/g, '\\$&'); }

/**
 * Log entity resolution misses to .runtime/entity-misses.jsonl.
 *
 * Judgment criteria — what's worth capturing vs noise:
 * - Worth capturing: repeated lookups for the same entity name (indicates a gap
 *   in the entity graph that the user keeps hitting), entity names that look like
 *   real library/tool names (not random query fragments).
 * - Noise: single one-off lookups for short generic terms, lookups that fail
 *   because the query was malformed. We filter these by requiring name.length > 2.
 *
 * Gated by CORTEX_DEBUG to avoid disk writes for regular users. The miss log is
 * append-only JSONL so downstream tooling can detect repeated patterns (e.g.
 * "entity X was looked up 5 times but never found" → suggest adding it).
 */
export function logEntityMiss(cortexPath: string, name: string, context: string, project?: string): void {
  if (!process.env.CORTEX_DEBUG) return;
  if (!name || name.length <= 2) return;
  try {
    const entry = JSON.stringify({
      entity: name,
      context,
      ts: Date.now(),
      project: project ?? null,
    });
    const missFile = runtimeFile(cortexPath, "entity-misses.jsonl");
    fs.appendFileSync(missFile, entry + "\n");
  } catch {
    // Best-effort logging; don't let miss tracking break the caller.
  }
}

// Use the shared universal starter set. Framework/tool specifics are learned
// dynamically per project via extractDynamicEntities() in content-dedup.ts.
const PROSE_ENTITY_PATTERN = UNIVERSAL_TECH_TERMS_RE;

const ENTITY_PATTERNS = [
  // import/require patterns: import X from 'pkg' or require('pkg')
  /(?:import\s+.*?\s+from\s+['"])(@?[\w\-/]+)(?:['"])/g,
  /(?:require\s*\(\s*['"])(@?[\w\-/]+)(?:['"]\s*\))/g,
  // @scope/package patterns in text
  /@[\w-]+\/[\w-]+/g,
  // Known library/tool names mentioned in prose (case-insensitive word boundaries)
  PROSE_ENTITY_PATTERN,
  // Backtick-quoted identifiers: `word` or `word-with-dashes`
  /`([\w][\w\-\.\/]{1,48}[\w])`/g,
  // Double-quoted short identifiers (tool/package names, not full sentences)
  /"([\w][\w\-]{1,30}[\w])"/g,
];

function isAllowedEntityName(name: string): boolean {
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
    if (COMMON_SINGLE_WORD_ENTITIES.has(normalized)) return false;
  }

  return true;
}

/**
 * Lightweight synchronous entity extraction from text — regex only, no DB writes.
 * Used by add_finding to surface detected entities in the MCP response without
 * requiring a DB reference in the write path. Full DB linking happens on the next
 * index rebuild, which is triggered automatically after every add_finding call via
 * updateFileInIndex → extractAndLinkEntities.
 */
export function extractEntityNames(content: string): string[] {
  const found = new Set<string>();
  for (const pattern of ENTITY_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const name = match[1] || match[0];
      if (!isAllowedEntityName(name)) continue;
      found.add(name.toLowerCase());
    }
  }

  // Extract explicit entity annotations: <!-- entity: Foo,Bar -->
  const annotationRe = /<!--\s*entity:\s*([^-]+)-->/gi;
  let m: RegExpExecArray | null;
  while ((m = annotationRe.exec(content)) !== null) {
    for (const part of m[1].split(",")) {
      const name = part.trim();
      if (isAllowedEntityName(name)) {
        found.add(name.toLowerCase());
      }
    }
  }

  return [...found];
}

function getOrCreateEntity(db: SqlJsDatabase, name: string, type: string): number {
  try {
    db.run("INSERT OR IGNORE INTO entities (name, type, first_seen_at) VALUES (?, ?, ?)", [name, type, new Date().toISOString().slice(0, 10)]);
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] entityInsert: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  const result = db.exec("SELECT id FROM entities WHERE name = ? AND type = ?", [name, type]);
  if (result?.length && result[0]?.values?.length) {
    return Number(result[0].values[0][0]);
  }
  return -1;
}

/**
 * Ensure the global_entities cross-project index table exists.
 * Called during buildIndex to enable cross-project entity queries.
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
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] ensureGlobalEntitiesTable: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

/**
 * Parse user-defined entity names from CLAUDE.md frontmatter.
 * Looks for: <!-- cortex:entities: Redis,MyService,InternalAPI -->
 *
 * Results are cached per project+mtime to avoid repeated sync readFileSync calls
 * during a single index build that processes many docs for the same project.
 */
const _userEntityCache = new Map<string, { mtime: number; entities: string[] }>();
const _buildUserEntityCache = new Map<string, string[]>();
let _activeBuildCacheKeyPrefix: string | null = null;

function readUserDefinedEntitiesFromDisk(claudeMdPath: string): { mtime: number; entities: string[] } | null {
  if (!fs.existsSync(claudeMdPath)) return null;
  const stat = fs.statSync(claudeMdPath);
  const content = fs.readFileSync(claudeMdPath, "utf-8");
  const match = content.match(/<!--\s*cortex:entities:\s*(.+?)\s*-->/);
  const entities = match
    ? match[1].split(",").map(s => s.trim()).filter(s => s.length > 0)
    : [];
  return { mtime: stat.mtimeMs, entities };
}

/**
 * Prime CLAUDE.md entities per project for a single build pass.
 * During an active build, extractAndLinkEntities resolves user entities from this
 * in-memory map and avoids per-file sync stat/read calls.
 */
export function beginUserEntityBuildCache(cortexPath: string, projects: Iterable<string>): void {
  _activeBuildCacheKeyPrefix = `${cortexPath}/`;
  for (const project of projects) {
    const cacheKey = `${cortexPath}/${project}`;
    const claudeMdPath = `${cortexPath}/${project}/CLAUDE.md`;
    try {
      const loaded = readUserDefinedEntitiesFromDisk(claudeMdPath);
      if (!loaded) {
        _buildUserEntityCache.set(cacheKey, []);
        continue;
      }
      _userEntityCache.set(cacheKey, loaded);
      _buildUserEntityCache.set(cacheKey, loaded.entities);
    } catch (err: unknown) {
      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] beginUserEntityBuildCache: ${err instanceof Error ? err.message : String(err)}\n`);
      _buildUserEntityCache.set(cacheKey, []);
    }
  }
}

/** End a build-scoped cache created by beginUserEntityBuildCache(). */
export function endUserEntityBuildCache(cortexPath: string): void {
  const prefix = `${cortexPath}/`;
  for (const key of [..._buildUserEntityCache.keys()]) {
    if (key.startsWith(prefix)) _buildUserEntityCache.delete(key);
  }
  if (_activeBuildCacheKeyPrefix === prefix) _activeBuildCacheKeyPrefix = null;
}

function parseUserDefinedEntities(cortexPath: string, project: string): string[] {
  const claudeMdPath = `${cortexPath}/${project}/CLAUDE.md`;
  const cacheKey = `${cortexPath}/${project}`;
  try {
    // Active build path: no sync I/O in per-file extraction.
    if (_activeBuildCacheKeyPrefix === `${cortexPath}/`) {
      if (_buildUserEntityCache.has(cacheKey)) return _buildUserEntityCache.get(cacheKey) ?? [];
      _buildUserEntityCache.set(cacheKey, []);
      return [];
    }

    const cached = _userEntityCache.get(cacheKey);
    if (cached) {
      try {
        if (fs.existsSync(claudeMdPath) && fs.statSync(claudeMdPath).mtimeMs === cached.mtime) {
          return cached.entities;
        }
      } catch (err: unknown) {
        if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] parseUserDefinedEntities statCheck: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }

    const loaded = readUserDefinedEntitiesFromDisk(claudeMdPath);
    if (!loaded) return [];
    _userEntityCache.set(cacheKey, loaded);
    return loaded.entities;
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] parseUserDefinedEntities: ${err instanceof Error ? err.message : String(err)}\n`);
    return [];
  }
}

/** Clear the user entity cache (call between index builds). */
export function clearUserEntityCache(): void {
  _userEntityCache.clear();
  _buildUserEntityCache.clear();
  _activeBuildCacheKeyPrefix = null;
}

// Words that commonly start sentences or appear in titles — not entity names
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

const COMMON_SINGLE_WORD_ENTITIES = new Set([
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

// Patterns that look like version strings, file paths, or dates — not entities
const FALSE_POSITIVE_PATTERNS = [
  /^v?\d+\.\d+/,              // version strings: 1.2.3, v2.0
  /^[A-Z]:\\/,                // Windows paths: C:\
  /^\//,                       // Unix paths: /usr/bin
  /^\d{4}-\d{2}/,             // ISO dates: 2026-03
  /^[A-Z]{2,6}$/,             // All-caps abbreviations shorter than 7 chars (OK, API, etc.)
  /^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i, // Month names
];

/**
 * Extract capitalized noun phrases (2+ words starting with uppercase) as candidate entities.
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

export function extractAndLinkEntities(db: SqlJsDatabase, content: string, sourceDoc: string, cortexPath?: string): void {
  const entityNames = extractEntityNames(content);

  // Q28: Extract capitalized noun phrases as candidate entities
  const capitalizedPhrases = extractCapitalizedPhrases(content);
  for (const phrase of capitalizedPhrases) {
    entityNames.push(phrase);
  }

  // Q28: Add user-defined entities from CLAUDE.md frontmatter
  if (cortexPath) {
    const projectMatch = sourceDoc.match(/^([^/]+)\//);
    if (projectMatch) {
      const project = projectMatch[1];
      const userEntities = parseUserDefinedEntities(cortexPath, project);
      for (const ue of userEntities) {
        const lower = ue.toLowerCase();
        // Check if user-defined entity appears in content (use escaped regex for safe matching)
        const safePattern = new RegExp(`\\b${escapeRegex(lower)}\\b`, "i");
        if (safePattern.test(content)) {
          entityNames.push(lower);
        }
      }
    }
  }

  // Deduplicate
  const uniqueNames = [...new Set(entityNames)];
  if (uniqueNames.length === 0) return;

  const docEntityId = getOrCreateEntity(db, sourceDoc, "document");
  if (docEntityId === -1) return;

  // Q20: Ensure global_entities table exists
  ensureGlobalEntitiesTable(db);

  // Extract project from sourceDoc for global_entities
  const projectMatch = sourceDoc.match(/^([^/]+)\//);
  const project = projectMatch ? projectMatch[1] : null;

  for (const name of uniqueNames) {
    const entityType = name.includes(" ") ? "concept" : "library";
    const entityId = getOrCreateEntity(db, name, entityType);
    if (entityId === -1) continue;
    try {
      db.run(
        "INSERT OR IGNORE INTO entity_links (source_id, target_id, rel_type, source_doc) VALUES (?, ?, ?, ?)",
        [docEntityId, entityId, "mentions", sourceDoc]
      );
    } catch (err: unknown) {
      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] entityLinksInsert: ${err instanceof Error ? err.message : String(err)}\n`);
    }

    // Q20: Write to global_entities for cross-project queries
    if (project) {
      try {
        db.run(
          "INSERT OR IGNORE INTO global_entities (entity, project, doc_key) VALUES (?, ?, ?)",
          [name, project, sourceDoc]
        );
      } catch (err: unknown) {
        if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] globalEntitiesInsert: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  }
}

/**
 * Query related entities for a given name.
 */
export function queryEntityLinks(db: SqlJsDatabase, name: string): { related: string[] } {
  const related: string[] = [];
  try {
    // Find the entity
    const entityResult = db.exec("SELECT id FROM entities WHERE name = ?", [name.toLowerCase()]);
    if (!entityResult?.length || !entityResult[0]?.values?.length) return { related };
    const entityId = Number(entityResult[0].values[0][0]);

    // Find related entities through links (both directions)
    const links = db.exec(
      `SELECT DISTINCT e.name FROM entity_links el JOIN entities e ON (el.target_id = e.id OR el.source_id = e.id)
       WHERE (el.source_id = ? OR el.target_id = ?) AND e.id != ?`,
      [entityId, entityId, entityId]
    );
    if (links?.length && links[0]?.values?.length) {
      for (const row of links[0].values) {
        related.push(decodeStringRow(row, 1, "queryEntityLinks")[0]);
      }
    }
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] queryEntityLinks: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  return { related };
}

/**
 * Q20: Query cross-project entity relationships.
 * Returns projects and docs that share entities with the given query.
 */
export function queryCrossProjectEntities(
  db: SqlJsDatabase,
  entityName: string,
  excludeProject?: string
): Array<{ entity: string; project: string; docKey: string }> {
  const results: Array<{ entity: string; project: string; docKey: string }> = [];
  try {
    ensureGlobalEntitiesTable(db);
    const pattern = `%${escapeLike(entityName.toLowerCase())}%`;
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
        const [entity, project, docKey] = decodeStringRow(row, 3, "queryCrossProjectEntities");
        results.push({
          entity,
          project,
          docKey,
        });
      }
    }
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] queryCrossProjectEntities: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  return results;
}

export function getEntityBoostDocs(db: SqlJsDatabase, query: string): Set<string> {
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
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] getEntityBoostDocs: ${err instanceof Error ? err.message : String(err)}\n`);
    return new Set();
  }
}
