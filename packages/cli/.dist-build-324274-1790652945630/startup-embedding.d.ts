import { type SqlJsDatabase } from "./shared/index.js";
import type { EmbeddingCache } from "./shared/embedding-cache.js";
export interface EmbeddingWarmupDeps {
    checkOllamaAvailable(): Promise<boolean>;
    embedText(text: string): Promise<number[] | null>;
    getEmbeddingModel(): string;
    getOllamaUrl(): string | null | undefined;
    sleep(ms: number): Promise<void>;
}
export type EmbeddingCacheLike = Pick<EmbeddingCache, "load" | "get" | "set" | "flush">;
export declare function startEmbeddingWarmup(db: SqlJsDatabase, cache: EmbeddingCacheLike, deps?: Partial<EmbeddingWarmupDeps>): {
    loadPromise: Promise<void>;
    backgroundPromise: Promise<number>;
};
export declare function backgroundEmbedMissingDocs(db: SqlJsDatabase, cache: EmbeddingCacheLike, deps?: Partial<EmbeddingWarmupDeps>): Promise<number>;
