import * as path from "path";

// Synonym map for fuzzy search expansion
const SYNONYMS: Record<string, string[]> = {
  "rate limit": ["throttle", "throttling", "429", "too many requests"],
  "throttle": ["rate limit", "throttling", "429"],
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

// Validate a project name: no path separators, no dot-dot segments, no null bytes
export function isValidProjectName(name: string): boolean {
  if (!name || name.length === 0) return false;
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

// Sanitize user input before passing it to an FTS5 MATCH expression.
// Strips FTS5-specific syntax that could cause injection or parse errors.
export function sanitizeFts5Query(raw: string): string {
  let q = raw.replace(/\0/g, " ");
  q = q.replace(/\b(content|type|project|filename|path):/gi, "");
  q = q.replace(/\b(AND|OR|NOT|NEAR)\b/gi, " ");
  q = q.replace(/[\^"()[\]{}!@#$%&*+=~`';?,\\|]/g, " ");
  q = q.replace(/\s+/g, " ");
  return q.trim();
}

// Build a defensive FTS5 MATCH query:
// - sanitizes user input
// - expands known synonyms
// - quotes each term/phrase to avoid syntax surprises
export function buildRobustFtsQuery(raw: string): string {
  const safe = sanitizeFts5Query(raw);
  if (!safe) return "";

  const terms = new Set<string>();
  const baseTerms = safe.split(/\s+/).filter((t) => t.length > 1);
  for (const t of baseTerms) terms.add(t);

  const lowered = safe.toLowerCase();
  for (const [term, synonyms] of Object.entries(SYNONYMS)) {
    if (!lowered.includes(term)) continue;
    terms.add(term);
    for (const syn of synonyms) {
      if (terms.size >= 20) break;
      terms.add(syn);
    }
    if (terms.size >= 20) break;
  }

  return [...terms]
    .map((term) => term.replace(/"/g, "").trim())
    .filter((term) => term.length > 1)
    .map((term) => `"${term}"`)
    .join(" OR ");
}
