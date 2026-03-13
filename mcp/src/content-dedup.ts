import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { debugLog, runtimeFile, KNOWN_OBSERVATION_TAGS } from "./shared.js";
import { isFeatureEnabled, safeProjectPath } from "./utils.js";
import { UNIVERSAL_TECH_TERMS_RE, EXTRA_ENTITY_PATTERNS } from "./cortex-core.js";
import { isInactiveFindingLine } from "./finding-lifecycle.js";

// ── LLM provider abstraction ────────────────────────────────────────────────

const MAX_CACHE_ENTRIES = 500;

type RawCacheEntry<T> = { result: T; ts?: number };

// In-memory format: ts is always normalized by loadCache.
type TimestampedCacheEntry<T> = { result: T; ts: number };

function loadCache<T>(cachePath: string): Record<string, TimestampedCacheEntry<T>> {
  if (!fs.existsSync(cachePath)) return {};
  const raw = JSON.parse(fs.readFileSync(cachePath, "utf8")) as Record<string, RawCacheEntry<T>>;
  const now = Date.now();
  const normalized: Record<string, TimestampedCacheEntry<T>> = {};
  for (const [key, entry] of Object.entries(raw)) {
    const ts = typeof entry.ts === "number" ? entry.ts : now;
    normalized[key] = { result: entry.result, ts };
  }
  return normalized;
}

function trimCache<T>(cache: Record<string, TimestampedCacheEntry<T>>): void {
  const entries = Object.entries(cache);
  if (entries.length <= MAX_CACHE_ENTRIES) return;

  entries
    .sort(([, a], [, b]) => a.ts - b.ts)
    .slice(0, entries.length - MAX_CACHE_ENTRIES)
    .forEach(([key]) => {
      delete cache[key];
    });
}

function persistCache<T>(cachePath: string, cache: Record<string, TimestampedCacheEntry<T>>): void {
  trimCache(cache);
  fs.writeFileSync(cachePath, JSON.stringify(cache));
}

/**
 * Generic cache-through helper: load cache → check TTL → touch timestamp → persist → return.
 * If the key is cached and within TTL, returns the cached result.
 * Otherwise, calls `compute()` to produce a fresh result, caches it, and returns it.
 */
async function withCache<T>(
  cachePath: string,
  key: string,
  ttlMs: number,
  compute: () => Promise<T>,
): Promise<T> {
  // Check cache
  try {
    const cache = loadCache<T>(cachePath);
    if (cache[key] && Date.now() - cache[key].ts < ttlMs) {
      cache[key].ts = Date.now();
      persistCache(cachePath, cache);
      return cache[key].result;
    }
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] withCache load (${path.basename(cachePath)}): ${err instanceof Error ? err.message : String(err)}\n`);
  }

  const result = await compute();

  // Persist result
  try {
    const cache = loadCache<T>(cachePath);
    cache[key] = { result, ts: Date.now() };
    persistCache(cachePath, cache);
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] withCache persist (${path.basename(cachePath)}): ${err instanceof Error ? err.message : String(err)}\n`);
  }

  return result;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

const LLM_TIMEOUT_MS = 10_000;

function parseOpenAiResponse(data: unknown): string {
  const d = data as { choices?: Array<{ message?: { content?: string } }> };
  return d.choices?.[0]?.message?.content?.trim() ?? "";
}

/** POST to an LLM endpoint with a combined per-call timeout + parent abort relay. */
async function fetchLlm(
  url: string,
  init: Omit<RequestInit, "signal">,
  signal: AbortSignal | undefined,
  parseResponse: (data: unknown) => string,
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
  if (!response.ok) throw new Error(`LLM API error: ${response.status}`);
  return parseResponse(await response.json());
}

// Default maxTokens is 10 — callers that only need YES/NO or CONFLICT/OK responses
// need just 3-5 tokens. Callers expecting longer output pass an explicit override (e.g. 60).
export async function callLlm(prompt: string, signal?: AbortSignal, maxTokens = 10): Promise<string> {
  // Check abort before starting any work to avoid unnecessary API calls
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  const endpoint = process.env.CORTEX_LLM_ENDPOINT;
  const customKey = process.env.CORTEX_LLM_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const model = process.env.CORTEX_LLM_MODEL;

  if (endpoint) {
    // Custom endpoint: use CORTEX_LLM_KEY, fall back to any available key
    const key = customKey || openaiKey || anthropicKey || "";
    return fetchLlm(
      `${endpoint.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model: model || "gpt-4o-mini", messages: [{ role: "user", content: prompt }], max_tokens: maxTokens, temperature: 0 }),
      },
      signal,
      parseOpenAiResponse,
    );
  } else if (anthropicKey) {
    // Anthropic REST API fallback (no SDK required)
    return fetchLlm(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: model || "claude-haiku-4-5-20251001", max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
      },
      signal,
      (data) => {
        const d = data as { content?: Array<{ type: string; text?: string }> };
        const block = d.content?.[0];
        return (block?.type === "text" ? block.text ?? "" : "").trim();
      },
    );
  } else if (openaiKey) {
    // OpenAI REST API fallback
    return fetchLlm(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${openaiKey}` },
        body: JSON.stringify({ model: model || "gpt-4o-mini", messages: [{ role: "user", content: prompt }], max_tokens: maxTokens, temperature: 0 }),
      },
      signal,
      parseOpenAiResponse,
    );
  } else {
    // No LLM configured — return empty to signal "not duplicate" / "no conflict"
    return "";
  }
}

// ── Cache TTL constants ───────────────────────────────────────────────────────

const DEDUP_CACHE_TTL_MS = 86_400_000;   // 1 day
const CONFLICT_CACHE_TTL_MS = 7 * 86_400_000; // 7 days

// ── Metadata stripping helpers ────────────────────────────────────────────────

/**
 * Strip HTML comments only (timestamp metadata, citations).
 * Use this when you only need to remove <!-- ... --> markers.
 */
function stripHtmlComments(s: string): string {
  return s.replace(/<!--.*?-->/gs, "");
}

/**
 * Strip all common finding metadata:
 * - HTML comments: <!-- ... -->
 * - "migrated from" annotations: (migrated from ...)
 * - Leading bullet dash: "- " at the start of the string
 */
export function stripMetadata(s: string): string {
  return s
    .replace(/<!--.*?-->/gs, "")
    .replace(/\(migrated from [^)]+\)/gi, "")
    .replace(/^-\s+/, "");
}

// Stop words for lightweight semantic overlap checks
const DEDUP_STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "in", "on", "at", "to", "for",
  "of", "and", "or", "but", "not", "with", "from", "by", "as", "it", "its",
  "this", "that", "be", "has", "have", "had", "will", "would", "can", "could", "should",
]);

export function jaccardTokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .split(/[\s\W]+/)
      .filter(w => w.length > 0 && !DEDUP_STOP_WORDS.has(w))
  );
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const w of a) {
    if (b.has(w)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ── Contradiction detection ───────────────────────────────────────────────────

// Use the shared universal starter set. Framework/tool specifics are learned
// dynamically per project via extractDynamicEntities().
const PROSE_ENTITY_RE = UNIVERSAL_TECH_TERMS_RE;

const POSITIVE_RE = /\b(always|prefer|should|must|works|recommend|enable)\b/i;
const NEGATIVE_RE = /\b(never|avoid|don't|do not|shouldn't|must not|broken|deprecated|disable)\b/i;

// ── Dynamic entity extraction ─────────────────────────────────────────────────

const ENTITY_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// Patterns that suggest a token is a proper noun / tool name:
//   - CamelCase word (at least one interior uppercase): PhotonMappingEngine, GameKit
//   - All-caps acronym of 2–8 letters: AWS, GPU, API
//   - Known suffix patterns: *.js, *Engine, *API, *SDK, *DB, *UI, *ML
const DYNAMIC_ENTITY_RE =
  /\b(?:[A-Z][a-z]+(?:[A-Z][a-z]*)+|[A-Z]{2,8}|[A-Z][a-z]+(?:Engine|API|SDK|DB|UI|ML|IO|OS|JS|TS|CLI|MCP|GL|VR|AR|AI|NN|GAN))\b/g;

interface ProjectEntityCache {
  entities: string[];
  builtAt: number;
  findingsMtimeMs: number;
}

/**
 * Scan existing findings for proper nouns / tool names that appear in 2+ bullets.
 * Results are cached in .runtime/project-entities-{project}.json (1h TTL or
 * invalidated when FINDINGS.md changes).
 */
export function extractDynamicEntities(cortexPath: string, project: string): Set<string> {
  try {
    const findingsPath = path.join(cortexPath, project, "FINDINGS.md");
    if (!fs.existsSync(findingsPath)) return new Set();

    const findingsStat = fs.statSync(findingsPath);
    const findingsMtime = findingsStat.mtimeMs;
    const cachePath = runtimeFile(cortexPath, `project-entities-${project}.json`);

    // Try reading existing cache
    if (fs.existsSync(cachePath)) {
      try {
        const cached = JSON.parse(fs.readFileSync(cachePath, "utf8")) as ProjectEntityCache;
        const age = Date.now() - (cached.builtAt ?? 0);
        if (age < ENTITY_CACHE_TTL_MS && cached.findingsMtimeMs === findingsMtime) {
          return new Set(cached.entities);
        }
      } catch {
        // fall through to rebuild
      }
    }

    // Rebuild: scan bullets for candidate tokens
    const content = fs.readFileSync(findingsPath, "utf8");
    const bullets = content.split("\n").filter(l => l.startsWith("- ") && !isInactiveFindingLine(l));

    // Count occurrences of each candidate across bullets
    const counts = new Map<string, number>();
    for (const bullet of bullets) {
      const stripped = bullet.replace(/<!--.*?-->/g, "").replace(/^-\s+/, "");
      const seen = new Set<string>();
      let m: RegExpExecArray | null;
      const re = new RegExp(DYNAMIC_ENTITY_RE.source, DYNAMIC_ENTITY_RE.flags);
      while ((m = re.exec(stripped)) !== null) {
        const token = m[0];
        if (!seen.has(token)) {
          seen.add(token);
          counts.set(token, (counts.get(token) ?? 0) + 1);
        }
      }
    }

    // Keep tokens that appear in 2+ distinct bullets
    const entities = [...counts.entries()]
      .filter(([, n]) => n >= 2)
      .map(([token]) => token.toLowerCase());

    // Write cache
    const cacheEntry: ProjectEntityCache = { entities, builtAt: Date.now(), findingsMtimeMs: findingsMtime };
    fs.writeFileSync(cachePath, JSON.stringify(cacheEntry));

    return new Set(entities);
  } catch {
    return new Set();
  }
}

function extractProseEntities(text: string, dynamicEntities?: Set<string>): string[] {
  const found = new Set<string>();
  const re = new RegExp(PROSE_ENTITY_RE.source, PROSE_ENTITY_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) found.add(m[0].toLowerCase());

  // Match additional entity patterns (versions, env keys, file paths, error codes, dates)
  for (const { re: pattern } of EXTRA_ENTITY_PATTERNS) {
    const pRe = new RegExp(pattern.source, pattern.flags);
    let pm: RegExpExecArray | null;
    while ((pm = pRe.exec(text)) !== null) found.add(pm[0].toLowerCase());
  }

  if (dynamicEntities) {
    // Also check whether any dynamic entity appears (case-insensitive word match)
    for (const entity of dynamicEntities) {
      const escaped = entity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`\\b${escaped}\\b`, "i").test(text)) {
        found.add(entity);
      }
    }
  }
  return [...found];
}

function learningPolarity(text: string): "positive" | "negative" | "neutral" {
  const hasPos = POSITIVE_RE.test(text);
  const hasNeg = NEGATIVE_RE.test(text);
  if (hasPos && !hasNeg) return "positive";
  if (hasNeg && !hasPos) return "negative";
  return "neutral";
}

/** Returns existing learning lines that appear to conflict with newFinding. */
export function detectConflicts(newFinding: string, existingLines: string[], dynamicEntities?: Set<string>): string[] {
  const newEntities = extractProseEntities(newFinding, dynamicEntities);
  if (newEntities.length === 0) return [];
  const newPol = learningPolarity(newFinding);
  if (newPol === "neutral") return [];

  const conflicts: string[] = [];
  for (const line of existingLines) {
    if (!line.startsWith("- ")) continue;
    const lineEntities = extractProseEntities(line, dynamicEntities);
    const shared = lineEntities.filter((e) => newEntities.includes(e));
    if (shared.length === 0) continue;
    const linePol = learningPolarity(line);
    if (linePol !== "neutral" && linePol !== newPol) {
      conflicts.push(line);
    }
  }
  return conflicts;
}

export function isDuplicateFinding(existingContent: string, newLearning: string, threshold = 0.6): boolean {
  const normalize = (text: string): string[] => {
    return stripHtmlComments(text).trim()
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 2 && !DEDUP_STOP_WORDS.has(w));
  };

  const newWords = normalize(newLearning);
  if (newWords.length === 0) return false;
  const newSet = new Set(newWords);

  const bullets = existingContent.split("\n").filter(l => l.startsWith("- "));
  for (const bullet of bullets) {
    if (isInactiveFindingLine(bullet)) continue;

    const existingWords = normalize(bullet);
    if (existingWords.length === 0) continue;
    const existingSet = new Set(existingWords);

    // Fast path: exact word overlap check
    let overlap = 0;
    for (const w of newSet) {
      if (existingSet.has(w)) overlap++;
    }

    const smaller = Math.min(newSet.size, existingSet.size);
    if (smaller > 0 && overlap / smaller > threshold) {
      debugLog(`duplicate-detection: skipping learning, ${Math.round((overlap / smaller) * 100)}% overlap with existing: "${bullet.slice(0, 80)}"`);
      return true;
    }

    // Second pass: Jaccard similarity (strip metadata before comparing)
    const newTokens = jaccardTokenize(stripMetadata(newLearning));
    const existingTokens = jaccardTokenize(stripMetadata(bullet));
    if (newTokens.size < 3 || existingTokens.size < 3) continue; // too few tokens for reliable Jaccard
    const jaccard = jaccardSimilarity(newTokens, existingTokens);
    if (jaccard > 0.55) {
      debugLog(`duplicate-detection: Jaccard ${Math.round(jaccard * 100)}% with existing: "${bullet.slice(0, 80)}"`);
      return true;
    }
  }

  return false;
}

// ── Typed observation tags ────────────────────────────────────────────────────

/**
 * Normalize known observation tags in learning text to lowercase.
 * Returns the normalized text and a warning if unknown bracket tags are found.
 */
export function normalizeObservationTags(text: string): { text: string; warning?: string } {
  // Normalize known tags to lowercase
  let normalized = text.replace(/\[([a-zA-Z_-]+)\]/g, (_match, tag: string) => {
    const lower = tag.toLowerCase();
    if (KNOWN_OBSERVATION_TAGS.has(lower)) return `[${lower}]`;
    return _match; // keep unknown tags as-is
  });

  // Detect unknown bracket tags for warning
  const unknownTags: string[] = [];
  const tagPattern = /\[([a-zA-Z_-]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = tagPattern.exec(normalized)) !== null) {
    const lower = m[1].toLowerCase();
    if (!KNOWN_OBSERVATION_TAGS.has(lower)) {
      unknownTags.push(m[0]);
    }
  }

  const warning = unknownTags.length > 0
    ? `Unknown tag(s) ${unknownTags.join(", ")} — known tags: ${[...KNOWN_OBSERVATION_TAGS].map(t => `[${t}]`).join(", ")}`
    : undefined;

  return { text: normalized, warning };
}

/**
 * Scan text for secrets and PII patterns. Returns the type of secret found, or null if clean.
 */
export function scanForSecrets(text: string): string | null {
  // AWS Access Key
  if (/AKIA[0-9A-Z]{16}/.test(text)) return 'AWS access key';
  // AWS Secret Access Key (variable assignment pattern)
  if (/(?:aws[_-]?secret|AWS_SECRET)[_-]?(?:access[_-]?)?key[_-]?(?:id)?['":\s]+[A-Za-z0-9/+=]{40}/i.test(text)) return 'AWS secret access key';
  // JWT token
  if (/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(text)) return 'JWT token';
  // Long base64-encoded secret-like blob (requires base64 chars including +/= and must not be
  // a plain hex digest like a git commit SHA — 40-char lowercase hex is explicitly exempt).
  if (!/^[0-9a-f]{40}$/.test(text) && /(?=[A-Za-z0-9+/]*[+/][A-Za-z0-9+/]*)[A-Za-z0-9+/]{40,}={0,2}/.test(text.replace(/[0-9a-f]{40}/g, ""))) return 'long base64 secret';
  // Connection string with credentials
  if (/(mongodb|postgres|mysql|redis):\/\/[^@\s]+:[^@\s]+@/i.test(text)) return 'connection string with credentials';
  // SSH private key
  if (/-----BEGIN (RSA|EC|OPENSSH) PRIVATE KEY-----/.test(text)) return 'SSH private key';
  // Anthropic API key
  if (/sk-ant-api\d{2}-[A-Za-z0-9_\-]{10,}/.test(text)) return 'Anthropic API key';
  // OpenAI API key
  if (/sk-proj-[A-Za-z0-9_\-]{30,}/.test(text)) return 'OpenAI API key';
  // GitHub PAT classic
  if (/ghp_[A-Za-z0-9]{36}/.test(text)) return 'GitHub personal access token';
  // GitHub OAuth token
  if (/gho_[A-Za-z0-9]{36}/.test(text)) return 'GitHub OAuth token';
  // GitHub tokens (classic, OAuth, user, org, server)
  if (/gh[pousr]_[A-Za-z0-9]{36}/.test(text)) return 'GitHub token';
  // Slack bot token
  if (/xoxb-[0-9]+-[A-Za-z0-9-]+/.test(text)) return 'Slack bot token';
  // Slack user token
  if (/xoxp-[0-9]+-[A-Za-z0-9-]+/.test(text)) return 'Slack user token';
  // Stripe secret key
  if (/sk_live_[A-Za-z0-9]{24,}/.test(text)) return 'Stripe secret key';
  // Stripe publishable key
  if (/pk_live_[A-Za-z0-9]{24,}/.test(text)) return 'Stripe publishable key';
  // npm access token
  if (/npm_[A-Za-z0-9]{36}/.test(text)) return 'npm access token';
  // GCP service account
  if (/"private_key_id"\s*:\s*"[^"]{20,}"/.test(text)) return 'GCP service account key';
  // Generic API key (only when variable name suggests it)
  if (/['"]?(api_?key|secret|token|password)['"]?\s*[=:]\s*['"]?[a-zA-Z0-9_\-\.]{20,}/i.test(text)) return 'API key or secret';
  return null;
}

/**
 * Resolve coreferences in learning text by replacing vague pronouns with concrete names.
 */
export function resolveCoref(text: string, context: { project?: string; file?: string }): string {
  if (!context.project && !context.file) return text;

  let result = text;

  if (context.project) {
    // Sentence-starting "It ", "This ", "That " followed by a verb-like word
    result = result.replace(/^(It|This|That)\s+(?=[a-z])/i, (match) => `[${context.project}] ${match}`);
    // " the project" -> " {project}"
    result = result.replace(/\bthe project\b/gi, context.project);
  }

  if (context.file) {
    const basename = path.basename(context.file);
    result = result.replace(/\b(this file|the file)\b/gi, basename);
  }

  // If text has no concrete nouns AND has vague pronouns, prepend context
  if (context.project && /\b(it|this|that|they|them)\b/i.test(result)) {
    const hasConcreteNoun = /[A-Z][a-z]+[A-Z]|[a-z]+\.[a-z]+|@[a-z]|https?:\/\//.test(result);
    if (!hasConcreteNoun && result === text) {
      result = `[context: ${context.project}] ${result}`;
    }
  }

  return result;
}

/**
 * LLM-based semantic dedup check. Only called when CORTEX_FEATURE_SEMANTIC_DEDUP=1.
 * Must be called before addFindingToFile() since that function is sync.
 * Returns true if the new learning is a semantic duplicate of any existing bullet.
 */
export async function checkSemanticDedup(
  cortexPath: string,
  project: string,
  newLearning: string,
  signal?: AbortSignal
): Promise<boolean> {
  if (!isFeatureEnabled("CORTEX_FEATURE_SEMANTIC_DEDUP", false)) return false;

  const resolvedDir = safeProjectPath(cortexPath, project);
  if (!resolvedDir) return false;
  const findingsPath = path.join(resolvedDir, "FINDINGS.md");
  if (!fs.existsSync(findingsPath)) return false;

  const existingContent = fs.readFileSync(findingsPath, "utf8");
  const bullets = existingContent.split("\n").filter((l) => l.startsWith("- ") && !isInactiveFindingLine(l));

  for (const bullet of bullets) {
    const a = stripMetadata(newLearning).trim();
    const b = stripMetadata(bullet).trim();
    const tokA = jaccardTokenize(a);
    const tokB = jaccardTokenize(b);
    if (tokA.size < 3 || tokB.size < 3) continue;
    const jaccard = jaccardSimilarity(tokA, tokB);
    if (jaccard >= 0.55) continue; // already caught by sync isDuplicateFinding
    if (jaccard >= 0.3) {
      const isDup = await semanticDedup(a, b, cortexPath, signal);
      if (isDup) return true;
    }
  }
  return false;
}

async function semanticDedup(a: string, b: string, cortexPath: string, signal?: AbortSignal): Promise<boolean> {
  const key = crypto.createHash("sha256").update(a + "|||" + b).digest("hex");
  const cachePath = runtimeFile(cortexPath, "dedup-cache.json");

  try {
    return await withCache<boolean>(cachePath, key, DEDUP_CACHE_TTL_MS, async () => {
      const answer = await callLlm(`Are these two findings semantically equivalent? Reply YES or NO only.\nA: ${a}\nB: ${b}`, signal);
      return answer.trim().toUpperCase().startsWith("YES");
    });
  } catch (error) {
    if (isAbortError(error)) return false;
    return false; // fallback: not a duplicate
  }
}

const CONFLICT_CHECK_TOTAL_TIMEOUT_MS = 30_000;

/**
 * LLM-based conflict check. Only called when CORTEX_FEATURE_SEMANTIC_CONFLICT=1.
 * Call after detectConflicts() in addFindingToFile flow.
 * Returns conflict annotations to append to the bullet.
 * Also scans global findings and other projects for cross-project contradictions.
 * Has a 30-second total timeout; returns partial results if the deadline is hit.
 */
export async function checkSemanticConflicts(
  cortexPath: string,
  project: string,
  newFinding: string,
  signal?: AbortSignal
): Promise<{ annotations: string[]; checked: boolean }> {
  if (!isFeatureEnabled("CORTEX_FEATURE_SEMANTIC_CONFLICT", false)) return { annotations: [], checked: false };

  const resolvedDir = safeProjectPath(cortexPath, project);
  if (!resolvedDir) return { annotations: [], checked: false };

  const newEntities = extractProseEntities(newFinding);
  if (newEntities.length === 0) return { annotations: [], checked: true };

  // Collect bullet sources: { bullets, sourceProject } pairs
  const sources: Array<{ bullets: string[]; sourceProject: string | null }> = [];

  // Current project
  const findingsPath = path.join(resolvedDir, "FINDINGS.md");
  if (fs.existsSync(findingsPath)) {
    const content = fs.readFileSync(findingsPath, "utf8");
    sources.push({ bullets: content.split("\n").filter((l) => l.startsWith("- ")), sourceProject: null });
  }

  // Global project findings
  const globalFindingsPath = path.join(cortexPath, "global", "FINDINGS.md");
  if (fs.existsSync(globalFindingsPath)) {
    const content = fs.readFileSync(globalFindingsPath, "utf8");
    const bullets = content.split("\n").filter((l) => l.startsWith("- "));
    if (bullets.length > 0) sources.push({ bullets, sourceProject: "global" });
  }

  // Scan other projects by FINDINGS.md recency so we still check the hottest projects first,
  // but do not truncate the search set and miss older contradictions.
  try {
    const entries = fs.readdirSync(cortexPath, { withFileTypes: true });
    const otherProjects = entries
      .filter((e) => e.isDirectory() && e.name !== project && e.name !== "global" && !e.name.startsWith("."))
      .map((e) => {
        const fp = path.join(cortexPath, e.name, "FINDINGS.md");
        if (!fs.existsSync(fp)) return null;
        try {
          return { name: e.name, mtime: fs.statSync(fp).mtimeMs, fp };
        } catch (err: unknown) {
          if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] crossProjectScan stat: ${err instanceof Error ? err.message : String(err)}\n`);
          return null;
        }
      })
      .filter((x): x is { name: string; mtime: number; fp: string } => x !== null)
      .sort((a, b) => b.mtime - a.mtime);

    for (const proj of otherProjects) {
      const content = fs.readFileSync(proj.fp, "utf8");
      const bullets = content.split("\n").filter((l) => l.startsWith("- "));
      if (bullets.length > 0) sources.push({ bullets, sourceProject: proj.name });
    }
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] crossProjectScan: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  const annotations: string[] = [];
  const deadline = Date.now() + CONFLICT_CHECK_TOTAL_TIMEOUT_MS;

  outer: for (const { bullets, sourceProject } of sources) {
    for (const line of bullets) {
      // Respect the aggregate deadline — return partial results rather than hanging
      if (Date.now() >= deadline) {
        debugLog("checkSemanticConflicts: total timeout reached, returning partial results");
        break outer;
      }

      const lineEntities = extractProseEntities(line);
      const shared = lineEntities.filter((e) => newEntities.includes(e));
      if (shared.length === 0) continue;

      const result = await llmConflictCheck(line, newFinding, shared[0], cortexPath, signal);
      if (result === "CONFLICT") {
        const snippet = stripMetadata(line).trim().slice(0, 80);
        const sourceLabel = sourceProject ? ` (from project: ${sourceProject})` : "";
        annotations.push(`<!-- conflicts_with: "${snippet}"${sourceLabel} -->`);
      }
    }
  }

  return { annotations, checked: true };
}

async function llmConflictCheck(
  existing: string,
  newFinding: string,
  entity: string,
  cortexPath: string,
  signal?: AbortSignal
): Promise<"CONFLICT" | "OK"> {
  const key = crypto.createHash("sha256").update(existing + "|||" + newFinding).digest("hex");
  const cachePath = runtimeFile(cortexPath, "conflict-cache.json");

  try {
    return await withCache<"CONFLICT" | "OK">(cachePath, key, CONFLICT_CACHE_TTL_MS, async () => {
      const answer = await callLlm(`Finding A: ${existing}. Finding B: ${newFinding}. Do these contradict each other about how to use ${entity}? Reply CONFLICT or OK only.`, signal);
      return answer.trim().toUpperCase().startsWith("CONFLICT")
        ? ("CONFLICT" as const)
        : ("OK" as const);
    });
  } catch (error) {
    if (isAbortError(error)) return "OK";
    return "OK";
  }
}
