/**
 * Citation states this computer has checked, kept in `.runtime/citation-states.json`.
 * Whether a citation checks out depends on the checkouts a computer has, so the
 * states stay local and are never written into the synced markdown. A citation's
 * `remote` resolves to this computer's clone of it, and another computer's repo
 * path to a same-named checkout here that has the cited commit. Governance
 * checks the least recently checked citations first, a bounded number of git
 * calls per run, and picks up the rest on the next run.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { atomicWriteText, runtimeDir, runtimeFile } from "../phren-paths.js";
import { debugLog } from "../shared.js";
import { errorMessage } from "../utils.js";
import { parseFindingId } from "./metadata.js";
import {
  checkFindingCitation,
  citationGitCallCount,
  parseCitationComment,
  type CitationState,
  type FindingCitation,
} from "./citation.js";

export const CITATION_STATES_FILE = "citation-states.json";
export const CITATION_GIT_CALLS_PER_RUN = 300;
const RETENTION_MS = 30 * 86_400_000;
const MAX_ENTRIES = 5000;
const STATES = new Set<CitationState>(["valid", "drifted", "broken", "unverifiable"]);

export interface CitationStateEntry {
  state: CitationState;
  checkedAt: string;
}

export type CitationStates = Record<string, CitationStateEntry>;

export interface CitationSweep {
  states: CitationStates;
  checked: number;
  pending: number;
  gitCalls: number;
}

/**
 * A bullet's text as the store file and the search index both give it: metadata comments and the index's
 * `[from:actor@machine]` attribution removed (the index drops `created` and turns `source` into that).
 * The sweep and retrieval key unrecorded-fid bullets by it, so they cannot disagree.
 */
export function bulletKeyText(bullet: string): string {
  return bullet.replace(/<!--[\s\S]*?-->/g, " ").replace(/\[from:[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
}

/** The finding's fid, else a hash of the file it is in and its bullet's key text. */
export function citationStateKey(file: string, bullet: string): string {
  const fid = parseFindingId(bullet);
  if (fid) return `fid:${fid.toLowerCase()}`;
  const source = `${path.resolve(file)}\0${bulletKeyText(bullet)}`;
  return `hash:${crypto.createHash("sha1").update(source).digest("hex").slice(0, 16)}`;
}

/** The recorded states; reading never creates `.runtime` (store health is read-only). */
export function readCitationStates(phrenPath: string): CitationStates {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(runtimeDir(phrenPath), CITATION_STATES_FILE), "utf8")) as Record<string, Partial<CitationStateEntry>>;
    const states: CitationStates = {};
    for (const [key, entry] of Object.entries(raw)) {
      if (entry && STATES.has(entry.state as CitationState) && typeof entry.checkedAt === "string" && Number.isFinite(Date.parse(entry.checkedAt))) {
        states[key] = { state: entry.state as CitationState, checkedAt: entry.checkedAt };
      }
    }
    return states;
  } catch {
    return {};
  }
}

/** Cited findings in a project's FINDINGS.md, topic files and their .older.md splits that name something to check. */
function citedFindings(storePath: string, project: string): Array<{ key: string; citation: FindingCitation }> {
  const files = [path.join(storePath, project, "FINDINGS.md")];
  try {
    const topics = path.join(storePath, project, "reference", "topics");
    for (const name of fs.readdirSync(topics).sort()) {
      if (name.endsWith(".md")) files.push(path.join(topics, name));
    }
  } catch { /* No topic archive yet. */ }
  const found: Array<{ key: string; citation: FindingCitation }> = [];
  for (const file of files) {
    let lines: string[];
    try { lines = fs.readFileSync(file, "utf8").split("\n"); } catch { continue; }
    for (let i = 0; i < lines.length - 1; i++) {
      if (!lines[i].startsWith("- ")) continue;
      const citation = parseCitationComment(lines[i + 1]);
      // A bare timestamp names nothing to check.
      if (!citation || (!citation.repo && !citation.remote && !citation.file && !citation.symbol_unresolved)) continue;
      found.push({ key: citationStateKey(file, lines[i]), citation });
    }
  }
  return found;
}

/** Checks the targets' citations, least recently checked first, until `maxGitCalls` git processes have run. */
export function sweepCitationStates(
  phrenPath: string,
  targets: Array<{ storePath: string; project: string }>,
  opts: { maxGitCalls?: number; save?: boolean; now?: number } = {},
): CitationSweep {
  const maxGitCalls = opts.maxGitCalls ?? CITATION_GIT_CALLS_PER_RUN;
  const now = opts.now ?? Date.now();
  const checkedAt = new Date(now).toISOString();
  const states = readCitationStates(phrenPath);
  const cited = new Map<string, FindingCitation>();
  for (const { storePath, project } of targets) {
    for (const { key, citation } of citedFindings(storePath, project)) if (!cited.has(key)) cited.set(key, citation);
  }
  // Stable sort: never-checked citations keep document order ahead of the rest.
  const order = [...cited.keys()].sort((a, b) => (states[a]?.checkedAt ?? "").localeCompare(states[b]?.checkedAt ?? ""));
  const start = citationGitCallCount();
  let checked = 0;
  for (const key of order) {
    if (citationGitCallCount() - start >= maxGitCalls) break;
    states[key] = { state: checkFindingCitation(cited.get(key)!, { phrenPath, relocate: true }), checkedAt };
    checked++;
  }
  const kept = Object.entries(states)
    .filter(([, entry]) => now - Date.parse(entry.checkedAt) <= RETENTION_MS)
    .sort((a, b) => b[1].checkedAt.localeCompare(a[1].checkedAt))
    .slice(0, MAX_ENTRIES);
  const bounded = Object.fromEntries(kept);
  if (opts.save !== false) {
    try {
      atomicWriteText(runtimeFile(phrenPath, CITATION_STATES_FILE), `${JSON.stringify(bounded)}\n`, { mode: 0o600 });
    } catch (err: unknown) {
      debugLog(`sweepCitationStates: could not save states: ${errorMessage(err)}`);
    }
  }
  return { states: bounded, checked, pending: order.length - checked, gitCalls: citationGitCallCount() - start };
}
