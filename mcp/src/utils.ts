import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import * as yaml from "js-yaml";
import { fileURLToPath } from "url";
import { findCortexPath } from "./shared.js";

const _synonymsPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "synonyms.json");
const _synonymsJson: Record<string, string[]> = (() => {
  try { return JSON.parse(fs.readFileSync(_synonymsPath, "utf8")); } catch { return {}; }
})();

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

// Synonym map for fuzzy search expansion — source of truth is mcp/src/synonyms.json
const SYNONYMS: Record<string, string[]> = _synonymsJson;


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
    // Filter out bigrams where both tokens are stop words (words is already filtered,
    // so this is defensive — the real stop-word bigram filter is in buildRobustFtsQuery)
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
  if (name === "." || name === "..") return false;
  if (/^\./.test(name)) return false;  // hidden dirs
  if (/^-/.test(name)) return false;   // breaks CLI flags
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
const QUEUE_FILENAME = "MEMORY_QUEUE.md";

export function queueFilePath(cortexPath: string, project: string): string {
  return path.join(cortexPath, project, QUEUE_FILENAME);
}

// Sanitize user input before passing it to an FTS5 MATCH expression.
// Strips FTS5-specific syntax that could cause injection or parse errors.
export function sanitizeFts5Query(raw: string): string {
  if (!raw) return "";
  if (raw.length > 500) raw = raw.slice(0, 500);
  // Whitelist approach: only allow alphanumeric, spaces, hyphens, apostrophes, double quotes, asterisks
  let q = raw.replace(/[^a-zA-Z0-9 \-'"*]/g, " ");
  q = q.replace(/\s+/g, " ");
  q = q.trim();
  // Q83: FTS5 only accepts * as a prefix operator directly attached to a token
  // (e.g. "foo*").  A bare trailing asterisk (or lone "*") produces invalid
  // FTS5 syntax.  Strip any asterisk that is not immediately preceded by a
  // word character so the query remains valid.
  q = q.replace(/(?<!\w)\*/g, "");
  // Also strip a trailing asterisk that is preceded only by whitespace at word
  // end of the whole query (handles "foo *" → "foo").
  q = q.replace(/\s+\*$/g, "");
  return q.trim();
}

function parseSynonymsYaml(filePath: string): Record<string, string[]> {
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed = yaml.load(fs.readFileSync(filePath, "utf8"), { schema: yaml.CORE_SCHEMA });
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    const loaded: Record<string, string[]> = {};
    for (const [rawKey, value] of Object.entries(parsed)) {
      const key = String(rawKey).trim().toLowerCase();
      if (!key || !Array.isArray(value)) continue;
      const synonyms = value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.replace(/"/g, "").trim())
        .filter((item) => item.length > 1);
      if (synonyms.length > 0) loaded[key] = synonyms;
    }
    return loaded;
  } catch {
    return {};
  }
}

function loadUserSynonyms(project?: string | null): Record<string, string[]> {
  const cortexPath = findCortexPath();
  if (!cortexPath) return {};

  const globalSynonyms = parseSynonymsYaml(path.join(cortexPath, "global", "synonyms.yaml"));
  if (!project || !isValidProjectName(project)) return globalSynonyms;

  const projectSynonyms = parseSynonymsYaml(path.join(cortexPath, project, "synonyms.yaml"));
  return {
    ...globalSynonyms,
    ...projectSynonyms,
  };
}

// Build a defensive FTS5 MATCH query:
// - sanitizes user input
// - extracts bigrams and treats them as quoted phrases
// - expands known synonyms (capped at 10 total terms)
// - applies AND between core terms, with synonyms as OR alternatives
export function buildRobustFtsQuery(raw: string, project?: string | null): string {
  const MAX_TOTAL_TERMS = 10;
  const MAX_SYNONYM_GROUPS = 3;
  const safe = sanitizeFts5Query(raw);
  if (!safe) return "";
  const synonymsMap = {
    ...SYNONYMS,
    ...loadUserSynonyms(project),
  };

  const baseWords = safe.split(/\s+/).filter((t) => t.length > 1);
  if (baseWords.length === 0) return "";

  // Filter stop words from tokens before generating bigrams
  const filteredWords = baseWords.filter((t) => !STOP_WORDS.has(t.toLowerCase()));

  // Build bigrams from adjacent non-stop-words
  const bigrams: string[] = [];
  for (let i = 0; i < filteredWords.length - 1; i++) {
    bigrams.push(`${filteredWords[i]} ${filteredWords[i + 1]}`);
  }

  // Determine which words are consumed by bigrams that match synonym keys
  const consumedIndices = new Set<number>();
  const matchedBigrams: string[] = [];
  for (let i = 0; i < bigrams.length; i++) {
    const bg = bigrams[i].toLowerCase();
    if (synonymsMap[bg]) {
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
  for (let i = 0; i < filteredWords.length; i++) {
    if (!consumedIndices.has(i)) {
      const w = filteredWords[i].replace(/"/g, "").trim();
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

    if (groupsExpanded < MAX_SYNONYM_GROUPS && synonymsMap[termText]) {
      for (const syn of synonymsMap[termText]) {
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
