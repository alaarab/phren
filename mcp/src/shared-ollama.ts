import { debugLog } from "./shared.js";

const DEFAULT_OLLAMA_URL = "http://localhost:11434";
const DEFAULT_EMBEDDING_MODEL = "nomic-embed-text";
const DEFAULT_EXTRACT_MODEL = "llama3.2";

/**
 * Cloud embedding API support (Item 6).
 * Set CORTEX_EMBEDDING_API_URL to an OpenAI-compatible /embeddings endpoint.
 * Set CORTEX_EMBEDDING_API_KEY for the Authorization: Bearer header.
 * When set, cloud embedding takes priority over Ollama.
 *
 * Example (OpenAI):
 *   CORTEX_EMBEDDING_API_URL=https://api.openai.com/v1
 *   CORTEX_EMBEDDING_API_KEY=sk-...
 *   CORTEX_EMBEDDING_MODEL=text-embedding-3-small
 */
export function getCloudEmbeddingUrl(): string | null {
  const val = process.env["CORTEX_EMBEDDING_API_URL"];
  if (!val || ["off", "0", "false", "no"].includes(val.trim().toLowerCase())) return null;
  return val.trim().replace(/\/$/, ""); // strip trailing slash
}

export function getCloudEmbeddingKey(): string | null {
  return process.env["CORTEX_EMBEDDING_API_KEY"] ?? null;
}

/** Embed text via OpenAI-compatible /embeddings endpoint. */
async function embedTextCloud(text: string, baseUrl: string, model: string, apiKey: string | null): Promise<number[] | null> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, input: text.slice(0, 8000) }),
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
  const val = process.env["CORTEX_OLLAMA_URL"];
  if (val !== undefined && ["off", "0", "false", "no"].includes(val.trim().toLowerCase())) return null;
  return val ?? DEFAULT_OLLAMA_URL;
}

export function getEmbeddingModel(): string {
  return process.env["CORTEX_EMBEDDING_MODEL"] ?? DEFAULT_EMBEDDING_MODEL;
}

export function getExtractModel(): string {
  return process.env["CORTEX_EXTRACT_MODEL"] ?? DEFAULT_EXTRACT_MODEL;
}

export async function checkOllamaAvailable(url?: string): Promise<boolean> {
  // When cloud embedding is configured, report as "available" (skip Ollama probe)
  if (!url && getCloudEmbeddingUrl()) return true;
  const baseUrl = url ?? getOllamaUrl();
  if (!baseUrl) return false;
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 2000);
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
    const id = setTimeout(() => controller.abort(), 2000);
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

  // Cloud embedding takes priority when CORTEX_EMBEDDING_API_URL is set
  const cloudUrl = url ? null : getCloudEmbeddingUrl();
  if (cloudUrl) {
    return embedTextCloud(text, cloudUrl, modelName, getCloudEmbeddingKey());
  }

  const baseUrl = url ?? getOllamaUrl();
  if (!baseUrl) return null;
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(`${baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelName, input: text.slice(0, 8000) }),
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
    const id = setTimeout(() => controller.abort(), 60000);
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

