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
} from "./shared.js";
import { getIndexPolicy, withFileLock } from "./shared-governance.js";
import { stripTaskDoneSection } from "./shared-content.js";
import { invalidateDfCache } from "./shared-search-fallback.js";
import { errorMessage } from "./utils.js";
import { extractAndLinkEntities, ensureGlobalEntitiesTable } from "./shared-entity-graph.js";
import { bootstrapSqlJs } from "./shared-sqljs.js";
import { findProjectDir } from "./project-locator.js";
import { getProjectOwnershipMode, readProjectConfig } from "./project-config.js";
import {
  buildSourceDocKey,
  queryDocRows,
  type SqlJsDatabase,
} from "./index-query.js";

export { porterStem } from "./shared-stemmer.js";
export { cosineFallback } from "./shared-search-fallback.js";
export { queryEntityLinks, getEntityBoostDocs, ensureGlobalEntitiesTable, queryCrossProjectEntities, logEntityMiss } from "./shared-entity-graph.js";
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
} from "./index-query.js";
export type { SqlValue, DbRow, DocRow, SqlJsDatabase } from "./index-query.js";

interface SqlJsStatic {
  Database: new (data?: ArrayLike<number>) => SqlJsDatabase;
}

// ── Async embedding queue ───────────────────────────────────────────────────
const _embQueue = new Map<string, { cortexPath: string; content: string }>();
let _embTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleEmbedding(cortexPath: string, docPath: string, content: string): void {
  _embQueue.set(docPath, { cortexPath, content });
  if (_embTimer) clearTimeout(_embTimer);
  _embTimer = setTimeout(() => { _embTimer = null; void _drainEmbQueue(); }, 500);
  // Unref so the timer doesn't keep short-lived CLI processes alive
  _embTimer.unref();
}

async function _drainEmbQueue(): Promise<void> {
  if (_embQueue.size === 0) return;
  const { embedText, getEmbeddingModel } = await import("./shared-ollama.js");
  const { getEmbeddingCache } = await import("./shared-embedding-cache.js");
  const entries = [..._embQueue.entries()];
  _embQueue.clear();
  // Group by cortexPath so we flush each cache once after all its entries are set.
  const byCortexPath = new Map<string, Array<{ docPath: string; content: string }>>();
  for (const [docPath, { cortexPath, content }] of entries) {
    const bucket = byCortexPath.get(cortexPath) ?? [];
    bucket.push({ docPath, content });
    byCortexPath.set(cortexPath, bucket);
  }
  for (const [cortexPath, docs] of byCortexPath) {
    const cache = getEmbeddingCache(cortexPath);
    try { await cache.load(); } catch (err: unknown) {
      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] embeddingQueue cacheLoad: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    const model = getEmbeddingModel();
    for (const { docPath, content } of docs) {
      try {
        if (cache.get(docPath, model)) continue;
        const vec = await embedText(content);
        if (vec) cache.set(docPath, getEmbeddingModel(), vec);
      } catch (err: unknown) {
        if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] embeddingQueue embedText: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
    try { await cache.flush(); } catch (err: unknown) {
      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] embeddingQueue cacheFlush: ${err instanceof Error ? err.message : String(err)}\n`);
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
  "canonical_memories.md": "canonical",
  "memory_queue.md": "memory-queue",
};

export function classifyFile(filename: string, relPath: string): string {
  // Directory takes priority over filename-based classification
  if (relPath.includes("reference/") || relPath.includes("reference\\")) return "reference";
  if (relPath.includes("skills/") || relPath.includes("skills\\")) return "skill";
  const mapped = FILE_TYPE_MAP[filename.toLowerCase()];
  if (mapped) return mapped;
  return "other";
}

const IMPORT_RE = /^@import\s+(.+)$/gm;
const MAX_IMPORT_DEPTH = 5;

/**
 * Internal recursive helper for resolveImports. Tracks `seen` (cycle detection) and `depth` (runaway
 * recursion guard) — callers should never pass these; use the public `resolveImports` instead.
 */
function _resolveImportsRecursive(
  content: string,
  cortexPath: string,
  seen: Set<string>,
  depth: number,
): string {
  if (depth >= MAX_IMPORT_DEPTH) return content;

  return content.replace(IMPORT_RE, (_match, importPath: string) => {
    const trimmed = importPath.trim();
    const globalRoot = path.resolve(cortexPath, "global");
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
      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] resolveImports realpath: ${err instanceof Error ? err.message : String(err)}\n`);
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
      return _resolveImportsRecursive(imported, cortexPath, childSeen, depth + 1);
    } catch (err: unknown) {
      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] resolveImports fileRead: ${err instanceof Error ? err.message : String(err)}\n`);
      return `<!-- @import error: ${trimmed} -->`;
    }
  });
}

/**
 * Resolve `@import shared/file.md` directives in document content.
 * The import path is resolved relative to the cortex root (e.g. `shared/foo.md` -> `~/.cortex/global/shared/foo.md`).
 * Circular imports are detected and skipped. Depth is capped to prevent runaway recursion.
 */
export function resolveImports(
  content: string,
  cortexPath: string,
): string {
  return _resolveImportsRecursive(content, cortexPath, new Set<string>(), 0);
}

function touchSentinel(cortexPath: string): void {
  const dir = path.join(cortexPath, ".runtime");
  const sentinelPath = path.join(dir, "cortex-sentinel");
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(sentinelPath, Date.now().toString());
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] touchSentinel: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

function computeCortexHash(cortexPath: string, profile?: string, preGlobbed?: string[]): string {
  const policy = getIndexPolicy(cortexPath);
  const hash = crypto.createHash("sha1");

  if (preGlobbed) {
    for (const f of preGlobbed) {
      try {
        const stat = fs.statSync(f);
        hash.update(`${f}:${stat.mtimeMs}:${stat.size}`);
      } catch (err: unknown) {
        if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] computeCortexHash skip: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  } else {
    const projectDirs = getProjectDirs(cortexPath, profile);
    const files: string[] = [];
    for (const dir of projectDirs) {
      const projectName = path.basename(dir);
      const config = readProjectConfig(cortexPath, projectName);
      const ownership = getProjectOwnershipMode(cortexPath, projectName, config);
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
          for (const entry of getRepoManagedInstructionEntries(projectName)) {
            files.push(entry.fullPath);
          }
        }
      } catch (err: unknown) {
        if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] computeCortexHash globDir: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
    files.sort();
    for (const f of files) {
      try {
        const stat = fs.statSync(f);
        hash.update(`${f}:${stat.mtimeMs}:${stat.size}`);
      } catch (err: unknown) {
        if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] computeCortexHash skip: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  }

  for (const mem of collectNativeMemoryFiles()) {
    try {
      const stat = fs.statSync(mem.fullPath);
      hash.update(`native:${mem.fullPath}:${stat.mtimeMs}:${stat.size}`);
    } catch (err: unknown) {
        if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] computeCortexHash skip: ${err instanceof Error ? err.message : String(err)}\n`);
      }
  }
  // Include global/ files (pulled via @import) so changes invalidate the cache
  const globalDir = path.join(cortexPath, "global");
  if (fs.existsSync(globalDir)) {
    const globalFiles = globSync("**/*.md", { cwd: globalDir, nodir: true }).sort();
    for (const f of globalFiles) {
      try {
        const fp = path.join(globalDir, f);
        const stat = fs.statSync(fp);
        hash.update(`global:${f}:${stat.mtimeMs}:${stat.size}`);
      } catch (err: unknown) {
        if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] computeCortexHash skip: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  }
  // Include manual entity links so graph changes invalidate the cache
  const manualLinksPath = runtimeFile(cortexPath, "manual-links.json");
  if (fs.existsSync(manualLinksPath)) {
    try {
      const stat = fs.statSync(manualLinksPath);
      hash.update(`manual-links:${stat.mtimeMs}:${stat.size}`);
    } catch (err: unknown) {
        if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] computeCortexHash skip: ${err instanceof Error ? err.message : String(err)}\n`);
      }
  }
  const indexPolicyPath = path.join(cortexPath, ".governance", "index-policy.json");
  if (fs.existsSync(indexPolicyPath)) {
    try {
      const stat = fs.statSync(indexPolicyPath);
      hash.update(`index-policy-file:${stat.mtimeMs}:${stat.size}`);
    } catch (err: unknown) {
        if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] computeCortexHash skip: ${err instanceof Error ? err.message : String(err)}\n`);
      }
  }
  if (profile) hash.update(`profile:${profile}`);
  hash.update(`index-policy:${JSON.stringify(policy)}`);
  return hash.digest("hex").slice(0, 16);
}

const INDEX_HASHES_FILENAME = "index-hashes.json";
const INDEX_SCHEMA_VERSION = 3; // bump when FTS schema changes to force full rebuild

function hashFileContent(filePath: string): string {
  const content = fs.readFileSync(filePath, "utf-8");
  return crypto.createHash("sha256").update(content).digest("hex");
}

function loadHashMap(cortexPath: string): { version?: number; hashes: Record<string, string> } {
  const runtimeDir = path.join(cortexPath, ".runtime");
  const hashFile = path.join(runtimeDir, INDEX_HASHES_FILENAME);
  try {
    if (fs.existsSync(hashFile)) {
      return JSON.parse(fs.readFileSync(hashFile, "utf-8"));
    }
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] loadHashMap: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  return { hashes: {} };
}

function saveHashMap(cortexPath: string, hashes: Record<string, string>): void {
  const runtimeDir = path.join(cortexPath, ".runtime");
  try {
    fs.mkdirSync(runtimeDir, { recursive: true });
    const hashFile = path.join(runtimeDir, INDEX_HASHES_FILENAME);
    withFileLock(hashFile, () => {
      // Read-merge-write: load existing hashes, merge new values (new wins), then write.
      // Prune entries for files that no longer exist to prevent ghost paths from causing
      // repeated full rebuilds when deleted files are found in the hash map.
      let existing: Record<string, string> = {};
      try {
        const data = JSON.parse(fs.readFileSync(hashFile, "utf-8"));
        if (data.hashes && typeof data.hashes === "object") existing = data.hashes;
      } catch (err: unknown) {
        if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] saveHashMap readExisting: ${err instanceof Error ? err.message : String(err)}\n`);
      }
      const merged = { ...existing, ...hashes };
      // Remove entries for paths that no longer exist on disk
      for (const filePath of Object.keys(merged)) {
        if (!fs.existsSync(filePath)) {
          delete merged[filePath];
        }
      }
      fs.writeFileSync(
        hashFile,
        JSON.stringify({ version: INDEX_SCHEMA_VERSION, hashes: merged }, null, 2)
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

function normalizeDocSegment(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

function getEntrySourceDocKey(entry: FileEntry, cortexPath: string): string {
  if (entry.relFile) {
    return `${normalizeDocSegment(entry.project)}/${normalizeDocSegment(entry.relFile)}`;
  }
  return buildSourceDocKey(entry.project, entry.fullPath, cortexPath, entry.filename);
}

function getRepoManagedInstructionEntries(project: string): FileEntry[] {
  const repoDir = findProjectDir(project);
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

function globAllFiles(cortexPath: string, profile?: string): { filePaths: string[]; entries: FileEntry[] } {
  const projectDirs = getProjectDirs(cortexPath, profile);
  const indexPolicy = getIndexPolicy(cortexPath);
  const entries: FileEntry[] = [];
  const allAbsolutePaths: string[] = [];

  for (const dir of projectDirs) {
    const projectName = path.basename(dir);
    const config = readProjectConfig(cortexPath, projectName);
    const ownership = getProjectOwnershipMode(cortexPath, projectName, config);
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
      for (const entry of getRepoManagedInstructionEntries(projectName)) {
        entries.push(entry);
        allAbsolutePaths.push(entry.fullPath);
      }
    }
  }

  // Index global skills so search_knowledge can find them
  const globalSkillsDir = path.join(cortexPath, "global", "skills");
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

export function listIndexedDocumentPaths(cortexPath: string, profile?: string): string[] {
  return globAllFiles(cortexPath, profile).filePaths;
}

export function normalizeIndexedContent(content: string, type: string, cortexPath: string, maxChars?: number): string {
  let normalized = content
    .replace(/<!-- cortex:archive:start -->[\s\S]*?<!-- cortex:archive:end -->/g, "")
    .replace(/<details>[\s\S]*?<\/details>/gi, "")
    .replace(/<!--\s*created:\s*.*?-->/g, "")
    .replace(/<!--\s*source:\s*.*?-->/g, "")
    .replace(/<!--\s*cortex:cite\s+\{[\s\S]*?\}\s*-->/g, "");
  normalized = resolveImports(normalized, cortexPath);
  if (type === "task") {
    normalized = stripTaskDoneSection(normalized);
  }
  if (typeof maxChars === "number" && maxChars >= 0) {
    normalized = normalized.slice(0, maxChars);
  }
  return normalized;
}

function insertFileIntoIndex(
  db: SqlJsDatabase,
  entry: FileEntry,
  cortexPath: string,
  opts?: { scheduleEmbeddings?: boolean }
): boolean {
  try {
    const raw = fs.readFileSync(entry.fullPath, "utf-8");
    const content = normalizeIndexedContent(raw, entry.type, cortexPath);
    db.run(
      "INSERT INTO docs (project, filename, type, content, path) VALUES (?, ?, ?, ?, ?)",
      [entry.project, entry.filename, entry.type, content, entry.fullPath]
    );
    if (opts?.scheduleEmbeddings) {
      scheduleEmbedding(cortexPath, entry.fullPath, content.slice(0, 8000));
    }
    return true;
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] insertFileIntoIndex: ${err instanceof Error ? err.message : String(err)}\n`);
    return false;
  }
}

function deleteEntityLinksForDocPath(db: SqlJsDatabase, cortexPath: string, docPath: string, fallbackProject?: string, fallbackFilename?: string): void {
  const docRows = queryDocRows(db, "SELECT project, filename, type, content, path FROM docs WHERE path = ? LIMIT 1", [docPath]);
  const project = docRows?.[0]?.project ?? fallbackProject;
  if (!project) return;
  const filename = docRows?.[0]?.filename ?? fallbackFilename;
  const sourceDoc = buildSourceDocKey(project, docPath, cortexPath, filename);
  db.run("DELETE FROM entity_links WHERE source_doc = ?", [sourceDoc]);
  // Q19: also purge global_entities rows for this doc so cross_project_entities
  // never returns deleted/stale documents.
  try {
    db.run("DELETE FROM global_entities WHERE doc_key = ?", [sourceDoc]);
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] deleteEntityLinksForDocPath globalEntities: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

/**
 * Incrementally update a single file in the FTS index.
 * Deletes the old record for the file, re-reads and re-inserts it.
 * Touches the sentinel file to invalidate caches.
 */
export function updateFileInIndex(db: SqlJsDatabase, filePath: string, cortexPath: string): void {
  const resolvedPath = path.resolve(filePath);

  // Delete old record
  try { deleteEntityLinksForDocPath(db, cortexPath, resolvedPath); } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] updateFileInIndex deleteEntityLinks: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  try { db.run("DELETE FROM docs WHERE path = ?", [resolvedPath]); } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] updateFileInIndex deleteDocs: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  // Re-insert if file still exists
  if (fs.existsSync(resolvedPath)) {
    const filename = path.basename(resolvedPath);
    // Determine project from path: the file should be under cortexPath/<project>/
    const rel = path.relative(path.resolve(cortexPath), resolvedPath);
    const project = rel.split(path.sep)[0];
    const relFile = rel.split(path.sep).slice(1).join(path.sep);
    const type = classifyFile(filename, relFile);
    const entry: FileEntry = { fullPath: resolvedPath, project, filename, type, relFile };
    if (insertFileIntoIndex(db, entry, cortexPath, { scheduleEmbeddings: true })) {
      // Re-extract entities for finding files
      if (type === "findings") {
        try {
          const content = fs.readFileSync(resolvedPath, "utf-8");
          extractAndLinkEntities(db, content, getEntrySourceDocKey(entry, cortexPath), cortexPath);
        } catch (err: unknown) {
          if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] updateFileInIndex entityExtraction: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }
    }

    // Update hash map for this file
    try {
      const hashData = loadHashMap(cortexPath);
      hashData.hashes[resolvedPath] = hashFileContent(resolvedPath);
      saveHashMap(cortexPath, hashData.hashes);
    } catch (err: unknown) {
      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] updateFileInIndex hashMap: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  } else {
    // Remove stale embedding if file was deleted
    void (async () => {
      try {
        const { getEmbeddingCache } = await import("./shared-embedding-cache.js");
        const c = getEmbeddingCache(cortexPath);
        c.delete(resolvedPath);
        await c.flush();
      } catch (err: unknown) {
        if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] updateFileInIndex embeddingDelete: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    })();
  }

  touchSentinel(cortexPath);
  invalidateDfCache();
}

/** Read/write a sentinel that caches the cortex hash to skip full recomputation. */
function readHashSentinel(cortexPath: string): { hash: string; computedAt: number } | null {
  try {
    const sentinelPath = runtimeFile(cortexPath, "index-sentinel.json");
    if (!fs.existsSync(sentinelPath)) return null;
    const data = JSON.parse(fs.readFileSync(sentinelPath, "utf-8")) as { hash?: string; computedAt?: number };
    if (typeof data.hash === "string" && typeof data.computedAt === "number") {
      return { hash: data.hash, computedAt: data.computedAt };
    }
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] readHashSentinel: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  return null;
}

function writeHashSentinel(cortexPath: string, hash: string): void {
  try {
    const sentinelPath = runtimeFile(cortexPath, "index-sentinel.json");
    fs.writeFileSync(sentinelPath, JSON.stringify({ hash, computedAt: Date.now() }));
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] writeHashSentinel: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

function isSentinelFresh(cortexPath: string, sentinel: { computedAt: number }): boolean {
  // Check mtime of key directories — if any are newer than the sentinel, it's stale
  const dirsToCheck = [
    cortexPath,
    path.join(cortexPath, ".governance"),
    path.join(cortexPath, ".runtime"),
  ];
  for (const dir of dirsToCheck) {
    try {
      const stat = fs.statSync(dir);
      if (stat.mtimeMs > sentinel.computedAt) return false;
    } catch (err: unknown) {
      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] isSentinelFresh statDir: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  return true;
}

/**
 * Attempt to restore the entity graph (entities, entity_links, global_entities) from a
 * previously persisted JSON snapshot. Returns true if the graph was loaded, false if the
 * caller must run full extraction instead.
 */
function loadCachedEntityGraph(db: SqlJsDatabase, graphPath: string, allFiles: FileEntry[], cortexPath: string): boolean {
  if (!fs.existsSync(graphPath)) return false;
  try {
    const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
    const graphMtime = fs.statSync(graphPath).mtimeMs;
    const anyNewer = allFiles.some(f => {
      try { return fs.statSync(f.fullPath).mtimeMs > graphMtime; } catch (err: unknown) {
        if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] loadCachedEntityGraph statFile: ${err instanceof Error ? err.message : String(err)}\n`);
        return true;
      }
    });
    if (!anyNewer && graph.entities && graph.links) {
      // Build set of valid source doc keys from current file set
      const validDocKeys = new Set(allFiles.map(f => getEntrySourceDocKey(f, cortexPath)));

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
          // Skip global entities whose source doc no longer exists
          if (docKey && !validDocKeys.has(docKey)) continue;
          try {
            db.run(
              "INSERT OR IGNORE INTO global_entities (entity, project, doc_key) VALUES (?, ?, ?)",
              [entity, project, docKey]
            );
          } catch (err: unknown) {
            if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] loadCachedEntityGraph globalEntitiesInsert2: ${err instanceof Error ? err.message : String(err)}\n`);
          }
        }
      } else {
        // Older cache without globalEntities: re-derive from entity_links + entities
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
            if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] loadCachedEntityGraph globalEntitiesInsert: ${err instanceof Error ? err.message : String(err)}\n`);
          }
            }
          }
        } catch (err: unknown) {
          if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] entityGraph globalEntitiesRestore: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }
      return true;
    }
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] entityGraph cacheLoad: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  return false;
}

/** Merge manual entity links (written by link_findings tool) into the live DB. Always runs on
 * every build so hand-authored links survive a full index rebuild. */
function mergeManualLinks(db: SqlJsDatabase, cortexPath: string): void {
  const manualLinksPath = runtimeFile(cortexPath, 'manual-links.json');
  if (!fs.existsSync(manualLinksPath)) return;
  try {
    const manualLinks: Array<{ entity: string; entityType: string; sourceDoc: string; relType: string }> =
      JSON.parse(fs.readFileSync(manualLinksPath, 'utf8'));
    for (const link of manualLinks) {
      try {
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
            if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] manualLinks globalEntities: ${err instanceof Error ? err.message : String(err)}\n`);
          }
        }
      } catch (err: unknown) {
        if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] manualLinks entry: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] mergeManualLinks: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

async function buildIndexImpl(cortexPath: string, profile?: string): Promise<SqlJsDatabase> {
  const t0 = Date.now();

  // ── Cache dir + hash sentinel ─────────────────────────────────────────────
  let userSuffix: string;
  try {
    userSuffix = String(os.userInfo().uid);
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] buildIndexImpl userInfo: ${err instanceof Error ? err.message : String(err)}\n`);
    userSuffix = crypto.createHash("sha1").update(homeDir()).digest("hex").slice(0, 12);
  }
  const cacheDir = path.join(os.tmpdir(), `cortex-fts-${userSuffix}`);

  // Fast path: if the sentinel is fresh, skip the expensive glob + hash computation
  const sentinel = readHashSentinel(cortexPath);
  let hash: string;
  let globResult: { filePaths: string[]; entries: FileEntry[] };
  if (sentinel && isSentinelFresh(cortexPath, sentinel)) {
    hash = sentinel.hash;
    const cacheFile = path.join(cacheDir, `${hash}.db`);
    if (fs.existsSync(cacheFile)) {
      // Sentinel cache hit — defer full glob until we actually need it
      globResult = globAllFiles(cortexPath, profile);
    } else {
      // Cache file was cleaned up, fall through to full computation
      globResult = globAllFiles(cortexPath, profile);
      hash = computeCortexHash(cortexPath, profile, globResult.filePaths);
      writeHashSentinel(cortexPath, hash);
    }
  } else {
    globResult = globAllFiles(cortexPath, profile);
    hash = computeCortexHash(cortexPath, profile, globResult.filePaths);
    writeHashSentinel(cortexPath, hash);
  }
  const cacheFile = path.join(cacheDir, `${hash}.db`);

  const SQL = await bootstrapSqlJs() as SqlJsStatic;

  // ── Incremental update (cache hit path) ───────────────────────────────────
  // Load saved per-file hashes for incremental updates
  const savedHashData = loadHashMap(cortexPath);
  const savedHashes = savedHashData.hashes;
  const schemaChanged = savedHashData.version !== INDEX_SCHEMA_VERSION;

  // Try loading cached DB for incremental update
  if (!schemaChanged && fs.existsSync(cacheFile)) {
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
        try { db.run("ALTER TABLE entities ADD COLUMN first_seen_at TEXT"); } catch { /* column already exists — expected */ }

        // Compute current file hashes and determine what changed
        const allFiles = globResult.entries;
        const currentHashes: Record<string, string> = {};
        const changedFiles: FileEntry[] = [];
        const newFiles: FileEntry[] = [];

        for (const entry of allFiles) {
          try {
            const fileHash = hashFileContent(entry.fullPath);
            currentHashes[entry.fullPath] = fileHash;
            if (!(entry.fullPath in savedHashes)) {
              newFiles.push(entry);
            } else if (savedHashes[entry.fullPath] !== fileHash) {
              changedFiles.push(entry);
            }
          } catch (err: unknown) {
            if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] buildIndex hashFile: ${err instanceof Error ? err.message : String(err)}\n`);
          }
        }

        // Check for files missing from the index (deleted files)
        const currentPaths = new Set(Object.keys(currentHashes));
        const missingFromIndex = Object.keys(savedHashes).filter(p => !currentPaths.has(p));

        // Force full rebuild if >20% of saved files are missing
        const totalSaved = Object.keys(savedHashes).length;
        if (totalSaved > 0 && missingFromIndex.length / totalSaved > 0.2) {
          debugLog(`>20% files missing (${missingFromIndex.length}/${totalSaved}), forcing full rebuild`);
          // Fall through to full rebuild below
        } else if (changedFiles.length === 0 && newFiles.length === 0 && missingFromIndex.length === 0) {
          // Nothing changed, pure cache hit
          debugLog(`Loaded FTS index from cache (${hash.slice(0, 8)}) in ${Date.now() - t0}ms`);
          appendIndexEvent(cortexPath, {
            event: "build_index",
            cache: "hit",
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
              try { deleteEntityLinksForDocPath(db, cortexPath, missingPath); } catch (err: unknown) {
                if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] buildIndex deleteEntityLinksForMissing: ${err instanceof Error ? err.message : String(err)}\n`);
              }
              try { db.run("DELETE FROM docs WHERE path = ?", [missingPath]); } catch (err: unknown) {
                if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] buildIndex deleteDocForMissing: ${err instanceof Error ? err.message : String(err)}\n`);
              }
            }
            db.run("COMMIT");
          } catch (err: unknown) {
            if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] buildIndex incrementalDeleteCommit: ${err instanceof Error ? err.message : String(err)}\n`);
            try { db.run("ROLLBACK"); } catch (e2: unknown) {
              if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] buildIndex incrementalDeleteRollback: ${e2 instanceof Error ? e2.message : String(e2)}\n`);
            }
          }

          let updatedCount = 0;
          for (const entry of [...changedFiles, ...newFiles]) {
            db.run("BEGIN");
            try {
              if (changedPaths.has(entry.fullPath)) {
                const sourceDocKey = getEntrySourceDocKey(entry, cortexPath);
                db.run("DELETE FROM entity_links WHERE source_doc = ?", [sourceDocKey]);
                // Q19: keep global_entities in sync with entity_links on updates
                try { db.run("DELETE FROM global_entities WHERE doc_key = ?", [sourceDocKey]); } catch { /* table may not exist in older cached DBs */ }
                db.run("DELETE FROM docs WHERE path = ?", [entry.fullPath]);
              }

              if (insertFileIntoIndex(db, entry, cortexPath, { scheduleEmbeddings: true })) {
                updatedCount++;
                if (entry.type === "findings") {
                  try {
                    const content = fs.readFileSync(entry.fullPath, "utf-8");
                    extractAndLinkEntities(db, content, getEntrySourceDocKey(entry, cortexPath), cortexPath);
                  } catch (err: unknown) { debugLog(`entity extraction failed: ${errorMessage(err)}`); }
                }
              }

              db.run("COMMIT");
            } catch (err: unknown) {
              try { db.run("ROLLBACK"); } catch (e2: unknown) {
                if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] buildIndex perFileRollback: ${e2 instanceof Error ? e2.message : String(e2)}\n`);
              }
              throw err;
            }
          }

          saveHashMap(cortexPath, currentHashes);
          touchSentinel(cortexPath);
          invalidateDfCache();

          // Save updated cache
          try {
            fs.mkdirSync(cacheDir, { recursive: true });
            fs.writeFileSync(cacheFile, db.export());
          } catch (err: unknown) {
            if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] buildIndex incrementalCacheSave: ${err instanceof Error ? err.message : String(err)}\n`);
          }

          const incMs = Date.now() - t0;
          debugLog(`Incremental FTS update: ${updatedCount} changed, ${missingFromIndex.length} removed in ${incMs}ms`);
          appendIndexEvent(cortexPath, {
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
  const db = new SQL.Database();
  db.run(`
    CREATE VIRTUAL TABLE docs USING fts5(
      project, filename, type, content, path,
      tokenize = "porter unicode61"
    );
  `);

  // Entity graph tables for lightweight reference graph
  db.run(`CREATE TABLE IF NOT EXISTS entities (id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, first_seen_at TEXT, UNIQUE(name, type))`);
  db.run(`CREATE TABLE IF NOT EXISTS entity_links (source_id INTEGER REFERENCES entities(id), target_id INTEGER REFERENCES entities(id), rel_type TEXT NOT NULL, source_doc TEXT, PRIMARY KEY (source_id, target_id, rel_type))`);
  // Q20: Cross-project entity index
  ensureGlobalEntitiesTable(db);

  const allFiles = globResult.entries;
  const newHashes: Record<string, string> = {};
  let fileCount = 0;

  // Try loading cached entity graph
  const graphPath = runtimeFile(cortexPath, 'entity-graph.json');
  const entityGraphLoaded = loadCachedEntityGraph(db, graphPath, allFiles, cortexPath);

  for (const entry of allFiles) {
    try {
      newHashes[entry.fullPath] = hashFileContent(entry.fullPath);
    } catch (err: unknown) {
        if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] computeCortexHash skip: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    if (insertFileIntoIndex(db, entry, cortexPath, { scheduleEmbeddings: true })) {
      fileCount++;
      // Extract entities from finding files (if not loaded from cache)
      if (!entityGraphLoaded && entry.type === "findings") {
        try {
          const content = fs.readFileSync(entry.fullPath, "utf-8");
          extractAndLinkEntities(db, content, getEntrySourceDocKey(entry, cortexPath), cortexPath);
        } catch (err: unknown) { debugLog(`entity extraction failed: ${errorMessage(err)}`); }
      }
    }
  }

  // Persist entity graph for next build
  if (!entityGraphLoaded) {
    try {
      const entityRows = db.exec("SELECT id, name, type FROM entities")[0]?.values ?? [];
      const linkRows = db.exec("SELECT source_id, target_id, rel_type, source_doc FROM entity_links")[0]?.values ?? [];
      // Q19: also persist global_entities so the cached-graph rebuild path can
      // restore it without re-running extraction on every file.
      const globalEntityRows = db.exec("SELECT entity, project, doc_key FROM global_entities")[0]?.values ?? [];
      fs.writeFileSync(graphPath, JSON.stringify({ entities: entityRows, links: linkRows, globalEntities: globalEntityRows, ts: Date.now() }));
    } catch (err: unknown) {
      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] buildIndex entityGraphPersist: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  // Always merge manual links (survive rebuild)
  mergeManualLinks(db, cortexPath);

  // ── Finalize: persist hashes, save cache, log ─────────────────────────────
  saveHashMap(cortexPath, newHashes);
  touchSentinel(cortexPath);
  invalidateDfCache();

  const buildMs = Date.now() - t0;
  debugLog(`Built FTS index: ${fileCount} files from ${getProjectDirs(cortexPath, profile).length} projects in ${buildMs}ms`);
  if (process.env.CORTEX_DEBUG) console.error(`Indexed ${fileCount} files from ${getProjectDirs(cortexPath, profile).length} projects`);
  appendIndexEvent(cortexPath, {
    event: "build_index",
    cache: "miss",
    hash: hash.slice(0, 12),
    files: fileCount,
    projects: getProjectDirs(cortexPath, profile).length,
    elapsedMs: buildMs,
    profile: profile || "",
  });

  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cacheFile, db.export());
    for (const f of fs.readdirSync(cacheDir)) {
      if (!f.endsWith(".db") || f === `${hash}.db`) continue;
      try { fs.unlinkSync(path.join(cacheDir, f)); } catch (err: unknown) {
        if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] buildIndex staleCacheCleanup: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
    debugLog(`Saved FTS index cache (${hash.slice(0, 8)}) — total ${Date.now() - t0}ms`);
  } catch (err: unknown) {
    debugLog(`Failed to save FTS index cache: ${errorMessage(err)}`);
  }

  return db;
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

function isRebuildLockHeld(cortexPath: string): boolean {
  const lockTarget = runtimeFile(cortexPath, "index-rebuild");
  const lockPath = lockTarget + ".lock";
  try {
    const stat = fs.statSync(lockPath);
    const staleThreshold = Number.parseInt(process.env.CORTEX_FILE_LOCK_STALE_MS || "30000", 10) || 30000;
    return Date.now() - stat.mtimeMs <= staleThreshold;
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] isRebuildLockHeld stat: ${err instanceof Error ? err.message : String(err)}\n`);
    return false;
  }
}

async function loadIndexSnapshotOrEmpty(cortexPath: string, profile?: string): Promise<SqlJsDatabase> {
  const SQL = await bootstrapSqlJs() as SqlJsStatic;
  let userSuffix: string;
  try {
    userSuffix = String(os.userInfo().uid);
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] loadIndexSnapshotOrEmpty userInfo: ${err instanceof Error ? err.message : String(err)}\n`);
    userSuffix = crypto.createHash("sha1").update(homeDir()).digest("hex").slice(0, 12);
  }
  const cacheDir = path.join(os.tmpdir(), `cortex-fts-${userSuffix}`);
  const globResult = globAllFiles(cortexPath, profile);
  const hash = computeCortexHash(cortexPath, profile, globResult.filePaths);
  const cacheFile = path.join(cacheDir, `${hash}.db`);

  if (fs.existsSync(cacheFile)) {
    try {
      return new SQL.Database(fs.readFileSync(cacheFile));
    } catch (err: unknown) {
      debugLog(`Failed to open cached FTS snapshot while rebuild lock held: ${errorMessage(err)}`);
    }
  }

  debugLog("FTS rebuild already in progress; returning empty snapshot");
  return createEmptyIndexDb(SQL);
}

// Serialize concurrent in-process buildIndex calls to prevent SQLite corruption
let buildLock: Promise<SqlJsDatabase> = Promise.resolve(null as unknown as SqlJsDatabase);

export async function buildIndex(cortexPath: string, profile?: string): Promise<SqlJsDatabase> {
  const result = buildLock.then(() => _buildIndexGuarded(cortexPath, profile));
  // Update the lock chain; swallow rejections so the chain doesn't stall
  buildLock = result.catch(() => null as unknown as SqlJsDatabase);
  return result;
}

async function _buildIndexGuarded(cortexPath: string, profile?: string): Promise<SqlJsDatabase> {
  const lockTarget = runtimeFile(cortexPath, "index-rebuild");
  if (isRebuildLockHeld(cortexPath)) {
    return loadIndexSnapshotOrEmpty(cortexPath, profile);
  }

  try {
    return await withFileLock(lockTarget, async () => {
      let timer: ReturnType<typeof setTimeout>;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("buildIndex timed out after 30s")), 30000);
      });
      try {
        return await Promise.race([buildIndexImpl(cortexPath, profile), timeout]);
      } finally {
        clearTimeout(timer!);
      }
    });
  } catch (err: unknown) {
    const message = errorMessage(err);
    if (message.includes("could not acquire lock")) {
      debugLog(`FTS rebuild skipped because another process holds the rebuild lock: ${message}`);
      return loadIndexSnapshotOrEmpty(cortexPath, profile);
    }
    throw err;
  }
}

/** Find the FTS cache file for a specific cortexPath+profile. Returns exists + size. */
export function findFtsCacheForPath(cortexPath: string, profile?: string): { exists: boolean; sizeBytes?: number } {
  let userSuffix: string;
  try {
    userSuffix = String(os.userInfo().uid);
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] findFtsCacheForPath userInfo: ${err instanceof Error ? err.message : String(err)}\n`);
    userSuffix = crypto.createHash("sha1").update(homeDir()).digest("hex").slice(0, 12);
  }
  const cacheDir = path.join(os.tmpdir(), `cortex-fts-${userSuffix}`);
  try {
    const globResult = globAllFiles(cortexPath, profile);
    const hash = computeCortexHash(cortexPath, profile, globResult.filePaths);
    const cacheFile = path.join(cacheDir, `${hash}.db`);
    if (fs.existsSync(cacheFile)) {
      const stat = fs.statSync(cacheFile);
      return { exists: true, sizeBytes: stat.size };
    }
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] findFtsCacheForPath: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  return { exists: false };
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
