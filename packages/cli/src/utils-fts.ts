import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { fileURLToPath } from "url";
import { findPhrenPath } from "./phren-paths.js";
import { isValidProjectName, safeProjectPath } from "./utils-paths.js";

// Lazy import of logDebug to break circular dependency:
// utils.ts -> phren-paths.ts -> logger.ts -> phren-paths.ts -> utils.ts
let _logDebug: ((tool: string, msg: string) => void) | undefined;
async function ensureLogDebug(): Promise<void> {
  if (!_logDebug) {
    try {
      const mod = await import("./logger.js");
      _logDebug = mod.logger.debug;
    } catch {
      _logDebug = () => {};
    }
  }
}
function getLogDebug(): (tool: string, msg: string) => void {
  if (!_logDebug) {
    // Kick off the async import for future calls; fall back to no-op for this call
    void ensureLogDebug();
    return () => {};
  }
  return _logDebug;
}

const _moduleDir = path.dirname(fileURLToPath(import.meta.url));

function loadSynonymsJson(fileName: string): Record<string, string[]> {
  const filePath = path.join(_moduleDir, fileName);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err: unknown) {
    getLogDebug()("loadSynonymsJson", `${fileName} load failed: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

const _baseSynonymsJson = loadSynonymsJson("synonyms.json");

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
export function extractKeywordEntries(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, " ")
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

  return result;
}

export function extractKeywords(text: string): string {
  return extractKeywordEntries(text).join(" ");
}

// Base synonym map for fuzzy search expansion — source of truth is mcp/src/synonyms.json
const BASE_SYNONYMS: Record<string, string[]> = _baseSynonymsJson;
const LEARNED_SYNONYMS_FILE = "learned-synonyms.json";

function normalizeSynonymTerm(term: string): string {
  return term.toLowerCase().replace(/"/g, "").trim();
}

function normalizeSynonymValues(items: string[], baseTerm?: string): string[] {
  const normalizedBase = baseTerm ? normalizeSynonymTerm(baseTerm) : "";
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of items) {
    const term = normalizeSynonymTerm(raw);
    if (!term || term.length <= 1 || term === normalizedBase || seen.has(term)) continue;
    seen.add(term);
    normalized.push(term);
  }
  return normalized;
}

function mergeSynonymMaps(...maps: Array<Record<string, string[]>>): Record<string, string[]> {
  const merged: Record<string, string[]> = {};
  for (const map of maps) {
    for (const [rawKey, rawValues] of Object.entries(map)) {
      const key = normalizeSynonymTerm(rawKey);
      if (!key) continue;
      const existing = merged[key] ?? [];
      const values = normalizeSynonymValues([...(existing || []), ...(Array.isArray(rawValues) ? rawValues : [])], key);
      if (values.length > 0) merged[key] = values;
    }
  }
  return merged;
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
    getLogDebug()("parseSynonymsYaml", `synonyms.yaml parse failed (${filePath}): ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

function loadUserSynonyms(project?: string | null, phrenPath?: string | null): Record<string, string[]> {
  const resolved = phrenPath ?? findPhrenPath();
  if (!resolved) return {};

  const globalSynonyms = parseSynonymsYaml(path.join(resolved, "global", "synonyms.yaml"));
  if (!project || !isValidProjectName(project)) return globalSynonyms;

  const projectSynonyms = parseSynonymsYaml(path.join(resolved, project, "synonyms.yaml"));
  return {
    ...globalSynonyms,
    ...projectSynonyms,
  };
}

function parseLearnedSynonymsJson(filePath: string): Record<string, string[]> {
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const loaded: Record<string, string[]> = {};
    for (const [rawKey, rawValue] of Object.entries(parsed)) {
      if (!Array.isArray(rawValue)) continue;
      const key = normalizeSynonymTerm(rawKey);
      if (!key) continue;
      const synonyms = normalizeSynonymValues(
        rawValue.filter((v): v is string => typeof v === "string"),
        key,
      );
      if (synonyms.length > 0) loaded[key] = synonyms;
    }
    return loaded;
  } catch (err: unknown) {
    getLogDebug()("parseLearnedSynonymsJson", `learned-synonyms parse failed (${filePath}): ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

export function learnedSynonymsPath(phrenPath: string, project: string): string | null {
  if (!isValidProjectName(project)) return null;
  return safeProjectPath(phrenPath, project, LEARNED_SYNONYMS_FILE);
}

export function loadLearnedSynonyms(project?: string | null, phrenPath?: string | null): Record<string, string[]> {
  if (!project || !isValidProjectName(project)) return {};
  const resolved = phrenPath ?? findPhrenPath();
  if (!resolved) return {};
  const targetPath = learnedSynonymsPath(resolved, project);
  if (!targetPath) return {};
  return parseLearnedSynonymsJson(targetPath);
}

export function loadSynonymMap(project?: string | null, phrenPath?: string | null): Record<string, string[]> {
  return mergeSynonymMaps(
    BASE_SYNONYMS,
    loadUserSynonyms(project, phrenPath),
    loadLearnedSynonyms(project, phrenPath),
  );
}

export function learnSynonym(
  phrenPath: string,
  project: string,
  term: string,
  synonyms: string[],
): Record<string, string[]> {
  if (!isValidProjectName(project)) throw new Error(`Invalid project name: ${project}`);
  const targetPath = learnedSynonymsPath(phrenPath, project);
  if (!targetPath) throw new Error(`Path traversal detected for project: ${project}`);

  const normalizedTerm = normalizeSynonymTerm(term);
  if (!normalizedTerm || normalizedTerm.length <= 1) {
    throw new Error("Invalid synonym term");
  }
  const normalizedSynonyms = normalizeSynonymValues(synonyms, normalizedTerm);
  if (normalizedSynonyms.length === 0) {
    return loadLearnedSynonyms(project, phrenPath);
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const existing = parseLearnedSynonymsJson(targetPath);
  const next = mergeSynonymMaps(existing, { [normalizedTerm]: normalizedSynonyms });
  const tmpPath = `${targetPath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2) + "\n", "utf8");
  fs.renameSync(tmpPath, targetPath);
  return next;
}

export function removeLearnedSynonym(
  phrenPath: string,
  project: string,
  term: string,
  synonyms?: string[],
): Record<string, string[]> {
  if (!isValidProjectName(project)) throw new Error(`Invalid project name: ${project}`);
  const targetPath = learnedSynonymsPath(phrenPath, project);
  if (!targetPath) throw new Error(`Path traversal detected for project: ${project}`);

  const normalizedTerm = normalizeSynonymTerm(term);
  if (!normalizedTerm || normalizedTerm.length <= 1) {
    throw new Error("Invalid synonym term");
  }

  const existing = parseLearnedSynonymsJson(targetPath);
  if (!existing[normalizedTerm]) return existing;

  if (!synonyms || synonyms.length === 0) {
    delete existing[normalizedTerm];
  } else {
    const drop = new Set(normalizeSynonymValues(synonyms));
    existing[normalizedTerm] = (existing[normalizedTerm] || []).filter((item) => !drop.has(item));
    if (existing[normalizedTerm].length === 0) delete existing[normalizedTerm];
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  if (Object.keys(existing).length === 0) {
    try { fs.unlinkSync(targetPath); } catch {}
    return {};
  }
  const tmpPath = `${targetPath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(existing, null, 2) + "\n", "utf8");
  fs.renameSync(tmpPath, targetPath);
  return existing;
}

const MAX_FTS_QUERY_LENGTH = 500;

// Sanitize user input before passing it to an FTS5 MATCH expression.
// Strips FTS5-specific syntax that could cause injection or parse errors.
export function sanitizeFts5Query(raw: string): string {
  if (!raw) return "";
  if (raw.length > MAX_FTS_QUERY_LENGTH) raw = raw.slice(0, MAX_FTS_QUERY_LENGTH);
  // Whitelist approach: only allow alphanumeric, spaces, hyphens, apostrophes, asterisks
  let q = raw.replace(/[^\p{L}\p{N} \-"*]/gu, " ");
  // Strip all double quotes — buildFtsClauses wraps terms in quotes itself,
  // so user-supplied quotes only risk producing unbalanced FTS5 syntax.
  q = q.replace(/"/g, "");
  // Q83: see docs/decisions/Q83-fts5-asterisk-validation.md
  q = q.replace(/(?<!\w)\*/g, "");
  // Also strip a trailing asterisk that is preceded only by whitespace at word
  // end of the whole query (handles "foo *" → "foo").
  q = q.replace(/\s+\*$/g, "");
  // Normalize spaces after all stripping to avoid double spaces from removed characters
  q = q.replace(/\s+/g, " ").trim();
  return q;
}

function buildFtsClauses(raw: string, project?: string | null, phrenPath?: string): string[] {
  const MAX_TOTAL_TERMS = 10;
  const MAX_SYNONYM_GROUPS = 3;

  // Step 1: Sanitize — strip FTS5 special chars, enforce length limits
  const safe = sanitizeFts5Query(raw);
  if (!safe) return [];

  // Step 2: Merge built-in and per-project synonym maps
  const synonymsMap = loadSynonymMap(project, phrenPath);

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
export function buildRobustFtsQuery(raw: string, project?: string | null, phrenPath?: string): string {
  const clauses = buildFtsClauses(raw, project, phrenPath);
  if (clauses.length === 0) return "";
  return clauses.join(" AND ");
}

// Build a relaxed lexical rescue query that matches any 2 of the most informative
// clauses. This is only intended as a fallback when the stricter AND query returns
// nothing; it trades precision for recall while staying in the FTS index.
export function buildRelaxedFtsQuery(raw: string, project?: string | null, phrenPath?: string): string {
  const clauses = buildFtsClauses(raw, project, phrenPath);
  if (clauses.length === 0) return "";

  // Short queries (1-2 terms): OR the clauses together with prefix expansion
  if (clauses.length === 1) {
    const term = clauses[0];
    // Add prefix wildcard for unquoted-style terms to broaden recall
    const inner = term.replace(/^"(.*)"$/, "$1");
    if (inner.length >= 3) {
      return `(${term} OR "${inner}"*)`;
    }
    return term;
  }
  if (clauses.length === 2) {
    return `(${clauses[0]} OR ${clauses[1]})`;
  }

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

export function buildFtsQueryVariants(raw: string, project?: string | null, phrenPath?: string): string[] {
  const variants = [
    buildRobustFtsQuery(raw, project, phrenPath),
    buildRelaxedFtsQuery(raw, project, phrenPath),
  ].filter(Boolean);

  // For short queries, add a prefix-expanded variant to catch partial matches
  const clauses = buildFtsClauses(raw, project, phrenPath);
  if (clauses.length <= 2) {
    const prefixParts = clauses
      .map(c => c.replace(/^"(.*)"$/, "$1"))
      .filter(t => t.length >= 3)
      .map(t => `"${t}"*`);
    if (prefixParts.length > 0) {
      variants.push(prefixParts.join(" OR "));
    }
  }

  return [...new Set(variants)];
}
