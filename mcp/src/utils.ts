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
const STOP_WORDS = new Set([
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
  "fix", "use", "using", "used", "need", "want", "look", "help", "please",
]);

// Expand a search query with synonym alternatives using OR
export function expandSynonyms(query: string): string {
  const lower = query.toLowerCase();
  const additions: string[] = [];

  for (const [term, synonyms] of Object.entries(SYNONYMS)) {
    if (lower.includes(term)) {
      for (const syn of synonyms) {
        if (!lower.includes(syn)) {
          additions.push(syn);
        }
      }
    }
  }

  if (additions.length === 0) return query;

  // Build OR expression: original terms OR each synonym
  const parts = [query, ...additions];
  return parts.map(p => p.includes(" ") ? `"${p}"` : p).join(" OR ");
}

// Extract meaningful keywords from a prompt by removing stop words
export function extractKeywords(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w))
    .slice(0, 8)
    .join(" ");
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
  let q = raw.replace(/\0/g, "");
  q = q.replace(/\b(content|type|project|filename|path):/gi, "");
  q = q.replace(/\^/g, "");
  q = q.replace(/"/g, "");
  return q.trim();
}
