/**
 * The injected layer's size, and what to demote when it is too big.
 *
 * What phren puts in front of every session for a project regardless of the
 * prompt is (see `shared/retrieval.ts` and `cli/hooks.ts`):
 *  - the whole of the project's `truths.md` (canonical rows are prepended to
 *    every search for the detected project), and
 *  - the "What phren knows" block from `summary.md`, once per session, capped
 *    at 520 characters by the hook.
 * Everything else the hook injects is chosen by relevance and already sits
 * under its own token budget. Errors in the always-on part spread to every
 * session, so dreaming keeps it under `dreaming.injectBudgetKB`.
 */

import * as fs from "fs";
import { readKnowsBlock } from "../content/summarize.js";
import { lookupEventsLogFile } from "../phren-paths.js";
import { storeAwareProjectPath } from "../store-routing.js";

/** The hook trims the knows block to this many characters (cli/hooks.ts). */
const KNOWS_INJECT_CHARS = 520;
/** Read at most this much of the lookup log's tail when looking for citations. */
const LOOKUP_TAIL_BYTES = 4 * 1024 * 1024;
const ADDED_RE = /\s*_\(added (\d{4}-\d{2}-\d{2})\)_\s*$/;

export interface Truth {
  /** The truth as written, without the leading "- " and the "_(added …)_" stamp. */
  text: string;
  /** The full bullet line as stored, for an exact demote. */
  line: string;
  added?: string;
  /** Bytes this line costs in the injected file (line plus newline). */
  bytes: number;
}

export interface InjectedSize {
  project: string;
  /** Bytes of truths.md as stored; the hook injects the file as is. */
  truthsBytes: number;
  /** Bytes of the knows block as the hook injects it (after its trim). */
  knowsBytes: number;
  bytes: number;
  kb: number;
  truths: Truth[];
}

export interface DemotionCandidate extends Truth {
  /** Most recent evidence that the truth was used: a lookup hit, a caller-supplied citation, or its added date. */
  lastCited?: string;
}

export interface BudgetState {
  project: string;
  budgetBytes: number;
  bytes: number;
  over: boolean;
  /** Bytes to free to get back under budget; 0 when under. */
  excessBytes: number;
  /** The shortest least-recently-cited-first prefix that, demoted, gets under budget. Empty when under. */
  candidates: DemotionCandidate[];
  /** Every truth, least recently cited first. */
  ranking: DemotionCandidate[];
}

export interface OverBudgetOptions {
  /** Extra citation dates by truth text (e.g. transcript mentions found by collect). Newer dates win. */
  citedAt?: Map<string, string> | Record<string, string>;
  /** Skip reading the lookup log (tests, or callers that pass citedAt themselves). */
  skipLookupLog?: boolean;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

export function parseTruths(content: string): Truth[] {
  const truths: Truth[] = [];
  for (const line of content.split("\n")) {
    if (!line.startsWith("- ")) continue;
    const raw = line.slice(2);
    const added = raw.match(ADDED_RE)?.[1];
    truths.push({ text: raw.replace(ADDED_RE, "").trim(), line, added, bytes: byteLength(line) + 1 });
  }
  return truths;
}

function truthsPath(store: string, project: string): string | null {
  return storeAwareProjectPath(store, project, "truths.md");
}

export function injectedSize(store: string, project: string): InjectedSize {
  const file = truthsPath(store, project);
  let content = "";
  try { if (file) content = fs.readFileSync(file, "utf8"); } catch { content = ""; }
  let knowsBytes = 0;
  try {
    const knows = readKnowsBlock(store, project);
    if (knows) {
      const text = knows.text.length > KNOWS_INJECT_CHARS ? `${knows.text.slice(0, KNOWS_INJECT_CHARS - 1)}…` : knows.text;
      knowsBytes = byteLength(text);
    }
  } catch { knowsBytes = 0; }
  const truthsBytes = byteLength(content);
  const bytes = truthsBytes + knowsBytes;
  return { project, truthsBytes, knowsBytes, bytes, kb: Math.round((bytes / 1024) * 100) / 100, truths: parseTruths(content) };
}

/**
 * Latest lookup-log time at which each truth showed up in a hit's snippet for
 * this project. The always-inject path logs the whole truths file, so only
 * search hits that matched a truth's own words are a useful signal; a truth
 * nobody searched into stays uncited and is demoted first.
 */
function lookupCitations(store: string, project: string, truths: Truth[]): Map<string, string> {
  const result = new Map<string, string>();
  const file = lookupEventsLogFile(store);
  let text = "";
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - LOOKUP_TAIL_BYTES);
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString("utf8");
    } finally { fs.closeSync(fd); }
  } catch { return result; }
  const keys = truths.map((t) => ({ text: t.text, key: normalize(t.text).slice(0, 60) })).filter((k) => k.key.length >= 12);
  for (const line of text.split("\n")) {
    if (!line.includes(project)) continue;
    let event: { at?: string; project?: string; type?: string; snippet?: string; source?: string };
    try { event = JSON.parse(line); } catch { continue; }
    if (event.project !== project || event.type !== "canonical" || !event.at || !event.snippet) continue;
    // A snippet carrying most of the file is the always-inject path, not a citation.
    const snippet = normalize(event.snippet);
    const hits = keys.filter((k) => snippet.includes(k.key));
    if (!hits.length || (keys.length > 2 && hits.length > keys.length / 2)) continue;
    for (const hit of hits) {
      const prev = result.get(hit.text);
      if (!prev || event.at > prev) result.set(hit.text, event.at);
    }
  }
  return result;
}

function newer(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

export function rankTruths(store: string, project: string, truths: Truth[], opts: OverBudgetOptions = {}): DemotionCandidate[] {
  const looked = opts.skipLookupLog ? new Map<string, string>() : lookupCitations(store, project, truths);
  const extra = opts.citedAt instanceof Map ? opts.citedAt : new Map(Object.entries(opts.citedAt ?? {}));
  const extraByNorm = new Map([...extra].map(([k, v]) => [normalize(k), v]));
  return truths
    .map((t, index) => ({ t, index, lastCited: newer(newer(t.added, looked.get(t.text)), extraByNorm.get(normalize(t.text))) }))
    .sort((a, b) => (a.lastCited ?? "").localeCompare(b.lastCited ?? "") || b.t.bytes - a.t.bytes || a.index - b.index)
    .map(({ t, lastCited }) => ({ ...t, lastCited }));
}

export function overBudget(store: string, project: string, budgetKB: number, opts: OverBudgetOptions = {}): BudgetState {
  const size = injectedSize(store, project);
  const budgetBytes = Math.max(0, Math.floor(budgetKB * 1024));
  const ranking = rankTruths(store, project, size.truths, opts);
  const excessBytes = Math.max(0, size.bytes - budgetBytes);
  const candidates: DemotionCandidate[] = [];
  let freed = 0;
  for (const truth of ranking) {
    if (freed >= excessBytes) break;
    candidates.push(truth);
    freed += truth.bytes;
  }
  return { project, budgetBytes, bytes: size.bytes, over: excessBytes > 0, excessBytes, candidates, ranking };
}

/**
 * Bytes a new truth costs once `upsertCanonical` has written it: a new file is
 * the header plus "- text _(added YYYY-MM-DD)_\n"; an existing one gets the
 * line plus a blank-line separator inserted under "## Truths".
 */
export function truthCost(project: string, text: string, fileExists: boolean): number {
  const line = byteLength(`- ${text.replace(/^- /, "")} _(added 0000-00-00)_`);
  return fileExists ? line + 2 : byteLength(`# ${project} Truths\n\n## Truths\n\n`) + line + 1;
}

export interface PromotionCheck {
  fits: boolean;
  bytesBefore: number;
  bytesAfter: number;
  budgetBytes: number;
}

/**
 * Whether promoting `text` to a truth keeps the injected layer under budget,
 * counting the truths the same changeset demotes. `apply` refuses a
 * promote_truth that does not fit.
 */
export function checkPromotion(store: string, project: string, budgetKB: number, text: string, demoted: string[] = []): PromotionCheck {
  const size = injectedSize(store, project);
  const budgetBytes = Math.max(0, Math.floor(budgetKB * 1024));
  const gone = new Set(demoted.map((d) => normalize(d.replace(/^- /, "").replace(ADDED_RE, ""))));
  const freed = size.truths.filter((t) => gone.has(normalize(t.text))).reduce((sum, t) => sum + t.bytes, 0);
  const bytesAfter = size.bytes - freed + truthCost(project, text, size.truthsBytes > 0);
  return { fits: bytesAfter <= budgetBytes, bytesBefore: size.bytes, bytesAfter, budgetBytes };
}

/** One line for the dreaming prompt: where the injected layer stands. */
export function describeBudget(state: BudgetState): string {
  const kb = (n: number) => (n / 1024).toFixed(1);
  if (!state.over) return `Injected layer: ${kb(state.bytes)} KB of ${kb(state.budgetBytes)} KB budget (${state.ranking.length} truths).`;
  return `Injected layer: ${kb(state.bytes)} KB, over the ${kb(state.budgetBytes)} KB budget by ${kb(state.excessBytes)} KB. `
    + `Least recently cited truths: ${state.candidates.map((c) => JSON.stringify(c.text)).join("; ")}.`;
}
