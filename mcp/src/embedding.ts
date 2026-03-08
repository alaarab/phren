import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import {
  debugLog,
  runtimeDir,
} from "./shared.js";
import { withFileLock } from "./shared-governance.js";

// ---------------------------------------------------------------------------
// SQLite cache (Q17) — replaces embed-cache.jsonl with O(1) lookup
// ---------------------------------------------------------------------------

export interface SqlJsDatabase {
  run(sql: string, params?: (string | number | null | Uint8Array)[]): void;
  exec(sql: string, params?: (string | number | null | Uint8Array)[]): { columns: string[]; values: (string | number | null | Uint8Array)[][] }[];
  export(): Uint8Array;
  close(): void;
}

interface SqlJsStatic {
  Database: new (data?: ArrayLike<number>) => SqlJsDatabase;
}

const require = createRequire(import.meta.url);
const initSqlJs = require("sql.js-fts5") as (config?: Record<string, unknown>) => Promise<SqlJsStatic>;

const EMBED_CACHE_DB = "embed-cache.db";
const EMBED_CACHE_JSONL = "embed-cache.jsonl"; // legacy file for migration

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

function getCacheDbPath(cortexPath: string): string {
  const dir = runtimeDir(cortexPath);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, EMBED_CACHE_DB);
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/** Encode a number[] embedding into a compact binary blob (Float32Array). */
function encodeEmbedding(embedding: number[]): Buffer {
  const f32 = new Float32Array(embedding);
  return Buffer.from(f32.buffer);
}

/** Decode a binary blob back to number[]. */
function decodeEmbedding(blob: Uint8Array): number[] {
  const f32 = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  return Array.from(f32);
}

let sqlPromise: Promise<SqlJsStatic> | null = null;
// Q14: Synchronously-accessible resolved SQL static, set once sqlPromise settles.
let sqlResolved: SqlJsStatic | null = null;
function getSql(): Promise<SqlJsStatic> {
  if (!sqlPromise) {
    const wasmBinary = findWasmBinary();
    sqlPromise = initSqlJs(wasmBinary ? { wasmBinary } : {});
    sqlPromise.then(s => { sqlResolved = s; }).catch(() => {});
  }
  return sqlPromise;
}

async function openCacheDb(cortexPath: string): Promise<SqlJsDatabase> {
  const dbPath = getCacheDbPath(cortexPath);
  const SQL = await getSql();

  let db: SqlJsDatabase | undefined;
  try {
    if (fs.existsSync(dbPath)) {
      const data = fs.readFileSync(dbPath);
      db = new SQL.Database(data);
    } else {
      db = new SQL.Database();
    }

    db.run(`CREATE TABLE IF NOT EXISTS embeddings (
      model TEXT NOT NULL,
      hash TEXT NOT NULL,
      embedding BLOB NOT NULL,
      PRIMARY KEY (model, hash)
    )`);

    // Migrate legacy JSONL cache if it exists
    const legacyPath = path.join(runtimeDir(cortexPath), EMBED_CACHE_JSONL);
    if (fs.existsSync(legacyPath)) {
      try {
        const lines = fs.readFileSync(legacyPath, "utf-8").split("\n").filter(Boolean);
        if (lines.length > 0) {
          db.run("BEGIN TRANSACTION");
          for (const line of lines) {
            const entry = JSON.parse(line) as { hash: string; model: string; embedding: number[] };
            db.run(
              "INSERT OR IGNORE INTO embeddings (model, hash, embedding) VALUES (?, ?, ?)",
              [entry.model, entry.hash, encodeEmbedding(entry.embedding)]
            );
          }
          db.run("COMMIT");
          fs.writeFileSync(dbPath, Buffer.from(db.export()));
          fs.unlinkSync(legacyPath);
          debugLog(`embedding: migrated ${lines.length} entries from JSONL to SQLite`);
        }
      } catch (err) {
        try { db.run("ROLLBACK"); } catch { /* ignore */ }
        debugLog(`embedding: JSONL migration failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return db;
  } catch (err) {
    try { db?.close(); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Q14: Persist the in-memory DB to disk under a file lock.
 * Reads the current on-disk snapshot inside the lock, merges any entries that
 * are in `db` but missing from disk, then writes atomically via temp-file rename.
 * This prevents the "last writer wins" race where two concurrent processes each
 * open the same on-disk snapshot, insert different entries, and overwrite each
 * other's work.
 */
function persistDb(cortexPath: string, db: SqlJsDatabase): void {
  const dbPath = getCacheDbPath(cortexPath);
  try {
    withFileLock(dbPath, () => {
      // Read the freshest on-disk snapshot (may have entries from another process)
      let onDisk: SqlJsDatabase | null = null;
      // We cannot call the async openCacheDb here; use a raw sync open instead.
      // If that fails we fall back to writing `db` as-is (best-effort).
      try {
        if (fs.existsSync(dbPath)) {
          // sql.js-fts5 is already initialised by the time we persist; reuse the
          // cached promise result synchronously if available (it is a resolved
          // Promise at this point because getCachedEmbedding awaited it first).
          // We extract the resolved value by creating a fulfilled-only thenable.
          if (sqlResolved) {
            onDisk = new sqlResolved.Database(fs.readFileSync(dbPath));
            onDisk.run(`CREATE TABLE IF NOT EXISTS embeddings (
              model TEXT NOT NULL, hash TEXT NOT NULL, embedding BLOB NOT NULL,
              PRIMARY KEY (model, hash)
            )`);
            // Merge entries from `db` into onDisk
            const rows = db.exec("SELECT model, hash, embedding FROM embeddings")[0]?.values ?? [];
            if (rows.length > 0) {
              onDisk.run("BEGIN TRANSACTION");
              for (const [model, hash, embedding] of rows) {
                onDisk.run(
                  "INSERT OR IGNORE INTO embeddings (model, hash, embedding) VALUES (?, ?, ?)",
                  [model as string, hash as string, embedding as Uint8Array]
                );
              }
              onDisk.run("COMMIT");
            }
          }
        }
      } catch {
        try { onDisk?.close(); } catch { /* ignore */ }
        onDisk = null;
      }

      const target = onDisk ?? db;
      const tmp = dbPath + `.tmp-${crypto.randomUUID()}`;
      try {
        fs.writeFileSync(tmp, Buffer.from(target.export()));
        fs.renameSync(tmp, dbPath);
      } finally {
        if (onDisk) try { onDisk.close(); } catch { /* ignore */ }
      }
    });
  } catch {
    debugLog("embedding: failed to persist cache db");
  }
}

function lookupCache(db: SqlJsDatabase, model: string, hash: string): number[] | null {
  const results = db.exec("SELECT embedding FROM embeddings WHERE model = ? AND hash = ?", [model, hash]);
  if (results.length > 0 && results[0].values.length > 0) {
    const blob = results[0].values[0][0] as Uint8Array;
    return decodeEmbedding(blob);
  }
  return null;
}

function insertCache(db: SqlJsDatabase, model: string, hash: string, embedding: number[]): void {
  db.run(
    "INSERT OR REPLACE INTO embeddings (model, hash, embedding) VALUES (?, ?, ?)",
    [model, hash, encodeEmbedding(embedding)]
  );
}


// ---------------------------------------------------------------------------
// API embedding (unchanged)
// ---------------------------------------------------------------------------

/**
 * Get embedding from OpenAI-compatible API.
 * Calls POST https://api.openai.com/v1/embeddings (or compatible endpoint).
 */
export async function getApiEmbedding(
  text: string,
  apiKey: string,
  model: string = "text-embedding-3-small"
): Promise<number[]> {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      input: text,
      model,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Embedding API error ${response.status}: ${body}`);
  }

  const data = await response.json() as { data: Array<{ embedding: number[] }> };
  if (!data.data?.[0]?.embedding) {
    throw new Error("Embedding API returned unexpected format");
  }

  return data.data[0].embedding;
}

/**
 * Get embeddings for multiple texts in a single API call.
 * The OpenAI embeddings API supports array input natively.
 */
export async function getApiEmbeddings(
  texts: string[],
  apiKey: string,
  model: string = "text-embedding-3-small"
): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (texts.length === 1) return [await getApiEmbedding(texts[0], apiKey, model)];

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      input: texts,
      model,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Embedding API error ${response.status}: ${body}`);
  }

  const data = await response.json() as { data: Array<{ index: number; embedding: number[] }> };
  if (!data.data?.length) {
    throw new Error("Embedding API returned unexpected format");
  }

  // Sort by index to ensure order matches input
  const sorted = data.data.sort((a, b) => a.index - b.index);
  return sorted.map(d => d.embedding);
}

export const embeddingOps = {
  openCacheDb,
  persistDb,
  lookupCache,
  insertCache,
  getApiEmbedding,
  getApiEmbeddings,
};

// ---------------------------------------------------------------------------
// Cached embedding (uses SQLite cache)
// ---------------------------------------------------------------------------

/**
 * Get embedding with caching. Uses the configured provider.
 */
export async function getCachedEmbedding(
  cortexPath: string,
  text: string,
  apiKey: string,
  model: string
): Promise<number[]> {
  let db: SqlJsDatabase | undefined;
  try {
    const hash = sha256(`${model}:${text}`);
    db = await embeddingOps.openCacheDb(cortexPath);
    const cached = embeddingOps.lookupCache(db, model, hash);
    if (cached) return cached;

    const embedding = await embeddingOps.getApiEmbedding(text, apiKey, model);
    embeddingOps.insertCache(db, model, hash, embedding);
    // Q14: persistDb now holds a file lock and merges with the on-disk snapshot
    // before writing, so concurrent callers don't overwrite each other's entries.
    embeddingOps.persistDb(cortexPath, db);
    return embedding;
  } catch (err) {
    debugLog(`embedding: getCachedEmbedding failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/**
 * Get embeddings for multiple texts with caching. Batches uncached texts into single API calls.
 */
export async function getCachedEmbeddings(
  cortexPath: string,
  texts: string[],
  apiKey: string,
  model: string
): Promise<number[][]> {
  if (texts.length === 0) return [];

  let db: SqlJsDatabase | undefined;
  try {
    db = await embeddingOps.openCacheDb(cortexPath);
    const results: (number[] | null)[] = texts.map(text => {
      const hash = sha256(`${model}:${text}`);
      return embeddingOps.lookupCache(db!, model, hash);
    });

    const uncachedIndices: number[] = [];
    const uncachedTexts: string[] = [];
    for (let i = 0; i < results.length; i++) {
      if (results[i] === null) {
        uncachedIndices.push(i);
        uncachedTexts.push(texts[i]);
      }
    }

    if (uncachedTexts.length > 0) {
      const BATCH_SIZE = 20;
      for (let start = 0; start < uncachedTexts.length; start += BATCH_SIZE) {
        const batch = uncachedTexts.slice(start, start + BATCH_SIZE);
        const batchEmbeddings = await embeddingOps.getApiEmbeddings(batch, apiKey, model);
        for (let j = 0; j < batch.length; j++) {
          const idx = uncachedIndices[start + j];
          results[idx] = batchEmbeddings[j];
          const hash = sha256(`${model}:${batch[j]}`);
          embeddingOps.insertCache(db, model, hash, batchEmbeddings[j]);
        }
      }
      embeddingOps.persistDb(cortexPath, db);
    }

    return results.map(result => result ?? []);
  } catch (err) {
    debugLog(`embedding: getCachedEmbeddings failed: ${err instanceof Error ? err.message : String(err)}`);
    return texts.map(() => []);
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/**
 * Compute cosine similarity between two vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// Export helpers for testing
export { encodeEmbedding, decodeEmbedding, openCacheDb, lookupCache, insertCache, persistDb };
