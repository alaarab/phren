import * as fs from "node:fs";
import type { SqlJsDatabase } from "../index-query.js";
import { parseFindingsContent, readFindings, type FindingItem } from "../data/access.js";
import { listTopicFiles } from "../content/summarize.js";
import { openCodeDatabase, type CodeDatabase } from "./store.js";
import { parseSymbolQuery, resolveSymbol, type SymbolHit } from "./query.js";

/**
 * The memory link (stage 4): findings cite symbols, and a definition lists the
 * findings that cite it.
 *
 * A finding's text is scanned for symbol-shaped names; a name that resolves to
 * exactly one non-variable (or exported) symbol in the project's code index is
 * attached as a `symbol:` citation. An explicit `symbol:` citation is validated
 * the same way a file citation is and stored even when it does not resolve,
 * with `symbol_unresolved` set so the read side can show it as unresolved.
 *
 * Nothing here rewrites the finding text; the citation is the only thing added.
 */

/** Shorter names are too close to common words to auto-attach without noise. */
export const MIN_AUTO_SYMBOL_LENGTH = 4;

// Identifier-shaped tokens: a dotted `Type.member` or a bare `Name`/`name()`.
// The trailing `()` is not part of the token; parseSymbolQuery strips it anyway.
const CANDIDATE_RE = /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?/g;
const MAX_CANDIDATES = 100;

/** Symbol-shaped tokens in a finding, in order and deduplicated. */
export function symbolCandidates(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(CANDIDATE_RE)) {
    const token = match[0];
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

/** A symbol is worth auto-attaching only when it is a real declaration, not a local. */
function passesAutoFilter(hit: SymbolHit): boolean {
  if (hit.name.length < MIN_AUTO_SYMBOL_LENGTH) return false;
  if (hit.kind === "variable" && !hit.exported) return false;
  return true;
}

/** The first candidate in the text that resolves to exactly one attachable symbol. */
export function resolveAutoSymbol(db: SqlJsDatabase, text: string): SymbolHit | undefined {
  for (const candidate of symbolCandidates(text)) {
    const { chosen, candidates } = resolveSymbol(db, candidate);
    if (!chosen || candidates !== 1) continue;
    if (!passesAutoFilter(chosen)) continue;
    return chosen;
  }
  return undefined;
}

/** The canonical citation form of a resolved symbol: `Type.member` or `Name`. */
export function citationSymbolName(hit: SymbolHit): string {
  return hit.parent ? `${hit.parent}.${hit.name}` : hit.name;
}

export interface SymbolCitationResult {
  symbol?: string;
  symbol_unresolved?: boolean;
}

/**
 * Resolve the symbol citation to store for a finding.
 *
 * With an explicit symbol, the index is consulted and the citation is returned
 * either way: unresolved is recorded, not rejected, mirroring how an invalid
 * file citation is still stored. Without one, a symbol is auto-attached only
 * when the finding names exactly one resolvable, non-variable symbol. When the
 * project has no index there is nothing to resolve against, so an explicit
 * symbol is stored as given and no symbol is auto-attached.
 */
export async function symbolCitationForFinding(
  store: string,
  project: string,
  text: string,
  explicitSymbol?: string,
): Promise<SymbolCitationResult> {
  const explicit = explicitSymbol?.trim();
  let database: CodeDatabase | undefined;
  try {
    database = await openCodeDatabase(store, project, false);
  } catch {
    // A broken or unavailable index must never block a finding write.
    return explicit ? { symbol: explicit } : {};
  }
  if (!database) {
    return explicit ? { symbol: explicit } : {};
  }
  try {
    if (explicit) {
      const { chosen, candidates } = resolveSymbol(database.db, explicit);
      if (chosen && candidates === 1) return { symbol: explicit };
      return { symbol: explicit, symbol_unresolved: true };
    }
    const chosen = resolveAutoSymbol(database.db, text);
    return chosen ? { symbol: citationSymbolName(chosen) } : {};
  } catch {
    return explicit ? { symbol: explicit } : {};
  } finally {
    database.close();
  }
}

// ── Findings that cite a symbol ─────────────────────────────────────────────

export interface CitingFinding {
  id: string;
  stableId?: string;
  text: string;
  /** The citation's own symbol string, which may be a container-qualified form. */
  symbol: string;
}

function symbolMatchesCitation(symbol: string, cited: string): boolean {
  const wanted = parseSymbolQuery(symbol);
  const have = parseSymbolQuery(cited);
  if (wanted.name.toLowerCase() !== have.name.toLowerCase()) return false;
  if (!wanted.container || !have.container) return true;
  return wanted.container.toLowerCase() === have.container.toLowerCase();
}

function collectCiting(items: FindingItem[], symbol: string, out: CitingFinding[], seen: Set<string>): void {
  for (const item of items) {
    const cited = item.citationData?.symbol;
    if (!cited || !symbolMatchesCitation(symbol, cited)) continue;
    const key = item.stableId ?? item.text;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: item.id, stableId: item.stableId, text: item.text, symbol: cited });
  }
}

/**
 * Every finding that cites `symbol`, from FINDINGS.md (including its archive
 * blocks) and from the project's `reference/topics/*.md` archives, read through
 * the same finding parser the rest of phren uses.
 */
export function findingsCitingSymbol(store: string, project: string, symbol: string): CitingFinding[] {
  const out: CitingFinding[] = [];
  const seen = new Set<string>();

  const live = readFindings(store, project, { includeArchived: true });
  if (live.ok) collectCiting(live.data, symbol, out, seen);

  for (const topic of listTopicFiles(store, project)) {
    try {
      collectCiting(parseFindingsContent(fs.readFileSync(topic.file, "utf8"), { includeArchived: true }), symbol, out, seen);
    } catch {
      // A topic file that cannot be read is skipped; the live findings still answer.
    }
  }

  return out;
}

/** One line per citing finding: its id/bid and the first 160 characters of its text. */
export function formatCitingFinding(finding: CitingFinding): string {
  const label = finding.stableId ? `${finding.id}|fid:${finding.stableId}` : finding.id;
  const text = finding.text.replace(/\s+/g, " ").trim().slice(0, 160);
  return `- [${label}] ${text}`;
}
