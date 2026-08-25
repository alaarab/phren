import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { globSync } from "glob";
import {
  debugLog,
  appendIndexEvent,
  getProjectDirs,
  collectNativeMemoryFiles,
  runtimeFile,
  homeDir,
  readRootManifest,
} from "../shared.js";
/**
 * Cached store project dirs to avoid repeated dynamic imports in sync code paths.
 * Populated by `refreshStoreProjectDirs()`, consumed by `getAllStoreProjectDirs()`.
 */
let _cachedStoreProjectDirs: string[] | null = null;
let _cachedStorePhrenPath: string | null = null;

/**
 * Gather project directories from the primary store AND all non-primary stores.
 * This enables the FTS5 index to include team store projects alongside personal ones.
 * Uses a sync cache populated by the async buildIndex path.
 */
function getAllStoreProjectDirs(phrenPath: string, profile?: string): string[] {
  const dirs = [...getProjectDirs(phrenPath, profile)];
  if (_cachedStoreProjectDirs && _cachedStorePhrenPath === phrenPath) {
    dirs.push(..._cachedStoreProjectDirs);
  }
  return dirs;
}

/**
 * Refresh the store project dirs cache. Called from async contexts (buildIndex, etc.)
 * before sync code paths that need getAllStoreProjectDirs.
 */
async function refreshStoreProjectDirs(phrenPath: string, profile?: string): Promise<void> {
  try {
    const { getNonPrimaryStores, getStoreProjectDirs } = await import("../store-registry.js");
    const otherStores = getNonPrimaryStores(phrenPath);
    let dirs: string[] = [];
    for (const store of otherStores) {
      if (!fs.existsSync(store.path)) continue;
      dirs.push(...getStoreProjectDirs(store));
    }
    // Filter by active profile's project list, matching getProjectDirs behavior
    if (profile) {
      const profilePath = path.join(phrenPath, "profiles", `${profile}.yaml`);
      if (fs.existsSync(profilePath)) {
        try {
          const yaml = await import("js-yaml");
          const data = yaml.load(fs.readFileSync(profilePath, "utf-8"), { schema: yaml.CORE_SCHEMA }) as Record<string, unknown> | undefined;
          const projects = data?.projects;
          if (Array.isArray(projects)) {
            const allowed = new Set(projects.map(String));
            dirs = dirs.filter(dir => allowed.has(path.basename(dir)));
          }
        } catch {
          // Profile parse error — include all dirs as fallback
        }
      }
    }
    _cachedStoreProjectDirs = dirs;
    _cachedStorePhrenPath = phrenPath;
  } catch {
    _cachedStoreProjectDirs = [];
    _cachedStorePhrenPath = phrenPath;
  }
}
import { getIndexPolicy, withFileLock } from "./governance.js";
import { stripTaskDoneSection } from "./content.js";
import { isInactiveFindingLine } from "../finding/lifecycle.js";
import { invalidateDfCache } from "./search-fallback.js";
import { errorMessage } from "../utils.js";
import { logger } from "../logger.js";
import { formatActorAttribution, parseSourceComment } from "../content/citation.js";
import {
  beginUserFragmentBuildCache,
  endUserFragmentBuildCache,
  extractAndLinkFragments,
  ensureGlobalEntitiesTable,
} from "./fragment-graph.js";
import { bootstrapSqlJs } from "./sqljs.js";
import { spawnDetachedChild } from "./process.js";
import { getProjectOwnershipMode, getProjectSourcePath, readProjectConfig } from "../project-config.js";
import { resolveRepoRootForPath } from "../git-worktree.js";
import {
  buildSourceDocKey,
  decodeStringRow,
  getDocSourceKey,
  queryDocRows,
  queryRows,
  type SqlJsDatabase,
} from "../index-query.js";
import {
  classifyTopicForText,
  readProjectTopics,
  type ProjectTopic,
} from "../project-topics.js";

export { porterStem } from "./stemmer.js";
export { cosineFallback } from "./search-fallback.js";
export {
  queryFragmentLinks,
  getFragmentBoostDocs,
  ensureGlobalEntitiesTable,
  queryCrossProjectFragments,
  logFragmentMiss,
  extractFragmentNames,
} from "./fragment-graph.js";
export {
  buildSourceDocKey,
  decodeFiniteNumber,
  decodeStringRow,
  extractSnippet,
  getDocSourceKey,
  normalizeMemoryId,
  queryDocBySourceKey,
  queryDocRows,
  queryRows,
  rowToDoc,
  rowToDocWithRowid,
} from "../index-query.js";
export type { SqlValue, DbRow, DocRow, SqlJsDatabase } from "../index-query.js";

interface SqlJsStatic {
  Database: new (data?: ArrayLike<number>) => SqlJsDatabase;
}

// ── Async embedding queue ───────────────────────────────────────────────────
const _embQueue = new Map<string, { phrenPath: string; content: string }>();
let _embTimer: ReturnType<typeof setTimeout> | null = null;
const MAX_EMB_QUEUE = 500;

function scheduleEmbedding(phrenPath: string, docPath: string, content: string): void {
  if (_embQueue.size >= MAX_EMB_QUEUE) {
    const oldest = _embQueue.keys().next().value;
    if (oldest !== undefined) _embQueue.delete(oldest);
  }
  _embQueue.set(docPath, { phrenPath, content });
  if (_embTimer) clearTimeout(_embTimer);
  _embTimer = setTimeout(() => { _embTimer = null; void _drainEmbQueue(); }, 500);
  // Unref so the timer doesn't keep short-lived CLI processes alive. Pending
  // embeddings are lost if such a process exits first (acceptable: they're
  // regenerated on demand); the MCP server calls flushEmbeddingQueue on shutdown.
  _embTimer.unref();
}

/** Drain pending embeddings immediately (used by the MCP server's graceful shutdown). */
export async function flushEmbeddingQueue(): Promise<void> {
  if (_embTimer) {
    clearTimeout(_embTimer);
    _embTimer = null;
  }
  await _drainEmbQueue();
}

async function _drainEmbQueue(): Promise<void> {
  if (_embQueue.size === 0) return;
  const { embedText, getEmbeddingModel } = await import("./ollama.js");
  const { getEmbeddingCache } = await import("./embedding-cache.js");
  const entries = [..._embQueue.entries()];
  _embQueue.clear();
  // Group by phrenPath so we flush each cache once after all its entries are set.
  const byPhrenPath = new Map<string, Array<{ docPath: string; content: string }>>();
  for (const [docPath, { phrenPath, content }] of entries) {
    const bucket = byPhrenPath.get(phrenPath) ?? [];
    bucket.push({ docPath, content });
    byPhrenPath.set(phrenPath, bucket);
  }
  for (const [phrenPath, docs] of byPhrenPath) {
    const cache = getEmbeddingCache(phrenPath);
    try { await cache.load(); } catch (err: unknown) {
      logger.debug("embeddingQueue cacheLoad", errorMessage(err));
    }
    const model = getEmbeddingModel();
    for (const { docPath, content } of docs) {
      try {
        if (cache.get(docPath, model)) continue;
        const vec = await embedText(content);
        if (vec) cache.set(docPath, getEmbeddingModel(), vec);
      } catch (err: unknown) {
        logger.debug("embeddingQueue embedText", errorMessage(err));
        _embQueue.clear();
      }
    }
    try { await cache.flush(); } catch (err: unknown) {
      logger.debug("embeddingQueue cacheFlush", errorMessage(err));
      _embQueue.clear();
    }
  }
}

const FILE_TYPE_MAP: Record<string, string> = {
  "claude.md": "claude",
  "summary.md": "summary",
  "findings.md": "findings",
  "reference.md": "reference",
  "tasks.md": "task",
  "changelog.md": "changelog",
  "truths.md": "canonical",
  // review.md is indexed on purpose so `search_knowledge` can answer "why is this in my
  // queue?", but `review-queue` is in NON_INJECTABLE_TYPES (shared/retrieval.ts): it is
  // unreviewed, quarantined content and must never be pushed into a prompt automatically.
  "review.md": "review-queue",
};

function pathHasSegment(relPath: string, segment: string): boolean {
  const parts = relPath.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.includes(segment);
}

export function classifyFile(filename: string, relPath: string): string {
  // Directory takes priority over filename-based classification
  if (pathHasSegment(relPath, "notes")) return "notes";
  if (pathHasSegment(relPath, "reference")) return "reference";
  if (pathHasSegment(relPath, "skills")) return "skill";
  const mapped = FILE_TYPE_MAP[filename.toLowerCase()];
  if (mapped) return mapped;
  return "other";
}

const IMPORT_RE = /^@import\s+(.+)$/gm;
const MAX_IMPORT_DEPTH = 5;
const IMPORT_ROOT_PREFIX = "shared/";

function isAllowedImportPath(importPath: string): boolean {
  const normalized = importPath.replace(/\\/g, "/");
  return normalized.startsWith(IMPORT_ROOT_PREFIX) && normalized.toLowerCase().endsWith(".md");
}

/**
 * Internal recursive helper for resolveImports. Tracks `seen` (cycle detection) and `depth` (runaway
 * recursion guard) — callers should never pass these; use the public `resolveImports` instead.
 */
function _resolveImportsRecursive(
  content: string,
  phrenPath: string,
  seen: Set<string>,
  depth: number,
): string {
  if (depth >= MAX_IMPORT_DEPTH) return content;

  return content.replace(IMPORT_RE, (_match, importPath: string) => {
    const trimmed = importPath.trim();
    if (!isAllowedImportPath(trimmed)) {
      return "<!-- @import blocked: only shared/*.md allowed -->";
    }
    const globalRoot = path.resolve(phrenPath, "global");
    const resolved = path.join(globalRoot, trimmed);
    // Use lexical resolution first for the prefix check
    const lexical = path.resolve(resolved);

    if (lexical !== globalRoot && !lexical.startsWith(globalRoot + path.sep)) {
      return `<!-- @import blocked: path traversal -->`;
    }

    // Dereference symlinks before the prefix check to prevent symlink traversal attacks
    // (e.g. global/evil -> /etc/passwd would pass the lexical check but fail here).
    let normalized: string;
    try {
      normalized = fs.realpathSync.native(resolved);
    } catch (err: unknown) {
      logger.debug("resolveImports realpath", errorMessage(err));
      return `<!-- @import not found: ${trimmed} -->`;
    }

    let normalizedGlobalRoot = globalRoot;
    try {
      normalizedGlobalRoot = fs.realpathSync.native(globalRoot);
    } catch {
      // Fall back to the lexical global path if the root cannot be resolved.
    }

    if (
      normalized !== normalizedGlobalRoot &&
      !normalized.startsWith(normalizedGlobalRoot + path.sep)
    ) {
      return `<!-- @import blocked: symlink traversal -->`;
    }

    if (seen.has(normalized)) {
      return `<!-- @import cycle: ${trimmed} -->`;
    }

    try {
      const childSeen = new Set(seen);
      childSeen.add(normalized);
      const imported = fs.readFileSync(normalized, "utf-8");
      return _resolveImportsRecursive(imported, phrenPath, childSeen, depth + 1);
    } catch (err: unknown) {
      logger.debug("resolveImports fileRead", errorMessage(err));
      return `<!-- @import error: ${trimmed} -->`;
    }
  });
}

/**
 * Resolve `@import shared/file.md` directives in document content.
 * The import path is resolved relative to the phren root (e.g. `shared/foo.md` -> `~/.phren/global/shared/foo.md`).
 * Circular imports are detected and skipped. Depth is capped to prevent runaway recursion.
 */
/** @internal Exported for tests. */
export function resolveImports(
  content: string,
  phrenPath: string,
): string {
  return _resolveImportsRecursive(content, phrenPath, new Set<string>(), 0);
}

// `touchSentinel()` used to write `.runtime/phren-sentinel` here. Nothing ever
// read that file — index freshness is decided by index-sentinel.json (directory
// mtimes + a re-hash of the recorded file list), and a content write already
// changes the file's own mtime, so the stat-hash invalidates on its own.

function computePhrenHash(phrenPath: string, profile?: string, preGlobbed?: string[]): string {
  const policy = getIndexPolicy(phrenPath);
  const hash = crypto.createHash("sha1");
  const topicConfigEntries = getAllStoreProjectDirs(phrenPath, profile)
    .map((dir) => path.join(dir, "topic-config.json"))
    .filter((configPath) => fs.existsSync(configPath));

  if (preGlobbed) {
    for (const f of preGlobbed) {
      try {
        const stat = fs.statSync(f);
        hash.update(`${f}:${stat.mtimeMs}:${stat.size}`);
      } catch (err: unknown) {
        logger.debug("computePhrenHash skip", errorMessage(err));
      }
    }
    for (const configPath of topicConfigEntries) {
      try {
        const stat = fs.statSync(configPath);
        hash.update(`topic-config:${configPath}:${stat.mtimeMs}:${stat.size}`);
      } catch (err: unknown) {
        logger.debug("computePhrenHash topicConfig", errorMessage(err));
      }
    }
  } else {
    const allProjectDirs = getAllStoreProjectDirs(phrenPath, profile);
    const files: string[] = [];
    for (const dir of allProjectDirs) {
      const projectName = path.basename(dir);
      const config = readProjectConfig(phrenPath, projectName);
      const ownership = getProjectOwnershipMode(phrenPath, projectName, config);
      try {
        const matched = new Set<string>();
        for (const pattern of policy.includeGlobs) {
          const dot = policy.includeHidden || pattern.startsWith(".") || pattern.includes("/.");
          const mdFiles = globSync(pattern, { cwd: dir, nodir: true, dot, ignore: policy.excludeGlobs });
          for (const f of mdFiles) matched.add(f);
        }
        for (const f of matched) {
          if (ownership === "repo-managed" && path.basename(f).toLowerCase() === "claude.md") continue;
          files.push(path.join(dir, f));
        }
        if (ownership === "repo-managed") {
          for (const entry of getRepoManagedInstructionEntries(phrenPath, projectName)) {
            files.push(entry.fullPath);
          }
        }
      } catch (err: unknown) {
        logger.debug("computePhrenHash globDir", errorMessage(err));
      }
    }
    files.sort();
    for (const f of files) {
      try {
        const stat = fs.statSync(f);
        hash.update(`${f}:${stat.mtimeMs}:${stat.size}`);
      } catch (err: unknown) {
        logger.debug("computePhrenHash skip", errorMessage(err));
      }
    }
    for (const configPath of topicConfigEntries) {
      try {
        const stat = fs.statSync(configPath);
        hash.update(`topic-config:${configPath}:${stat.mtimeMs}:${stat.size}`);
      } catch (err: unknown) {
        logger.debug("computePhrenHash topicConfig", errorMessage(err));
      }
    }
  }

  for (const mem of collectNativeMemoryFiles()) {
    try {
      const stat = fs.statSync(mem.fullPath);
      hash.update(`native:${mem.fullPath}:${stat.mtimeMs}:${stat.size}`);
    } catch (err: unknown) {
        logger.debug("computePhrenHash skip", errorMessage(err));
      }
  }
  // Include global/ files (pulled via @import) so changes invalidate the cache
  const globalDir = path.join(phrenPath, "global");
  if (fs.existsSync(globalDir)) {
    const globalFiles = globSync("**/*.md", { cwd: globalDir, nodir: true }).sort();
    for (const f of globalFiles) {
      try {
        const fp = path.join(globalDir, f);
        const stat = fs.statSync(fp);
        hash.update(`global:${f}:${stat.mtimeMs}:${stat.size}`);
      } catch (err: unknown) {
        logger.debug("computePhrenHash skip", errorMessage(err));
      }
    }
  }
  // Include manual fragment links so graph changes invalidate the cache
  const manualLinksPath = runtimeFile(phrenPath, "manual-links.json");
  if (fs.existsSync(manualLinksPath)) {
    try {
      const stat = fs.statSync(manualLinksPath);
      hash.update(`manual-links:${stat.mtimeMs}:${stat.size}`);
    } catch (err: unknown) {
        logger.debug("computePhrenHash skip", errorMessage(err));
      }
  }
  const indexPolicyPath = path.join(phrenPath, ".config", "index-policy.json");
  if (fs.existsSync(indexPolicyPath)) {
    try {
      const stat = fs.statSync(indexPolicyPath);
      hash.update(`index-policy-file:${stat.mtimeMs}:${stat.size}`);
    } catch (err: unknown) {
        logger.debug("computePhrenHash skip", errorMessage(err));
      }
  }
  if (profile) hash.update(`profile:${profile}`);
  hash.update(`index-policy:${JSON.stringify(policy)}`);
  return hash.digest("hex").slice(0, 16);
}

const INDEX_HASHES_FILENAME = "index-hashes.json";
const INDEX_SCHEMA_VERSION = 3; // bump when FTS schema changes to force full rebuild
// Deletion share above which an incremental update falls back to a full rebuild.
const MAX_INCREMENTAL_DELETE_RATIO = 0.5;

function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function hashFileContent(filePath: string): string {
  return hashContent(fs.readFileSync(filePath, "utf-8"));
}

/** Read a file's text, or null when it is gone/unreadable (races with deletion are normal). */
function readFileOrNull(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch (err: unknown) {
    logger.debug("readFileOrNull", errorMessage(err));
    return null;
  }
}

/**
 * Carries a file's bytes from the pass that hashes it to the pass that indexes
 * it, so one rebuild reads each file exactly once instead of 2x (hash + insert)
 * or 3x (hash + insert + fragment extraction on findings files).
 *
 * Bounded on purpose: the incremental path can, in the worst case, see every
 * file as changed, and holding a whole store's markdown in memory to save a
 * re-read is a bad trade. Past the budget the cache simply stops accepting
 * entries and the consumer falls back to reading from disk — slower, never
 * wrong.
 */
const BUILD_CONTENT_BUDGET_BYTES = 32 * 1024 * 1024;

class BuildContentCache {
  private entries = new Map<string, string>();
  private bytes = 0;

  put(filePath: string, content: string): void {
    if (this.bytes + content.length > BUILD_CONTENT_BUDGET_BYTES) return;
    if (this.entries.has(filePath)) return;
    this.entries.set(filePath, content);
    this.bytes += content.length;
  }

  /** Read-and-forget: content is consumed exactly once, then released. */
  take(filePath: string): string | undefined {
    const hit = this.entries.get(filePath);
    if (hit === undefined) return undefined;
    this.entries.delete(filePath);
    this.bytes -= hit.length;
    return hit;
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }
}

/** Errors expected from idempotent schema migrations run against older cached DBs. */
function isExpectedMigrationError(err: unknown): boolean {
  const msg = errorMessage(err).toLowerCase();
  return msg.includes("duplicate column name") || msg.includes("no such table");
}

/** Stat snapshot stored alongside each file hash so unchanged files can skip re-hashing. */
interface FileStatMeta {
  mtimeMs: number;
  size: number;
}

function loadHashMap(phrenPath: string): { version?: number; hashes: Record<string, string>; meta?: Record<string, FileStatMeta> } {
  const runtimeDir = path.join(phrenPath, ".runtime");
  const hashFile = path.join(runtimeDir, INDEX_HASHES_FILENAME);
  try {
    if (fs.existsSync(hashFile)) {
      return JSON.parse(fs.readFileSync(hashFile, "utf-8"));
    }
  } catch (err: unknown) {
    logger.debug("loadHashMap", errorMessage(err));
  }
  return { hashes: {} };
}

function saveHashMap(phrenPath: string, hashes: Record<string, string>, knownPaths?: Set<string>, meta?: Record<string, FileStatMeta>): void {
  const runtimeDir = path.join(phrenPath, ".runtime");
  try {
    fs.mkdirSync(runtimeDir, { recursive: true });
    const hashFile = path.join(runtimeDir, INDEX_HASHES_FILENAME);
    withFileLock(hashFile, () => {
      // Read-merge-write: load existing hashes, merge new values (new wins), then write.
      // Prune entries for files that no longer exist to prevent ghost paths from causing
      // repeated full rebuilds when deleted files are found in the hash map.
      let existing: Record<string, string> = {};
      let existingMeta: Record<string, FileStatMeta> = {};
      try {
        const data = JSON.parse(fs.readFileSync(hashFile, "utf-8"));
        if (data.hashes && typeof data.hashes === "object") existing = data.hashes;
        if (data.meta && typeof data.meta === "object") existingMeta = data.meta;
      } catch (err: unknown) {
        logger.debug("saveHashMap readExisting", errorMessage(err));
      }
      const merged = { ...existing, ...hashes };
      const mergedMeta = { ...existingMeta, ...meta };
      // Remove entries for paths that no longer exist. When knownPaths is provided
      // (build passes supply the full file list), use set membership instead of
      // hitting the filesystem — avoids N sync stat calls inside the lock.
      for (const filePath of Object.keys(merged)) {
        if (knownPaths ? !knownPaths.has(filePath) : !fs.existsSync(filePath)) {
          delete merged[filePath];
          delete mergedMeta[filePath];
        }
      }
      // Drop meta for paths without a hash entry (meta is only an optimization).
      for (const filePath of Object.keys(mergedMeta)) {
        if (!(filePath in merged)) delete mergedMeta[filePath];
      }
      fs.writeFileSync(
        hashFile,
        JSON.stringify({ version: INDEX_SCHEMA_VERSION, hashes: merged, meta: mergedMeta }, null, 2)
      );
    });
  } catch (err: unknown) {
    debugLog(`Failed to save index hash map: ${errorMessage(err)}`);
  }
}

interface FileEntry {
  fullPath: string;
  project: string;
  filename: string;
  type: string;
  relFile?: string;
}

const LEGACY_TOPIC_REFERENCE_RE = /^reference[\\/]+topics[\\/]+([a-z0-9_-]+)\.md$/i;

function normalizeDocSegment(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

function getEntrySourceDocKey(entry: FileEntry, phrenPath: string): string {
  if (entry.relFile) {
    return `${normalizeDocSegment(entry.project)}/${normalizeDocSegment(entry.relFile)}`;
  }
  return buildSourceDocKey(entry.project, entry.fullPath, phrenPath, entry.filename);
}

function getRepoManagedInstructionEntries(phrenPath: string, project: string): FileEntry[] {
  const repoDir = getProjectSourcePath(phrenPath, project);
  if (!repoDir) return [];
  const candidates = ["CLAUDE.md", path.join(".claude", "CLAUDE.md")];
  const entries: FileEntry[] = [];
  for (const relFile of candidates) {
    const fullPath = path.join(repoDir, relFile);
    if (!fs.existsSync(fullPath)) continue;
    const filename = path.basename(relFile);
    entries.push({
      fullPath,
      project,
      filename,
      type: classifyFile(filename, relFile),
      relFile,
    });
  }
  return entries;
}

function globAllFiles(phrenPath: string, profile?: string): { filePaths: string[]; entries: FileEntry[] } {
  const projectDirs = getAllStoreProjectDirs(phrenPath, profile);
  const indexPolicy = getIndexPolicy(phrenPath);
  const entries: FileEntry[] = [];
  const allAbsolutePaths: string[] = [];

  for (const dir of projectDirs) {
    const projectName = path.basename(dir);
    const storePath = path.dirname(dir);
    const config = readProjectConfig(storePath, projectName);
    const ownership = getProjectOwnershipMode(storePath, projectName, config);
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
    const relFiles = [...mdFilesSet].sort();
    for (const relFile of relFiles) {
      const filename = path.basename(relFile);
      if (ownership === "repo-managed" && filename.toLowerCase() === "claude.md") continue;
      const fullPath = path.join(dir, relFile);
      const type = classifyFile(filename, relFile);
      entries.push({ fullPath, project: projectName, filename, type, relFile });
      allAbsolutePaths.push(fullPath);
    }
    if (ownership === "repo-managed") {
      for (const entry of getRepoManagedInstructionEntries(phrenPath, projectName)) {
        entries.push(entry);
        allAbsolutePaths.push(entry.fullPath);
      }
    }
  }

  // Index global skills so search_knowledge can find them
  const globalSkillsDir = path.join(phrenPath, "global", "skills");
  if (fs.existsSync(globalSkillsDir)) {
    const skillFiles = globSync("**/*.md", { cwd: globalSkillsDir, nodir: true });
    for (const relFile of skillFiles) {
      const fullPath = path.join(globalSkillsDir, relFile);
      const filename = path.basename(relFile);
      entries.push({ fullPath, project: "global", filename, type: "skill", relFile: `skills/${relFile}` });
      allAbsolutePaths.push(fullPath);
    }
  }

  for (const mem of collectNativeMemoryFiles()) {
    entries.push({ fullPath: mem.fullPath, project: mem.project, filename: mem.file, type: "findings" });
    allAbsolutePaths.push(mem.fullPath);
  }

  allAbsolutePaths.sort();
  return { filePaths: allAbsolutePaths, entries };
}

export function listIndexedDocumentPaths(phrenPath: string, profile?: string): string[] {
  return globAllFiles(phrenPath, profile).filePaths;
}

export function normalizeIndexedContent(content: string, type: string, phrenPath: string, maxChars?: number): string {
  let normalized = content
    .replace(/<!-- phren:archive:start -->[\s\S]*?<!-- phren:archive:end -->/g, "")
    .replace(/<details>[\s\S]*?<\/details>/gi, "")
    .replace(/<!--\s*created:\s*.*?-->/g, "")
    .replace(/<!--\s*source:.*?-->/g, (match) => {
      const parsed = parseSourceComment(match);
      return formatActorAttribution(parsed?.actor, parsed?.machine);
    })
    .replace(/<!--\s*phren:cite\s+\{[\s\S]*?\}\s*-->/g, "");
  normalized = resolveImports(normalized, phrenPath);
  if (type === "task") {
    normalized = stripTaskDoneSection(normalized);
  }
  if (type === "findings") {
    const lines = normalized.split("\n");
    normalized = lines.filter(line => !isInactiveFindingLine(line)).join("\n");
  }
  if (typeof maxChars === "number" && maxChars >= 0) {
    normalized = normalized.slice(0, maxChars);
  }
  return normalized;
}

function insertFileIntoIndex(
  db: SqlJsDatabase,
  entry: FileEntry,
  phrenPath: string,
  opts?: { scheduleEmbeddings?: boolean; content?: string }
): boolean {
  try {
    const raw = opts?.content ?? fs.readFileSync(entry.fullPath, "utf-8");
    const content = normalizeIndexedContent(raw, entry.type, phrenPath);
    const indexedContent = applyReferenceTopicHints(entry, content, phrenPath);
    db.run(
      "INSERT INTO docs (project, filename, type, content, path) VALUES (?, ?, ?, ?, ?)",
      [entry.project, entry.filename, entry.type, indexedContent, entry.fullPath]
    );
    if (opts?.scheduleEmbeddings) {
      scheduleEmbedding(phrenPath, entry.fullPath, indexedContent.slice(0, 8000));
    }
    return true;
  } catch (err: unknown) {
    logger.debug("insertFileIntoIndex", errorMessage(err));
    return false;
  }
}

function normalizeTopicTokenSegment(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function extractLegacyTopicSlug(entry: FileEntry): string | null {
  const rel = (entry.relFile || "").replace(/\\/g, "/");
  const match = rel.match(LEGACY_TOPIC_REFERENCE_RE);
  if (!match) return null;
  return match[1].toLowerCase();
}

/**
 * Build-scoped memo for `readProjectTopics()`.
 *
 * `readProjectTopics` derives adaptive topics by reading and tokenising the
 * *whole* project corpus — CLAUDE.md, FINDINGS.md and every reference/*.md —
 * on each call (see `buildTopicContentSignal` in project-topics.ts). It is
 * called once per reference document, so a project with R reference docs read
 * and tokenised its own corpus R times per rebuild. Measured on a 1892-file
 * store (46 projects x 34 reference docs): 60,180 markdown reads for 1892
 * files, ~85% of a 9.4s cold build spent in topic re-derivation.
 *
 * The answer is per-project, not per-document, and the corpus cannot change
 * mid-build, so one derivation per project per build is exactly equivalent.
 * The memo is armed only for the duration of `buildIndexImpl`; single-file
 * callers such as `updateFileInIndex` keep reading through.
 */
const _buildTopicCache = new Map<string, ReturnType<typeof readProjectTopics>>();
let _buildTopicCacheActive = false;

function beginTopicBuildCache(): void {
  _buildTopicCacheActive = true;
  _buildTopicCache.clear();
}

function endTopicBuildCache(): void {
  _buildTopicCacheActive = false;
  _buildTopicCache.clear();
}

function readProjectTopicsForBuild(phrenPath: string, project: string): ReturnType<typeof readProjectTopics> {
  if (!_buildTopicCacheActive) return readProjectTopics(phrenPath, project);
  const key = `${phrenPath} ${project}`;
  const hit = _buildTopicCache.get(key);
  if (hit) return hit;
  const resolved = readProjectTopics(phrenPath, project);
  _buildTopicCache.set(key, resolved);
  return resolved;
}

function detectReferenceTopics(entry: FileEntry, content: string, phrenPath: string): ProjectTopic[] {
  if (entry.type !== "reference") return [];
  const { topics } = readProjectTopicsForBuild(phrenPath, entry.project);
  if (!topics.length) return [];

  const topicBySlug = new Map<string, ProjectTopic>(topics.map((topic) => [topic.slug, topic]));
  const lower = content.toLowerCase();
  const matchedByContent = topics.filter((topic) => {
    if (topic.slug === "general") return false;
    return topic.keywords.some((keyword) => keyword && lower.includes(keyword));
  });
  const selected: ProjectTopic[] = [];
  const pushUnique = (topic: ProjectTopic | undefined): void => {
    if (!topic) return;
    if (selected.some((item) => item.slug === topic.slug)) return;
    selected.push(topic);
  };

  // Backward compatibility: keep legacy topic docs pinned to their filename slug
  // when that slug still exists in topic-config (or built-in topics).
  const legacySlug = extractLegacyTopicSlug(entry);
  if (legacySlug) pushUnique(topicBySlug.get(legacySlug));

  // Content-based topic tags for any reference doc shape (not only reference/topics/<slug>.md).
  for (const topic of matchedByContent) pushUnique(topic);

  // Preserve previous behavior: always include at least one topic hint.
  if (!selected.length) {
    pushUnique(classifyTopicForText(content, topics));
  }

  return selected;
}

function applyReferenceTopicHints(entry: FileEntry, content: string, phrenPath: string): string {
  const topics = detectReferenceTopics(entry, content, phrenPath);
  if (!topics.length) return content;
  const hintTokens = new Set<string>();
  for (const topic of topics) {
    const slugToken = normalizeTopicTokenSegment(topic.slug) || "general";
    hintTokens.add(`phrentopic${slugToken}`);
    for (const keyword of topic.keywords) {
      const keywordToken = normalizeTopicTokenSegment(keyword);
      if (!keywordToken) continue;
      hintTokens.add(`phrentopickeyword${keywordToken}`);
    }
  }
  return `${content}\n\n${Array.from(hintTokens).join(" ")}`.trimEnd();
}

function deleteEntityLinksForDocPath(db: SqlJsDatabase, phrenPath: string, docPath: string, fallbackProject?: string, fallbackFilename?: string): void {
  const docRows = queryDocRows(db, "SELECT project, filename, type, content, path FROM docs WHERE path = ? LIMIT 1", [docPath]);
  const project = docRows?.[0]?.project ?? fallbackProject;
  if (!project) return;
  const filename = docRows?.[0]?.filename ?? fallbackFilename;
  const sourceDoc = buildSourceDocKey(project, docPath, phrenPath, filename);
  db.run("DELETE FROM entity_links WHERE source_doc = ?", [sourceDoc]);
  // Q19: also purge global_entities rows for this doc so cross_project_entities
  // never returns deleted/stale documents.
  try {
    db.run("DELETE FROM global_entities WHERE doc_key = ?", [sourceDoc]);
  } catch (err: unknown) {
    logger.debug("deleteEntityLinksForDocPath globalEntities", errorMessage(err));
  }
}

/**
 * Incrementally update a single file in the FTS index.
 * Deletes the old record for the file, re-reads and re-inserts it.
 * Touches the sentinel file to invalidate caches.
 */
export function updateFileInIndex(db: SqlJsDatabase, filePath: string, phrenPath: string): void {
  const resolvedPath = path.resolve(filePath);

  // Delete old record
  try { deleteEntityLinksForDocPath(db, phrenPath, resolvedPath); } catch (err: unknown) {
    logger.debug("updateFileInIndex deleteEntityLinks", errorMessage(err));
  }
  try { db.run("DELETE FROM docs WHERE path = ?", [resolvedPath]); } catch (err: unknown) {
    logger.debug("updateFileInIndex deleteDocs", errorMessage(err));
  }

  // Re-insert if file still exists
  if (fs.existsSync(resolvedPath)) {
    const filename = path.basename(resolvedPath);
    // Determine project from path: the file should be under phrenPath/<project>/
    const rel = path.relative(path.resolve(phrenPath), resolvedPath);
    const project = rel.split(path.sep)[0];
    const relFile = rel.split(path.sep).slice(1).join(path.sep);
    const type = classifyFile(filename, relFile);
    const entry: FileEntry = { fullPath: resolvedPath, project, filename, type, relFile };
    // Single read feeds the insert, fragment extraction and the content hash.
    const raw = readFileOrNull(resolvedPath);
    if (raw !== null && insertFileIntoIndex(db, entry, phrenPath, { scheduleEmbeddings: true, content: raw })) {
      // Re-extract fragments for finding files
      if (type === "findings") {
        try {
          extractAndLinkFragments(db, raw, getEntrySourceDocKey(entry, phrenPath), phrenPath);
        } catch (err: unknown) {
          logger.debug("updateFileInIndex entityExtraction", errorMessage(err));
        }
      }
    }

    // Update hash map for this file
    try {
      const hashData = loadHashMap(phrenPath);
      hashData.hashes[resolvedPath] = raw !== null ? hashContent(raw) : hashFileContent(resolvedPath);
      const stat = fs.statSync(resolvedPath);
      saveHashMap(phrenPath, hashData.hashes, undefined, { [resolvedPath]: { mtimeMs: stat.mtimeMs, size: stat.size } });
    } catch (err: unknown) {
      logger.debug("updateFileInIndex hashMap", errorMessage(err));
    }
  } else {
    // Remove stale embedding if file was deleted
    void (async () => {
      try {
        const { getEmbeddingCache } = await import("./embedding-cache.js");
        const c = getEmbeddingCache(phrenPath);
        c.delete(resolvedPath);
        await c.flush();
      } catch (err: unknown) {
        logger.debug("updateFileInIndex embeddingDelete", errorMessage(err));
      }
    })();
  }
  invalidateDfCache();
}

// ── Index freshness sentinel ────────────────────────────────────────────────
//
// The sentinel exists to skip `globAllFiles()` — the single most expensive part
// of a warm `buildIndex` (≈14ms on a 400-file store, ≈46ms on a 1900-file one,
// versus ≈0.7ms/4.3ms to re-stat the same files).
//
// It works in two steps, and BOTH are required for correctness:
//
//   1. Directory-mtime scan. POSIX bumps a directory's mtime whenever an entry
//      inside it is created, removed or renamed, so if every directory in the
//      indexed tree still has the exact mtime it had at build time, the *set*
//      of indexed files provably has not changed and the glob can be skipped.
//   2. Re-hash the recorded file list. A directory's mtime does NOT change when
//      a file inside it is edited in place, so step 1 alone would happily serve
//      a stale index. `computePhrenHash()` over the recorded paths re-stats
//      every file and catches edits — the same hash the slow path computes.
//
// `.runtime` is deliberately excluded from step 1 (see SENTINEL_SKIP_DIRS).

/**
 * Directories that never hold indexed content and must stay out of the mtime
 * scan.
 *
 * `.runtime` is the load-bearing entry. It is phren's own scratch dir, and
 * `_buildIndexGuarded()` creates `.runtime/index-rebuild.lock` on entry and
 * unlinks it on exit — i.e. *after* the sentinel is written. Any scan that
 * includes `.runtime` therefore sees a directory that is unconditionally newer
 * than the sentinel it is being compared against, on every single call. That is
 * why the fast path had never once fired. `updateRuntimeHealth()` and the debug
 * log dirty it too, but the rebuild lock alone is enough to guarantee a miss.
 */
const SENTINEL_SKIP_DIRS: ReadonlySet<string> = new Set([
  ".runtime",
  ".sessions",
  ".git",
  "node_modules",
  "dist",
  "build",
]);

const INDEX_SENTINEL_VERSION = 3;

interface IndexSentinel {
  version: number;
  hash: string;
  computedAt: number;
  /** Sentinel is per-profile: profiles index different project sets. */
  profile: string;
  /** [mtimeMs, size] of .config/index-policy.json; it decides what gets globbed. */
  policy: [number, number];
  /** Resolved store project dirs, so a stores.yaml/profile change invalidates. */
  projectDirs: string[];
  /** The glob result this hash was computed from. */
  files: string[];
  /** dir -> mtimeMs, sampled immediately *before* the glob ran. */
  dirs: Record<string, number>;
}

function indexSentinelPath(phrenPath: string): string {
  return runtimeFile(phrenPath, "index-sentinel.json");
}

function statIndexPolicy(phrenPath: string): [number, number] {
  try {
    const stat = fs.statSync(path.join(phrenPath, ".config", "index-policy.json"));
    return [stat.mtimeMs, stat.size];
  } catch {
    return [-1, -1];
  }
}

/**
 * Every directory whose entry list can change which files end up in the index:
 * the phren root, its config/profiles dirs, each store root, the full tree
 * under every project dir, the global skills tree, and the native agent memory
 * dirs. A dir-only walk — no per-file stats, no glob pattern matching.
 */
function collectContentDirs(phrenPath: string, projectDirs: string[]): string[] {
  const out = new Set<string>([
    phrenPath,
    path.join(phrenPath, ".config"),
    path.join(phrenPath, "profiles"),
  ]);
  const walk = (dir: string): void => {
    out.add(dir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SENTINEL_SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name));
    }
  };
  for (const dir of projectDirs) {
    out.add(path.dirname(dir)); // store root
    walk(dir);
  }
  walk(path.join(phrenPath, "global", "skills"));
  // Native agent memory (~/.claude/projects/*/memory) is indexed too, but the
  // surrounding project dirs are huge — watch only the two levels that matter.
  const nativeRoot = path.join(homeDir(), ".claude", "projects");
  out.add(nativeRoot);
  try {
    for (const entry of fs.readdirSync(nativeRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) out.add(path.join(nativeRoot, entry.name, "memory"));
    }
  } catch {
    // no native memory dirs — the nativeRoot entry above still catches creation
  }
  return [...out];
}

function snapshotContentDirs(phrenPath: string, projectDirs: string[]): Record<string, number> {
  const snapshot: Record<string, number> = {};
  for (const dir of collectContentDirs(phrenPath, projectDirs)) {
    try {
      snapshot[dir] = fs.statSync(dir).mtimeMs;
    } catch {
      snapshot[dir] = -1; // absent now; reappearing is itself a change
    }
  }
  return snapshot;
}

function readIndexSentinel(phrenPath: string): IndexSentinel | null {
  try {
    const sentinelPath = indexSentinelPath(phrenPath);
    if (!fs.existsSync(sentinelPath)) return null;
    const data = JSON.parse(fs.readFileSync(sentinelPath, "utf-8")) as Partial<IndexSentinel>;
    if (
      data.version === INDEX_SENTINEL_VERSION &&
      typeof data.hash === "string" &&
      typeof data.computedAt === "number" &&
      typeof data.profile === "string" &&
      Array.isArray(data.policy) &&
      Array.isArray(data.projectDirs) &&
      Array.isArray(data.files) &&
      data.dirs && typeof data.dirs === "object"
    ) {
      return data as IndexSentinel;
    }
  } catch (err: unknown) {
    logger.debug("readIndexSentinel", errorMessage(err));
  }
  return null;
}

function writeIndexSentinel(
  phrenPath: string,
  entry: { hash: string; profile?: string; projectDirs: string[]; files: string[]; dirs: Record<string, number> },
): void {
  try {
    const sentinel: IndexSentinel = {
      version: INDEX_SENTINEL_VERSION,
      hash: entry.hash,
      computedAt: Date.now(),
      profile: entry.profile ?? "",
      policy: statIndexPolicy(phrenPath),
      projectDirs: entry.projectDirs,
      files: entry.files,
      dirs: entry.dirs,
    };
    fs.writeFileSync(indexSentinelPath(phrenPath), JSON.stringify(sentinel));
  } catch (err: unknown) {
    logger.debug("writeIndexSentinel", errorMessage(err));
  }
}

/**
 * True when nothing that feeds the index hash can have changed since the
 * sentinel was written. Deliberately conservative: any unreadable directory,
 * any mtime that differs *at all* (not just "newer"), a profile or project-set
 * change, or an index-policy edit all report stale.
 */
function isSentinelFresh(
  phrenPath: string,
  sentinel: IndexSentinel,
  profile: string | undefined,
  projectDirs: string[],
): boolean {
  if (sentinel.profile !== (profile ?? "")) return false;

  const [policyMtime, policySize] = statIndexPolicy(phrenPath);
  if (sentinel.policy[0] !== policyMtime || sentinel.policy[1] !== policySize) return false;

  if (sentinel.projectDirs.length !== projectDirs.length) return false;
  const currentDirs = new Set(projectDirs);
  for (const dir of sentinel.projectDirs) {
    if (!currentDirs.has(dir)) return false;
  }

  for (const [dir, mtimeMs] of Object.entries(sentinel.dirs)) {
    let current: number;
    try {
      current = fs.statSync(dir).mtimeMs;
    } catch {
      current = -1;
    }
    if (current !== mtimeMs) return false;
  }
  return true;
}

/**
 * The slow path: snapshot directory mtimes, glob, hash, and seal a new sentinel.
 *
 * The snapshot is taken *before* the glob on purpose. Anything written during or
 * after the glob leaves the recorded mtime behind the real one, so the next
 * freshness check reports stale — the conservative direction.
 */
function globAndSealSentinel(
  phrenPath: string,
  profile: string | undefined,
  projectDirs: string[],
): { globResult: { filePaths: string[]; entries: FileEntry[] }; hash: string } {
  const dirs = snapshotContentDirs(phrenPath, projectDirs);
  const globResult = globAllFiles(phrenPath, profile);
  const hash = computePhrenHash(phrenPath, profile, globResult.filePaths);
  writeIndexSentinel(phrenPath, { hash, profile, projectDirs, files: globResult.filePaths, dirs });
  return { globResult, hash };
}

/**
 * Resolve the current index hash without globbing when the sentinel proves the
 * file set is unchanged. Returns null when the caller must fall back to a glob.
 */
function hashFromFreshSentinel(
  phrenPath: string,
  profile: string | undefined,
  projectDirs: string[],
): string | null {
  const sentinel = readIndexSentinel(phrenPath);
  if (!sentinel || !isSentinelFresh(phrenPath, sentinel, profile, projectDirs)) return null;
  // File set is proven unchanged; re-stat those files so an in-place edit
  // (which leaves every directory mtime untouched) still busts the cache.
  const hash = computePhrenHash(phrenPath, profile, sentinel.files);
  return hash === sentinel.hash ? hash : null;
}

/**
 * Attempt to restore the fragment graph (entities, entity_links, global_entities) from a
 * previously persisted JSON snapshot. Returns true if the graph was loaded, false if the
 * caller must run full extraction instead.
 */
function loadCachedEntityGraph(db: SqlJsDatabase, graphPath: string, allFiles: FileEntry[], phrenPath: string): boolean {
  if (!fs.existsSync(graphPath)) return false;
  try {
    const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
    const graphMtime = fs.statSync(graphPath).mtimeMs;
    const anyNewer = allFiles.some(f => {
      try { return fs.statSync(f.fullPath).mtimeMs > graphMtime; } catch (err: unknown) {
        logger.debug("loadCachedEntityGraph statFile", errorMessage(err));
        return true;
      }
    });
    if (!anyNewer && graph.entities && graph.links) {
      // Build set of valid source doc keys from current file set
      const validDocKeys = new Set(allFiles.map(f => getEntrySourceDocKey(f, phrenPath)));

      for (const [id, name, type] of graph.entities) {
        db.run("INSERT OR IGNORE INTO entities (id, name, type, first_seen_at) VALUES (?, ?, ?, ?)", [id, name, type, new Date().toISOString().slice(0, 10)]);
      }
      for (const [sourceId, targetId, relType, sourceDoc] of graph.links) {
        // Skip links for docs that no longer exist in the current file set
        if (sourceDoc && !validDocKeys.has(sourceDoc)) continue;
        db.run("INSERT OR IGNORE INTO entity_links (source_id, target_id, rel_type, source_doc) VALUES (?, ?, ?, ?)", [sourceId, targetId, relType, sourceDoc]);
      }
      // Q19: also restore global_entities from cached graph so cross_project_entities
      // is not empty after a cached-graph rebuild path.
      if (Array.isArray(graph.globalEntities)) {
        for (const [entity, project, docKey] of graph.globalEntities) {
          // Skip global fragments whose source doc no longer exists
          if (docKey && !validDocKeys.has(docKey)) continue;
          try {
            db.run(
              "INSERT OR IGNORE INTO global_entities (entity, project, doc_key) VALUES (?, ?, ?)",
              [entity, project, docKey]
            );
          } catch (err: unknown) {
            logger.debug("loadCachedEntityGraph globalEntitiesInsert2", errorMessage(err));
          }
        }
      } else {
        // Older cache without globalEntities: re-derive from entity_links + entities tables
        try {
          const rows = db.exec(
            `SELECT e.name, el.source_doc FROM entity_links el
             JOIN entities e ON el.target_id = e.id
             WHERE el.source_doc IS NOT NULL`
          )[0]?.values ?? [];
          for (const [name, sourceDoc] of rows) {
            const projectMatch = typeof sourceDoc === "string" ? sourceDoc.match(/^([^/]+)\//) : null;
            const proj = projectMatch ? projectMatch[1] : null;
            if (proj && name) {
              try {
                db.run(
                  "INSERT OR IGNORE INTO global_entities (entity, project, doc_key) VALUES (?, ?, ?)",
                  [name as string, proj, sourceDoc as string]
                );
              } catch (err: unknown) {
            logger.debug("loadCachedEntityGraph globalEntitiesInsert", errorMessage(err));
          }
            }
          }
        } catch (err: unknown) {
          logger.debug("entityGraph globalEntitiesRestore", errorMessage(err));
        }
      }
      return true;
    }
  } catch (err: unknown) {
    logger.debug("entityGraph cacheLoad", errorMessage(err));
  }
  return false;
}

/** Merge manual fragment links (written by link_findings tool) into the live DB. Always runs on
 * every build so hand-authored links survive a full index rebuild. */
function mergeManualLinks(db: SqlJsDatabase, phrenPath: string): void {
  const manualLinksPath = runtimeFile(phrenPath, 'manual-links.json');
  if (!fs.existsSync(manualLinksPath)) return;
  try {
    const manualLinks: Array<{ entity: string; entityType: string; sourceDoc: string; relType: string }> =
      JSON.parse(fs.readFileSync(manualLinksPath, 'utf8'));

    // Resolve all sourceDoc keys in one query instead of one lookup per link.
    // Mirrors queryDocBySourceKey semantics: match project + basename(filename),
    // then compare the full source-doc key.
    const projects = [...new Set(
      manualLinks.map((l) => l.sourceDoc.match(/^([^/]+)\//)?.[1]).filter((p): p is string => !!p)
    )];
    const filenames = [...new Set(
      manualLinks
        .map((l) => l.sourceDoc.match(/^[^/]+\/(.+)$/)?.[1])
        .filter((rest): rest is string => !!rest)
        .map((rest) => path.basename(rest))
    )];
    const validSourceKeys = new Set<string>();
    if (projects.length && filenames.length) {
      const sql = `SELECT project, filename, path FROM docs WHERE project IN (${projects.map(() => "?").join(",")}) AND filename IN (${filenames.map(() => "?").join(",")})`;
      const rows = queryRows(db, sql, [...projects, ...filenames]) ?? [];
      for (const row of rows) {
        const [project, filename, docPath] = decodeStringRow(row, 3, "mergeManualLinks");
        validSourceKeys.add(getDocSourceKey({ project, filename, path: docPath }, phrenPath));
      }
    }

    let pruned = false;
    const validLinks: typeof manualLinks = [];
    for (const link of manualLinks) {
      try {
        // Validate: skip manual links whose sourceDoc no longer exists in the index
        if (!validSourceKeys.has(link.sourceDoc)) {
          logger.debug("manualLinks", `pruning stale link to "${link.sourceDoc}"`);
          pruned = true;
          continue;
        }
        validLinks.push(link);

        db.run("INSERT OR IGNORE INTO entities (name, type, first_seen_at) VALUES (?, ?, ?)", [link.entity, link.entityType, new Date().toISOString().slice(0, 10)]);
        db.run("INSERT OR IGNORE INTO entities (name, type, first_seen_at) VALUES (?, ?, ?)", [link.sourceDoc, "document", new Date().toISOString().slice(0, 10)]);
        const eRes = db.exec("SELECT id FROM entities WHERE name = ? AND type = ?", [link.entity, link.entityType]);
        const dRes = db.exec("SELECT id FROM entities WHERE name = ? AND type = ?", [link.sourceDoc, "document"]);
        const eId = eRes?.[0]?.values?.[0]?.[0];
        const dId = dRes?.[0]?.values?.[0]?.[0];
        if (eId != null && dId != null) {
          db.run(
            "INSERT OR IGNORE INTO entity_links (source_id, target_id, rel_type, source_doc) VALUES (?, ?, ?, ?)",
            [dId, eId, link.relType, link.sourceDoc]
          );
        }
        // Also populate global_entities so manual links are discoverable via cross_project_entities
        const projectMatch = link.sourceDoc.match(/^([^/]+)\//);
        if (projectMatch) {
          try {
            db.run(
              "INSERT OR IGNORE INTO global_entities (entity, project, doc_key) VALUES (?, ?, ?)",
              [link.entity, projectMatch[1], link.sourceDoc]
            );
          } catch (err: unknown) {
            logger.debug("manualLinks globalEntities", errorMessage(err));
          }
        }
      } catch (err: unknown) {
        logger.debug("manualLinks entry", errorMessage(err));
      }
    }
    // Rewrite manual-links.json if stale entries were pruned
    if (pruned) {
      try {
        withFileLock(manualLinksPath, () => {
          const tmpPath = manualLinksPath + `.tmp-${crypto.randomUUID()}`;
          fs.writeFileSync(tmpPath, JSON.stringify(validLinks, null, 2));
          fs.renameSync(tmpPath, manualLinksPath);
        });
      } catch (err: unknown) {
        logger.debug("manualLinks prune write", errorMessage(err));
      }
    }
  } catch (err: unknown) {
    logger.debug("mergeManualLinks", errorMessage(err));
  }
}

async function buildIndexImpl(phrenPath: string, profile?: string): Promise<SqlJsDatabase> {
  const t0 = Date.now();
  await refreshStoreProjectDirs(phrenPath, profile);
  const projectDirs = getAllStoreProjectDirs(phrenPath, profile);
  beginUserFragmentBuildCache(phrenPath, projectDirs.map(dir => path.basename(dir)));
  beginTopicBuildCache();
  const contentCache = new BuildContentCache();
  try {

  // ── Cache dir + hash sentinel ─────────────────────────────────────────────
  pruneFtsCacheRoot(storeCacheKey(phrenPath, profile));
  const cacheDir = ftsCacheDir(phrenPath, profile);

  // Fast path: if the sentinel is fresh, skip the expensive glob computation.
  let hash: string;
  let globResult: { filePaths: string[]; entries: FileEntry[] } | null = null;
  const sentinelHash = hashFromFreshSentinel(phrenPath, profile, projectDirs);
  if (sentinelHash && fs.existsSync(path.join(cacheDir, `${sentinelHash}.db`))) {
    // Sentinel cache hit — defer glob; only load it if incremental path needs it
    hash = sentinelHash;
  } else {
    // Sentinel stale, content changed, or the cache file was cleaned up.
    const sealed = globAndSealSentinel(phrenPath, profile, projectDirs);
    globResult = sealed.globResult;
    hash = sealed.hash;
  }
  const cacheFile = path.join(cacheDir, `${hash}.db`);

  const SQL = await bootstrapSqlJs() as SqlJsStatic;

  // ── Incremental update (cache hit path) ───────────────────────────────────
  // Load saved per-file hashes for incremental updates
  const savedHashData = loadHashMap(phrenPath);
  const savedHashes = savedHashData.hashes;
  const schemaChanged = savedHashData.version !== INDEX_SCHEMA_VERSION;

  // Try loading cached DB for incremental update
  if (!schemaChanged && fs.existsSync(cacheFile)) {
    // Pure sentinel hit: glob was skipped, return DB without computing file diffs
    if (!globResult) {
      try {
        const cached = fs.readFileSync(cacheFile);
        const db = new SQL.Database(cached);
        const docCountResult = db.exec("SELECT COUNT(*) FROM docs");
        const docCount = docCountResult?.[0]?.values?.[0]?.[0] as number ?? 0;
        if (docCount > 0) {
          try { db.run("ALTER TABLE entities ADD COLUMN first_seen_at TEXT"); } catch (err: unknown) {
            // Usually "duplicate column name" — column already exists
            if (!isExpectedMigrationError(err)) logger.warn("buildIndex migration", errorMessage(err));
          }
          debugLog(`Loaded FTS index from cache (${hash.slice(0, 8)}) in ${Date.now() - t0}ms [sentinel-hit]`);
          appendIndexEvent(phrenPath, {
            event: "build_index",
            cache: "hit",
            // The glob was skipped entirely. Recorded so "is the fast path
            // firing?" is answerable from the event log instead of by reasoning.
            sentinel: true,
            hash: hash.slice(0, 12),
            elapsedMs: Date.now() - t0,
            profile: profile || "",
          });
          return db;
        }
        // Empty DB — fall through to full rebuild with glob
        db.close();
      } catch (err: unknown) {
        debugLog(`sentinel-hit DB load failed, falling back to full rebuild: ${errorMessage(err)}`);
      }
      // Need glob for rebuild
      const sealed = globAndSealSentinel(phrenPath, profile, projectDirs);
      globResult = sealed.globResult;
      hash = sealed.hash;
    }
    try {
      const cached = fs.readFileSync(cacheFile);
      let db: SqlJsDatabase | undefined;
      let shouldCloseDb = true;
      try {
        db = new SQL.Database(cached);

        // If OS cleaned /tmp and the file was recreated as empty, the DB will have
        // 0 docs even though savedHashes has full content. Treat as cache miss so
        // the stale hash map doesn't drive an incremental update against an empty DB.
        const docCountResult = db.exec("SELECT COUNT(*) FROM docs");
        const docCount = docCountResult?.[0]?.values?.[0]?.[0] as number ?? 0;
        if (docCount === 0 && globResult.entries.length > 0) {
          throw new Error("cached DB is empty, forcing full rebuild");
        }

        // Schema migration: add first_seen_at column if missing
        try { db.run("ALTER TABLE entities ADD COLUMN first_seen_at TEXT"); } catch (err: unknown) {
          // Usually "duplicate column name" — column already exists
          if (!isExpectedMigrationError(err)) logger.warn("buildIndex migration", errorMessage(err));
        }

        // Compute current file hashes and determine what changed.
        // Files whose mtime+size match the stored snapshot reuse the stored hash,
        // skipping a read+SHA256 per file; the content hash stays the source of
        // truth whenever the stat changed.
        const allFiles = globResult.entries;
        const savedMeta = savedHashData.meta ?? {};
        const currentHashes: Record<string, string> = {};
        const currentMeta: Record<string, FileStatMeta> = {};
        const changedFiles: FileEntry[] = [];
        const newFiles: FileEntry[] = [];

        for (const entry of allFiles) {
          try {
            const stat = fs.statSync(entry.fullPath);
            const prevHash = savedHashes[entry.fullPath];
            const prevMeta = savedMeta[entry.fullPath];
            const statUnchanged = prevHash !== undefined && prevMeta !== undefined
              && prevMeta.mtimeMs === stat.mtimeMs && prevMeta.size === stat.size;
            let fileHash: string;
            if (statUnchanged) {
              fileHash = prevHash;
            } else {
              // The only read of this file in this rebuild: hand the bytes to the
              // insert pass below instead of letting it read them again.
              const raw = fs.readFileSync(entry.fullPath, "utf-8");
              fileHash = hashContent(raw);
              contentCache.put(entry.fullPath, raw);
            }
            currentHashes[entry.fullPath] = fileHash;
            currentMeta[entry.fullPath] = { mtimeMs: stat.mtimeMs, size: stat.size };
            if (!(entry.fullPath in savedHashes)) {
              newFiles.push(entry);
            } else if (savedHashes[entry.fullPath] !== fileHash) {
              changedFiles.push(entry);
            }
          } catch (err: unknown) {
            logger.debug("buildIndex hashFile", errorMessage(err));
          }
        }

        // Check for files missing from the index (deleted files)
        const currentPaths = new Set(Object.keys(currentHashes));
        const missingFromIndex = Object.keys(savedHashes).filter(p => !currentPaths.has(p));

        // Force a full rebuild when a large share of saved files vanished at once —
        // guards against pathological glob results (e.g. a temporarily unmounted
        // store dir) and bounds FTS bloat from mass tombstones. Smaller deletions
        // are removed incrementally.
        const totalSaved = Object.keys(savedHashes).length;
        if (totalSaved > 0 && missingFromIndex.length / totalSaved > MAX_INCREMENTAL_DELETE_RATIO) {
          debugLog(`>${MAX_INCREMENTAL_DELETE_RATIO * 100}% files missing (${missingFromIndex.length}/${totalSaved}), forcing full rebuild`);
          // Fall through to full rebuild below
        } else if (changedFiles.length === 0 && newFiles.length === 0 && missingFromIndex.length === 0) {
          // Nothing changed, pure cache hit
          debugLog(`Loaded FTS index from cache (${hash.slice(0, 8)}) in ${Date.now() - t0}ms`);
          appendIndexEvent(phrenPath, {
            event: "build_index",
            cache: "hit",
            sentinel: false,
            hash: hash.slice(0, 12),
            elapsedMs: Date.now() - t0,
            profile: profile || "",
          });
          shouldCloseDb = false;
          return db;
        } else {
          // Incremental update: apply each file change atomically to avoid losing docs on crash.
          const changedPaths = new Set(changedFiles.map(entry => entry.fullPath));
          db.run("BEGIN");
          try {
            for (const missingPath of missingFromIndex) {
              try { deleteEntityLinksForDocPath(db, phrenPath, missingPath); } catch (err: unknown) {
                logger.debug("buildIndex deleteEntityLinksForMissing", errorMessage(err));
              }
              try { db.run("DELETE FROM docs WHERE path = ?", [missingPath]); } catch (err: unknown) {
                logger.debug("buildIndex deleteDocForMissing", errorMessage(err));
              }
            }
            db.run("COMMIT");
          } catch (err: unknown) {
            logger.debug("buildIndex incrementalDeleteCommit", errorMessage(err));
            try { db.run("ROLLBACK"); } catch (e2: unknown) {
              logger.debug("buildIndex incrementalDeleteRollback", e2 instanceof Error ? e2.message : String(e2));
            }
          }

          let updatedCount = 0;
          for (const entry of [...changedFiles, ...newFiles]) {
            db.run("BEGIN");
            try {
              if (changedPaths.has(entry.fullPath)) {
                const sourceDocKey = getEntrySourceDocKey(entry, phrenPath);
                db.run("DELETE FROM entity_links WHERE source_doc = ?", [sourceDocKey]);
                // Q19: keep global_entities in sync with entity_links on updates
                try { db.run("DELETE FROM global_entities WHERE doc_key = ?", [sourceDocKey]); } catch (err: unknown) {
                  // Usually "no such table" — table may not exist in older cached DBs
                  if (!isExpectedMigrationError(err)) logger.warn("buildIndex migration", errorMessage(err));
                }
                db.run("DELETE FROM docs WHERE path = ?", [entry.fullPath]);
              }

              // Reuse the bytes read during hashing; only fall back to disk when
              // the carry cache declined the file (budget) or never saw it.
              const carried = contentCache.take(entry.fullPath);
              const raw = carried ?? readFileOrNull(entry.fullPath);
              if (raw !== null && insertFileIntoIndex(db, entry, phrenPath, { scheduleEmbeddings: true, content: raw })) {
                updatedCount++;
                if (entry.type === "findings") {
                  try {
                    extractAndLinkFragments(db, raw, getEntrySourceDocKey(entry, phrenPath), phrenPath);
                  } catch (err: unknown) { debugLog(`fragment extraction failed: ${errorMessage(err)}`); }
                }
              }

              db.run("COMMIT");
            } catch (err: unknown) {
              try { db.run("ROLLBACK"); } catch (e2: unknown) {
                logger.debug("buildIndex perFileRollback", e2 instanceof Error ? e2.message : String(e2));
              }
              throw err;
            }
          }

          saveHashMap(phrenPath, currentHashes, new Set(Object.keys(currentHashes)), currentMeta);
          invalidateDfCache();

          // Save updated cache
          try {
            fs.mkdirSync(cacheDir, { recursive: true });
            fs.writeFileSync(cacheFile, db.export());
          } catch (err: unknown) {
            logger.debug("buildIndex incrementalCacheSave", errorMessage(err));
          }

          const incMs = Date.now() - t0;
          debugLog(`Incremental FTS update: ${updatedCount} changed, ${missingFromIndex.length} removed in ${incMs}ms`);
          appendIndexEvent(phrenPath, {
            event: "build_index",
            cache: "incremental",
            hash: hash.slice(0, 12),
            files: updatedCount,
            removed: missingFromIndex.length,
            elapsedMs: incMs,
            profile: profile || "",
          });
          shouldCloseDb = false;
          return db;
        }
      } finally {
        if (shouldCloseDb) {
          db?.close();
        }
      }
    } catch (err: unknown) {
      debugLog(`Cache load failed, rebuilding index: ${errorMessage(err)}`);
    }
  }

  // ── Full rebuild ──────────────────────────────────────────────────────────
  // Ensure glob data is available for full rebuild (may be null from sentinel fast-path fallback)
  if (!globResult) {
    const sealed = globAndSealSentinel(phrenPath, profile, projectDirs);
    globResult = sealed.globResult;
    hash = sealed.hash;
  }
  const db = new SQL.Database();
  db.run(`
    CREATE VIRTUAL TABLE docs USING fts5(
      project, filename, type, content, path,
      tokenize = "porter unicode61"
    );
  `);

  // Fragment graph tables for lightweight reference graph
  db.run(`CREATE TABLE IF NOT EXISTS entities (id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, first_seen_at TEXT, UNIQUE(name, type))`);
  db.run(`CREATE TABLE IF NOT EXISTS entity_links (source_id INTEGER REFERENCES entities(id), target_id INTEGER REFERENCES entities(id), rel_type TEXT NOT NULL, source_doc TEXT, PRIMARY KEY (source_id, target_id, rel_type))`);
  // Q20: Cross-project fragment index
  ensureGlobalEntitiesTable(db);

  const allFiles = globResult.entries;
  const newHashes: Record<string, string> = {};
  const newMeta: Record<string, FileStatMeta> = {};
  let fileCount = 0;

  // Try loading cached fragment graph
  const graphPath = runtimeFile(phrenPath, 'entity-graph.json');
  const entityGraphLoaded = loadCachedEntityGraph(db, graphPath, allFiles, phrenPath);

  // One read per file: the bytes feed the content hash, the FTS insert and (for
  // findings) fragment extraction. Every insert is batched into a single
  // transaction so sql.js does not open and commit one per statement.
  db.run("BEGIN");
  let fullRebuildCommitted = false;
  try {
    for (const entry of allFiles) {
      const raw = readFileOrNull(entry.fullPath);
      if (raw === null) continue;
      try {
        newHashes[entry.fullPath] = hashContent(raw);
        const stat = fs.statSync(entry.fullPath);
        newMeta[entry.fullPath] = { mtimeMs: stat.mtimeMs, size: stat.size };
      } catch (err: unknown) {
        logger.debug("buildIndex statFile", errorMessage(err));
      }
      if (insertFileIntoIndex(db, entry, phrenPath, { scheduleEmbeddings: true, content: raw })) {
        fileCount++;
        // Extract fragments from finding files (if not loaded from cache)
        if (!entityGraphLoaded && entry.type === "findings") {
          try {
            extractAndLinkFragments(db, raw, getEntrySourceDocKey(entry, phrenPath), phrenPath);
          } catch (err: unknown) { debugLog(`fragment extraction failed: ${errorMessage(err)}`); }
        }
      }
    }
    db.run("COMMIT");
    fullRebuildCommitted = true;
  } finally {
    if (!fullRebuildCommitted) {
      try { db.run("ROLLBACK"); } catch (err: unknown) {
        logger.debug("buildIndex fullRebuildRollback", errorMessage(err));
      }
    }
  }

  // Persist fragment graph for next build
  if (!entityGraphLoaded) {
    try {
      const entityRows = db.exec("SELECT id, name, type FROM entities")[0]?.values ?? [];
      const linkRows = db.exec("SELECT source_id, target_id, rel_type, source_doc FROM entity_links")[0]?.values ?? [];
      // Q19: also persist global_entities so the cached-graph rebuild path can
      // restore it without re-running extraction on every file.
      const globalEntityRows = db.exec("SELECT entity, project, doc_key FROM global_entities")[0]?.values ?? [];
      fs.writeFileSync(graphPath, JSON.stringify({ entities: entityRows, links: linkRows, globalEntities: globalEntityRows, ts: Date.now() }));
    } catch (err: unknown) {
      logger.debug("buildIndex entityGraphPersist", errorMessage(err));
    }
  }

  // Always merge manual links (survive rebuild)
  mergeManualLinks(db, phrenPath);

  // ── Finalize: persist hashes, save cache, log ─────────────────────────────
  saveHashMap(phrenPath, newHashes, new Set(Object.keys(newHashes)), newMeta);
  invalidateDfCache();

  const buildMs = Date.now() - t0;
  debugLog(`Built FTS index: ${fileCount} files from ${projectDirs.length} projects in ${buildMs}ms`);
  if ((process.env.PHREN_DEBUG)) console.error(`Indexed ${fileCount} files from ${projectDirs.length} projects`);
  appendIndexEvent(phrenPath, {
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
      try { fs.unlinkSync(path.join(cacheDir, f)); } catch (err: unknown) {
        logger.debug("buildIndex staleCacheCleanup", errorMessage(err));
      }
    }
    debugLog(`Saved FTS index cache (${hash.slice(0, 8)}) — total ${Date.now() - t0}ms`);
  } catch (err: unknown) {
    debugLog(`Failed to save FTS index cache: ${errorMessage(err)}`);
  }

  return db;
  } finally {
    endUserFragmentBuildCache(phrenPath);
    endTopicBuildCache();
    contentCache.clear();
  }
}

function createEmptyIndexDb(SQL: SqlJsStatic): SqlJsDatabase {
  const db = new SQL.Database();
  db.run(`
    CREATE VIRTUAL TABLE docs USING fts5(
      project, filename, type, content, path,
      tokenize = "porter unicode61"
    );
  `);
  db.run(`CREATE TABLE IF NOT EXISTS entities (id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, first_seen_at TEXT, UNIQUE(name, type))`);
  db.run(`CREATE TABLE IF NOT EXISTS entity_links (source_id INTEGER REFERENCES entities(id), target_id INTEGER REFERENCES entities(id), rel_type TEXT NOT NULL, source_doc TEXT, PRIMARY KEY (source_id, target_id, rel_type))`);
  ensureGlobalEntitiesTable(db);
  return db;
}

function isRebuildLockHeld(phrenPath: string): boolean {
  const lockTarget = runtimeFile(phrenPath, "index-rebuild");
  const lockPath = lockTarget + ".lock";
  try {
    const stat = fs.statSync(lockPath);
    const staleThreshold = Number.parseInt((process.env.PHREN_FILE_LOCK_STALE_MS) || "30000", 10) || 30000;
    return Date.now() - stat.mtimeMs <= staleThreshold;
  } catch (err: unknown) {
    logger.debug("isRebuildLockHeld stat", errorMessage(err));
    return false;
  }
}

async function loadIndexSnapshotOrEmpty(
  phrenPath: string,
  profile?: string,
  knownHash?: string,
): Promise<SqlJsDatabase> {
  const SQL = await bootstrapSqlJs() as SqlJsStatic;
  const cacheDir = ftsCacheDir(phrenPath, profile);
  // `knownHash` lets loadIndexForHook skip a second glob for a hash it just
  // computed (and already knows misses).
  const hash = knownHash ?? computePhrenHash(phrenPath, profile, globAllFiles(phrenPath, profile).filePaths);
  const cacheFile = path.join(cacheDir, `${hash}.db`);

  if (fs.existsSync(cacheFile)) {
    try {
      return new SQL.Database(fs.readFileSync(cacheFile));
    } catch (err: unknown) {
      debugLog(`Failed to open cached FTS snapshot while rebuild lock held: ${errorMessage(err)}`);
    }
  }

  // Before returning empty, fall back to an older snapshot *of this store*.
  // cacheDir is store+profile scoped, so nothing here can belong to another
  // store — serving a neighbour's index would inject its knowledge into this
  // store's prompts.
  try {
    if (fs.existsSync(cacheDir)) {
      const cacheFiles = fs.readdirSync(cacheDir)
        .filter(f => f.endsWith(".db"))
        .map(f => ({ name: f, mtime: fs.statSync(path.join(cacheDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      for (const cf of cacheFiles) {
        try {
          const staleDb = new SQL.Database(fs.readFileSync(path.join(cacheDir, cf.name)));
          debugLog(`FTS rebuild in progress; falling back to stale cache: ${cf.name}`);
          return staleDb;
        } catch { /* try next */ }
      }
    }
  } catch (err: unknown) {
    debugLog(`Failed to scan stale FTS caches: ${errorMessage(err)}`);
  }

  debugLog("FTS rebuild already in progress; no usable cache found, returning empty snapshot");
  return createEmptyIndexDb(SQL);
}

// Serialize concurrent in-process buildIndex calls to prevent SQLite corruption
let buildLock: Promise<SqlJsDatabase | null> = Promise.resolve(null);

// Staleness debounce: if the index was rebuilt within this window, return the
// cached DB immediately without re-running the expensive glob + hash pipeline.
// Configurable via PHREN_INDEX_DEBOUNCE_MS (default 5000ms).
const INDEX_DEBOUNCE_DEFAULT_MS = 5000;
let _lastBuiltDb: SqlJsDatabase | null = null;
let _lastBuildTimestamp = 0;
let _lastBuildKey = "";

function getIndexDebounceMs(): number {
  const raw = (process.env.PHREN_INDEX_DEBOUNCE_MS);
  if (!raw) return INDEX_DEBOUNCE_DEFAULT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) return INDEX_DEBOUNCE_DEFAULT_MS;
  return Math.min(parsed, 60000);
}

function isDbOpen(db: SqlJsDatabase): boolean {
  try {
    db.exec("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

export async function buildIndex(phrenPath: string, profile?: string): Promise<SqlJsDatabase> {
  const debounceMs = getIndexDebounceMs();
  const buildKey = `${phrenPath}|${profile ?? ""}`;
  if (
    debounceMs > 0 &&
    _lastBuiltDb !== null &&
    _lastBuildKey === buildKey &&
    Date.now() - _lastBuildTimestamp < debounceMs &&
    isDbOpen(_lastBuiltDb)
  ) {
    debugLog(`buildIndex debounce hit (${Date.now() - _lastBuildTimestamp}ms < ${debounceMs}ms)`);
    return _lastBuiltDb;
  }

  const result = buildLock.then(() => _buildIndexGuarded(phrenPath, profile));
  // Update the lock chain; swallow rejections so the chain doesn't stall
  buildLock = result.catch(() => null);
  const db = await result;
  _lastBuiltDb = db;
  _lastBuildTimestamp = Date.now();
  _lastBuildKey = buildKey;
  return db;
}

/** Per-user FTS cache root (os.tmpdir()/phren-fts-<uid>). */
function ftsCacheRoot(): string {
  let userSuffix: string;
  try {
    userSuffix = String(os.userInfo().uid);
  } catch (err: unknown) {
    logger.debug("ftsCacheRoot userInfo", errorMessage(err));
    userSuffix = crypto.createHash("sha1").update(homeDir()).digest("hex").slice(0, 12);
  }
  return path.join(os.tmpdir(), `phren-fts-${userSuffix}`);
}

/**
 * Store identity, independent of content. A snapshot's filename is a *content*
 * hash, so an older snapshot of this store has a different name than the
 * current one — there is no way to recognise your own stale caches by hash.
 * Identity therefore has to live in the path.
 */
function storeCacheKey(phrenPath: string, profile?: string): string {
  return crypto.createHash("sha1")
    .update(`${path.resolve(phrenPath)}|${profile ?? ""}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * FTS cache directory for one store+profile: os.tmpdir()/phren-fts-<uid>/<storeKey>/.
 *
 * The per-user root used to hold every store's `<contentHash>.db` side by side,
 * and the "serve a stale snapshot" fallback picked the newest .db in it without
 * checking whose it was. With two stores configured — phren's own documented
 * personal + team setup — one store's knowledge could be injected into the
 * other's agent prompt whenever the second store's hash missed. Scoping the
 * directory makes every scan trivially store-local. It also keeps the
 * "prune older snapshots" sweep from evicting a sibling store's cache and
 * forcing it into a full rebuild on its next build.
 */
function ftsCacheDir(phrenPath: string, profile?: string): string {
  return path.join(ftsCacheRoot(), storeCacheKey(phrenPath, profile));
}

/** Store cache dirs older than this are dropped; a cold rebuild recreates them. */
const FTS_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Hard cap on retained store dirs, so a burst of transient stores cannot pile up. */
const FTS_CACHE_MAX_STORES = 64;

/**
 * Keep the cache root bounded, once per process.
 *
 * The old flat layout self-limited to a single snapshot because every full
 * rebuild unlinked all the others — cross-store eviction was the (accidental)
 * garbage collector. Per-store directories fix the contamination that caused,
 * but nothing would ever reclaim a directory again: one test-suite run alone
 * left 524 store dirs / 36MB behind. So prune explicitly.
 *
 * Also removes pre-0.1.41 snapshots sitting flat in the root: they are not
 * attributable to any store, so they can only ever be mis-served.
 */
let _ftsCachePruned = false;

/**
 * @internal Exported for tests. The prune is a one-shot per process, so a test
 * that needs to set up state *after* a build (which consumes it) has no other
 * way to exercise the pruning logic a second time.
 */
export function __resetFtsCachePruneGuardForTests(): void {
  _ftsCachePruned = false;
}

function pruneFtsCacheRoot(keepKey: string): void {
  if (_ftsCachePruned) return;
  _ftsCachePruned = true;
  try {
    const root = ftsCacheRoot();
    if (!fs.existsSync(root)) return;
    const now = Date.now();
    const stores: { name: string; mtimeMs: number }[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const full = path.join(root, entry.name);
      if (entry.isFile()) {
        if (entry.name.endsWith(".db")) {
          try { fs.unlinkSync(full); } catch { /* best effort */ }
        }
        continue;
      }
      if (!entry.isDirectory() || entry.name === keepKey) continue;
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(full).mtimeMs; } catch { /* treat as ancient */ }
      if (now - mtimeMs > FTS_CACHE_TTL_MS) {
        try { fs.rmSync(full, { recursive: true, force: true }); } catch { /* best effort */ }
        continue;
      }
      stores.push({ name: entry.name, mtimeMs });
    }
    if (stores.length <= FTS_CACHE_MAX_STORES) return;
    stores.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const store of stores.slice(FTS_CACHE_MAX_STORES)) {
      try { fs.rmSync(path.join(root, store.name), { recursive: true, force: true }); } catch { /* best effort */ }
    }
  } catch (err: unknown) {
    logger.debug("pruneFtsCacheRoot", errorMessage(err));
  }
}

/**
 * Non-blocking index loader for the UserPromptSubmit / PostToolUse hooks.
 * Unlike buildIndex(), this NEVER blocks a hook on a 2-12s rebuild:
 *   - exact stat-hash cache hit → serve it immediately (fast path);
 *   - miss but a usable (possibly stale) cache exists → serve the stale snapshot
 *     now and kick a *detached* `background-reindex` (deduped by the rebuild
 *     lock) so the next prompt gets fresh results. A single prompt's context may
 *     lag one write — far better than freezing the prompt;
 *   - cold start (no cache at all) → block once on a full build so the very first
 *     prompt isn't empty.
 * Freshness stays correct over time: an edit bumps mtime → new stat-hash → this
 * misses → a rebuild is scheduled → the following prompt hits the new cache.
 */
export async function loadIndexForHook(phrenPath: string, profile?: string): Promise<SqlJsDatabase> {
  pruneFtsCacheRoot(storeCacheKey(phrenPath, profile));
  const cacheDir = ftsCacheDir(phrenPath, profile);
  // Resolve team stores the same way buildIndex does. Without this the hook's
  // file set (and therefore its hash) can never match the one buildIndex sealed,
  // so every prompt would miss the cache and spawn a redundant reindex.
  await refreshStoreProjectDirs(phrenPath, profile);
  const projectDirs = getAllStoreProjectDirs(phrenPath, profile);
  // Skip the glob when the sentinel proves nothing changed (see the sentinel
  // block above): ~20x cheaper than re-globbing, and yields the same hash.
  const sentinelHash = hashFromFreshSentinel(phrenPath, profile, projectDirs);
  const hash = sentinelHash
    ?? computePhrenHash(phrenPath, profile, globAllFiles(phrenPath, profile).filePaths);
  const cacheFile = path.join(cacheDir, `${hash}.db`);
  const SQL = await bootstrapSqlJs() as SqlJsStatic;

  // Fast path: exact stat-hash hit (no file changed mtime/size since the build).
  if (fs.existsSync(cacheFile)) {
    try {
      const db = new SQL.Database(fs.readFileSync(cacheFile));
      const docCount = db.exec("SELECT COUNT(*) FROM docs")?.[0]?.values?.[0]?.[0] as number ?? 0;
      if (docCount > 0) {
        appendIndexEvent(phrenPath, { event: "build_index", cache: "hit", sentinel: sentinelHash !== null, hash: hash.slice(0, 12), elapsedMs: 0, profile: profile || "" });
        return db;
      }
      db.close();
    } catch (err: unknown) {
      debugLog(`loadIndexForHook fast-path load failed: ${errorMessage(err)}`);
    }
  }

  // Miss. Serve stale immediately if *this store* has a snapshot; else
  // cold-build once. cacheDir is store+profile scoped, so another store's
  // snapshot can never satisfy this check.
  let hasStale = false;
  try {
    hasStale = fs.existsSync(cacheDir) && fs.readdirSync(cacheDir).some(f => f.endsWith(".db"));
  } catch (err: unknown) {
    logger.debug("loadIndexForHook staleScan", errorMessage(err));
  }
  if (!hasStale) {
    // Cold start: no snapshot exists at all. Block once rather than inject an
    // empty context — "instant but empty" is worse than "slow but right".
    return buildIndex(phrenPath, profile);
  }

  // Schedule a detached rebuild for next time (rebuild lock dedups concurrent hooks).
  let scheduled = false;
  if (!isRebuildLockHeld(phrenPath)) {
    const entry = process.argv[1];
    if (entry && /index\.(c?js|mjs|ts)$/.test(entry) && fs.existsSync(entry)) {
      try {
        spawnDetachedChild([entry, "background-reindex"], { phrenPath }).unref();
        scheduled = true;
        debugLog(`loadIndexForHook: scheduled detached background-reindex (stat-hash miss ${hash.slice(0, 8)})`);
      } catch (err: unknown) {
        debugLog(`loadIndexForHook: detached reindex spawn failed: ${errorMessage(err)}`);
      }
    }
  }
  // The prompt is about to be answered from a snapshot that predates the latest
  // write. That trade is deliberate, but it must not be invisible: record it so
  // "why did phren miss the finding I just wrote?" is answerable from the log.
  appendIndexEvent(phrenPath, {
    event: "build_index",
    cache: "stale",
    hash: hash.slice(0, 12),
    rebuildScheduled: scheduled,
    elapsedMs: 0,
    profile: profile || "",
  });
  return loadIndexSnapshotOrEmpty(phrenPath, profile, hash);
}

async function _buildIndexGuarded(phrenPath: string, profile?: string): Promise<SqlJsDatabase> {
  const lockTarget = runtimeFile(phrenPath, "index-rebuild");
  if (isRebuildLockHeld(phrenPath)) {
    return loadIndexSnapshotOrEmpty(phrenPath, profile);
  }

  try {
    return await withFileLock(lockTarget, async () => {
      let timer: ReturnType<typeof setTimeout>;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("buildIndex timed out after 30s")), 30000);
      });
      try {
        return await Promise.race([buildIndexImpl(phrenPath, profile), timeout]);
      } finally {
        clearTimeout(timer!);
      }
    });
  } catch (err: unknown) {
    const message = errorMessage(err);
    if (message.includes("could not acquire lock")) {
      debugLog(`FTS rebuild skipped because another process holds the rebuild lock: ${message}`);
      return loadIndexSnapshotOrEmpty(phrenPath, profile);
    }
    throw err;
  }
}

/** Find the FTS cache file for a specific phrenPath+profile. Returns exists + size. */
export function findFtsCacheForPath(phrenPath: string, profile?: string): { exists: boolean; sizeBytes?: number } {
  const cacheDir = ftsCacheDir(phrenPath, profile);
  try {
    const globResult = globAllFiles(phrenPath, profile);
    const hash = computePhrenHash(phrenPath, profile, globResult.filePaths);
    const cacheFile = path.join(cacheDir, `${hash}.db`);
    if (fs.existsSync(cacheFile)) {
      const stat = fs.statSync(cacheFile);
      return { exists: true, sizeBytes: stat.size };
    }
  } catch (err: unknown) {
    logger.debug("findFtsCacheForPath", errorMessage(err));
  }
  return { exists: false };
}

export function detectProject(phrenPath: string, cwd: string, profile?: string): string | null {
  const manifest = readRootManifest(phrenPath);
  if (manifest?.installMode === "project-local") {
    return manifest.primaryProject || null;
  }
  const projectDirs = getAllStoreProjectDirs(phrenPath, profile);
  // A session running inside a git worktree belongs to the repository the
  // worktree came from — its own path never matches any registered sourcePath.
  const resolvedCwd = resolveRepoRootForPath(cwd);
  let bestMatch: { project: string; length: number } | null = null;
  for (const dir of projectDirs) {
    const projectName = path.basename(dir);
    // Try the project's own store path first (handles team store projects),
    // then fall back to primary phrenPath
    const storePhrenPath = path.dirname(dir);
    const sourcePath = getProjectSourcePath(storePhrenPath, projectName)
      || getProjectSourcePath(phrenPath, projectName);
    if (!sourcePath) continue;
    const matches = resolvedCwd === sourcePath || resolvedCwd.startsWith(sourcePath + path.sep);
    if (!matches) continue;
    if (!bestMatch || sourcePath.length > bestMatch.length) {
      bestMatch = { project: projectName, length: sourcePath.length };
    }
  }
  return bestMatch?.project || null;
}
