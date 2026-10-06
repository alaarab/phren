import type { SqlJsDatabase } from "./index-query.js";
interface SqlJsStatic {
    Database: new (data?: ArrayLike<number>) => SqlJsDatabase;
}
/** Encode a number[] embedding into a compact binary blob (Float32Array). */
declare function encodeEmbedding(embedding: number[]): Buffer;
/** Decode a binary blob back to number[]. */
declare function decodeEmbedding(blob: Uint8Array): number[];
export declare function setSqlJsLoaderForTests(loader: () => Promise<SqlJsStatic>): void;
export declare function resetSqlJsStateForTests(): void;
declare function openCacheDb(phrenPath: string): Promise<SqlJsDatabase>;
/**
 * Q14: Persist the in-memory DB to disk under a file lock.
 * Reads the current on-disk snapshot inside the lock, merges any entries that
 * are in `db` but missing from disk, then writes atomically via temp-file rename.
 * This prevents the "last writer wins" race where two concurrent processes each
 * open the same on-disk snapshot, insert different entries, and overwrite each
 * other's work.
 */
declare function persistDb(phrenPath: string, db: SqlJsDatabase): void;
declare function lookupCache(db: SqlJsDatabase, model: string, hash: string): number[] | null;
declare function insertCache(db: SqlJsDatabase, model: string, hash: string, embedding: number[]): void;
/**
 * Get embedding from OpenAI-compatible API.
 * Calls POST https://api.openai.com/v1/embeddings (or compatible endpoint).
 */
declare function getApiEmbedding(text: string, apiKey: string, model?: string): Promise<number[]>;
/**
 * Get embeddings for multiple texts in a single API call.
 * The OpenAI embeddings API supports array input natively.
 */
declare function getApiEmbeddings(texts: string[], apiKey: string, model?: string): Promise<number[][]>;
export declare const embeddingOps: {
    openCacheDb: typeof openCacheDb;
    persistDb: typeof persistDb;
    lookupCache: typeof lookupCache;
    insertCache: typeof insertCache;
    getApiEmbedding: typeof getApiEmbedding;
    getApiEmbeddings: typeof getApiEmbeddings;
};
/**
 * Get embedding with caching. Uses the configured provider.
 */
export declare function getCachedEmbedding(phrenPath: string, text: string, apiKey: string, model: string): Promise<number[]>;
/**
 * Get embeddings for multiple texts with caching. Batches uncached texts into single API calls.
 */
export declare function getCachedEmbeddings(phrenPath: string, texts: string[], apiKey: string, model: string): Promise<number[][]>;
/**
 * Compute cosine similarity between two vectors.
 */
export declare function cosineSimilarity(a: number[], b: number[]): number;
export type { SqlJsDatabase } from "./index-query.js";
export { encodeEmbedding, decodeEmbedding, openCacheDb };
