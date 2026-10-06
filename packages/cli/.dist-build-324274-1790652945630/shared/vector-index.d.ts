/** Mirrors `EmbeddingSourceMarker`; kept structural so the modules stay decoupled. */
interface SourceMarker {
    mtimeMs: number;
    size: number;
}
interface EmbeddingEntryLike {
    path: string;
    model: string;
    vec: number[];
}
declare class PersistentVectorIndex {
    private phrenPath;
    private loaded;
    private source;
    private models;
    constructor(phrenPath: string);
    private loadFromDisk;
    private saveToDisk;
    /**
     * Build (or reuse) the LSH tables for `entries`.
     *
     * `entriesSource` is the embeddings.json revision `entries` was read from.
     * It matters because the caller's entry list can lag the file on disk: a
     * long-lived MCP server loads the embedding cache once, while hooks and
     * background reindexes keep rewriting embeddings.json underneath it. Statting
     * the file here instead would stamp the *current* revision onto tables built
     * from the *older* entry list, and every later process would then accept that
     * index as fresh — permanently invisible documents, not a rebuild loop.
     *
     * Callers that genuinely hold the file's current contents may omit it; the
     * marker then falls back to a stat, which is what it always was.
     */
    ensure(entries: EmbeddingEntryLike[], entriesSource?: SourceMarker | null): void;
    query(model: string, queryVec: number[], limit: number, eligiblePaths?: Set<string>): string[];
}
export declare function getPersistentVectorIndex(phrenPath: string): PersistentVectorIndex;
export {};
