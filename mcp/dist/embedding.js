import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { debugLog, runtimeDir, } from "./shared.js";
import { withFileLock } from "./shared-governance.js";
import { errorMessage } from "./utils.js";
import { bootstrapSqlJs } from "./shared-sqljs.js";
let sqlJsLoader = bootstrapSqlJs;
const EMBED_CACHE_DB = "embed-cache.db";
function getCacheDbPath(phrenPath) {
    const dir = runtimeDir(phrenPath);
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, EMBED_CACHE_DB);
}
function sha256(text) {
    return crypto.createHash("sha256").update(text).digest("hex");
}
/** Encode a number[] embedding into a compact binary blob (Float32Array). */
function encodeEmbedding(embedding) {
    const f32 = new Float32Array(embedding);
    return Buffer.from(f32.buffer);
}
/** Decode a binary blob back to number[]. */
function decodeEmbedding(blob) {
    const f32 = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
    return Array.from(f32);
}
let sqlPromise = null;
// Q14: Synchronously-accessible resolved SQL static, set once sqlPromise settles.
let sqlResolved = null;
function getSql() {
    if (!sqlPromise) {
        sqlPromise = sqlJsLoader()
            .then(sql => {
            sqlResolved = sql;
            return sql;
        })
            .catch((err) => {
            sqlPromise = null;
            sqlResolved = null;
            debugLog(`embedding: sql.js init failed: ${errorMessage(err)}`);
            throw err;
        });
    }
    return sqlPromise;
}
export function setSqlJsLoaderForTests(loader) {
    sqlJsLoader = loader;
    sqlPromise = null;
    sqlResolved = null;
}
export function resetSqlJsStateForTests() {
    sqlJsLoader = bootstrapSqlJs;
    sqlPromise = null;
    sqlResolved = null;
}
async function openCacheDb(phrenPath) {
    const dbPath = getCacheDbPath(phrenPath);
    const SQL = await getSql();
    let db;
    try {
        if (fs.existsSync(dbPath)) {
            const data = fs.readFileSync(dbPath);
            db = new SQL.Database(data);
        }
        else {
            db = new SQL.Database();
        }
        db.run(`CREATE TABLE IF NOT EXISTS embeddings (
      model TEXT NOT NULL,
      hash TEXT NOT NULL,
      embedding BLOB NOT NULL,
      PRIMARY KEY (model, hash)
    )`);
        return db;
    }
    catch (err) {
        try {
            db?.close();
        }
        catch (e2) {
            if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG))
                process.stderr.write(`[phren] embedding openCacheDb dbClose: ${e2 instanceof Error ? e2.message : String(e2)}\n`);
        }
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
function persistDb(phrenPath, db) {
    const dbPath = getCacheDbPath(phrenPath);
    try {
        withFileLock(dbPath, () => {
            // Read the freshest on-disk snapshot (may have entries from another process)
            let onDisk = null;
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
                                onDisk.run("INSERT OR IGNORE INTO embeddings (model, hash, embedding) VALUES (?, ?, ?)", [model, hash, embedding]);
                            }
                            onDisk.run("COMMIT");
                        }
                    }
                }
            }
            catch (err) {
                if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG))
                    process.stderr.write(`[phren] embedding persistDb onDiskLoad: ${err instanceof Error ? err.message : String(err)}\n`);
                try {
                    onDisk?.close();
                }
                catch (e2) {
                    if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG))
                        process.stderr.write(`[phren] embedding persistDb onDiskClose: ${e2 instanceof Error ? e2.message : String(e2)}\n`);
                }
                onDisk = null;
            }
            const target = onDisk ?? db;
            const tmp = dbPath + `.tmp-${crypto.randomUUID()}`;
            try {
                fs.writeFileSync(tmp, Buffer.from(target.export()));
                fs.renameSync(tmp, dbPath);
            }
            finally {
                if (onDisk)
                    try {
                        onDisk.close();
                    }
                    catch (e2) {
                        if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG))
                            process.stderr.write(`[phren] embedding persistDb onDiskCloseFinally: ${e2 instanceof Error ? e2.message : String(e2)}\n`);
                    }
            }
        });
    }
    catch (err) {
        debugLog(`embedding: failed to persist cache db: ${errorMessage(err)}`);
    }
}
function lookupCache(db, model, hash) {
    const results = db.exec("SELECT embedding FROM embeddings WHERE model = ? AND hash = ?", [model, hash]);
    if (results.length > 0 && results[0].values.length > 0) {
        const blob = results[0].values[0][0];
        return decodeEmbedding(blob);
    }
    return null;
}
function insertCache(db, model, hash, embedding) {
    db.run("INSERT OR REPLACE INTO embeddings (model, hash, embedding) VALUES (?, ?, ?)", [model, hash, encodeEmbedding(embedding)]);
}
// ---------------------------------------------------------------------------
// API embedding (unchanged)
// ---------------------------------------------------------------------------
/**
 * Get embedding from OpenAI-compatible API.
 * Calls POST https://api.openai.com/v1/embeddings (or compatible endpoint).
 */
async function getApiEmbedding(text, apiKey, model = "text-embedding-3-small") {
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
    const data = await response.json();
    if (!data.data?.[0]?.embedding) {
        throw new Error("Embedding API returned unexpected format");
    }
    return data.data[0].embedding;
}
/**
 * Get embeddings for multiple texts in a single API call.
 * The OpenAI embeddings API supports array input natively.
 */
async function getApiEmbeddings(texts, apiKey, model = "text-embedding-3-small") {
    if (texts.length === 0)
        return [];
    if (texts.length === 1)
        return [await getApiEmbedding(texts[0], apiKey, model)];
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
    const data = await response.json();
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
export async function getCachedEmbedding(phrenPath, text, apiKey, model) {
    let db;
    try {
        const hash = sha256(`${model}:${text}`);
        db = await embeddingOps.openCacheDb(phrenPath);
        const cached = embeddingOps.lookupCache(db, model, hash);
        if (cached)
            return cached;
        const embedding = await embeddingOps.getApiEmbedding(text, apiKey, model);
        embeddingOps.insertCache(db, model, hash, embedding);
        // Q14: persistDb now holds a file lock and merges with the on-disk snapshot
        // before writing, so concurrent callers don't overwrite each other's entries.
        embeddingOps.persistDb(phrenPath, db);
        return embedding;
    }
    catch (err) {
        debugLog(`embedding: getCachedEmbedding failed: ${errorMessage(err)}`);
        return [];
    }
    finally {
        try {
            db?.close();
        }
        catch (e2) {
            if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG))
                process.stderr.write(`[phren] embedding getCachedEmbedding dbClose: ${e2 instanceof Error ? e2.message : String(e2)}\n`);
        }
    }
}
/**
 * Get embeddings for multiple texts with caching. Batches uncached texts into single API calls.
 */
export async function getCachedEmbeddings(phrenPath, texts, apiKey, model) {
    if (texts.length === 0)
        return [];
    let db;
    try {
        db = await embeddingOps.openCacheDb(phrenPath);
        const results = texts.map(text => {
            const hash = sha256(`${model}:${text}`);
            return embeddingOps.lookupCache(db, model, hash);
        });
        const uncachedIndices = [];
        const uncachedTexts = [];
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
            embeddingOps.persistDb(phrenPath, db);
        }
        return results.map(result => result ?? []);
    }
    catch (err) {
        debugLog(`embedding: getCachedEmbeddings failed: ${errorMessage(err)}`);
        return texts.map(() => []);
    }
    finally {
        try {
            db?.close();
        }
        catch (e2) {
            if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG))
                process.stderr.write(`[phren] embedding getCachedEmbeddings dbClose: ${e2 instanceof Error ? e2.message : String(e2)}\n`);
        }
    }
}
/**
 * Compute cosine similarity between two vectors.
 */
export function cosineSimilarity(a, b) {
    if (a.length !== b.length || a.length === 0)
        return 0;
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
export { encodeEmbedding, decodeEmbedding, openCacheDb };
