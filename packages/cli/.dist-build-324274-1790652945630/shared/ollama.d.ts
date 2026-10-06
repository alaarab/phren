/** @internal Exported for tests. */
export declare function prepareEmbeddingInput(text: string): string;
/**
 * Cloud embedding API support (Item 6).
 * Set PHREN_EMBEDDING_API_URL to an OpenAI-compatible /embeddings endpoint.
 * Set PHREN_EMBEDDING_API_KEY for the Authorization: Bearer header.
 * When set, cloud embedding takes priority over Ollama.
 *
 * Example (OpenAI):
 *   PHREN_EMBEDDING_API_URL=https://api.openai.com/v1
 *   PHREN_EMBEDDING_API_KEY=sk-...
 *   PHREN_EMBEDDING_MODEL=text-embedding-3-small
 */
export declare function getCloudEmbeddingUrl(): string | null;
export declare function getOllamaUrl(): string | null;
export declare function getEmbeddingModel(): string;
export declare function getExtractModel(): string;
export declare function checkOllamaAvailable(url?: string, timeoutMs?: number): Promise<boolean>;
/** Budget for the one query embedding a prompt-time vector search is allowed to wait on. */
export declare function getVectorQueryTimeoutMs(): number;
/**
 * Cheap, cached "can we embed right now?" check for latency-sensitive callers.
 *
 * Returns false immediately (no network at all) when a probe within the last
 * minute already failed, so a machine without Ollama pays at most one 800ms
 * probe per minute instead of a 10s stall per prompt. A configured cloud
 * embedding endpoint short-circuits to true — it has its own timeout and is not
 * expected to be a local process that may simply be missing.
 */
export declare function isEmbeddingBackendReachable(phrenPath: string): Promise<boolean>;
export declare function checkModelAvailable(model?: string, url?: string): Promise<boolean>;
export declare function embedText(text: string, model?: string, url?: string, timeoutMs?: number): Promise<number[] | null>;
export declare function generateText(prompt: string, model?: string, url?: string): Promise<string | null>;
export type OllamaStatus = "ready" | "no_model" | "not_running" | "disabled";
/**
 * Probe Ollama availability and model readiness in one call.
 * Returns a status enum so callers can branch on it without repeating the check logic.
 */
export declare function checkOllamaStatus(): Promise<OllamaStatus>;
export { cosineSimilarity } from "../embedding.js";
