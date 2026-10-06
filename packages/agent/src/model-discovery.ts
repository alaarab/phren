/**
 * Provider model discovery. This module only performs bounded GET requests;
 * it never starts a completion. The on-disk cache is deliberately separate
 * from credentials and contains provider metadata only.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { codexConfiguredModel } from "./providers/codex-auth.js";
import { configuredProviders, resolveConnector } from "./provider-connectors.js";
import {
  getBuiltinModels,
  getDiscoveredModels,
  normalizeReasoningEffort,
  registerDiscoveredModels,
  type ModelCatalogEntry,
  type ModelPricing,
  type ProviderId,
  type ReasoningEffort,
} from "./models.js";

export const MODEL_CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_ROWS = 400;
const MAX_ANTHROPIC_PAGES = 4;
const runtimeStatuses = new Map<string, CatalogStatus>();

export type CatalogStatus = "live" | "cached" | "stale" | "offline";

export interface ProviderCatalog {
  provider: ProviderId;
  models: ModelCatalogEntry[];
  status: CatalogStatus;
  fetchedAt?: string;
  error?: string;
  baseUrl?: string;
}

interface CacheEntry {
  provider: ProviderId;
  cacheKey: string;
  fetchedAt: string;
  models: ModelCatalogEntry[];
}

interface CacheFile {
  version: 1;
  entries: Record<string, CacheEntry>;
}

export interface DiscoveryOptions {
  baseUrl?: string;
  force?: boolean;
  now?: number;
  fetchImpl?: typeof fetch;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record).filter((row): row is Record<string, unknown> => !!row) : [];
}

function modelId(row: Record<string, unknown>): string | undefined {
  return string(row.id) ?? string(row.slug) ?? string(row.model) ?? string(row.name);
}

function label(row: Record<string, unknown>, id: string): string {
  return string(row.display_name) ?? string(row.displayName) ?? string(row.name) ?? id;
}

function supportedEfforts(value: unknown): ReasoningEffort[] {
  const values: unknown[] = Array.isArray(value) ? value : [];
  const seen = new Set<ReasoningEffort>();
  for (const item of values) {
    const raw = typeof item === "string" ? item : string(record(item)?.effort) ?? string(record(item)?.id) ?? string(record(item)?.name);
    const lower = raw?.toLowerCase();
    // ultra is a CLI orchestration level, not an API effort. A provider may
    // advertise max distinctly from xhigh.
    const effort: ReasoningEffort | undefined = lower === "max" ? "max" : normalizeReasoningEffort(raw);
    if (effort && effort !== "none") seen.add(effort);
  }
  return (["minimal", "low", "medium", "high", "xhigh", "max"] as ReasoningEffort[]).filter((level) => seen.has(level));
}

function catalogEffort(raw: string | undefined): ReasoningEffort | undefined {
  const lower = raw?.toLowerCase();
  if (lower === "max") return "max";
  return normalizeReasoningEffort(raw);
}

function anthropicEfforts(row: Record<string, unknown>): ReasoningEffort[] {
  const capabilities = record(row.capabilities);
  const effort = record(capabilities?.effort);
  if (effort?.supported !== true) return [];
  return supportedEfforts(
    ["minimal", "low", "medium", "high", "xhigh", "max"].map((level) => {
      const detail = record(effort[level]);
      return detail?.supported === true ? level : undefined;
    }),
  );
}

function advertisedEfforts(row: Record<string, unknown>, provider?: ProviderId): ReasoningEffort[] {
  // These fields are only used when the provider explicitly supplies levels.
  // A boolean `reasoning: true` or a supported_parameters entry is not enough.
  for (const value of [
    row.supported_reasoning_levels,
    row.supported_reasoning_efforts,
    row.reasoning_efforts,
    row.effort_levels,
    record(row.reasoning)?.supported_efforts,
    record(row.reasoning)?.effort_levels,
    record(row.capabilities)?.supported_reasoning_levels,
    record(row.capabilities)?.effort_levels,
    record(record(row.capabilities)?.effort)?.levels,
  ]) {
    const parsed = supportedEfforts(value);
    if (parsed.length > 0) return parsed;
  }
  const anthropic = anthropicEfforts(row);
  if (anthropic.length > 0) return anthropic;
  if (provider === "openrouter") {
    const parameters = Array.isArray(row.supported_parameters) ? row.supported_parameters : [];
    if (parameters.some((item) => item === "reasoning_effort")) return ["low", "medium", "high"];
  }
  return [];
}

function defaultEffort(row: Record<string, unknown>, range: ReasoningEffort[]): ReasoningEffort | null {
  const raw = string(row.default_reasoning_level) ?? string(row.default_reasoning_effort) ?? string(row.default_effort)
    ?? string(record(row.reasoning)?.default_effort) ?? string(record(row.capabilities)?.default_effort);
  const effort = catalogEffort(raw);
  return effort && (effort === "none" || range.includes(effort)) ? effort : null;
}

function pricing(row: Record<string, unknown>): ModelPricing | undefined {
  const source = record(row.pricing) ?? row;
  const input = number(source.prompt) ?? number(source.input);
  const output = number(source.completion) ?? number(source.output);
  if (input === undefined || output === undefined) return undefined;
  const cache = number(source.cache_read) ?? number(source.cacheRead) ?? number(source.input_cache_read);
  // Provider catalogues report dollars per token. Do not guess units from
  // the magnitude: an expensive per-token price is still per-token.
  return { inputPer1M: input * 1_000_000, outputPer1M: output * 1_000_000, ...(cache !== undefined ? { cacheReadPer1M: cache * 1_000_000 } : {}) };
}

function vision(row: Record<string, unknown>): boolean | undefined {
  const architecture = record(row.architecture);
  const modalities = architecture?.input_modalities ?? row.input_modalities ?? row.inputModalities;
  if (!Array.isArray(modalities)) {
    const image = record(record(row.capabilities)?.image_input);
    return typeof image?.supported === "boolean" ? image.supported : undefined;
  }
  return modalities.some((item) => item === "image");
}

function entry(provider: ProviderId, row: Record<string, unknown>): ModelCatalogEntry | undefined {
  const id = modelId(row);
  if (!id || id.length > 200) return undefined;
  let reasoningRange = advertisedEfforts(row, provider);
  const capabilities = record(row.capabilities);
  const thinking = record(capabilities?.thinking) ?? record(row.thinking);
  const adaptive = record(record(thinking?.types)?.adaptive);
  const budget = record(record(thinking?.types)?.enabled)?.supported === true;
  if (provider === "anthropic" && !reasoningRange.length && budget) reasoningRange = ["low", "medium", "high"];
  const reasoningMode = adaptive?.supported === true || string(thinking?.type) === "adaptive" || string(capabilities?.reasoning_mode) === "adaptive"
    ? "adaptive" as const : budget ? "budget" as const : undefined;
  const contextWindow = number(row.context_window) ?? number(row.context_length) ?? number(row.max_input_tokens);
  const topProvider = record(row.top_provider);
  const maxOutputTokens = number(topProvider?.max_completion_tokens) ?? number(row.max_output_tokens) ?? number(row.max_completion_tokens) ?? number(row.max_tokens);
  const modelPricing = pricing(row);
  const modelVision = vision(row);
  return {
    id,
    provider,
    label: label(row, id),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    reasoningDefault: defaultEffort(row, reasoningRange),
    reasoningRange,
    ...(reasoningMode ? { reasoningMode } : {}),
    ...(modelPricing ? { pricing: modelPricing } : {}),
    ...(modelVision !== undefined ? { vision: modelVision } : {}),
  };
}

function unique(entries: Array<ModelCatalogEntry | undefined>): ModelCatalogEntry[] {
  const seen = new Set<string>();
  return entries.filter((item): item is ModelCatalogEntry => {
    if (!item || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  }).slice(0, MAX_ROWS);
}

export function parseCodexModels(raw: unknown): ModelCatalogEntry[] {
  const root = record(raw);
  const list = Array.isArray(raw) ? raw : root?.models;
  return unique(rows(list).map((row) => {
    const levels = supportedEfforts(row.supported_reasoning_levels);
    const id = string(row.slug) ?? string(row.id);
    if (!id) return undefined;
    return {
      id,
      provider: "openai-codex",
      label: string(row.display_name) ?? id,
      ...(number(row.context_window) !== undefined ? { contextWindow: number(row.context_window) } : {}),
      reasoningDefault: defaultEffort(row, levels),
      reasoningRange: levels,
      ...(Array.isArray(row.input_modalities) ? { vision: row.input_modalities.some((item) => item === "image") } : {}),
    } satisfies ModelCatalogEntry;
  }));
}

export function parseOpenRouterModels(raw: unknown): ModelCatalogEntry[] {
  const root = record(raw);
  return unique(rows(root?.data).filter((row) => {
    const architecture = record(row.architecture);
    const modalities = architecture?.input_modalities;
    const parameters = row.supported_parameters;
    const hasText = Array.isArray(modalities) && modalities.some((item) => item === "text");
    const hasTools = Array.isArray(parameters) && parameters.some((item) => item === "tools" || item === "tool_choice");
    return hasText && hasTools;
  }).map((row) => entry("openrouter", row)));
}

function readCodexModels(): ModelCatalogEntry[] {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  try { return parseCodexModels(JSON.parse(fs.readFileSync(path.join(codexHome, "models_cache.json"), "utf8"))); } catch { return []; }
}

export function parseOpenAiModels(raw: unknown, codexModels: ModelCatalogEntry[] = readCodexModels()): ModelCatalogEntry[] {
  const root = record(raw);
  const codexById = new Map([...getBuiltinModels("openai"), ...codexModels.filter((model) => model.provider === "openai-codex")].map((model) => [model.id, model]));
  return unique(rows(root?.data).filter((row) => {
    const id = modelId(row)?.toLowerCase() ?? "";
    if (/embedding|embed|audio|transcri|whisper|dall-e|image|moderation|realtime/.test(id)) return false;
    const architecture = record(row.architecture);
    const modalities = architecture?.input_modalities ?? row.input_modalities;
    const outputs = architecture?.output_modalities ?? row.output_modalities;
    return (!Array.isArray(modalities) || modalities.some((item) => item === "text"))
      && (!Array.isArray(outputs) || outputs.some((item) => item === "text"));
  }).map((row) => {
    const model = entry("openai", row);
    const codex = model ? codexById.get(model.id) : undefined;
    return model && codex ? {
      ...model,
      ...(codex.contextWindow !== undefined ? { contextWindow: codex.contextWindow } : {}),
      reasoningDefault: codex.reasoningDefault,
      reasoningRange: codex.reasoningRange,
      ...(codex.vision !== undefined ? { vision: codex.vision } : {}),
    } : model;
  }));
}

export function parseAnthropicModels(raw: unknown): ModelCatalogEntry[] {
  const root = record(raw);
  return unique(rows(root?.data).map((row) => entry("anthropic", row)));
}

export function parseDeepSeekModels(raw: unknown): ModelCatalogEntry[] {
  const root = record(raw);
  return unique(rows(root?.data ?? raw).map((row) => {
    const model = entry("deepseek", row);
    if (!model || !/^deepseek-(?:v4|flash$|pro$)/i.test(model.id) || model.reasoningRange.length > 0) return model;
    // DeepSeek V4 documents low/high/max. Older reasoner models use the
    // budget-mode contract and must not be presented as invented efforts.
    return { ...model, reasoningRange: ["low", "high", "max"] as ReasoningEffort[] };
  }));
}

export function parseOllamaModels(raw: unknown): ModelCatalogEntry[] {
  const root = record(raw);
  return unique(rows(root?.models).map((row) => {
    const id = string(row.name) ?? string(row.model);
    if (!id) return undefined;
    const details = record(row.details);
    return {
      id,
      provider: "ollama",
      label: id,
      ...(number(row.context_length) ? { contextWindow: number(row.context_length) } : {}),
      reasoningDefault: null,
      reasoningRange: [],
      ...(details?.families && Array.isArray(details.families) && details.families.some((family) => /clip|vision/i.test(String(family))) ? { vision: true } : {}),
    } satisfies ModelCatalogEntry;
  }));
}

function cachePath(): string {
  return path.join(os.homedir(), ".phren-agent", "model-catalog.json");
}

function readCache(): CacheFile {
  try {
    const parsed = record(JSON.parse(fs.readFileSync(cachePath(), "utf8")));
    if (parsed?.version !== 1) return { version: 1, entries: {} };
    const entries: Record<string, CacheEntry> = {};
    for (const [key, value] of Object.entries(record(parsed.entries) ?? {})) {
      const candidate = record(value);
      const provider = string(candidate?.provider) as ProviderId | undefined;
      const fetchedAt = string(candidate?.fetchedAt);
      const models = candidate?.models;
      if (!provider || !fetchedAt || !Number.isFinite(Date.parse(fetchedAt)) || !Array.isArray(models)) continue;
      if (!(["openai", "openai-codex", "openrouter", "anthropic", "deepseek", "ollama", "openai-compat"] as string[]).includes(provider)) continue;
      const validModels = models.filter((model): model is ModelCatalogEntry => {
        const row = record(model);
        return !!row && string(row.id) !== undefined && row.provider === provider
          && typeof row.label === "string" && Array.isArray(row.reasoningRange)
          && row.reasoningRange.every(level => typeof level === "string" && normalizeReasoningEffort(level) === level)
          && (row.reasoningDefault === null || (typeof row.reasoningDefault === "string" && normalizeReasoningEffort(row.reasoningDefault) === row.reasoningDefault));
      });
      entries[key] = { provider, cacheKey: string(candidate?.cacheKey) ?? key, fetchedAt, models: validModels.slice(0, MAX_ROWS) };
    }
    return { version: 1, entries };
  } catch {
    return { version: 1, entries: {} };
  }
}

function writeCache(cache: CacheFile): void {
  try {
    const file = cachePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(cache, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch { /* discovery still works for this invocation */ }
}

function writeCacheEntry(entry: CacheEntry): void {
  const latest = readCache();
  latest.entries[entry.cacheKey] = entry;
  writeCache(latest);
}

function safeCacheKey(provider: ProviderId, baseUrl: string | undefined): string {
  const normalized = (baseUrl ?? "").replace(/[?#].*$/, "").replace(/^https?:\/\/[^/]+@/i, "https://");
  return `${provider}-${createHash("sha256").update(normalized).digest("hex").slice(0, 16)}`;
}

function baseUrlFor(provider: ProviderId, override?: string): string | undefined {
  return resolveConnector(provider, override).baseUrl;
}

export function credentialedProviders(env: NodeJS.ProcessEnv = process.env): ProviderId[] {
  return configuredProviders(env);
}

async function getJson(fetchImpl: typeof fetch, url: string, headers: Record<string, string>, signal: AbortSignal): Promise<unknown> {
  const response = await fetchImpl(url, { headers, signal, redirect: "error" });
  const reader = response.body?.getReader();
  let text = "";
  if (reader) {
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    let total = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Error("model catalogue response is too large");
        }
        chunks.push(decoder.decode(next.value, { stream: true }));
      }
      chunks.push(decoder.decode());
      text = chunks.join("");
    } finally {
      reader.releaseLock();
    }
  } else {
    text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw new Error("model catalogue response is too large");
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  try { return JSON.parse(text); } catch { throw new Error("model catalogue returned invalid JSON"); }
}

function headersFor(provider: ProviderId, key: string | undefined): Record<string, string> {
  if (provider === "anthropic") return { "x-api-key": key ?? "", "anthropic-version": "2023-06-01" };
  return key ? { Authorization: `Bearer ${key}` } : {};
}

async function fetchCatalog(provider: ProviderId, baseUrl: string, key: string | undefined, fetchImpl: typeof fetch): Promise<ModelCatalogEntry[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    if (provider === "openai-codex") {
      const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
      try { return parseCodexModels(JSON.parse(fs.readFileSync(path.join(codexHome, "models_cache.json"), "utf8"))); } catch { return []; }
    }
    if (provider === "anthropic") {
      const all: Record<string, unknown>[] = [];
      let after: string | undefined;
      for (let page = 0; page < MAX_ANTHROPIC_PAGES; page++) {
        const query = new URLSearchParams({ limit: "100", ...(after ? { after_id: after } : {}) });
        const raw = record(await getJson(fetchImpl, `${baseUrl}/v1/models?${query}`, headersFor(provider, key), controller.signal));
        all.push(...rows(raw?.data));
        if (raw?.has_more !== true) break;
        after = string(raw.last_id);
        if (!after) break;
      }
      return parseAnthropicModels({ data: all });
    }
    const url = provider === "ollama" ? `${baseUrl}/api/tags`
      : provider === "openrouter" ? `${baseUrl}/models?supported_parameters=tools&output_modalities=text`
        : `${baseUrl}/models`;
    const raw = await getJson(fetchImpl, url, headersFor(provider, key), controller.signal);
    if (provider === "openrouter") return parseOpenRouterModels(raw);
    if (provider === "openai" || provider === "openai-compat") return parseOpenAiModels(raw, provider === "openai" ? readCodexModels() : []).map((item) => ({ ...item, provider }));
    if (provider === "deepseek") return parseDeepSeekModels(raw);
    return parseOllamaModels(raw);
  } finally {
    clearTimeout(timer);
  }
}

export async function discoverProvider(provider: ProviderId, options: DiscoveryOptions = {}): Promise<ProviderCatalog> {
  const connector = resolveConnector(provider, options.baseUrl);
  const baseUrl = connector.baseUrl;
  const key = safeCacheKey(provider, baseUrl);
  const now = options.now ?? Date.now();
  const cache = readCache();
  const cached = cache.entries[key];
  const cachedModels = cached?.models ?? getDiscoveredModels(provider) ?? [];
  const fetchedAt = cached?.fetchedAt;
  const fresh = cached && now - Date.parse(cached.fetchedAt) < MODEL_CACHE_TTL_MS;
  if (!options.force && fresh) {
    registerDiscoveredModels(provider, cached.models, "cache");
    runtimeStatuses.set(key, "cached");
    return { provider, models: cached.models, status: "cached", fetchedAt, baseUrl };
  }
  if (provider !== "openai-codex" && !baseUrl) {
    runtimeStatuses.set(key, cached ? "stale" : "offline");
    return { provider, models: cachedModels, status: cached ? "stale" : "offline", ...(fetchedAt ? { fetchedAt } : {}), error: "provider endpoint is not configured" };
  }
  try {
    const models = await fetchCatalog(provider, baseUrl ?? "", connector.apiKey, options.fetchImpl ?? fetch);
    if (models.length === 0) throw new Error("provider returned no model rows");
    registerDiscoveredModels(provider, models, "live");
    runtimeStatuses.set(key, "live");
    writeCacheEntry({ provider, cacheKey: key, fetchedAt: new Date(now).toISOString(), models });
    return { provider, models, status: "live", fetchedAt: new Date(now).toISOString(), baseUrl };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (cached) {
      registerDiscoveredModels(provider, cached.models, "cache");
      runtimeStatuses.set(key, "stale");
      return { provider, models: cached.models, status: "stale", fetchedAt, error: message, baseUrl };
    }
    runtimeStatuses.set(key, "offline");
    const fallback = getBuiltinModels(provider);
    registerDiscoveredModels(provider, fallback, "fallback");
    return { provider, models: fallback.map(model => ({ ...model, catalogSource: "fallback" as const })), status: "offline", error: message, baseUrl };
  }
}

export async function discoverAllProviders(options: DiscoveryOptions = {}): Promise<ProviderCatalog[]> {
  return Promise.all(credentialedProviders().map((provider) => discoverProvider(provider, provider === "openai-compat" || provider === "deepseek" ? options : { ...options, baseUrl: undefined })));
}

/** Refreshes the cache for the Hook/CLI JSON catalog, without completions. */
export async function refreshModelCatalogs(force = false): Promise<ProviderCatalog[]> {
  return discoverAllProviders({ force });
}

export function catalogStatusFor(provider: ProviderId): CatalogStatus {
  const key = safeCacheKey(provider, baseUrlFor(provider));
  const runtime = runtimeStatuses.get(key);
  if (runtime) return runtime;
  const cached = readCache().entries[key];
  if (cached && Date.now() - Date.parse(cached.fetchedAt) < MODEL_CACHE_TTL_MS) return "cached";
  if (cached) return "stale";
  return "offline";
}

export function codexCatalogConfiguredModel(): string | undefined {
  return codexConfiguredModel(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}
