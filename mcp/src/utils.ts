import * as fs from "fs";
import * as path from "path";
import { execFileSync, spawnSync } from "child_process";
import * as yaml from "js-yaml";
import { fileURLToPath } from "url";
import { findCortexPath } from "./shared.js";
import { bootstrapCortexDotEnv } from "./cortex-dotenv.js";

const _synonymsPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "synonyms.json");
const _synonymsJson: Record<string, string[]> = (() => {
  try { return JSON.parse(fs.readFileSync(_synonymsPath, "utf8")); } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] synonyms.json load failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return {};
  }
})();

// ── Shared Git helper ────────────────────────────────────────────────────────

export function runGitOrThrow(cwd: string, args: string[], timeoutMs: number): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    const suffix = stderr ? `: ${stderr}` : result.signal ? ` (signal: ${result.signal})` : "";
    throw new Error(`git ${args.join(" ")} exited with status ${result.status ?? "unknown"}${suffix}`);
  }
  return result.stdout ?? "";
}

export function runGit(cwd: string, args: string[], timeoutMs: number, debugLogFn?: (msg: string) => void): string | null {
  try {
    return runGitOrThrow(cwd, args, timeoutMs).trim();
  } catch (err: unknown) {
    const msg = errorMessage(err);
    if (debugLogFn) debugLogFn(`runGit: git ${args[0]} failed in ${cwd}: ${msg}`);
    return null;
  }
}

export interface ResolvedExecCommand {
  command: string;
  shell: boolean;
}

function needsCommandShell(cmd: string): boolean {
  return /\.(cmd|bat)$/i.test(path.basename(cmd));
}

export function normalizeExecCommand(
  cmd: string,
  platform: NodeJS.Platform = process.platform,
  whereOutput?: string | null,
): ResolvedExecCommand {
  if (platform !== "win32") return { command: cmd, shell: false };

  if (cmd.includes("\\") || cmd.includes("/") || /\.[A-Za-z0-9]+$/i.test(path.basename(cmd))) {
    return { command: cmd, shell: needsCommandShell(cmd) };
  }

  const candidate = (whereOutput || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  const resolved = candidate || cmd;
  return { command: resolved, shell: needsCommandShell(resolved) };
}

export function resolveExecCommand(cmd: string): ResolvedExecCommand {
  if (process.platform !== "win32") return { command: cmd, shell: false };
  try {
    const whereOutput = execFileSync("where.exe", [cmd], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    return normalizeExecCommand(cmd, process.platform, whereOutput);
  } catch {
    return normalizeExecCommand(cmd, process.platform, null);
  }
}


// ── Error message extractor ─────────────────────────────────────────────────

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Feature flag and clamping helpers ────────────────────────────────────────

export function isFeatureEnabled(envName: string, defaultValue: boolean = true): boolean {
  bootstrapCortexDotEnv();
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

// Validate a project name: lowercase letters/numbers with optional hyphen/underscore separators.
// Must not start with a hyphen (breaks CLI flags) or dot (hidden dirs). Max 100 chars.
// Internal keys like "native:-home" bypass this — they never go through user-facing validation.
export function isValidProjectName(name: string): boolean {
  if (!name || name.length === 0) return false;
  if (name.length > 100) return false;
  return /^[a-z0-9][a-z0-9_-]*$/.test(name);
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
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] synonyms.yaml parse failed (${filePath}): ${err instanceof Error ? err.message : String(err)}\n`);
    return {};
  }
}

function loadUserSynonyms(project?: string | null, cortexPath?: string | null): Record<string, string[]> {
  const resolved = cortexPath ?? findCortexPath();
  if (!resolved) return {};

  const globalSynonyms = parseSynonymsYaml(path.join(resolved, "global", "synonyms.yaml"));
  if (!project || !isValidProjectName(project)) return globalSynonyms;

  const projectSynonyms = parseSynonymsYaml(path.join(resolved, project, "synonyms.yaml"));
  return {
    ...globalSynonyms,
    ...projectSynonyms,
  };
}

function buildFtsClauses(raw: string, project?: string | null, cortexPath?: string): string[] {
  const MAX_TOTAL_TERMS = 10;
  const MAX_SYNONYM_GROUPS = 3;

  // Step 1: Sanitize — strip FTS5 special chars, enforce length limits
  const safe = sanitizeFts5Query(raw);
  if (!safe) return [];

  // Step 2: Merge built-in and per-project synonym maps
  const synonymsMap = {
    ...SYNONYMS,
    ...loadUserSynonyms(project, cortexPath),
  };

  // Step 3: Tokenize — split sanitized input into individual words (min length 2)
  const baseWords = safe.split(/\s+/).filter((t) => t.length > 1);
  if (baseWords.length === 0) return [];

  // Step 4: Filter stop words — remove common English words that add no search signal
  const filteredTerms = baseWords.filter((t) => !STOP_WORDS.has(t.toLowerCase()));

  // Step 5: Build bigrams — sliding window over adjacent filtered terms for phrase matching
  const bigrams: string[] = [];
  for (let i = 0; i < filteredTerms.length - 1; i++) {
    bigrams.push(`${filteredTerms[i]} ${filteredTerms[i + 1]}`);
  }

  // Step 6: Match bigrams against synonym keys — bigram matches are promoted to quoted
  // phrases and their constituent words are marked consumed (not repeated as singletons)
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

  // Step 7: Assemble and deduplicate core terms — matched bigrams (as quoted phrases)
  // first, then unconsumed individual words; duplicates removed via seenTerms
  const dedupedTerms: string[] = [];
  const seenTerms = new Set<string>();
  for (const bg of matchedBigrams) {
    const clean = bg.replace(/"/g, "").trim().toLowerCase();
    if (!seenTerms.has(clean)) {
      seenTerms.add(clean);
      dedupedTerms.push(`"${bg.replace(/"/g, "").trim()}"`);
    }
  }
  for (let i = 0; i < filteredTerms.length; i++) {
    if (!consumedIndices.has(i)) {
      const w = filteredTerms[i].replace(/"/g, "").trim();
      const wLow = w.toLowerCase();
      if (w.length > 1 && !seenTerms.has(wLow)) {
        seenTerms.add(wLow);
        dedupedTerms.push(`"${w}"`);
      }
    }
  }

  if (dedupedTerms.length === 0) return [];

  // Step 8: Expand synonyms — for up to MAX_SYNONYM_GROUPS core terms, add OR alternatives
  // from the synonym map; total term count is capped at MAX_TOTAL_TERMS to keep queries sane
  let totalTermCount = dedupedTerms.length;
  let groupsExpanded = 0;
  const expandedClauses: string[] = [];

  for (const coreTerm of dedupedTerms) {
    const termText = coreTerm.slice(1, -1).toLowerCase(); // strip surrounding quotes
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
      expandedClauses.push(`(${coreTerm} OR ${synonyms.join(" OR ")})`);
    } else {
      expandedClauses.push(coreTerm);
    }
  }

  // Step 9: Join all clauses with AND — every core term (with its OR synonyms) must match
  return expandedClauses;
}

function clauseSignalScore(clause: string): number {
  const normalized = clause
    .replace(/[()"]/g, " ")
    .replace(/\bOR\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!normalized) return 0;
  const tokens = normalized.split(" ").filter(Boolean);
  const longestToken = tokens.reduce((max, token) => Math.max(max, token.length), 0);
  const phraseBonus = tokens.length > 1 ? 1.5 : 0;
  const synonymBonus = /\bOR\b/i.test(clause) ? 0.5 : 0;
  return longestToken + phraseBonus + synonymBonus;
}

// Build a defensive FTS5 MATCH query:
// - sanitizes user input
// - extracts bigrams and treats them as quoted phrases
// - expands known synonyms (capped at 10 total terms)
// - applies AND between core terms, with synonyms as OR alternatives
export function buildRobustFtsQuery(raw: string, project?: string | null, cortexPath?: string): string {
  const clauses = buildFtsClauses(raw, project, cortexPath);
  if (clauses.length === 0) return "";
  return clauses.join(" AND ");
}

// Build a relaxed lexical rescue query that matches any 2 of the most informative
// clauses. This is only intended as a fallback when the stricter AND query returns
// nothing; it trades precision for recall while staying in the FTS index.
export function buildRelaxedFtsQuery(raw: string, project?: string | null, cortexPath?: string): string {
  const clauses = buildFtsClauses(raw, project, cortexPath);
  if (clauses.length < 3) return "";

  const salientClauses = clauses
    .map((clause, index) => ({ clause, index, score: clauseSignalScore(clause) }))
    .sort((a, b) => {
      const scoreDelta = b.score - a.score;
      if (Math.abs(scoreDelta) > 0.01) return scoreDelta;
      return a.index - b.index;
    })
    .slice(0, Math.min(4, clauses.length))
    .sort((a, b) => a.index - b.index);

  if (salientClauses.length < 2) return "";

  const combos: string[] = [];
  for (let i = 0; i < salientClauses.length - 1; i++) {
    for (let j = i + 1; j < salientClauses.length; j++) {
      combos.push(`(${salientClauses[i].clause} AND ${salientClauses[j].clause})`);
    }
  }

  return combos.join(" OR ");
}

export function buildFtsQueryVariants(raw: string, project?: string | null, cortexPath?: string): string[] {
  const variants = [
    buildRobustFtsQuery(raw, project, cortexPath),
    buildRelaxedFtsQuery(raw, project, cortexPath),
  ].filter(Boolean);
  return [...new Set(variants)];
}
