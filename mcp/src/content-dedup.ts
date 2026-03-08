import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { debugLog, runtimeFile } from "./shared.js";
import { safeProjectPath } from "./utils.js";

// ── LLM provider abstraction ────────────────────────────────────────────────

const MAX_CACHE_ENTRIES = 500;

type TimestampedCacheEntry<T> = {
  result: T;
  ts: number;
  timestamp?: number;
  cachedAt?: number;
};

function getCacheEntryTimestamp<T>(entry: TimestampedCacheEntry<T> | undefined): number {
  if (!entry) return 0;
  if (typeof entry.ts === "number") return entry.ts;
  if (typeof entry.timestamp === "number") return entry.timestamp;
  if (typeof entry.cachedAt === "number") return entry.cachedAt;
  return 0;
}

function loadCache<T>(cachePath: string): Record<string, TimestampedCacheEntry<T>> {
  if (!fs.existsSync(cachePath)) return {};
  const raw = JSON.parse(fs.readFileSync(cachePath, "utf8")) as Record<string, TimestampedCacheEntry<T>>;
  const now = Date.now();

  for (const entry of Object.values(raw)) {
    const ts = getCacheEntryTimestamp(entry) || now;
    entry.ts = ts;
  }

  return raw;
}

function trimCache<T>(cache: Record<string, TimestampedCacheEntry<T>>): void {
  const entries = Object.entries(cache);
  if (entries.length <= MAX_CACHE_ENTRIES) return;

  entries
    .sort(([, a], [, b]) => getCacheEntryTimestamp(a) - getCacheEntryTimestamp(b))
    .slice(0, entries.length - MAX_CACHE_ENTRIES)
    .forEach(([key]) => {
      delete cache[key];
    });
}

function persistCache<T>(cachePath: string, cache: Record<string, TimestampedCacheEntry<T>>): void {
  trimCache(cache);
  fs.writeFileSync(cachePath, JSON.stringify(cache));
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function callLlm(prompt: string): Promise<string> {
  const endpoint = process.env.CORTEX_LLM_ENDPOINT;
  const key = process.env.CORTEX_LLM_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || "";
  const model = process.env.CORTEX_LLM_MODEL;

  if (endpoint) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);
    let response: Response;
    try {
      response = await fetch(`${endpoint.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(key ? { "Authorization": `Bearer ${key}` } : {}),
        },
        body: JSON.stringify({
          model: model || "gpt-4o-mini",
          messages: [{ role: "user", content: prompt }],
          max_tokens: 10,
          temperature: 0,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
    if (!response.ok) throw new Error(`LLM API error: ${response.status}`);
    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content?.trim() ?? "";
  } else {
    // Anthropic REST API fallback (no SDK required)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);
    let response: Response;
    try {
      response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: model || "claude-haiku-4-5-20251001",
          max_tokens: 10,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
    if (!response.ok) throw new Error(`Anthropic API error: ${response.status}`);
    const data = await response.json() as { content?: Array<{ type: string; text?: string }> };
    const block = data.content?.[0];
    return (block?.type === "text" ? block.text ?? "" : "").trim();
  }
}

// Stop words for lightweight semantic overlap checks
const DEDUP_STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "in", "on", "at", "to", "for",
  "of", "and", "or", "but", "not", "with", "from", "by", "as", "it", "its",
  "this", "that", "be", "has", "have", "had", "will", "would", "can", "could", "should",
]);

function jaccardTokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .split(/[\s\W]+/)
      .filter(w => w.length > 0 && !DEDUP_STOP_WORDS.has(w))
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const w of a) {
    if (b.has(w)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ── Contradiction detection ───────────────────────────────────────────────────

const PROSE_ENTITY_RE =
  /\b(React|Vue|Angular|Next\.js|Nuxt|Svelte|Express|Fastify|Django|Flask|Rails|Spring|Redis|Postgres|MySQL|MongoDB|SQLite|Docker|Kubernetes|Terraform|AWS|GCP|Azure|Vercel|Netlify|Prisma|TypeORM|Sequelize|Jest|Vitest|Cypress|Playwright|Webpack|Vite|ESLint|Prettier|GraphQL|gRPC|Kafka|RabbitMQ|Elasticsearch|Nginx|Caddy|Node\.js|Deno|Bun|Python|Rust|Go|Java|TypeScript)\b/gi;

const POSITIVE_RE = /\b(always|prefer|should|must|works|recommend|enable)\b/i;
const NEGATIVE_RE = /\b(never|avoid|don't|do not|shouldn't|must not|broken|deprecated|disable)\b/i;

function extractProseEntities(text: string): string[] {
  const found = new Set<string>();
  const re = new RegExp(PROSE_ENTITY_RE.source, PROSE_ENTITY_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) found.add(m[0].toLowerCase());
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
export function detectConflicts(newFinding: string, existingLines: string[]): string[] {
  const newEntities = extractProseEntities(newFinding);
  if (newEntities.length === 0) return [];
  const newPol = learningPolarity(newFinding);
  if (newPol === "neutral") return [];

  const conflicts: string[] = [];
  for (const line of existingLines) {
    if (!line.startsWith("- ")) continue;
    const lineEntities = extractProseEntities(line);
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
  // Strip HTML comments (timestamp metadata, citations) before comparing
  const stripComments = (s: string) => s.replace(/<!--.*?-->/g, "").trim();

  const normalize = (text: string): string[] => {
    return stripComments(text)
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
    // Skip superseded entries
    if (bullet.includes("<!-- superseded_by:")) continue;

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
    const stripMeta = (s: string) => s.replace(/<!--.*?-->/g, "").replace(/\(migrated from [^)]+\)/gi, "").replace(/^-\s+/, "");
    const newTokens = jaccardTokenize(stripMeta(newLearning));
    const existingTokens = jaccardTokenize(stripMeta(bullet));
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

export const KNOWN_OBSERVATION_TAGS = new Set([
  "decision",
  "pitfall",
  "pattern",
  "tradeoff",
  "architecture",
  "bug",
]);

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
  // JWT token
  if (/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(text)) return 'JWT token';
  // Long base64-encoded secret-like blob
  if (/[A-Za-z0-9+\/]{40,}={0,2}/.test(text)) return 'long base64 secret';
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
  newLearning: string
): Promise<boolean> {
  if (process.env.CORTEX_FEATURE_SEMANTIC_DEDUP !== "1") return false;

  const resolvedDir = safeProjectPath(cortexPath, project);
  if (!resolvedDir) return false;
  const findingsPath = path.join(resolvedDir, "FINDINGS.md");
  if (!fs.existsSync(findingsPath)) return false;

  const existingContent = fs.readFileSync(findingsPath, "utf8");
  const stripMeta = (s: string) =>
    s.replace(/<!--.*?-->/g, "").replace(/\(migrated from [^)]+\)/gi, "").replace(/^-\s+/, "").trim();
  const bullets = existingContent.split("\n").filter((l) => l.startsWith("- ") && !l.includes("<!-- superseded_by:"));

  for (const bullet of bullets) {
    const a = stripMeta(newLearning);
    const b = stripMeta(bullet);
    const tokA = jaccardTokenize(a);
    const tokB = jaccardTokenize(b);
    if (tokA.size < 3 || tokB.size < 3) continue;
    const jaccard = jaccardSimilarity(tokA, tokB);
    if (jaccard >= 0.55) continue; // already caught by sync isDuplicateFinding
    if (jaccard >= 0.3) {
      const isDup = await semanticDedup(a, b, cortexPath);
      if (isDup) return true;
    }
  }
  return false;
}

async function semanticDedup(a: string, b: string, cortexPath: string): Promise<boolean> {
  const key = crypto.createHash("sha256").update(a + "|||" + b).digest("hex");
  const cachePath = runtimeFile(cortexPath, "dedup-cache.json");

  // Check cache
  try {
    const cache = loadCache<boolean>(cachePath);
    if (cache[key] && Date.now() - getCacheEntryTimestamp(cache[key]) < 86400000) {
      cache[key].ts = Date.now();
      persistCache(cachePath, cache);
      return cache[key].result;
    }
  } catch { /* ignore */ }

  try {
    const answer = await callLlm(`Are these two findings semantically equivalent? Reply YES or NO only.\nA: ${a}\nB: ${b}`);
    const result = answer.startsWith("YES");

    // Cache result
    try {
      const cache = loadCache<boolean>(cachePath);
      cache[key] = { result, ts: Date.now() };
      persistCache(cachePath, cache);
    } catch { /* non-fatal */ }

    return result;
  } catch (error) {
    if (isAbortError(error)) return false;
    return false; // fallback: not a duplicate
  }
}

/**
 * LLM-based conflict check. Only called when CORTEX_FEATURE_SEMANTIC_CONFLICT=1.
 * Call after detectConflicts() in addFindingToFile flow.
 * Returns conflict annotations to append to the bullet.
 */
export async function checkSemanticConflicts(
  cortexPath: string,
  project: string,
  newFinding: string
): Promise<{ annotations: string[]; checked: boolean }> {
  if (process.env.CORTEX_FEATURE_SEMANTIC_CONFLICT !== "1") return { annotations: [], checked: false };

  const resolvedDir = safeProjectPath(cortexPath, project);
  if (!resolvedDir) return { annotations: [], checked: false };
  const findingsPath = path.join(resolvedDir, "FINDINGS.md");
  if (!fs.existsSync(findingsPath)) return { annotations: [], checked: false };

  const content = fs.readFileSync(findingsPath, "utf8");
  const existingBullets = content.split("\n").filter((l) => l.startsWith("- "));

  const newEntities = extractProseEntities(newFinding);
  if (newEntities.length === 0) return { annotations: [], checked: true };

  const annotations: string[] = [];
  for (const line of existingBullets) {
    const lineEntities = extractProseEntities(line);
    const shared = lineEntities.filter((e) => newEntities.includes(e));
    if (shared.length === 0) continue;

    const result = await llmConflictCheck(line, newFinding, shared[0], cortexPath);
    if (result === "CONFLICT") {
      const snippet = line.replace(/^-\s+/, "").replace(/<!--.*?-->/g, "").trim().slice(0, 80);
      annotations.push(`<!-- conflicts_with: "${snippet}" -->`);
    }
  }
  return { annotations, checked: true };
}

async function llmConflictCheck(
  existing: string,
  newFinding: string,
  entity: string,
  cortexPath: string
): Promise<"CONFLICT" | "OK"> {
  const key = crypto.createHash("sha256").update(existing + "|||" + newFinding).digest("hex");
  const cachePath = runtimeFile(cortexPath, "conflict-cache.json");

  // 7-day cache
  try {
    const cache = loadCache<"CONFLICT" | "OK">(cachePath);
    if (cache[key] && Date.now() - getCacheEntryTimestamp(cache[key]) < 7 * 86400000) {
      cache[key].ts = Date.now();
      persistCache(cachePath, cache);
      return cache[key].result;
    }
  } catch { /* ignore */ }

  try {
    const answer = await callLlm(`Finding A: ${existing}. Finding B: ${newFinding}. Do these contradict each other about how to use ${entity}? Reply CONFLICT or OK only.`);
    const result = answer.startsWith("CONFLICT")
      ? ("CONFLICT" as const)
      : ("OK" as const);

    // Cache
    try {
      const cache = loadCache<"CONFLICT" | "OK">(cachePath);
      cache[key] = { result, ts: Date.now() };
      persistCache(cachePath, cache);
    } catch { /* non-fatal */ }

    return result;
  } catch (error) {
    if (isAbortError(error)) return "OK";
    return "OK";
  }
}
