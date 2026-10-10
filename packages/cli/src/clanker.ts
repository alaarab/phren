/**
 * Clanker mode: keyword-first retrieval.
 *
 * With it on, the prompt hook, search_knowledge, get_tasks and get_findings
 * return one short row per hit (id, title, a few keywords, a score) instead
 * of the text itself, and the agent fetches what it needs with
 * get_memory_detail. Findings and tasks get their own fid:/bid: ids, so
 * fetching one returns that entry, not the whole file it lives in.
 *
 * `phren config clanker on|off` sets it per install; PHREN_CLANKER overrides
 * it, and the older PHREN_FEATURE_PROGRESSIVE_DISCLOSURE is read as an alias.
 */
import { readInstallPreferences } from "./init/preferences.js";
import { STOP_WORDS } from "./utils.js";

const TRUE_VALUES = new Set(["1", "true", "on", "yes"]);
const FALSE_VALUES = new Set(["0", "false", "off", "no"]);

function parseSwitch(raw: string | undefined): boolean | undefined {
  const value = raw?.trim().toLowerCase();
  if (!value) return undefined;
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  return undefined;
}

/** Where the clanker setting came from, for `phren config clanker`. */
export type ClankerSource = "PHREN_CLANKER" | "PHREN_FEATURE_PROGRESSIVE_DISCLOSURE" | "install preferences" | "default";

export function resolveClanker(phrenPath: string, env: NodeJS.ProcessEnv = process.env): { on: boolean; source: ClankerSource } {
  const fromEnv = parseSwitch(env.PHREN_CLANKER);
  if (fromEnv !== undefined) return { on: fromEnv, source: "PHREN_CLANKER" };
  const legacy = parseSwitch(env.PHREN_FEATURE_PROGRESSIVE_DISCLOSURE);
  if (legacy !== undefined) return { on: legacy, source: "PHREN_FEATURE_PROGRESSIVE_DISCLOSURE" };
  try {
    const prefs = readInstallPreferences(phrenPath);
    if (typeof prefs.clanker === "boolean") return { on: prefs.clanker, source: "install preferences" };
  } catch {
    // No preferences yet: the default applies.
  }
  return { on: false, source: "default" };
}

export function clankerEnabled(phrenPath: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveClanker(phrenPath, env).on;
}

// ── Rows ─────────────────────────────────────────────────────────────────────

export interface ClankerRow {
  id: string;
  project: string;
  type: string;
  title: string;
  keywords: string[];
  /** Share of the query's terms the entry contains, 0–1. Absent for plain lists. */
  score?: number;
}

const TITLE_CHARS = 90;
/** Hook rows are few and arrive unasked, so they get room for the entry's point, not just its subject. */
export const HOOK_TITLE_CHARS = 140;
const KEYWORD_COUNT = 4;

/** Query terms as the snippet extractor reads them: lowercase, no FTS operators. */
export function queryTerms(query: string): string[] {
  return [...new Set(query
    .replace(/\b(AND|OR|NOT|NEAR)\b/g, " ")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_.-]/gu, " ")
    .split(/\s+/)
    .map((term) => term.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((term) => term.length > 1 && !STOP_WORDS.has(term)))];
}

/** Entry text without markers, comments, checkboxes or markdown decoration. */
export function plainEntryText(line: string): string {
  return line
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/^\s*[-*]\s+(\[[ xX]\]\s+)?/, "")
    .replace(/^#+\s+/, "")
    // Backticks and bold only: underscores and single stars belong to
    // identifiers and globs (PHREN_PATH, node_modules, **/*.ts).
    .replace(/`|\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function rowTitle(text: string, max = TITLE_CHARS): string {
  const plain = plainEntryText(text);
  if (plain.length <= max) return plain;
  return `${plain.slice(0, max - 1).trimEnd()}…`;
}

/**
 * A few words that say what the entry is about: up to two query terms it
 * contains first, then identifier-looking words (paths, flags, names with dots,
 * dashes or capitals), then the longest remaining words.
 */
export function rowKeywords(text: string, terms: string[] = [], count = KEYWORD_COUNT): string[] {
  const plain = plainEntryText(text);
  const lower = plain.toLowerCase();
  // Two matched query terms say why it hit; the rest say what else it covers.
  const picked: string[] = [];
  for (const term of terms) {
    if (picked.length >= Math.min(2, count)) break;
    if (lower.includes(term)) picked.push(term);
  }
  const words = plain
    .split(/[\s,;:()[\]{}"'“”]+/)
    .map((word) => word.replace(/^[.-]+|[.!?.,-]+$/g, ""))
    .filter((word) => word.length > 3 && !STOP_WORDS.has(word.toLowerCase()) && !/^\d+$/.test(word));
  const seen = new Set(picked);
  const identifier = (word: string) => /[./_@#-]/.test(word) || /[a-z][A-Z]/.test(word) || /^[A-Z0-9]{2,}$/.test(word);
  const candidates = [
    ...words.filter(identifier),
    ...words.filter((word) => !identifier(word)).sort((a, b) => b.length - a.length),
  ];
  for (const word of candidates) {
    if (picked.length >= count) break;
    const key = word.toLowerCase();
    if (seen.has(key) || word.length > 40) continue;
    seen.add(key);
    picked.push(key);
  }
  return picked;
}

export function termScore(text: string, terms: string[]): number {
  if (!terms.length) return 0;
  const lower = text.toLowerCase();
  const hits = terms.filter((term) => lower.includes(term)).length;
  return Math.round((hits / terms.length) * 100) / 100;
}

/** One row per line: `id [project] title [keywords] score`. */
export function formatRow(row: ClankerRow, showProject = false): string {
  const project = showProject ? ` ${row.project}:` : "";
  const keywords = row.keywords.length ? ` [${row.keywords.join(", ")}]` : "";
  const score = row.score !== undefined ? ` ${row.score.toFixed(2)}` : "";
  return `${row.id}${project} ${row.title}${keywords}${score}`;
}

// ── Entries inside a document ────────────────────────────────────────────────

const ENTRY_ID = /<!--\s*(?:fid:([a-z0-9]{8})|bid:([a-f0-9]{8}))\b/i;

export interface DocEntry {
  /** `fid:xxxxxxxx` or `bid:xxxxxxxx`. */
  id: string;
  line: string;
  /** The bullet plus its indented continuation (task Context, citations). */
  text: string;
}

/** The bullets in a findings, task or archive document that carry a stable id. */
export function docEntries(content: string): DocEntry[] {
  const lines = content.split("\n");
  const entries: DocEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*-\s/.test(lines[i]) || /^\s+/.test(lines[i])) continue;
    const match = lines[i].match(ENTRY_ID);
    if (!match) continue;
    let end = i + 1;
    while (end < lines.length && /^\s+\S/.test(lines[end])) end++;
    entries.push({
      id: match[1] ? `fid:${match[1].toLowerCase()}` : `bid:${match[2].toLowerCase()}`,
      line: lines[i],
      text: lines.slice(i, end).join("\n"),
    });
  }
  return entries;
}

/** Find one entry by `fid:`/`bid:` id in a document's content. */
export function findEntry(content: string, id: string): DocEntry | null {
  const wanted = id.toLowerCase();
  return docEntries(content).find((entry) => entry.id === wanted) ?? null;
}

/**
 * Rows for one search hit. Findings, tasks and archive topics become one row
 * per matching entry (best first, at most `max`); other documents are one row
 * for the matched line under the document's mem: id.
 */
export function rowsForDoc(
  doc: { project: string; type: string; content: string },
  docId: string,
  terms: string[],
  bestLine: string,
  max: number,
): ClankerRow[] {
  const entries = docEntries(doc.content)
    .map((entry) => ({ entry, score: termScore(entry.line, terms) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
  if (entries.length) {
    return entries.map(({ entry, score }) => ({
      id: entry.id,
      project: doc.project,
      type: doc.type,
      title: rowTitle(entry.line),
      keywords: rowKeywords(entry.line, terms),
      score,
    }));
  }
  return [{
    id: docId,
    project: doc.project,
    type: doc.type,
    title: rowTitle(bestLine || doc.content.split("\n").find((line) => line.trim() && !/^\s*(#|<!--)/.test(line)) || ""),
    keywords: rowKeywords(bestLine || doc.content.slice(0, 2000), terms),
    score: termScore(bestLine || doc.content, terms),
  }];
}

export const CLANKER_FETCH_HINT = "Rows: id title [keywords], plus a 0-1 score on search hits. Full text: get_memory_detail id=<id>.";
