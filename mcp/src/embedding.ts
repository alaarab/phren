import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import {
  debugLog,
  runtimeDir,
} from "./shared.js";

const EMBED_CACHE_FILE = "embed-cache.jsonl";
const MAX_CACHE_FILE_SIZE_BYTES = 50 * 1024 * 1024;
const MAX_CACHE_ENTRIES_AFTER_TRUNCATE = 5000;

interface CacheEntry {
  hash: string;
  model: string;
  embedding: number[];
}

const cacheByFile = new Map<string, Map<string, number[]>>();

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
  const cached = cacheByFile.get(cacheFile);
  if (cached) return cached;

  const cache = new Map<string, number[]>();
  if (!fs.existsSync(cacheFile)) {
    cacheByFile.set(cacheFile, cache);
    return cache;
  }
  try {
    const lines = fs.readFileSync(cacheFile, "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      const entry = JSON.parse(line) as CacheEntry;
      cache.set(entry.hash, entry.embedding);
    }
  } catch {
    debugLog("embedding: failed to load cache");
  }
  cacheByFile.set(cacheFile, cache);
  return cache;
}

function appendCache(cortexPath: string, hash: string, model: string, embedding: number[]): void {
  const cacheFile = getCacheFilePath(cortexPath);
  const cache = loadCache(cortexPath);
  const entry: CacheEntry = { hash, model, embedding };

  try {
    if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > MAX_CACHE_FILE_SIZE_BYTES) {
      const recentLines = fs.readFileSync(cacheFile, "utf-8")
        .split("\n")
        .filter(Boolean)
        .slice(-MAX_CACHE_ENTRIES_AFTER_TRUNCATE);
      const truncatedCache = new Map<string, number[]>();
      for (const line of recentLines) {
        const parsed = JSON.parse(line) as CacheEntry;
        truncatedCache.set(parsed.hash, parsed.embedding);
      }
      cacheByFile.set(cacheFile, truncatedCache);
      fs.writeFileSync(cacheFile, recentLines.length > 0 ? `${recentLines.join("\n")}\n` : "");
    }
  } catch {
    debugLog("embedding: failed to truncate cache");
  }

  const activeCache = cacheByFile.get(cacheFile) ?? cache;
  activeCache.set(hash, embedding);
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
 * Get embeddings for multiple texts in a single API call.
 * The OpenAI embeddings API supports array input natively.
 */
export async function getApiEmbeddings(
  texts: string[],
  apiKey: string,
  model: string = "text-embedding-3-small"
): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (texts.length === 1) return [await getApiEmbedding(texts[0], apiKey, model)];

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      input: texts,
      model,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Embedding API error ${response.status}: ${body}`);
  }

  const data = await response.json() as { data: Array<{ index: number; embedding: number[] }> };
  if (!data.data?.length) {
    throw new Error("Embedding API returned unexpected format");
  }

  // Sort by index to ensure order matches input
  const sorted = data.data.sort((a, b) => a.index - b.index);
  return sorted.map(d => d.embedding);
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
  const hash = sha256(`${model}:${text}`);
  const cache = loadCache(cortexPath);
  const cached = cache.get(hash);
  if (cached) return cached;

  const embedding = await getApiEmbedding(text, apiKey, model);
  appendCache(cortexPath, hash, model, embedding);
  return embedding;
}

/**
 * Get embeddings for multiple texts with caching. Batches uncached texts into single API calls.
 */
export async function getCachedEmbeddings(
  cortexPath: string,
  texts: string[],
  apiKey: string,
  model: string
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const cache = loadCache(cortexPath);
  const results: (number[] | null)[] = texts.map(text => {
    const hash = sha256(`${model}:${text}`);
    return cache.get(hash) ?? null;
  });

  const uncachedIndices: number[] = [];
  const uncachedTexts: string[] = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i] === null) {
      uncachedIndices.push(i);
      uncachedTexts.push(texts[i]);
    }
  }

  if (uncachedTexts.length > 0) {
    const BATCH_SIZE = 20;
    for (let start = 0; start < uncachedTexts.length; start += BATCH_SIZE) {
      const batch = uncachedTexts.slice(start, start + BATCH_SIZE);
      const batchEmbeddings = await getApiEmbeddings(batch, apiKey, model);
      for (let j = 0; j < batch.length; j++) {
        const idx = uncachedIndices[start + j];
        results[idx] = batchEmbeddings[j];
        const hash = sha256(`${model}:${batch[j]}`);
        appendCache(cortexPath, hash, model, batchEmbeddings[j]);
      }
    }
  }

  return results as number[][];
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
