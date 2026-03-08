import { debugLog } from "./shared.js";
import { decodeStringRow, queryRows, type SqlJsDatabase } from "./shared-index.js";
import { errorMessage } from "./utils.js";
import type { EmbeddingCache } from "./shared-embedding-cache.js";

export interface EmbeddingWarmupDeps {
  checkOllamaAvailable(): Promise<boolean>;
  embedText(text: string): Promise<number[] | null>;
  getEmbeddingModel(): string;
  getOllamaUrl(): string | null | undefined;
  sleep(ms: number): Promise<void>;
}

export type EmbeddingCacheLike = Pick<EmbeddingCache, "load" | "get" | "set" | "flush">;

/** Throttle delay between embedding requests in the background embed loop. */
export const BACKGROUND_EMBED_THROTTLE_MS = 50;

async function loadWarmupDeps(): Promise<EmbeddingWarmupDeps> {
  const { checkOllamaAvailable, embedText, getEmbeddingModel, getOllamaUrl } = await import("./shared-ollama.js");
  return {
    checkOllamaAvailable,
    embedText,
    getEmbeddingModel,
    getOllamaUrl,
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

export function startEmbeddingWarmup(
  db: SqlJsDatabase,
  cache: EmbeddingCacheLike,
  deps?: Partial<EmbeddingWarmupDeps>
): { loadPromise: Promise<void>; backgroundPromise: Promise<number> } {
  const loadPromise = cache.load().catch((err: unknown) => {
    debugLog(`Embedding cache startup load failed: ${errorMessage(err)}`);
  });
  const backgroundPromise = backgroundEmbedMissingDocs(db, cache, deps);
  return { loadPromise, backgroundPromise };
}

export async function backgroundEmbedMissingDocs(
  db: SqlJsDatabase,
  cache: EmbeddingCacheLike,
  deps?: Partial<EmbeddingWarmupDeps>
): Promise<number> {
  try {
    const resolved = { ...(await loadWarmupDeps()), ...deps };
    if (!resolved.getOllamaUrl()) return 0;
    if (!await resolved.checkOllamaAvailable()) return 0;
    const rows = queryRows(db, "SELECT path, content FROM docs", []);
    if (!rows) return 0;
    const model = resolved.getEmbeddingModel();
    let count = 0;
    for (const row of rows) {
      const [docPath, content] = decodeStringRow(row, 2, "backgroundEmbedMissingDocs");
      if (cache.get(docPath, model)) continue;
      const vec = await resolved.embedText(content.slice(0, 8000));
      if (vec) {
        cache.set(docPath, model, vec);
        count++;
        if (count % 10 === 0) await cache.flush();
      }
      await resolved.sleep(BACKGROUND_EMBED_THROTTLE_MS);
    }
    if (count > 0) await cache.flush();
    debugLog(`backgroundEmbedMissingDocs: embedded ${count} new docs`);
    return count;
  } catch (err: unknown) {
    debugLog(`backgroundEmbedMissingDocs error: ${errorMessage(err)}`);
    return 0;
  }
}
