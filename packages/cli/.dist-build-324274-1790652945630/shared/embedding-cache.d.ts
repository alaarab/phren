export interface EmbeddingCoverage {
    total: number;
    embedded: number;
    missing: number;
    pct: number;
    missingPct: number;
    state: "empty" | "cold" | "warming" | "warm";
}
/**
 * `[mtimeMs, size]` of the embeddings.json the in-memory map was last built
 * from. Derived caches (the LSH vector index) stamp *this*, not a fresh stat of
 * the file, so an index can never claim to describe bytes it never saw.
 */
export interface EmbeddingSourceMarker {
    mtimeMs: number;
    size: number;
}
export declare class EmbeddingCache {
    private phrenPath;
    private cache;
    private dirty;
    private dirtyUpserts;
    private dirtyDeletes;
    private source;
    constructor(phrenPath: string);
    load(): Promise<void>;
    /**
     * Marker for the embeddings.json revision this in-memory map reflects, or
     * null when it was never loaded from a file. Pass it to anything that
     * persists a derived view of `getAllEntries()`.
     */
    sourceMarker(): EmbeddingSourceMarker | null;
    get(docPath: string, model: string): number[] | null;
    set(docPath: string, model: string, vec: number[]): void;
    delete(docPath: string): void;
    flush(): Promise<void>;
    getAllEntries(): Array<{
        path: string;
        vec: number[];
        model: string;
    }>;
    size(): number;
    coverage(allPaths: string[]): EmbeddingCoverage;
}
export declare function formatEmbeddingCoverage(coverage: EmbeddingCoverage): string;
export declare function getEmbeddingCache(phrenPath: string): EmbeddingCache;
