import { debugLog } from "./shared.js";

const DEFAULT_OLLAMA_URL = "http://localhost:11434";
const DEFAULT_EMBEDDING_MODEL = "nomic-embed-text";
const DEFAULT_EXTRACT_MODEL = "llama3.2";

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
  const baseUrl = url ?? getOllamaUrl();
  if (!baseUrl) return null;
  const modelName = model ?? getEmbeddingModel();
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

export function packEmbedding(vec: number[]): Buffer {
  const buf = Buffer.allocUnsafe(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
  return buf;
}

export function unpackEmbedding(buf: Buffer | Uint8Array): number[] {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const len = Math.floor(b.length / 4);
  const vec: number[] = new Array(len);
  for (let i = 0; i < len; i++) vec[i] = b.readFloatLE(i * 4);
  return vec;
}
