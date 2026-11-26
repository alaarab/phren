import * as fs from "fs";
import * as path from "path";
import { debugLog, EXEC_TIMEOUT_MS, EXEC_TIMEOUT_QUICK_MS } from "../shared.js";
import { errorMessage, runGitOrThrow } from "../utils.js";
import type { RetentionPolicy } from "../shared/governance.js";
import { findingIdFromLine } from "../finding/impact.js";
import { METADATA_REGEX, isArchiveStart, isArchiveEnd } from "./metadata.js";
import { FINDING_TYPE_DECAY, extractFindingType } from "../finding/lifecycle.js";

export interface FindingCitation {
  created_at: string;
  repo?: string;
  file?: string;
  line?: number;
  commit?: string;
  /**
   * A symbol the finding is about, as `Name`, `Type.member` or `name()`.
   * Auto-attached on write when the project has a code index and the finding
   * text names exactly one resolvable symbol; an explicit one is validated
   * against the index and stored either way.
   */
  symbol?: string;
  /** True when an explicit symbol citation could not be resolved in the index. */
  symbol_unresolved?: boolean;
  supersedes?: string;
  task_item?: string;
}

export const FINDING_PROVENANCE_SOURCES = [
  "human",
  "agent",
  "hook",
  "extract",
  "consolidation",
  "unknown",
] as const;

export type FindingProvenanceSource = (typeof FINDING_PROVENANCE_SOURCES)[number];

export function isFindingProvenanceSource(value: string | undefined): value is FindingProvenanceSource {
  if (!value) return false;
  return (FINDING_PROVENANCE_SOURCES as readonly string[]).includes(value);
}

export interface FindingProvenance {
  source?: FindingProvenanceSource;
  machine?: string;
  actor?: string;
  tool?: string;
  model?: string;
  session_id?: string;
  scope?: string;
}

export interface FindingTrustIssue {
  date: string;
  bullet: string;
  reason: "stale" | "invalid_citation";
}

export interface TrustFilterOptions {
  ttlDays?: number;
  minConfidence?: number;
  decay?: Partial<RetentionPolicy["decay"]>;
  project?: string;
  highImpactFindingIds?: Set<string>;
  /** States already known (governance's bounded sweep); an undefined answer counts as unverifiable. Unset checks live. */
  citationState?: (citation: FindingCitation, bullet: string) => CitationState | undefined;
}

export function getHeadCommit(cwd: string): string | undefined {
  try {
    const commit = runGitOrThrow(cwd, ["rev-parse", "HEAD"], EXEC_TIMEOUT_QUICK_MS).trim();
    return commit || undefined;
  } catch (err: unknown) {
    debugLog(`getHeadCommit: git rev-parse HEAD failed in ${cwd}: ${errorMessage(err)}`);
    return undefined;
  }
}

export function getRepoRoot(cwd: string): string | undefined {
  try {
    const root = runGitOrThrow(cwd, ["rev-parse", "--show-toplevel"], EXEC_TIMEOUT_QUICK_MS).trim();
    return root || undefined;
  } catch (err: unknown) {
    debugLog(`getRepoRoot: not a git repo or git unavailable in ${cwd}: ${errorMessage(err)}`);
    return undefined;
  }
}

export function inferCitationLocation(repoPath: string, commit: string): { file?: string; line?: number } {
  try {
    const raw = runGitOrThrow(repoPath, ["show", "--pretty=format:", "--unified=0", "--no-color", commit], EXEC_TIMEOUT_MS);
    let currentFile = "";
    for (const line of raw.split("\n")) {
      if (line.startsWith("+++ b/")) {
        currentFile = line.slice(6).trim();
        continue;
      }
      const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk && currentFile) {
        return { file: currentFile, line: Number.parseInt(hunk[1], 10) };
      }
    }
  } catch (err: unknown) {
    debugLog(`citationLocationFromCommit: git show failed: ${errorMessage(err)}`);
  }
  return {};
}

export function buildCitationComment(citation: FindingCitation): string {
  return `<!-- phren:cite ${JSON.stringify(citation)} -->`;
}

function readSourceToken(match: RegExpMatchArray | null | undefined): string | undefined {
  if (!match?.[1]) return undefined;
  const raw = match[1].trim();
  if (!raw) return undefined;
  if (raw.startsWith("\"") && raw.endsWith("\"") && raw.length >= 2) {
    return raw.slice(1, -1);
  }
  return raw;
}

/** Format actor/machine attribution for human-readable display. */
export function formatActorAttribution(actor: string | undefined, machine: string | undefined): string {
  if (!actor && !machine) return "";
  return `[from:${actor ?? "?"}${machine ? `@${machine}` : ""}]`;
}

export function buildSourceComment(source: FindingProvenance): string {
  const parts: string[] = [];
  if (source.source) parts.push(source.source);
  if (source.machine) parts.push(`machine:${source.machine}`);
  if (source.actor) parts.push(`actor:${source.actor}`);
  if (source.tool) parts.push(`tool:${source.tool}`);
  if (source.model) parts.push(`model:${source.model}`);
  if (source.session_id) parts.push(`session:${source.session_id}`);
  if (source.scope) parts.push(`scope:${source.scope}`);
  return parts.length > 0 ? `<!-- source:${parts.join(" ")} -->` : "";
}

/** Build a standalone scope comment. Returns empty string if scope is unset or "shared". */
export function buildScopeComment(scope: string | undefined): string {
  if (!scope || scope === "shared") return "";
  return `<!-- scope:${scope} -->`;
}

/** Parse a standalone `<!-- scope:VALUE -->` comment. */
export function parseScopeComment(line: string): string | undefined {
  const m = line.match(/<!--\s*scope:(".*?"|\S+)\s*-->/);
  if (!m) return undefined;
  const raw = m[1].replace(/^"|"$/g, "").trim();
  return raw || undefined;
}

export function parseSourceComment(line: string): FindingProvenance | null {
  const sourceMatch = line.match(METADATA_REGEX.source);
  if (!sourceMatch) return null;

  const payload = sourceMatch[1];
  const firstToken = payload.trim().split(/\s+/)[0] || "";
  const sourceRaw =
    (firstToken && !firstToken.includes(":") ? firstToken : undefined) ??
    readSourceToken(payload.match(/(?:^|\s)source:(".*?"|\S+)/)) ??
    readSourceToken(payload.match(/(?:^|\s)kind:(".*?"|\S+)/));
  const source = isFindingProvenanceSource(sourceRaw) ? sourceRaw : undefined;
  const machine =
    readSourceToken(payload.match(/(?:^|\s)machine:(".*?"|\S+)/)) ??
    readSourceToken(payload.match(/(?:^|\s)host:(".*?"|\S+)/));
  const actor =
    readSourceToken(payload.match(/(?:^|\s)actor:(".*?"|\S+)/)) ??
    readSourceToken(payload.match(/(?:^|\s)agent:(".*?"|\S+)/));
  const tool = readSourceToken(payload.match(/(?:^|\s)tool:(".*?"|\S+)/));
  const model = readSourceToken(payload.match(/(?:^|\s)model:(".*?"|\S+)/));
  const session_id =
    readSourceToken(payload.match(/(?:^|\s)session:(".*?"|\S+)/)) ??
    readSourceToken(payload.match(/(?:^|\s)session_id:(".*?"|\S+)/));
  const rawScope = readSourceToken(payload.match(/(?:^|\s)scope:(".*?"|\S+)/));
  const scope = rawScope === undefined
    ? undefined
    : (rawScope.trim() ? rawScope.trim() : "shared");

  if (!source && !machine && !actor && !tool && !model && !session_id && !scope) return null;
  return { source, machine, actor, tool, model, session_id, scope };
}

export function parseCitationComment(line: string): FindingCitation | null {
  // Find opening marker and closing --> to handle multiline/escaped JSON.
  // Uses marker-based extraction instead of regex to support multiline JSON.
  const markerMatch = line.match(METADATA_REGEX.citationMarker);
  if (!markerMatch) return null;
  const jsonStart = markerMatch.index! + markerMatch[0].length;
  const endMarker = line.indexOf("-->", jsonStart);
  if (endMarker === -1) return null;
  const jsonStr = line.slice(jsonStart, endMarker).trim();
  if (!jsonStr.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(jsonStr);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    // Default created_at to empty string if missing, but still require it to be string-like
    const created_at = typeof parsed.created_at === "string" ? parsed.created_at : "";
    if (!created_at) return null;
    return {
      created_at,
      repo: typeof parsed.repo === "string" ? parsed.repo : undefined,
      file: typeof parsed.file === "string" ? parsed.file : undefined,
      line: typeof parsed.line === "number" ? parsed.line : undefined,
      commit: typeof parsed.commit === "string" ? parsed.commit : undefined,
      symbol: typeof parsed.symbol === "string" && parsed.symbol.trim() ? parsed.symbol : undefined,
      symbol_unresolved: parsed.symbol_unresolved === true ? true : undefined,
      supersedes: typeof parsed.supersedes === "string" ? parsed.supersedes : undefined,
      task_item: typeof parsed.task_item === "string" ? parsed.task_item : undefined,
    };
  } catch (err: unknown) {
    debugLog(`parseCitationComment: malformed citation JSON: ${errorMessage(err)}`);
    return null;
  }
}

/** Every distinct `symbol:` value in a document's `phren:cite` comments, in order. */
export function collectSymbolCitations(content: string): string[] {
  const found = new Set<string>();
  for (const line of content.split("\n")) {
    const citation = parseCitationComment(line);
    if (citation?.symbol) found.add(citation.symbol);
  }
  return [...found];
}

function resolveCitationFile(citation: FindingCitation): string | null {
  if (!citation.file) return null;
  if (citation.repo) {
    const resolved = path.resolve(citation.repo, citation.file);
    const repoRoot = path.resolve(citation.repo);
    // Require resolved path to stay inside the repo to prevent file probing
    if (resolved !== repoRoot && !resolved.startsWith(repoRoot + path.sep)) return null;
    return resolved;
  }
  if (path.isAbsolute(citation.file)) return citation.file;
  return path.resolve(citation.file);
}

/**
 * What this computer can tell about a citation:
 * - valid: everything it names checks out.
 * - drifted: the cited line changed since the cited commit, or is past the end of the file; the finding may still be right.
 * - broken: the repo is here but the cited file is gone.
 * - unverifiable: nothing to check, the repo is not on this computer, git could not run,
 *   or the repo does not know the commit while the file is still there (squash-merged or unfetched).
 */
export type CitationState = "valid" | "drifted" | "broken" | "unverifiable";

// Session-scoped caches for git I/O during citation checks.
// Keyed by repo, "repo\0commit" and "repo\0file\0line" respectively.
const MAX_CACHE_ENTRIES = 500;
const checkoutCache = new Map<string, boolean>();
const commitExistsCache = new Map<string, boolean>();
const blameCache = new Map<string, string | false>();
let gitCalls = 0;

/** Git processes citation checks have started in this process; governance caps a run by it. */
export function citationGitCallCount(): number {
  return gitCalls;
}

function evictOldest<K, V>(cache: Map<K, V>): void {
  if (cache.size <= MAX_CACHE_ENTRIES) return;
  const first = cache.keys().next().value;
  if (first !== undefined) cache.delete(first);
}

// Output, false when git answered no, undefined when git could not run (missing binary, timeout).
function citationGit(repoPath: string, args: string[], timeoutMs: number): string | false | undefined {
  gitCalls++;
  try {
    return runGitOrThrow(repoPath, args, timeoutMs);
  } catch (err: unknown) {
    debugLog(`citation: git ${args[0]} in ${repoPath}: ${errorMessage(err)}`);
    return (err as NodeJS.ErrnoException).code ? undefined : false;
  }
}

function cachedGit(cache: Map<string, boolean>, key: string, repoPath: string, args: string[]): boolean | undefined {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const out = citationGit(repoPath, args, EXEC_TIMEOUT_QUICK_MS);
  if (out === undefined) return undefined;
  cache.set(key, out !== false);
  evictOldest(cache);
  return out !== false;
}

function cachedBlame(repoPath: string, relFile: string, line: number): string | false | undefined {
  const key = `${repoPath}\0${relFile}\0${line}`;
  const cached = blameCache.get(key);
  if (cached !== undefined) return cached;
  const out = citationGit(repoPath, ["blame", "-L", `${line},${line}`, "--porcelain", relFile], 10_000);
  if (out === undefined) return undefined;
  const first = out === false ? false : out.trim().split("\n")[0] || "";
  blameCache.set(key, first);
  evictOldest(blameCache);
  return first;
}

function lineState(file: string, line: number | undefined): CitationState {
  if (line === undefined) return "valid";
  if (!Number.isInteger(line) || line < 1) return "drifted";
  try {
    return line > fs.readFileSync(file, "utf8").split("\n").length ? "drifted" : "valid";
  } catch {
    return "unverifiable";
  }
}

export function checkFindingCitation(citation: FindingCitation): CitationState {
  // A symbol citation is resolved against the project's code index at write
  // time (the index lives outside the synced store, so it is not available
  // here). The write path records `symbol_unresolved` when it could not
  // resolve one; that is the symbol counterpart of a missing cited file.
  if (citation.symbol && citation.symbol_unresolved) return "broken";
  if (!citation.repo) {
    // Without a repo only an absolute file this computer has can be checked.
    if (!citation.file || !path.isAbsolute(citation.file) || !fs.existsSync(citation.file)) return "unverifiable";
    return lineState(citation.file, citation.line);
  }
  // Repo paths are per computer (/Users/... on a Mac, /home/... on Linux), so a missing one says nothing.
  if (!fs.existsSync(citation.repo)) return "unverifiable";
  let commitKnown = true;
  if (citation.commit) {
    if (cachedGit(checkoutCache, citation.repo, citation.repo, ["rev-parse", "--git-dir"]) !== true) return "unverifiable";
    const known = cachedGit(commitExistsCache, `${citation.repo}\0${citation.commit}`, citation.repo, ["cat-file", "-e", `${citation.commit}^{commit}`]);
    if (known === undefined) return "unverifiable";
    commitKnown = known;
  }
  // An unknown commit may be squash-merged or not fetched yet; only a missing file proves the citation wrong.
  if (!citation.file) return commitKnown ? "valid" : "unverifiable";
  const resolvedFile = resolveCitationFile(citation);
  if (!resolvedFile) return "unverifiable";
  if (!fs.existsSync(resolvedFile)) return "broken";
  if (!commitKnown) return "unverifiable";
  const range = lineState(resolvedFile, citation.line);
  if (range !== "valid" || citation.line === undefined || !citation.commit) return range;
  const first = cachedBlame(citation.repo, path.relative(citation.repo, resolvedFile), citation.line);
  if (first === undefined) return "unverifiable";
  return first !== false && first.startsWith(citation.commit) ? "valid" : "drifted";
}

/** False only when this computer knows the citation is broken or its line drifted; one it cannot check passes. */
export function validateFindingCitation(citation: FindingCitation): boolean {
  const state = checkFindingCitation(citation);
  return state === "valid" || state === "unverifiable";
}

function parseLearningDateHeading(line: string): string | null {
  const match = line.match(/^## (\d{4}-\d{2}-\d{2})$/);
  return match ? match[1] : null;
}

/** The decay rule of a finding's leading type tag. Only the tag phren writes at the front counts, so a
 * "[decision]" quoted in a finding's text does not keep it forever. */
function leadingTypeConfig(line: string) {
  const leadingTag = line.match(/^- (\[\w[\w-]*\])/);
  const findingType = leadingTag ? extractFindingType(leadingTag[1]) : null;
  return findingType ? FINDING_TYPE_DECAY[findingType] : undefined;
}

/** How many days a finding bullet lives before it expires: its type's limit in place of the TTL when it
 * has a type (a decision never expires, a pattern lives a year), else `ttlDays`. The trust filter and
 * maintenance's TTL review both expire findings by this. */
export function findingAgeLimitDays(line: string, ttlDays: number): number {
  return leadingTypeConfig(line)?.maxAgeDays ?? ttlDays;
}

function isDateStale(headingDate: string, ttlDays: number): boolean {
  const ts = Date.parse(`${headingDate}T00:00:00Z`);
  if (Number.isNaN(ts)) return false;
  const ageDays = Math.floor((Date.now() - ts) / 86400000);
  return ageDays > ttlDays;
}

function ageDaysForDate(headingDate: string): number | null {
  const ts = Date.parse(`${headingDate}T00:00:00Z`);
  if (Number.isNaN(ts)) return null;
  return Math.floor((Date.now() - ts) / 86400000);
}

const DEFAULT_DECAY = {
  d30: 1.0,
  d60: 0.85,
  d90: 0.65,
  d120: 0.45,
};

// Treat undated findings as oldest decay tier so they eventually get filtered.
// Previously 0.7 which meant undated findings never decayed.
const DEFAULT_UNDATED_CONFIDENCE = DEFAULT_DECAY.d120;

function confidenceForAge(ageDays: number, decay: RetentionPolicy["decay"]): number {
  const { d30 = 1.0, d60 = 0.85, d90 = 0.65, d120 = 0.45 } = decay;
  if (ageDays <= 0) return 1.0;
  if (ageDays <= 30) return 1.0 - ((1.0 - d30) * (ageDays / 30));
  if (ageDays <= 60) return d30 - ((d30 - d60) * ((ageDays - 30) / 30));
  if (ageDays <= 90) return d60 - ((d60 - d90) * ((ageDays - 60) / 30));
  if (ageDays <= 120) return d90 - ((d90 - d120) * ((ageDays - 90) / 30));
  return d120; // don't decay further past d120; TTL handles final expiry
}

function wasFileModifiedAfter(filePath: string, findingDate: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    const fileModified = stat.mtime.toISOString().slice(0, 10);
    return fileModified > findingDate;
  } catch {
    return false; // File doesn't exist or can't stat — handled by citation validation
  }
}

export function filterTrustedFindings(content: string, ttlDays: number): string {
  return filterTrustedFindingsDetailed(content, { ttlDays }).content;
}

export function filterTrustedFindingsDetailed(content: string, opts: number | TrustFilterOptions): {
  content: string;
  issues: FindingTrustIssue[];
} {
  const options: TrustFilterOptions = typeof opts === "number" ? { ttlDays: opts } : opts;
  const ttlDays = options.ttlDays ?? 120;
  const minConfidence = options.minConfidence ?? 0.35;
  const decay: RetentionPolicy["decay"] = {
    ...DEFAULT_DECAY,
    ...(options.decay || {}),
  };
  const highImpactFindingIds = options.highImpactFindingIds;
  const project = options.project;

  const lines = content.split("\n");
  const out: string[] = [];
  const issues: FindingTrustIssue[] = [];
  let currentDate: string | null = null;
  let headingBuffer: string[] = [];
  let inDetails = false;

  const flushHeading = (hasEntries: boolean) => {
    if (headingBuffer.length === 0) return;
    if (hasEntries) {
      out.push(...headingBuffer);
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
    }
    headingBuffer = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (isArchiveStart(line)) {
      inDetails = true;
      continue;
    }
    if (isArchiveEnd(line)) {
      inDetails = false;
      continue;
    }
    if (inDetails) continue;

    const headingDate = parseLearningDateHeading(line);
    if (headingDate) {
      flushHeading(false);
      currentDate = headingDate;
      headingBuffer = [line];
      continue;
    }

    if (line.startsWith("# ")) {
      if (out.length === 0) out.push(line, "");
      continue;
    }

    if (!line.startsWith("- ")) continue;

    // Determine the effective date for this bullet: heading date, inline created tag, or citation
    const next = lines[i + 1] ?? "";
    const citation = parseCitationComment(next);

    let effectiveDate = currentDate;
    if (!effectiveDate) {
      const inlineCreated = line.match(METADATA_REGEX.createdDate);
      if (inlineCreated) {
        effectiveDate = inlineCreated[1];
      } else if (citation?.created_at) {
        const citationDate = citation.created_at.slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(citationDate)) {
          effectiveDate = citationDate;
        }
      }
    }

    // Checked first: a long-lived type would otherwise be cut off at the TTL.
    const typeConfig = leadingTypeConfig(line);
    const stale = effectiveDate ? isDateStale(effectiveDate, findingAgeLimitDays(line, ttlDays)) : false;
    if (stale) {
      issues.push({ date: effectiveDate || "unknown", bullet: line, reason: "stale" });
      if (citation) i++;
      continue;
    }

    let confidence: number;
    if (effectiveDate) {
      const age = ageDaysForDate(effectiveDate);
      confidence = age !== null ? confidenceForAge(age, decay) : DEFAULT_UNDATED_CONFIDENCE;
    } else {
      confidence = DEFAULT_UNDATED_CONFIDENCE;
    }

    // Type-specific decay adjustment
    if (typeConfig) {
      confidence *= typeConfig.decayMultiplier;
      // Decisions get a floor boost (never drop below 0.6)
      if (typeConfig.maxAgeDays === Infinity) {
        confidence = Math.max(confidence, 0.6);
      }
    }

    const citationState = citation
      ? (options.citationState ? options.citationState(citation, line) ?? "unverifiable" : checkFindingCitation(citation))
      : undefined;
    if (citationState === "broken") {
      issues.push({ date: effectiveDate || "unknown", bullet: line, reason: "invalid_citation" });
      i++;
      continue;
    }

    // The cited line drifted, or the cited file changed after the finding was written: it may be stale.
    if (citationState === "drifted" || (citation && effectiveDate && citation.file && wasFileModifiedAfter(citation.file, effectiveDate))) {
      confidence *= 0.7;
    }

    if (!citation) confidence *= 0.8;
    if (project && highImpactFindingIds?.size) {
      const findingId = findingIdFromLine(line);
      if (highImpactFindingIds.has(findingId)) confidence *= 1.15;
    }
    // Confirmed findings decay 3x slower — recompute confidence with reduced age
    {
      const findingId = findingIdFromLine(line);
      if (findingId && highImpactFindingIds?.has(findingId) && effectiveDate) {
        const realAge = ageDaysForDate(effectiveDate);
        if (realAge !== null) {
          const slowedAge = Math.floor(realAge / 3);
          confidence = Math.max(confidence, confidenceForAge(slowedAge, decay));
        }
      }
    }
    confidence = Math.max(0, Math.min(1, confidence));
    if (confidence < minConfidence) {
      issues.push({ date: effectiveDate || "unknown", bullet: line, reason: "stale" });
      if (citation) i++;
      continue;
    }

    flushHeading(true);
    out.push(line);
    if (citation) {
      out.push(next);
      i++;
    }
  }

  return { content: out.join("\n").trim(), issues };
}
