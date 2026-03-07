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
import { getIndexPolicy } from "./shared-governance.js";
import { stripBacklogDoneSection } from "./shared-content.js";
import { STOP_WORDS } from "./utils.js";

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

function classifyFile(filename: string, relPath: string): string {
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
    const normalized = path.resolve(resolved);

    if (currentSeen.has(normalized)) {
      return `<!-- @import cycle: ${trimmed} -->`;
    }

    if (!normalized.startsWith(path.resolve(cortexPath) + path.sep)) {
      return `<!-- @import blocked: path traversal -->`;
    }

    try {
      if (!fs.existsSync(normalized)) {
        return `<!-- @import not found: ${trimmed} -->`;
      }
      currentSeen.add(normalized);
      const imported = fs.readFileSync(normalized, "utf-8");
      return resolveImports(imported, cortexPath, currentSeen, currentDepth + 1);
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

function computeCortexHash(cortexPath: string, profile?: string): string {
  const projectDirs = getProjectDirs(cortexPath, profile);
  const policy = getIndexPolicy(cortexPath);
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
  const hash = crypto.createHash("sha1");
  for (const f of files) {
    try {
      const stat = fs.statSync(f);
      hash.update(`${f}:${stat.mtimeMs}:${stat.size}`);
    } catch { /* skip */ }
  }
  for (const mem of collectNativeMemoryFiles()) {
    try {
      const stat = fs.statSync(mem.fullPath);
      hash.update(`native:${mem.fullPath}:${stat.mtimeMs}:${stat.size}`);
    } catch { /* skip */ }
  }
  if (profile) hash.update(`profile:${profile}`);
  hash.update(`index-policy:${JSON.stringify(policy)}`);
  return hash.digest("hex").slice(0, 16);
}

const INDEX_HASHES_FILENAME = "index-hashes.json";
const INDEX_SCHEMA_VERSION = 2; // bump when FTS schema changes to force full rebuild

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
    fs.writeFileSync(
      path.join(runtimeDir, INDEX_HASHES_FILENAME),
      JSON.stringify({ version: INDEX_SCHEMA_VERSION, hashes }, null, 2)
    );
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

function collectAllFiles(cortexPath: string, profile?: string): FileEntry[] {
  const projectDirs = getProjectDirs(cortexPath, profile);
  const indexPolicy = getIndexPolicy(cortexPath);
  const entries: FileEntry[] = [];

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
    for (const relFile of [...mdFilesSet].sort()) {
      const fullPath = path.join(dir, relFile);
      const filename = path.basename(relFile);
      const type = classifyFile(filename, relFile);
      entries.push({ fullPath, project: projectName, filename, type, relFile });
    }
  }

  for (const mem of collectNativeMemoryFiles()) {
    entries.push({ fullPath: mem.fullPath, project: mem.project, filename: mem.file, type: "findings" });
  }

  return entries;
}

function insertFileIntoIndex(db: SqlJsDatabase, entry: FileEntry, cortexPath: string): boolean {
  try {
    const raw = fs.readFileSync(entry.fullPath, "utf-8");
    let content = raw.replace(/<details>[\s\S]*?<\/details>/gi, "");
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
  const hash = computeCortexHash(cortexPath, profile);
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
      const db = new SQL.Database(cached);

      // Compute current file hashes and determine what changed
      const allFiles = collectAllFiles(cortexPath, profile);
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
        db.close();
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
        return db;
      } else {
        // Incremental update: delete changed/missing, re-insert changed/new
        for (const entry of changedFiles) {
          try { db.run("DELETE FROM docs WHERE path = ?", [entry.fullPath]); } catch { /* ignore */ }
          try { deleteEntityLinksForDocPath(db, cortexPath, entry.fullPath, entry.project, entry.filename); } catch { /* ignore */ }
        }
        for (const missingPath of missingFromIndex) {
          try { deleteEntityLinksForDocPath(db, cortexPath, missingPath); } catch { /* ignore */ }
          try { db.run("DELETE FROM docs WHERE path = ?", [missingPath]); } catch { /* ignore */ }
        }

        let updatedCount = 0;
        for (const entry of [...changedFiles, ...newFiles]) {
          if (insertFileIntoIndex(db, entry, cortexPath)) {
            updatedCount++;
            if (entry.type === "findings") {
              try {
                const content = fs.readFileSync(entry.fullPath, "utf-8");
                extractAndLinkEntities(db, content, getEntrySourceDocKey(entry, cortexPath));
              } catch { /* skip entity extraction errors */ }
            }
          }
        }

        saveHashMap(cortexPath, currentHashes);

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
        return db;
      }
    } catch {
      debugLog(`Cache load failed, rebuilding index`);
    }
  }

  // Full rebuild
  const db = new SQL.Database();
  db.run(`
    CREATE VIRTUAL TABLE docs USING fts5(
      project, filename, type, content, path
    );
  `);

  // Entity graph tables for lightweight reference graph
  db.run(`CREATE TABLE IF NOT EXISTS entities (id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, UNIQUE(name, type))`);
  db.run(`CREATE TABLE IF NOT EXISTS entity_links (source_id INTEGER REFERENCES entities(id), target_id INTEGER REFERENCES entities(id), rel_type TEXT NOT NULL, source_doc TEXT, PRIMARY KEY (source_id, target_id, rel_type))`);

  const allFiles = collectAllFiles(cortexPath, profile);
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
          db.run("INSERT OR IGNORE INTO entities (id, name, type) VALUES (?, ?, ?)", [id, name, type]);
        }
        for (const [sourceId, targetId, relType, sourceDoc] of graph.links) {
          db.run("INSERT OR IGNORE INTO entity_links (source_id, target_id, rel_type, source_doc) VALUES (?, ?, ?, ?)", [sourceId, targetId, relType, sourceDoc]);
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
          extractAndLinkEntities(db, content, getEntrySourceDocKey(entry, cortexPath));
        } catch { /* skip entity extraction errors */ }
      }
    }
  }

  // Persist entity graph for next build
  if (!entityGraphLoaded) {
    try {
      const entityRows = db.exec("SELECT id, name, type FROM entities")[0]?.values ?? [];
      const linkRows = db.exec("SELECT source_id, target_id, rel_type, source_doc FROM entity_links")[0]?.values ?? [];
      fs.writeFileSync(graphPath, JSON.stringify({ entities: entityRows, links: linkRows, ts: Date.now() }));
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
          db.run("INSERT OR IGNORE INTO entities (name, type) VALUES (?, ?)", [link.entity, link.entityType]);
          db.run("INSERT OR IGNORE INTO entities (name, type) VALUES (?, ?)", [link.sourceDoc, "document"]);
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
        } catch { /* skip bad entries */ }
      }
    } catch { /* non-fatal */ }
  }

  saveHashMap(cortexPath, newHashes);

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

export async function buildIndex(cortexPath: string, profile?: string): Promise<SqlJsDatabase> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("buildIndex timed out after 30s")), 30000);
  });
  try {
    return await Promise.race([buildIndexImpl(cortexPath, profile), timeout]);
  } finally {
    clearTimeout(timer!);
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

export function rowToDoc(row: DbRow): DocRow {
  return {
    project: row[0] as string,
    filename: row[1] as string,
    type: row[2] as string,
    content: row[3] as string,
    path: row[4] as string,
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
  const [, project] = match;
  const rows = queryDocRows(
    db,
    "SELECT project, filename, type, content, path FROM docs WHERE project = ?",
    [project]
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

const HYBRID_SEARCH_FLAG = "CORTEX_FEATURE_HYBRID_SEARCH";
const COSINE_FALLBACK_THRESHOLD = 3;
const COSINE_SIMILARITY_MIN = 0.15;
const COSINE_MAX_CORPUS = 10000;

/**
 * Porter stemmer implementation for English words.
 * Based on the Porter (1980) algorithm.
 */
export function porterStem(word: string): string {
  if (word.length <= 2) return word;

  function isConsonant(w: string, i: number): boolean {
    const c = w[i];
    if (c === 'a' || c === 'e' || c === 'i' || c === 'o' || c === 'u') return false;
    if (c === 'y') return i === 0 ? true : !isConsonant(w, i - 1);
    return true;
  }

  function measure(stem: string): number {
    if (stem.length === 0) return 0;
    let m = 0;
    let i = 0;
    // skip initial consonants
    while (i < stem.length && isConsonant(stem, i)) i++;
    while (i < stem.length) {
      // count vowel sequence
      while (i < stem.length && !isConsonant(stem, i)) i++;
      if (i >= stem.length) break;
      m++;
      // count consonant sequence
      while (i < stem.length && isConsonant(stem, i)) i++;
    }
    return m;
  }

  function hasVowel(stem: string): boolean {
    for (let i = 0; i < stem.length; i++) {
      if (!isConsonant(stem, i)) return true;
    }
    return false;
  }

  function endsDoubleConsonant(w: string): boolean {
    if (w.length < 2) return false;
    return w[w.length - 1] === w[w.length - 2] && isConsonant(w, w.length - 1);
  }

  function endsCVC(w: string): boolean {
    if (w.length < 3) return false;
    const l = w.length;
    if (!isConsonant(w, l - 1) || isConsonant(w, l - 2) || !isConsonant(w, l - 3)) return false;
    const last = w[l - 1];
    return last !== 'w' && last !== 'x' && last !== 'y';
  }

  function endsWith(w: string, suffix: string): string | null {
    if (w.length < suffix.length) return null;
    if (w.endsWith(suffix)) return w.slice(0, -suffix.length);
    return null;
  }

  let w = word;

  // Step 1a
  if (w.endsWith("sses")) {
    w = w.slice(0, -2);
  } else if (w.endsWith("ies")) {
    w = w.slice(0, -2);
  } else if (!w.endsWith("ss") && w.endsWith("s") && w.length > 2) {
    w = w.slice(0, -1);
  }

  // Step 1b
  let step1bExtra = false;
  if (w.endsWith("eed")) {
    const stem = w.slice(0, -3);
    if (measure(stem) > 0) w = w.slice(0, -1); // eed -> ee
  } else {
    let stemFound: string | null = null;
    if (w.endsWith("ed")) {
      stemFound = w.slice(0, -2);
    } else if (w.endsWith("ing")) {
      stemFound = w.slice(0, -3);
    }
    if (stemFound !== null && hasVowel(stemFound)) {
      w = stemFound;
      step1bExtra = true;
    }
  }

  if (step1bExtra) {
    if (w.endsWith("at") || w.endsWith("bl") || w.endsWith("iz")) {
      w += "e";
    } else if (endsDoubleConsonant(w) && !w.endsWith("l") && !w.endsWith("s") && !w.endsWith("z")) {
      w = w.slice(0, -1);
    } else if (measure(w) === 1 && endsCVC(w)) {
      w += "e";
    }
  }

  // Step 1c
  if (w.endsWith("y") && w.length > 2 && hasVowel(w.slice(0, -1))) {
    w = w.slice(0, -1) + "i";
  }

  // Step 2
  const step2Map: Record<string, string> = {
    ational: "ate", tional: "tion", enci: "ence", anci: "ance",
    izer: "ize", abli: "able", alli: "al", entli: "ent", eli: "e",
    ousli: "ous", ization: "ize", ation: "ate", ator: "ate",
    alism: "al", iveness: "ive", fulness: "ful", ousness: "ous",
    aliti: "al", iviti: "ive", biliti: "ble",
  };
  for (const [suffix, replacement] of Object.entries(step2Map)) {
    const stem = endsWith(w, suffix);
    if (stem !== null && measure(stem) > 0) {
      w = stem + replacement;
      break;
    }
  }

  // Step 3
  const step3Map: Record<string, string> = {
    icate: "ic", ative: "", iciti: "ic",
    ical: "ic", ful: "", ness: "",
  };
  for (const [suffix, replacement] of Object.entries(step3Map)) {
    const stem = endsWith(w, suffix);
    if (stem !== null && measure(stem) > 0) {
      w = stem + replacement;
      break;
    }
  }

  // Step 4
  const step4Suffixes = [
    "al", "ance", "ence", "er", "ic", "able", "ible", "ant",
    "ement", "ment", "ent", "ion", "ou", "ism", "ate", "iti",
    "ous", "ive", "ize",
  ];
  for (const suffix of step4Suffixes) {
    const stem = endsWith(w, suffix);
    if (stem !== null && measure(stem) > 1) {
      if (suffix === "ion") {
        if (stem.endsWith("s") || stem.endsWith("t")) {
          w = stem;
        }
      } else {
        w = stem;
      }
      break;
    }
  }

  // Step 5a
  if (w.endsWith("e")) {
    const stem = w.slice(0, -1);
    const m = measure(stem);
    if (m > 1 || (m === 1 && !endsCVC(stem))) {
      w = stem;
    }
  }

  // Step 5b
  if (measure(w) > 1 && endsDoubleConsonant(w) && w.endsWith("l")) {
    w = w.slice(0, -1);
  }

  return w;
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
 */
function tfidfCosine(docs: string[], query: string): number[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return docs.map(() => 0);

  // Collect all unique terms from query + all docs
  const allTokens = new Set<string>(queryTokens);
  const docTokenLists: string[][] = docs.map(d => {
    const tokens = tokenize(d);
    for (const t of tokens) allTokens.add(t);
    return tokens;
  });

  // Build a Set per document for O(1) term lookups
  const docTokenSets: Set<string>[] = docTokenLists.map(tokens => new Set(tokens));

  const terms = [...allTokens];
  const N = docs.length;

  // Compute document frequency for each term
  const df = new Map<string, number>();
  for (const term of terms) {
    let count = 0;
    for (const docSet of docTokenSets) {
      if (docSet.has(term)) count++;
    }
    df.set(term, count);
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
  // Feature flag guard — default off
  const flagVal = process.env[HYBRID_SEARCH_FLAG];
  if (!flagVal || ["0", "false", "off", "no"].includes(flagVal.trim().toLowerCase())) {
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

  // Load all docs
  let allRows: DbRow[] | null = null;
  try {
    const results = db.exec("SELECT rowid, project, filename, type, content, path FROM docs");
    if (!Array.isArray(results) || !results.length || !results[0]?.values?.length) return [];
    allRows = results[0].values;
  } catch {
    return [];
  }

  // Separate rowids, DocRows, and content strings for scoring
  const rowids: number[] = [];
  const docContents: string[] = [];
  const docMeta: { project: string; filename: string; type: string; content: string; path: string }[] = [];

  for (const row of allRows ?? []) {
    const rowid = Number(row[0]);
    if (excludeRowids.has(rowid)) continue;
    rowids.push(rowid);
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

  const scores = tfidfCosine(docContents, query);

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

// ── Entity graph helpers ──────────────────────────────────────────────────────

const ENTITY_PATTERNS = [
  // import/require patterns: import X from 'pkg' or require('pkg')
  /(?:import\s+.*?\s+from\s+['"])(@?[\w\-/]+)(?:['"])/g,
  /(?:require\s*\(\s*['"])(@?[\w\-/]+)(?:['"]\s*\))/g,
  // @scope/package patterns in text
  /@[\w-]+\/[\w-]+/g,
  // Known library/tool names mentioned in prose (case-insensitive word boundaries)
  /\b(React|Vue|Angular|Next\.js|Nuxt|Svelte|Express|Fastify|Django|Flask|Rails|Spring|Redis|Postgres|PostgreSQL|MySQL|MongoDB|SQLite|Docker|Kubernetes|Terraform|AWS|GCP|Azure|Vercel|Netlify|Prisma|TypeORM|Sequelize|Jest|Vitest|Cypress|Playwright|Webpack|Vite|ESLint|Prettier|GraphQL|gRPC|Kafka|RabbitMQ|Elasticsearch|Nginx|Caddy|Node\.js|Deno|Bun|Python|Rust|Go|Java|TypeScript|Zod|Drizzle|tRPC|Tailwind|shadcn)\b/gi,
];

function extractEntityNames(content: string): string[] {
  const found = new Set<string>();
  for (const pattern of ENTITY_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const name = match[1] || match[0];
      if (name && name.length > 1 && name.length < 100) {
        found.add(name.toLowerCase());
      }
    }
  }
  return [...found];
}

function getOrCreateEntity(db: SqlJsDatabase, name: string, type: string): number {
  try {
    db.run("INSERT OR IGNORE INTO entities (name, type) VALUES (?, ?)", [name, type]);
  } catch { /* ignore duplicate */ }
  const result = db.exec("SELECT id FROM entities WHERE name = ? AND type = ?", [name, type]);
  if (result?.length && result[0]?.values?.length) {
    return Number(result[0].values[0][0]);
  }
  return -1;
}

function extractAndLinkEntities(db: SqlJsDatabase, content: string, sourceDoc: string): void {
  const entityNames = extractEntityNames(content);
  if (entityNames.length === 0) return;

  const docEntityId = getOrCreateEntity(db, sourceDoc, "document");
  if (docEntityId === -1) return;

  for (const name of entityNames) {
    const entityId = getOrCreateEntity(db, name, "library");
    if (entityId === -1) continue;
    try {
      db.run(
        "INSERT OR IGNORE INTO entity_links (source_id, target_id, rel_type, source_doc) VALUES (?, ?, ?, ?)",
        [docEntityId, entityId, "mentions", sourceDoc]
      );
    } catch { /* ignore */ }
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
        related.push(String(row[0]));
      }
    }
  } catch { /* ignore query errors */ }
  return { related };
}

export function getEntityBoostDocs(db: SqlJsDatabase, query: string, _cortexPath: string): Set<string> {
  const entityNames: string[] = [];
  try {
    const rows = db.exec("SELECT name FROM entities WHERE length(name) > 2")[0]?.values ?? [];
    for (const [name] of rows) {
      if (typeof name === 'string' && query.toLowerCase().includes(name.toLowerCase())) {
        entityNames.push(name);
      }
    }
  } catch { return new Set(); }

  const boostDocs = new Set<string>();
  for (const name of entityNames) {
    try {
      const rows = db.exec(
        "SELECT DISTINCT el.source_doc FROM entity_links el JOIN entities e ON el.target_id = e.id WHERE e.name = ? COLLATE NOCASE",
        [name]
      )[0]?.values ?? [];
      for (const [doc] of rows) {
        if (typeof doc === 'string') boostDocs.add(doc);
      }
    } catch { /* skip */ }
  }
  return boostDocs;
}
