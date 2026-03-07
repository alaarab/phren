import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import {
  debugLog,
  runtimeDir,
} from "./shared.js";

const EMBED_CACHE_FILE = "embed-cache.jsonl";

interface CacheEntry {
  hash: string;
  model: string;
  embedding: number[];
}

function getCacheFilePath(cortexPath: string): string {
  const dir = runtimeDir(cortexPath);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, EMBED_CACHE_FILE);
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function loadCache(cortexPath: string): Map<string, number[]> {
  const cacheFile = getCacheFilePath(cortexPath);
  const cache = new Map<string, number[]>();
  if (!fs.existsSync(cacheFile)) return cache;
  try {
    const lines = fs.readFileSync(cacheFile, "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      const entry = JSON.parse(line) as CacheEntry;
      cache.set(entry.hash, entry.embedding);
    }
  } catch {
    debugLog("embedding: failed to load cache");
  }
  return cache;
}

function appendCache(cortexPath: string, hash: string, model: string, embedding: number[]): void {
  const cacheFile = getCacheFilePath(cortexPath);
  const entry: CacheEntry = { hash, model, embedding };
  fs.appendFileSync(cacheFile, JSON.stringify(entry) + "\n");
}

/**
 * Get embedding from OpenAI-compatible API.
 * Calls POST https://api.openai.com/v1/embeddings (or compatible endpoint).
 */
export async function getApiEmbedding(
  text: string,
  apiKey: string,
  model: string = "text-embedding-3-small"
): Promise<number[]> {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      input: text,
      model,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Embedding API error ${response.status}: ${body}`);
  }

  const data = await response.json() as { data: Array<{ embedding: number[] }> };
  if (!data.data?.[0]?.embedding) {
    throw new Error("Embedding API returned unexpected format");
  }

  return data.data[0].embedding;
}

/**
 * Stub for local ONNX embedding — not yet supported.
 */
export async function getLocalEmbedding(_text: string): Promise<number[]> {
  throw new Error("local ONNX embedding not yet supported; use CORTEX_EMBEDDING_PROVIDER=api");
}

/**
 * Get embedding with caching. Uses the configured provider.
 */
export async function getCachedEmbedding(
  cortexPath: string,
  text: string,
  apiKey: string,
  model: string
): Promise<number[]> {
  const hash = sha256(text);
  const cache = loadCache(cortexPath);
  const cached = cache.get(hash);
  if (cached) return cached;

  const embedding = await getApiEmbedding(text, apiKey, model);
  appendCache(cortexPath, hash, model, embedding);
  return embedding;
}

/**
 * Compute cosine similarity between two vectors.
 */
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
