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
  runtimeFile,
} from "./shared.js";
import { getIndexPolicy, withFileLock } from "./shared-governance.js";
import { stripBacklogDoneSection } from "./shared-content.js";
import { cosineFallback, COSINE_CANDIDATE_CAP, invalidateDfCache } from "./shared-search-fallback.js";
import { extractAndLinkEntities, queryEntityLinks, getEntityBoostDocs, ensureGlobalEntitiesTable, queryCrossProjectEntities } from "./shared-entity-graph.js";

// Re-export for backward compatibility
export { porterStem } from "./shared-stemmer.js";
export { cosineFallback, COSINE_CANDIDATE_CAP } from "./shared-search-fallback.js";
export { extractAndLinkEntities, queryEntityLinks, getEntityBoostDocs, ensureGlobalEntitiesTable, queryCrossProjectEntities } from "./shared-entity-graph.js";

export type SqlValue = string | number | null | Uint8Array;
export type DbRow = SqlValue[];

export interface SqlJsDatabase {
  run(sql: string, params?: SqlValue[]): void;
  exec(sql: string, params?: SqlValue[]): { columns: string[]; values: DbRow[] }[];
  export(): Uint8Array;
  close(): void;
}

interface SqlJsStatic {
  Database: new (data?: ArrayLike<number>) => SqlJsDatabase;
}

const require = createRequire(import.meta.url);
const initSqlJs = require("sql.js-fts5") as (config?: Record<string, unknown>) => Promise<SqlJsStatic>;

// ── Async embedding queue ───────────────────────────────────────────────────
const _embQueue = new Map<string, { cortexPath: string; content: string }>();
let _embTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleEmbedding(cortexPath: string, docPath: string, content: string): void {
  _embQueue.set(docPath, { cortexPath, content });
  if (_embTimer) clearTimeout(_embTimer);
  _embTimer = setTimeout(() => { _embTimer = null; void _drainEmbQueue(); }, 500);
}

async function _drainEmbQueue(): Promise<void> {
  if (_embQueue.size === 0) return;
  const { embedText, getEmbeddingModel } = await import("./shared-ollama.js");
  const { getEmbeddingCache } = await import("./shared-embedding-cache.js");
  const entries = [..._embQueue.entries()];
  _embQueue.clear();
  for (const [docPath, { cortexPath, content }] of entries) {
    try {
      const vec = await embedText(content);
      if (vec) {
        const cache = getEmbeddingCache(cortexPath);
        cache.set(docPath, getEmbeddingModel(), vec);
        await cache.flush();
      }
    } catch { /* best-effort */ }
  }
}

const FILE_TYPE_MAP: Record<string, string> = {
  "claude.md": "claude",
  "summary.md": "summary",
  "findings.md": "findings",
  "learnings.md": "findings",
  "reference.md": "reference",
  "backlog.md": "backlog",
  "changelog.md": "changelog",
  "canonical_memories.md": "canonical",
  "memory_queue.md": "memory-queue",
};

export function classifyFile(filename: string, relPath: string): string {
  // Directory takes priority over filename-based classification
  if (relPath.includes("reference/") || relPath.includes("reference\\")) return "reference";
  if (relPath.includes("knowledge/") || relPath.includes("knowledge\\")) return "reference";
  if (relPath.includes("skills/") || relPath.includes("skills\\")) return "skill";
  const mapped = FILE_TYPE_MAP[filename.toLowerCase()];
  if (mapped) return mapped;
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
    // Use lexical resolution first for the prefix check
    const lexical = path.resolve(resolved);

    if (!lexical.startsWith(path.resolve(cortexPath, "global") + path.sep)) {
      return `<!-- @import blocked: path traversal -->`;
    }

    // Dereference symlinks before the prefix check to prevent symlink traversal attacks
    // (e.g. global/evil -> /etc/passwd would pass the lexical check but fail here).
    let normalized: string;
    try {
      normalized = fs.realpathSync.native(resolved);
    } catch {
      return `<!-- @import not found: ${trimmed} -->`;
    }

    if (!normalized.startsWith(path.resolve(cortexPath, "global") + path.sep)) {
      return `<!-- @import blocked: symlink traversal -->`;
    }

    if (currentSeen.has(normalized)) {
      return `<!-- @import cycle: ${trimmed} -->`;
    }

    try {
      const childSeen = new Set(currentSeen);
      childSeen.add(normalized);
      const imported = fs.readFileSync(normalized, "utf-8");
      return resolveImports(imported, cortexPath, childSeen, currentDepth + 1);
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

function touchSentinel(cortexPath: string): void {
  const dir = path.join(cortexPath, ".runtime");
  const sentinelPath = path.join(dir, "cortex-sentinel");
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(sentinelPath, Date.now().toString());
  } catch { /* best-effort */ }
}

function computeCortexHash(cortexPath: string, profile?: string, preGlobbed?: string[]): string {
  const policy = getIndexPolicy(cortexPath);
  const hash = crypto.createHash("sha1");

  if (preGlobbed) {
    for (const f of preGlobbed) {
      try {
        const stat = fs.statSync(f);
        hash.update(`${f}:${stat.mtimeMs}:${stat.size}`);
      } catch { /* skip */ }
    }
  } else {
    const projectDirs = getProjectDirs(cortexPath, profile);
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
    for (const f of files) {
      try {
        const stat = fs.statSync(f);
        hash.update(`${f}:${stat.mtimeMs}:${stat.size}`);
      } catch { /* skip */ }
    }
  }

  for (const mem of collectNativeMemoryFiles()) {
    try {
      const stat = fs.statSync(mem.fullPath);
      hash.update(`native:${mem.fullPath}:${stat.mtimeMs}:${stat.size}`);
    } catch { /* skip */ }
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
      } catch { /* skip */ }
    }
  }
  // Include manual entity links so graph changes invalidate the cache
  const manualLinksPath = runtimeFile(cortexPath, "manual-links.json");
  if (fs.existsSync(manualLinksPath)) {
    try {
      const stat = fs.statSync(manualLinksPath);
      hash.update(`manual-links:${stat.mtimeMs}:${stat.size}`);
    } catch { /* skip */ }
  }
  const indexPolicyPath = path.join(cortexPath, ".governance", "index-policy.json");
  if (fs.existsSync(indexPolicyPath)) {
    try {
      const stat = fs.statSync(indexPolicyPath);
      hash.update(`index-policy-file:${stat.mtimeMs}:${stat.size}`);
    } catch { /* skip */ }
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
  } catch { /* corrupt file, treat as empty */ }
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
      } catch { /* file missing or corrupt — treat as empty */ }
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
  } catch {
    debugLog("Failed to save index hash map");
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

function getProjectRoot(cortexPath: string, project: string): string {
  return path.join(path.resolve(cortexPath), project);
}

export function buildSourceDocKey(project: string, docPath: string, cortexPath: string, fallbackFilename?: string): string {
  const normalizedProject = normalizeDocSegment(project);
  const normalizedDocPath = path.resolve(docPath);
  const projectRoot = getProjectRoot(cortexPath, project);
  if (normalizedDocPath.startsWith(projectRoot + path.sep) || normalizedDocPath === projectRoot) {
    const relPath = normalizeDocSegment(path.relative(projectRoot, normalizedDocPath));
    if (relPath) return `${normalizedProject}/${relPath}`;
  }
  const fallback = fallbackFilename ?? path.basename(docPath);
  return `${normalizedProject}/${normalizeDocSegment(fallback)}`;
}

function getEntrySourceDocKey(entry: FileEntry, cortexPath: string): string {
  if (entry.relFile) {
    return `${normalizeDocSegment(entry.project)}/${normalizeDocSegment(entry.relFile)}`;
  }
  return buildSourceDocKey(entry.project, entry.fullPath, cortexPath, entry.filename);
}

function globAllFiles(cortexPath: string, profile?: string): { filePaths: string[]; entries: FileEntry[] } {
  const projectDirs = getProjectDirs(cortexPath, profile);
  const indexPolicy = getIndexPolicy(cortexPath);
  const entries: FileEntry[] = [];
  const allAbsolutePaths: string[] = [];

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
    const relFiles = [...mdFilesSet].sort();
    // Q1: if both LEARNINGS.md (legacy) and FINDINGS.md (canonical) exist, skip LEARNINGS.md
    const hasFindingsMd = relFiles.some(f => path.basename(f).toLowerCase() === "findings.md");
    for (const relFile of relFiles) {
      const filename = path.basename(relFile);
      if (hasFindingsMd && filename.toLowerCase() === "learnings.md") continue;
      const fullPath = path.join(dir, relFile);
      const type = classifyFile(filename, relFile);
      entries.push({ fullPath, project: projectName, filename, type, relFile });
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

function collectAllFiles(cortexPath: string, profile?: string): FileEntry[] {
  return globAllFiles(cortexPath, profile).entries;
}

function insertFileIntoIndex(db: SqlJsDatabase, entry: FileEntry, cortexPath: string): boolean {
  try {
    const raw = fs.readFileSync(entry.fullPath, "utf-8");
    let content = raw
      .replace(/<!-- cortex:archive:start -->[\s\S]*?<!-- cortex:archive:end -->/g, "")
      .replace(/<details>[\s\S]*?<\/details>/gi, "");
    content = resolveImports(content, cortexPath);
    if (entry.type === "backlog") {
      content = stripBacklogDoneSection(content);
    }
    db.run(
      "INSERT INTO docs (project, filename, type, content, path) VALUES (?, ?, ?, ?, ?)",
      [entry.project, entry.filename, entry.type, content, entry.fullPath]
    );
    return true;
  } catch {
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
  } catch { /* global_entities table may not exist in older cached DBs */ }
}

/**
 * Incrementally update a single file in the FTS index.
 * Deletes the old record for the file, re-reads and re-inserts it.
 * Touches the sentinel file to invalidate caches.
 */
export function updateFileInIndex(db: SqlJsDatabase, filePath: string, cortexPath: string): void {
  const resolvedPath = path.resolve(filePath);

  // Delete old record
  try { deleteEntityLinksForDocPath(db, cortexPath, resolvedPath); } catch { /* ignore */ }
  try { db.run("DELETE FROM docs WHERE path = ?", [resolvedPath]); } catch { /* ignore */ }

  // Re-insert if file still exists
  if (fs.existsSync(resolvedPath)) {
    const filename = path.basename(resolvedPath);
    // Determine project from path: the file should be under cortexPath/<project>/
    const rel = path.relative(path.resolve(cortexPath), resolvedPath);
    const project = rel.split(path.sep)[0];
    const relFile = rel.split(path.sep).slice(1).join(path.sep);
    const type = classifyFile(filename, relFile);
    const entry: FileEntry = { fullPath: resolvedPath, project, filename, type, relFile };
    if (insertFileIntoIndex(db, entry, cortexPath)) {
      // Re-extract entities for finding files
      if (type === "findings") {
        try {
          const content = fs.readFileSync(resolvedPath, "utf-8");
          extractAndLinkEntities(db, content, getEntrySourceDocKey(entry, cortexPath), cortexPath);
        } catch { /* non-fatal */ }
      }
    }

    // Update hash map for this file
    try {
      const hashData = loadHashMap(cortexPath);
      hashData.hashes[resolvedPath] = hashFileContent(resolvedPath);
      saveHashMap(cortexPath, hashData.hashes);
    } catch { /* best-effort */ }

    // Schedule async embedding (best-effort, does not block caller)
    try {
      const rawContent = fs.readFileSync(resolvedPath, "utf-8").slice(0, 8000);
      scheduleEmbedding(cortexPath, resolvedPath, rawContent);
    } catch { /* best-effort */ }
  } else {
    // Remove stale embedding if file was deleted
    void (async () => {
      try {
        const { getEmbeddingCache } = await import("./shared-embedding-cache.js");
        const c = getEmbeddingCache(cortexPath);
        c.delete(resolvedPath);
        await c.flush();
      } catch { /* best-effort */ }
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
  } catch { /* corrupt or missing */ }
  return null;
}

function writeHashSentinel(cortexPath: string, hash: string): void {
  try {
    const sentinelPath = runtimeFile(cortexPath, "index-sentinel.json");
    fs.writeFileSync(sentinelPath, JSON.stringify({ hash, computedAt: Date.now() }));
  } catch { /* best-effort */ }
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
    } catch { /* dir doesn't exist, skip */ }
  }
  return true;
}

async function buildIndexImpl(cortexPath: string, profile?: string): Promise<SqlJsDatabase> {
  const t0 = Date.now();
  let userSuffix: string;
  try {
    userSuffix = String(os.userInfo().uid);
  } catch {
    userSuffix = crypto.createHash("sha1").update(os.homedir()).digest("hex").slice(0, 12);
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

  const wasmBinary = findWasmBinary();
  const SQL = await initSqlJs(wasmBinary ? { wasmBinary } : {});

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
        try { db.run("ALTER TABLE entities ADD COLUMN first_seen_at TEXT"); } catch { /* already exists */ }

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
          } catch { /* skip unreadable */ }
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
              try { deleteEntityLinksForDocPath(db, cortexPath, missingPath); } catch { /* ignore */ }
              try { db.run("DELETE FROM docs WHERE path = ?", [missingPath]); } catch { /* ignore */ }
            }
            db.run("COMMIT");
          } catch {
            try { db.run("ROLLBACK"); } catch { /* ignore */ }
          }

          let updatedCount = 0;
          for (const entry of [...changedFiles, ...newFiles]) {
            db.run("BEGIN");
            try {
              if (changedPaths.has(entry.fullPath)) {
                const sourceDocKey = getEntrySourceDocKey(entry, cortexPath);
                db.run("DELETE FROM entity_links WHERE source_doc = ?", [sourceDocKey]);
                // Q19: keep global_entities in sync with entity_links on updates
                try { db.run("DELETE FROM global_entities WHERE doc_key = ?", [sourceDocKey]); } catch { /* older cached DBs may not have this table */ }
                db.run("DELETE FROM docs WHERE path = ?", [entry.fullPath]);
              }

              if (insertFileIntoIndex(db, entry, cortexPath)) {
                updatedCount++;
                if (entry.type === "findings") {
                  try {
                    const content = fs.readFileSync(entry.fullPath, "utf-8");
                    extractAndLinkEntities(db, content, getEntrySourceDocKey(entry, cortexPath), cortexPath);
                  } catch (err: unknown) { debugLog(`entity extraction failed: ${err instanceof Error ? err.message : String(err)}`); }
                }
              }

              db.run("COMMIT");
            } catch (err: unknown) {
              try { db.run("ROLLBACK"); } catch { /* ignore */ }
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
          } catch { /* best-effort */ }

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
    } catch {
      debugLog(`Cache load failed, rebuilding index`);
    }
  }

  // Full rebuild
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
  let entityGraphLoaded = false;
  if (fs.existsSync(graphPath)) {
    try {
      const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
      const graphMtime = fs.statSync(graphPath).mtimeMs;
      const anyNewer = allFiles.some(f => {
        try { return fs.statSync(f.fullPath).mtimeMs > graphMtime; } catch { return true; }
      });
      if (!anyNewer && graph.entities && graph.links) {
        for (const [id, name, type] of graph.entities) {
          db.run("INSERT OR IGNORE INTO entities (id, name, type, first_seen_at) VALUES (?, ?, ?, ?)", [id, name, type, new Date().toISOString().slice(0, 10)]);
        }
        for (const [sourceId, targetId, relType, sourceDoc] of graph.links) {
          db.run("INSERT OR IGNORE INTO entity_links (source_id, target_id, rel_type, source_doc) VALUES (?, ?, ?, ?)", [sourceId, targetId, relType, sourceDoc]);
        }
        // Q19: also restore global_entities from cached graph so cross_project_entities
        // is not empty after a cached-graph rebuild path.
        if (Array.isArray(graph.globalEntities)) {
          for (const [entity, project, docKey] of graph.globalEntities) {
            try {
              db.run(
                "INSERT OR IGNORE INTO global_entities (entity, project, doc_key) VALUES (?, ?, ?)",
                [entity, project, docKey]
              );
            } catch { /* ignore */ }
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
                } catch { /* ignore */ }
              }
            }
          } catch { /* non-fatal */ }
        }
        entityGraphLoaded = true;
      }
    } catch { /* fall through to extract */ }
  }

  for (const entry of allFiles) {
    try {
      newHashes[entry.fullPath] = hashFileContent(entry.fullPath);
    } catch { /* skip */ }
    if (insertFileIntoIndex(db, entry, cortexPath)) {
      fileCount++;
      // Extract entities from finding files (if not loaded from cache)
      if (!entityGraphLoaded && entry.type === "findings") {
        try {
          const content = fs.readFileSync(entry.fullPath, "utf-8");
          extractAndLinkEntities(db, content, getEntrySourceDocKey(entry, cortexPath), cortexPath);
        } catch (err: unknown) { debugLog(`entity extraction failed: ${err instanceof Error ? err.message : String(err)}`); }
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
    } catch { /* non-fatal */ }
  }

  // Always merge manual links (survive rebuild)
  const manualLinksPath = runtimeFile(cortexPath, 'manual-links.json');
  if (fs.existsSync(manualLinksPath)) {
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
            } catch { /* global_entities table may not exist */ }
          }
        } catch { /* skip bad entries */ }
      }
    } catch { /* non-fatal */ }
  }

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
      try { fs.unlinkSync(path.join(cacheDir, f)); } catch { /* stale cache cleanup is best-effort */ }
    }
    debugLog(`Saved FTS index cache (${hash.slice(0, 8)}) — total ${Date.now() - t0}ms`);
  } catch {
    debugLog(`Failed to save FTS index cache`);
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
  } catch {
    return false;
  }
}

async function loadIndexSnapshotOrEmpty(cortexPath: string, profile?: string): Promise<SqlJsDatabase> {
  const wasmBinary = findWasmBinary();
  const SQL = await initSqlJs(wasmBinary ? { wasmBinary } : {});
  let userSuffix: string;
  try {
    userSuffix = String(os.userInfo().uid);
  } catch {
    userSuffix = crypto.createHash("sha1").update(os.homedir()).digest("hex").slice(0, 12);
  }
  const cacheDir = path.join(os.tmpdir(), `cortex-fts-${userSuffix}`);
  const globResult = globAllFiles(cortexPath, profile);
  const hash = computeCortexHash(cortexPath, profile, globResult.filePaths);
  const cacheFile = path.join(cacheDir, `${hash}.db`);

  if (fs.existsSync(cacheFile)) {
    try {
      return new SQL.Database(fs.readFileSync(cacheFile));
    } catch (err: unknown) {
      debugLog(`Failed to open cached FTS snapshot while rebuild lock held: ${err instanceof Error ? err.message : String(err)}`);
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
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("could not acquire lock")) {
      debugLog(`FTS rebuild skipped because another process holds the rebuild lock: ${message}`);
      return loadIndexSnapshotOrEmpty(cortexPath, profile);
    }
    throw err;
  }
}

export interface DocRow {
  project: string;
  filename: string;
  type: string;
  content: string;
  path: string;
}

export function getDocSourceKey(doc: Pick<DocRow, "project" | "filename" | "path">, cortexPath: string): string {
  return buildSourceDocKey(doc.project, doc.path, cortexPath, doc.filename);
}

/**
 * Normalize a memory ID to canonical format: `mem:project/path/to/file.md`.
 * Handles URL-encoded slashes, missing `mem:` prefix, backslashes, and
 * legacy formats with colons after the filename (e.g. `mem:project/file:linenum`).
 */
export function normalizeMemoryId(rawId: string): string {
  let id = decodeURIComponent(rawId).replace(/\\/g, "/");
  if (!id.startsWith("mem:")) id = `mem:${id}`;
  // Strip trailing :linenum if present (legacy format)
  id = id.replace(/:(\d+)$/, "");
  return id;
}

export function rowToDoc(row: DbRow): DocRow {
  if (!Array.isArray(row) || row.length < 5) {
    throw new Error(`rowToDoc: expected ≥5 columns, got ${Array.isArray(row) ? row.length : typeof row}`);
  }
  return {
    project: row[0] != null ? String(row[0]) : "",
    filename: row[1] != null ? String(row[1]) : "",
    type: row[2] != null ? String(row[2]) : "",
    content: row[3] != null ? String(row[3]) : "",
    path: row[4] != null ? String(row[4]) : "",
  };
}

export function queryDocRows(db: SqlJsDatabase, sql: string, params: (string | number)[]): DocRow[] | null {
  const raw = queryRows(db, sql, params);
  if (!raw) return null;
  return raw.map(rowToDoc);
}

export function queryDocBySourceKey(db: SqlJsDatabase, cortexPath: string, sourceKey: string): DocRow | null {
  const match = sourceKey.match(/^([^/]+)\/(.+)$/);
  if (!match) return null;
  const [, project, rest] = match;
  const filename = rest.includes("/") ? path.basename(rest) : rest;
  const rows = queryDocRows(
    db,
    "SELECT project, filename, type, content, path FROM docs WHERE project = ? AND filename = ?",
    [project, filename]
  );
  if (!rows) return null;
  return rows.find((row) => getDocSourceKey(row, cortexPath) === sourceKey) ?? null;
}

export function queryRows(db: SqlJsDatabase, sql: string, params: (string | number)[]): DbRow[] | null {
  try {
    const results = db.exec(sql, params);
    if (!Array.isArray(results) || !results.length || !results[0]?.values?.length) return null;
    return results[0].values;
  } catch (err: unknown) {
    debugLog(`queryRows failed: ${err instanceof Error ? err.message : "unknown error"}`);
    return null;
  }
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

/** Find existing FTS cache files in the temp directory. Returns { dir, files[], totalBytes }. */
export function findFtsCacheInfo(): { dir: string; files: string[]; totalBytes: number } {
  let userSuffix: string;
  try {
    userSuffix = String(os.userInfo().uid);
  } catch {
    userSuffix = crypto.createHash("sha1").update(os.homedir()).digest("hex").slice(0, 12);
  }
  const dir = path.join(os.tmpdir(), `cortex-fts-${userSuffix}`);
  const files: string[] = [];
  let totalBytes = 0;
  try {
    for (const entry of fs.readdirSync(dir)) {
      if (entry.endsWith(".db")) {
        const fullPath = path.join(dir, entry);
        try {
          const stat = fs.statSync(fullPath);
          files.push(fullPath);
          totalBytes += stat.size;
        } catch { /* skip */ }
      }
    }
  } catch { /* dir may not exist yet */ }
  return { dir, files, totalBytes };
}

/** Find the FTS cache file for a specific cortexPath+profile. Returns exists + size. */
export function findFtsCacheForPath(cortexPath: string, profile?: string): { exists: boolean; sizeBytes?: number } {
  let userSuffix: string;
  try {
    userSuffix = String(os.userInfo().uid);
  } catch {
    userSuffix = crypto.createHash("sha1").update(os.homedir()).digest("hex").slice(0, 12);
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
  } catch { /* best-effort */ }
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
