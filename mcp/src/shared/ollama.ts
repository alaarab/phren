import { debugLog } from "../shared.js";

const DEFAULT_OLLAMA_URL = "http://localhost:11434";
const DEFAULT_EMBEDDING_MODEL = "nomic-embed-text";
const DEFAULT_EXTRACT_MODEL = "llama3.2";
const MAX_EMBED_INPUT_CHARS = 6000;

const CLOUD_EMBEDDING_TIMEOUT_MS = 15_000;
const OLLAMA_HEALTH_TIMEOUT_MS = 2_000;
const OLLAMA_EMBEDDING_TIMEOUT_MS = 10_000;
const OLLAMA_GENERATE_TIMEOUT_MS = 60_000;

/** @internal Exported for tests. */
export function prepareEmbeddingInput(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, " "))
    .replace(/`([^`]+)`/g, " $1 ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, " $1 ")
    .replace(/\|/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_EMBED_INPUT_CHARS);
}

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
export function getCloudEmbeddingUrl(): string | null {
  const val = process.env["PHREN_EMBEDDING_API_URL"];
  if (!val || ["off", "0", "false", "no"].includes(val.trim().toLowerCase())) return null;
  return val.trim().replace(/\/$/, ""); // strip trailing slash
}

function getCloudEmbeddingKey(): string | null {
  return process.env["PHREN_EMBEDDING_API_KEY"] ?? null;
}

/** Embed text via OpenAI-compatible /embeddings endpoint. */
async function embedTextCloud(input: string, baseUrl: string, model: string, apiKey: string | null): Promise<number[] | null> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), CLOUD_EMBEDDING_TIMEOUT_MS);
    const res = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, input }),
      signal: controller.signal,
    });
    clearTimeout(id);
    if (!res.ok) {
      debugLog(`embedTextCloud: API returned ${res.status}`);
      return null;
    }
    const data = await res.json() as { data?: Array<{ embedding?: number[] }> };
    return data.data?.[0]?.embedding ?? null;
  } catch (e) {
    debugLog(`embedTextCloud error: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

export function getOllamaUrl(): string | null {
  const val = process.env["PHREN_OLLAMA_URL"];
  if (val !== undefined && ["off", "0", "false", "no"].includes(val.trim().toLowerCase())) return null;
  return val ?? DEFAULT_OLLAMA_URL;
}

export function getEmbeddingModel(): string {
  return process.env["PHREN_EMBEDDING_MODEL"] ?? DEFAULT_EMBEDDING_MODEL;
}

export function getExtractModel(): string {
  return process.env["PHREN_EXTRACT_MODEL"] ?? DEFAULT_EXTRACT_MODEL;
}

export async function checkOllamaAvailable(url?: string): Promise<boolean> {
  // When cloud embedding is configured, report as "available" (skip Ollama probe)
  if (!url && getCloudEmbeddingUrl()) return true;
  const baseUrl = url ?? getOllamaUrl();
  if (!baseUrl) return false;
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), OLLAMA_HEALTH_TIMEOUT_MS);
    const res = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
    clearTimeout(id);
    return res.ok;
  } catch {
    return false;
  }
}

export async function checkModelAvailable(model?: string, url?: string): Promise<boolean> {
  // When cloud embedding is configured, assume model is available (no /api/tags equivalent)
  if (!url && getCloudEmbeddingUrl()) return true;
  const baseUrl = url ?? getOllamaUrl();
  if (!baseUrl) return false;
  const modelName = model ?? getEmbeddingModel();
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), OLLAMA_HEALTH_TIMEOUT_MS);
    const res = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
    clearTimeout(id);
    if (!res.ok) return false;
    const data = await res.json() as { models?: Array<{ name: string }> };
    return (data.models ?? []).some(m => m.name.startsWith(modelName));
  } catch {
    return false;
  }
}

export async function embedText(text: string, model?: string, url?: string): Promise<number[] | null> {
  const modelName = model ?? getEmbeddingModel();
  const input = prepareEmbeddingInput(text);
  if (!input) return null;

  // Cloud embedding takes priority when PHREN_EMBEDDING_API_URL is set
  const cloudUrl = url ? null : getCloudEmbeddingUrl();
  if (cloudUrl) {
    return embedTextCloud(input, cloudUrl, modelName, getCloudEmbeddingKey());
  }

  const baseUrl = url ?? getOllamaUrl();
  if (!baseUrl) return null;
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), OLLAMA_EMBEDDING_TIMEOUT_MS);
    const res = await fetch(`${baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelName, input }),
      signal: controller.signal,
    });
    clearTimeout(id);
    if (!res.ok) {
      debugLog(`embedText: Ollama returned ${res.status}`);
      return null;
    }
    const data = await res.json() as { embeddings?: number[][] };
    return data.embeddings?.[0] ?? null;
  } catch (e) {
    debugLog(`embedText error: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

export async function generateText(prompt: string, model?: string, url?: string): Promise<string | null> {
  const baseUrl = url ?? getOllamaUrl();
  if (!baseUrl) return null;
  const modelName = model ?? getExtractModel();
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), OLLAMA_GENERATE_TIMEOUT_MS);
    const res = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelName, prompt, stream: false }),
      signal: controller.signal,
    });
    clearTimeout(id);
    if (!res.ok) {
      debugLog(`generateText: Ollama returned ${res.status}`);
      return null;
    }
    const data = await res.json() as { response?: string };
    return data.response ?? null;
  } catch (e) {
    debugLog(`generateText error: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

export type OllamaStatus = "ready" | "no_model" | "not_running" | "disabled";

/**
 * Probe Ollama availability and model readiness in one call.
 * Returns a status enum so callers can branch on it without repeating the check logic.
 */
export async function checkOllamaStatus(): Promise<OllamaStatus> {
  if (!getOllamaUrl()) return "disabled";
  const ollamaUp = await checkOllamaAvailable();
  if (!ollamaUp) return "not_running";
  const modelReady = await checkModelAvailable();
  return modelReady ? "ready" : "no_model";
}

export { cosineSimilarity } from "../embedding.js";
