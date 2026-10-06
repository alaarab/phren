import * as fs from "fs";
import { debugLog, runtimeFile } from "../shared.js";

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

export async function checkOllamaAvailable(url?: string, timeoutMs = OLLAMA_HEALTH_TIMEOUT_MS): Promise<boolean> {
  // When cloud embedding is configured, report as "available" (skip Ollama probe)
  if (!url && getCloudEmbeddingUrl()) return true;
  const baseUrl = url ?? getOllamaUrl();
  if (!baseUrl) return false;
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
    clearTimeout(id);
    return res.ok;
  } catch {
    return false;
  }
}

// ── Hook-safe reachability gate ─────────────────────────────────────────────
//
// PHREN_OLLAMA_URL defaults to http://localhost:11434, so a user who never set
// up Ollama still has an embedding backend "configured". A socket that accepts
// the connection and then never answers — Ollama mid-restart, a model still
// loading, an unrelated listener — makes `embedText` sit on its 10s abort
// timeout, which is the *entire* UserPromptSubmit budget: the hook is killed
// and the prompt gets no phren context at all. Measured on a 1892-file store:
// 306ms with the backend off, 368ms with it absent, 10,376ms against a
// listening-but-silent socket.
//
// So probe first, briefly, and remember the answer on disk. Hooks are separate
// processes, so an in-process memo would never survive to help the next prompt.

const HOOK_PROBE_TIMEOUT_MS = 800;
const REACHABILITY_TTL_DEFAULT_MS = 60_000;

interface ReachabilityMarker {
  url: string;
  ok: boolean;
  at: number;
}

function reachabilityFile(phrenPath: string): string {
  return runtimeFile(phrenPath, "embedding-backend-health.json");
}

function readReachability(phrenPath: string, url: string): ReachabilityMarker | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(reachabilityFile(phrenPath), "utf8")) as Partial<ReachabilityMarker>;
    if (typeof parsed?.url !== "string" || typeof parsed.ok !== "boolean" || typeof parsed.at !== "number") return null;
    if (parsed.url !== url) return null;
    // The cost of being wrong is asymmetric and bounded either way: a stale
    // "down" costs a minute of degraded (not broken) semantic search, a stale
    // "up" costs one probe. `phren doctor` still probes live, so diagnostics
    // never read from this marker.
    if (Date.now() - parsed.at > positiveIntEnv("PHREN_EMBEDDING_HEALTH_TTL_MS", REACHABILITY_TTL_DEFAULT_MS)) return null;
    return parsed as ReachabilityMarker;
  } catch {
    return null;
  }
}

function writeReachability(phrenPath: string, marker: ReachabilityMarker): void {
  try {
    fs.writeFileSync(reachabilityFile(phrenPath), JSON.stringify(marker));
  } catch (err: unknown) {
    debugLog(`writeReachability: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Budget for the one query embedding a prompt-time vector search is allowed to wait on. */
export function getVectorQueryTimeoutMs(): number {
  return positiveIntEnv("PHREN_VECTOR_QUERY_TIMEOUT_MS", 5_000);
}

/**
 * Cheap, cached "can we embed right now?" check for latency-sensitive callers.
 *
 * Returns false immediately (no network at all) when a probe within the last
 * minute already failed, so a machine without Ollama pays at most one 800ms
 * probe per minute instead of a 10s stall per prompt. A configured cloud
 * embedding endpoint short-circuits to true — it has its own timeout and is not
 * expected to be a local process that may simply be missing.
 */
export async function isEmbeddingBackendReachable(phrenPath: string): Promise<boolean> {
  if (getCloudEmbeddingUrl()) return true;
  const url = getOllamaUrl();
  if (!url) return false;

  const cached = readReachability(phrenPath, url);
  if (cached) return cached.ok;

  const ok = await checkOllamaAvailable(url, HOOK_PROBE_TIMEOUT_MS);
  writeReachability(phrenPath, { url, ok, at: Date.now() });
  return ok;
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

export async function embedText(text: string, model?: string, url?: string, timeoutMs?: number): Promise<number[] | null> {
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
    const id = setTimeout(() => controller.abort(), timeoutMs ?? OLLAMA_EMBEDDING_TIMEOUT_MS);
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
