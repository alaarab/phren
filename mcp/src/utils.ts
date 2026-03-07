import * as path from "path";
import { execFileSync } from "child_process";

// ── Shared Git helper ────────────────────────────────────────────────────────

export function runGit(cwd: string, args: string[], timeoutMs: number, debugLogFn?: (msg: string) => void): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: timeoutMs }).trim();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (debugLogFn) debugLogFn(`runGit: git ${args[0]} failed in ${cwd}: ${msg}`);
    return null;
  }
}

// ── Strict Git helper (throws on failure) ───────────────────────────────────

export function runGitStrict(args: string[], opts: { cwd: string; timeout?: number }): string {
  return execFileSync("git", args, {
    cwd: opts.cwd,
    encoding: "utf8",
    timeout: opts.timeout ?? 30000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

// ── Safe JSON parse ─────────────────────────────────────────────────────────

export function safeJsonParse<T>(str: string, fallback: T): T {
  try {
    return JSON.parse(str) as T;
  } catch {
    return fallback;
  }
}

// ── Error message extractor ─────────────────────────────────────────────────

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Feature flag and clamping helpers ────────────────────────────────────────

export function isFeatureEnabled(envName: string, defaultValue: boolean = true): boolean {
  const raw = process.env[envName];
  if (!raw) return defaultValue;
  return !["0", "false", "off", "no"].includes(raw.trim().toLowerCase());
}

export function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(raw || "", 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

// Synonym map for fuzzy search expansion
const SYNONYMS: Record<string, string[]> = {
  // ── Existing groups (23) ──────────────────────────────────────────────────
  "rate limit": ["throttle", "throttling", "429", "too many requests"],
  "throttle": ["rate limit", "throttling", "429", "debounce"],
  "throttling": ["rate limit", "throttle", "429"],
  "429": ["rate limit", "throttle", "throttling", "too many requests"],
  "error": ["exception", "failure", "crash", "bug"],
  "exception": ["error", "failure", "crash"],
  "bug": ["error", "failure", "crash"],
  "auth": ["authentication", "authorization", "login", "oauth", "jwt"],
  "authentication": ["auth", "login", "oauth"],
  "authorization": ["auth", "login", "oauth"],
  "login": ["auth", "authentication", "oauth"],
  "cache": ["caching", "memoize", "memoization"],
  "caching": ["cache", "memoize", "memoization"],
  "deploy": ["deployment", "release", "publish", "ship"],
  "deployment": ["deploy", "release", "publish"],
  "test": ["testing", "spec", "jest", "vitest", "pytest"],
  "testing": ["test", "spec", "jest", "vitest"],
  "api": ["endpoint", "route", "handler"],
  "endpoint": ["api", "route", "handler"],
  "database": ["db", "sqlite", "postgres", "sql"],
  "db": ["database", "sqlite", "postgres", "sql"],
  "env": ["environment", "dotenv", "config"],
  "environment": ["env", "dotenv", "config"],
  "ci": ["pipeline", "github actions", "workflow"],
  "pipeline": ["ci", "github actions", "workflow"],
  "websocket": ["ws", "socket", "real-time"],
  "hook": ["hooks", "lifecycle", "callback"],
  "hooks": ["hook", "lifecycle", "callback"],
  "middleware": ["interceptor", "handler", "filter"],
  "queue": ["job", "worker", "background"],
  "docker": ["container", "dockerfile", "compose"],
  "container": ["docker", "dockerfile", "compose"],

  // ── Frontend / CSS ────────────────────────────────────────────────────────
  "flexbox": ["flex", "css", "layout"],
  "grid": ["css grid", "layout", "display"],
  "css": ["stylesheet", "style", "sass", "scss", "tailwind"],
  "stylesheet": ["css", "sass", "scss"],
  "selector": ["css", "querySelector", "specificity"],
  "animation": ["transition", "keyframes", "css"],
  "transition": ["animation", "keyframes", "css"],
  "responsive": ["media query", "breakpoint", "viewport"],
  "media query": ["responsive", "breakpoint", "viewport"],
  "tailwind": ["css", "utility classes", "postcss"],
  "sass": ["scss", "css", "preprocessor"],
  "scss": ["sass", "css", "preprocessor"],

  // ── Security ──────────────────────────────────────────────────────────────
  "cors": ["cross-origin", "origin", "preflight"],
  "xss": ["cross-site scripting", "sanitize", "escape"],
  "csrf": ["cross-site request forgery", "token", "security"],
  "injection": ["sql injection", "xss", "sanitize"],
  "sanitize": ["escape", "xss", "injection", "validate"],
  "escape": ["sanitize", "xss", "encode"],
  "oauth": ["auth", "jwt", "token", "openid"],
  "jwt": ["token", "auth", "oauth", "bearer"],
  "rbac": ["role", "permission", "access control"],
  "permission": ["rbac", "role", "access control", "authorization"],
  "rate-limit": ["throttle", "429", "rate limit"],
  "csp": ["content security policy", "security", "header"],

  // ── State management ──────────────────────────────────────────────────────
  "redux": ["store", "dispatch", "reducer", "action"],
  "zustand": ["store", "state", "react"],
  "context": ["provider", "consumer", "react"],
  "store": ["state", "redux", "zustand"],
  "dispatch": ["action", "redux", "event"],
  "reducer": ["redux", "action", "state"],
  "action": ["dispatch", "reducer", "redux"],
  "recoil": ["atom", "selector", "state"],
  "jotai": ["atom", "state", "react"],
  "signal": ["reactive", "state", "observable"],

  // ── Performance / profiling ───────────────────────────────────────────────
  "profiler": ["benchmark", "performance", "flame graph"],
  "benchmark": ["profiler", "performance", "latency"],
  "latency": ["performance", "throughput", "response time"],
  "throughput": ["performance", "latency", "bandwidth"],
  "memory leak": ["gc", "heap", "memory"],
  "memory-leak": ["gc", "heap", "memory"],
  "gc": ["garbage collection", "memory", "heap"],
  "memoize": ["cache", "memoization", "useMemo"],
  "memoization": ["memoize", "cache", "useMemo"],
  "debounce": ["throttle", "rate limit", "delay"],
  "lazy-load": ["code splitting", "dynamic import", "lazy"],
  "lazy load": ["code splitting", "dynamic import", "lazy"],

  // ── Infrastructure / k8s ──────────────────────────────────────────────────
  "kubernetes": ["k8s", "helm", "pod", "deployment"],
  "k8s": ["kubernetes", "helm", "pod", "deployment"],
  "helm": ["kubernetes", "k8s", "chart"],
  "pod": ["kubernetes", "k8s", "container"],
  "ingress": ["kubernetes", "k8s", "routing", "service"],
  "namespace": ["kubernetes", "k8s", "scope"],
  "dockerfile": ["docker", "container", "build"],
  "compose": ["docker", "docker-compose", "container"],

  // ── Data / ML ─────────────────────────────────────────────────────────────
  "embedding": ["vector", "cosine", "similarity"],
  "vector": ["embedding", "cosine", "similarity"],
  "cosine": ["similarity", "vector", "embedding"],
  "similarity": ["cosine", "vector", "distance"],
  "model": ["inference", "training", "ml"],
  "inference": ["model", "prediction", "ml"],
  "training": ["model", "dataset", "ml"],
  "dataset": ["data", "training", "pipeline"],
  "feature": ["label", "dataset", "ml"],
  "label": ["feature", "annotation", "dataset"],
  "tokenize": ["tokenizer", "nlp", "parse"],

  // ── Mobile ────────────────────────────────────────────────────────────────
  "rn": ["react-native", "expo", "mobile"],
  "react-native": ["rn", "expo", "mobile"],
  "expo": ["react-native", "rn", "mobile"],
  "ios": ["apple", "swift", "xcode", "mobile"],
  "android": ["kotlin", "gradle", "mobile"],
  "native": ["ios", "android", "platform"],
  "gesture": ["touch", "swipe", "pan"],
  "navigation": ["router", "screen", "stack"],
  "deep-link": ["universal link", "app link", "url scheme"],
  "deep link": ["universal link", "app link", "url scheme"],

  // ── Accessibility ─────────────────────────────────────────────────────────
  "a11y": ["accessibility", "aria", "wcag"],
  "aria": ["a11y", "accessibility", "role"],
  "wcag": ["a11y", "accessibility", "contrast"],
  "screen-reader": ["a11y", "aria", "voiceover"],
  "screen reader": ["a11y", "aria", "voiceover"],
  "focus": ["keyboard-nav", "tabindex", "a11y"],
  "keyboard-nav": ["focus", "tabindex", "a11y"],
  "contrast": ["wcag", "a11y", "color"],
  "semantic": ["html", "a11y", "landmark"],

  // ── Testing ───────────────────────────────────────────────────────────────
  "jest": ["test", "vitest", "testing"],
  "vitest": ["test", "jest", "testing"],
  "mocha": ["test", "chai", "testing"],
  "pytest": ["test", "python", "testing"],
  "cypress": ["e2e", "testing", "browser"],
  "playwright": ["e2e", "testing", "browser"],
  "e2e": ["end-to-end", "cypress", "playwright"],
  "unit": ["test", "testing", "spec"],
  "integration": ["test", "testing", "e2e"],
  "mock": ["stub", "spy", "fake"],
  "stub": ["mock", "spy", "fake"],
  "fixture": ["test data", "factory", "seed"],
  "snapshot": ["test", "jest", "vitest"],
};

// Common English stop words to strip from prompts before searching
export const STOP_WORDS = new Set([
  "the", "is", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "it", "this", "that", "are", "was", "were",
  "be", "been", "being", "have", "has", "had", "do", "does", "did", "will",
  "would", "could", "should", "may", "might", "can", "shall", "not", "no",
  "so", "if", "then", "than", "too", "very", "just", "about", "up", "out",
  "my", "me", "i", "you", "your", "we", "our", "they", "them", "their",
  "he", "she", "his", "her", "its", "what", "which", "who", "when", "where",
  "how", "why", "all", "each", "every", "some", "any", "few", "more", "most",
  "other", "into", "over", "such", "only", "own", "same", "also", "back",
  "get", "got", "make", "made", "take", "like", "well", "here", "there",
  "use", "using", "used", "need", "want", "look", "help", "please",
]);

// Extract meaningful keywords from a prompt, including bigrams (2-word noun phrases).
// Bigrams capture intent better than isolated words (e.g., "rate limit" vs "rate" + "limit").
export function extractKeywords(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w));

  // Build bigrams from adjacent non-stop-words
  const bigrams: string[] = [];
  for (let i = 0; i < words.length - 1; i++) {
    bigrams.push(`${words[i]} ${words[i + 1]}`);
  }

  // Deduplicate and limit: prefer individual words first, then bigrams add extra signal
  const seen = new Set<string>();
  const result: string[] = [];
  for (const w of [...words, ...bigrams]) {
    if (!seen.has(w)) {
      seen.add(w);
      result.push(w);
    }
    if (result.length >= 10) break;
  }

  return result.join(" ");
}

// Validate a project name: no path separators, no dot-dot segments, no null bytes, max 100 chars
export function isValidProjectName(name: string): boolean {
  if (!name || name.length === 0) return false;
  if (name.length > 100) return false;
  if (name.includes("..") || name.includes("/") || name.includes("\\") || name.includes("\0")) return false;
  return true;
}

// Resolve a path inside the cortex directory and reject anything that escapes it
export function safeProjectPath(base: string, ...segments: string[]): string | null {
  const resolved = path.resolve(base, ...segments);
  const normalizedBase = path.resolve(base) + path.sep;
  if (!resolved.startsWith(normalizedBase) && resolved !== path.resolve(base)) return null;
  return resolved;
}

// Memory queue section types and file path helper, shared by data-access.ts and shared.ts.
export type QueueSection = "Review" | "Stale" | "Conflicts";
export const QUEUE_SECTIONS: QueueSection[] = ["Review", "Stale", "Conflicts"];
export const QUEUE_FILENAME = "MEMORY_QUEUE.md";

export function queueFilePath(cortexPath: string, project: string): string {
  return path.join(cortexPath, project, QUEUE_FILENAME);
}

// Sanitize user input before passing it to an FTS5 MATCH expression.
// Strips FTS5-specific syntax that could cause injection or parse errors.
export function sanitizeFts5Query(raw: string): string {
  if (!raw) return "";
  if (raw.length > 500) raw = raw.slice(0, 500);
  let q = raw.replace(/\0/g, " ");
  q = q.replace(/\b(content|type|project|filename|path):/gi, "");
  q = q.replace(/\b(AND|OR|NOT|NEAR)\b/gi, " ");
  q = q.replace(/[\^"()[\]{}!@#$%&*+=~`';?,\\|]/g, " ");
  q = q.replace(/\s+/g, " ");
  return q.trim();
}

// Build a defensive FTS5 MATCH query:
// - sanitizes user input
// - extracts bigrams and treats them as quoted phrases
// - expands known synonyms (capped at 10 total terms)
// - applies AND between core terms, with synonyms as OR alternatives
export function buildRobustFtsQuery(raw: string): string {
  const MAX_TOTAL_TERMS = 10;
  const MAX_SYNONYM_GROUPS = 3;
  const safe = sanitizeFts5Query(raw);
  if (!safe) return "";

  const baseWords = safe.split(/\s+/).filter((t) => t.length > 1);
  if (baseWords.length === 0) return "";

  // Build bigrams from adjacent words
  const bigrams: string[] = [];
  for (let i = 0; i < baseWords.length - 1; i++) {
    bigrams.push(`${baseWords[i]} ${baseWords[i + 1]}`);
  }

  // Determine which words are consumed by bigrams that match synonym keys
  const lowered = safe.toLowerCase();
  const consumedIndices = new Set<number>();
  const matchedBigrams: string[] = [];
  for (let i = 0; i < bigrams.length; i++) {
    const bg = bigrams[i].toLowerCase();
    if (SYNONYMS[bg]) {
      consumedIndices.add(i);
      consumedIndices.add(i + 1);
      matchedBigrams.push(bigrams[i]);
    }
  }

  // Core terms: bigrams (quoted phrases) + unconsumed individual words (deduplicated)
  const coreTerms: string[] = [];
  const seenTerms = new Set<string>();
  for (const bg of matchedBigrams) {
    const clean = bg.replace(/"/g, "").trim().toLowerCase();
    if (!seenTerms.has(clean)) {
      seenTerms.add(clean);
      coreTerms.push(`"${bg.replace(/"/g, "").trim()}"`);
    }
  }
  for (let i = 0; i < baseWords.length; i++) {
    if (!consumedIndices.has(i)) {
      const w = baseWords[i].replace(/"/g, "").trim();
      const wLow = w.toLowerCase();
      if (w.length > 1 && !seenTerms.has(wLow)) {
        seenTerms.add(wLow);
        coreTerms.push(`"${w}"`);
      }
    }
  }

  if (coreTerms.length === 0) return "";

  // Build query clauses: each core term AND'd, with synonym OR alternatives
  let totalTermCount = coreTerms.length;
  let groupsExpanded = 0;
  const clauses: string[] = [];

  for (const coreTerm of coreTerms) {
    const termText = coreTerm.slice(1, -1).toLowerCase(); // strip quotes
    const synonyms: string[] = [];

    if (groupsExpanded < MAX_SYNONYM_GROUPS && SYNONYMS[termText]) {
      for (const syn of SYNONYMS[termText]) {
        if (totalTermCount >= MAX_TOTAL_TERMS) break;
        const cleanSyn = syn.replace(/"/g, "").trim();
        if (cleanSyn.length > 1) {
          synonyms.push(`"${cleanSyn}"`);
          totalTermCount++;
        }
      }
      groupsExpanded++;
    }

    if (synonyms.length > 0) {
      clauses.push(`(${coreTerm} OR ${synonyms.join(" OR ")})`);
    } else {
      clauses.push(coreTerm);
    }
  }

  return clauses.join(" AND ");
}
