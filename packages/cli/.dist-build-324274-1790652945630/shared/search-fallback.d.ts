import type { SqlJsDatabase, DocRow } from "./index.js";
/** @internal Exported for tests. */
export declare function deriveVectorDocIdentity(phrenPath: string, fullPath: string): {
    project: string;
    filename: string;
    relFile: string;
};
/** Invalidate the DF cache. Call after a full index rebuild. */
export declare function invalidateDfCache(): void;
export declare function deterministicSeed(text: string): number;
/**
 * Cosine fallback search: when FTS5 returns fewer than COSINE_FALLBACK_THRESHOLD results,
 * load all docs and rank by TF-IDF cosine similarity.
 * Only activated when PHREN_FEATURE_HYBRID_SEARCH=1 and corpus size <= COSINE_MAX_CORPUS.
 * Returns DocRow[] ranked by similarity (threshold > COSINE_SIMILARITY_MIN), excluding already-found rowids.
 */
export declare function cosineFallback(db: SqlJsDatabase, query: string, excludeRowids: Set<number>, limit: number): DocRow[];
/**
 * Vector-based semantic search fallback using pre-computed Ollama embeddings.
 * Only runs when Ollama is configured (PHREN_OLLAMA_URL is set or defaults).
 * Returns DocRow[] sorted by cosine similarity, above 0.5 threshold.
 */
export declare function vectorFallback(phrenPath: string, query: string, excludePaths: Set<string>, limit: number, project?: string | null): Promise<DocRow[]>;
