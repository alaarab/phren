import * as fs from "fs";
import * as path from "path";
import { debugLog, EXEC_TIMEOUT_QUICK_MS } from "../shared.js";
import { errorMessage, runGitOrThrow } from "../utils.js";
import type { RetentionPolicy } from "../shared/governance.js";
import { findingIdFromLine } from "../finding/impact.js";
import { METADATA_REGEX, isArchiveStart, isArchiveEnd } from "./metadata.js";
import { FINDING_TYPE_DECAY, extractFindingType } from "../finding/lifecycle.js";
import { checkedOutCommit, checkoutForRemote, checkoutGitCallCount, checkoutsNamedLike } from "./citation-checkouts.js";

export interface FindingCitation {
  created_at: string;
  /** The repo's absolute path on the computer that wrote the citation; written now only for a repo with no clone URL. */
  repo?: string;
  /**
   * The repo by its `origin` remote, as `host/owner/repo` (content/citation-checkouts.ts),
   * so every computer with a clone of it can check the citation. `file` is then relative to the repo root.
   */
  remote?: string;
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
  /**
   * The citation of a bullet whose comment is not in `content` (the search index strips citation comments),
   * checked and counted as cited like one on the next line.
   */
  sourceCitation?: (bullet: string) => FindingCitation | undefined;
  /** The date of an archived bullet from the source file. */
  sourceArchiveDate?: (bullet: string) => string | undefined;
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
      remote: typeof parsed.remote === "string" && parsed.remote.trim() ? parsed.remote : undefined,
      file: typeof parsed.file === "string" ? parsed.file : undefined,
      line: typeof parsed.line === "number" ? parsed.line : undefined,
      commit: typeof parsed.commit === "string" ? parsed.commit : undefined,
      symbol: typeof parsed.symbol === "string" && parsed.symbol.trim() ? parsed.symbol : undefined,
      symbol_unresolved: parsed.symbol_unresolved === true ? true : undefined,
      supersedes: typeof parsed.supersedes === "string" ? parsed.supersedes : undefined,
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
 * - broken: the repo is here but the cited file is gone. In a checkout other than the one the citation was
 *   written in (found by `remote`, or another computer's repo path relocated here), only when the file was in
 *   the cited commit and that commit is in the checkout's history.
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
  return gitCalls + checkoutGitCallCount();
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

// `head` keys a checkout other than the writer's by the commit it has out, so a branch switch asks again.
function cachedBlame(repoPath: string, relFile: string, line: number, head = ""): string | false | undefined {
  const key = `${repoPath}\0${head}\0${relFile}\0${line}`;
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

export interface CitationCheckOptions {
  /**
   * The primary store, so a citation's `remote` resolves to this computer's checkout of it. Without it a remote is
   * unverifiable. Mapping a remote scans folders and may start git, so only the daily sweep passes it; the prompt
   * hook reads the states the sweep recorded.
   */
  phrenPath?: string;
  /**
   * Also look for another computer's absolute repo path among this computer's checkouts with the same folder
   * name, taking the first that has the cited commit. It costs git calls, so the daily sweep sets it, not the hook.
   */
  relocate?: boolean;
}

/** Where a remote or relocated citation points in this computer's checkout. */
interface CitationTarget {
  root: string;
  /** The cited file in the checkout, absolute, and repo-relative with forward slashes. */
  file?: string;
  relFile?: string;
}

// A cited file inside `root`: relative to it, or absolute under the repo path the citation was written with.
function targetIn(root: string, citation: FindingCitation, writtenRoot?: string): CitationTarget | null {
  if (!citation.file) return { root };
  const relative = path.isAbsolute(citation.file)
    ? (writtenRoot ? path.relative(writtenRoot, citation.file) : null)
    : citation.file;
  if (relative === null) return null;
  const relFile = path.posix.normalize(relative.split(path.sep).join("/"));
  if (!relFile || relFile === "." || relFile.startsWith("../") || relFile === ".." || path.isAbsolute(relFile)) return null;
  return { root, file: path.join(root, ...relFile.split("/")), relFile };
}

function commitKnownIn(root: string, commit: string): boolean | undefined {
  if (cachedGit(checkoutCache, root, root, ["rev-parse", "--git-dir"]) !== true) return undefined;
  return cachedGit(commitExistsCache, `${root}\0${commit}`, root, ["cat-file", "-e", `${commit}^{commit}`]);
}

// This computer's checkout for a citation that names its repo by remote, or by another computer's path.
function resolveTarget(citation: FindingCitation, opts: CitationCheckOptions): CitationTarget | null {
  if (!opts.phrenPath) return null;
  if (citation.remote) {
    const root = checkoutForRemote(opts.phrenPath, citation.remote);
    return root ? targetIn(root, citation) : null;
  }
  if (!opts.relocate || !citation.repo || !citation.commit) return null;
  // The cited commit is the proof that a same-named folder holds the same repo.
  const root = checkoutsNamedLike(opts.phrenPath, citation.repo).find(dir => commitKnownIn(dir, citation.commit!) === true);
  return root ? targetIn(root, citation, citation.repo) : null;
}

// The line check shared by both kinds of checkout: in range, and blamed on the cited commit when both are given.
function fileState(root: string, file: string, citation: FindingCitation, head?: string): CitationState {
  const range = lineState(file, citation.line);
  if (range !== "valid" || citation.line === undefined || !citation.commit) return range;
  const first = cachedBlame(root, path.relative(root, file), citation.line, head);
  if (first === undefined) return "unverifiable";
  return first !== false && first.startsWith(citation.commit) ? "valid" : "drifted";
}

// The commit a checkout has out: from its git files, else from git.
function checkoutHead(root: string): string | undefined {
  const head = checkedOutCommit(root);
  if (head) return head;
  const out = citationGit(root, ["rev-parse", "HEAD"], EXEC_TIMEOUT_QUICK_MS);
  return out ? out.trim() || undefined : undefined;
}

// Another checkout of the repo may be behind, ahead or on another branch than the writer's, so it says
// something about a cited file only when the cited commit is in the history it has out: then a changed
// line is drifted and a file that was in the commit and is gone now is broken. Anything else is
// unverifiable. The answer is cached per checked-out commit, so a branch switch asks git again.
function portableState(target: CitationTarget, citation: FindingCitation): CitationState {
  const { root, file, relFile } = target;
  if (!citation.commit) return file && fs.existsSync(file) ? lineState(file, citation.line) : "unverifiable";
  if (commitKnownIn(root, citation.commit) !== true) return "unverifiable";
  if (!file || !relFile) return "valid";
  const head = checkoutHead(root);
  if (!head) return "unverifiable";
  const inHistory = cachedGit(commitExistsCache, `${root}\0${head}\0ancestor\0${citation.commit}`, root, ["merge-base", "--is-ancestor", citation.commit, head]);
  if (inHistory !== true) return "unverifiable";
  if (fs.existsSync(file)) return fileState(root, file, citation, head);
  const inCommit = cachedGit(commitExistsCache, `${root}\0${citation.commit}:${relFile}`, root, ["cat-file", "-e", `${citation.commit}:${relFile}`]);
  return inCommit === true ? "broken" : "unverifiable";
}

export function checkFindingCitation(citation: FindingCitation, opts: CitationCheckOptions = {}): CitationState {
  // A symbol citation is resolved against the project's code index at write
  // time (the index lives outside the synced store, so it is not available
  // here). The write path records `symbol_unresolved` when it could not
  // resolve one; that is the symbol counterpart of a missing cited file.
  if (citation.symbol && citation.symbol_unresolved) return "broken";
  if (citation.remote || (citation.repo && !fs.existsSync(citation.repo))) {
    // A remote names the repo on every computer; a repo path from another computer may have a checkout here.
    const target = resolveTarget(citation, opts);
    return target ? portableState(target, citation) : "unverifiable";
  }
  if (!citation.repo) {
    // Without a repo only an absolute file this computer has can be checked.
    if (!citation.file || !path.isAbsolute(citation.file) || !fs.existsSync(citation.file)) return "unverifiable";
    return lineState(citation.file, citation.line);
  }
  let commitKnown = true;
  if (citation.commit) {
    const known = commitKnownIn(citation.repo, citation.commit);
    if (known === undefined) return "unverifiable";
    commitKnown = known;
  }
  // An unknown commit may be squash-merged or not fetched yet; only a missing file proves the citation wrong.
  if (!citation.file) return commitKnown ? "valid" : "unverifiable";
  const resolvedFile = resolveCitationFile(citation);
  if (!resolvedFile) return "unverifiable";
  if (!fs.existsSync(resolvedFile)) return "broken";
  if (!commitKnown) return "unverifiable";
  return fileState(citation.repo, resolvedFile, citation);
}

/** True when a citation names code: a repo, a file or a symbol. A bare `created_at`, which every new finding has, is no evidence. */
function citationNamesCode(citation: FindingCitation): boolean {
  return Boolean(citation.repo || citation.remote || citation.file || citation.symbol);
}

/** False only when this computer knows the citation is broken or its line drifted; one it cannot check passes. */
export function validateFindingCitation(citation: FindingCitation, opts: CitationCheckOptions = {}): boolean {
  const state = checkFindingCitation(citation, opts);
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

    // Archived bullets carry their own dates from the source file.
    const next = lines[i + 1] ?? "";
    const citation = parseCitationComment(next);

    const archivedDate = options.sourceArchiveDate?.(line);
    let effectiveDate = archivedDate ?? currentDate;
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
    const ageLimit = typeConfig?.maxAgeDays ?? (archivedDate ? FINDING_TYPE_DECAY.pattern.maxAgeDays : ttlDays);
    const stale = effectiveDate ? isDateStale(effectiveDate, ageLimit) : false;
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

    // Only a cited file or an unresolved symbol can be broken or drifted, so a commit-only citation costs no git here.
    const checked = citation ?? options.sourceCitation?.(line);
    const citationState = checked && (checked.file || checked.symbol_unresolved)
      ? (options.citationState ? options.citationState(checked, line) ?? "unverifiable" : checkFindingCitation(checked))
      : undefined;
    if (citationState === "broken") {
      issues.push({ date: effectiveDate || "unknown", bullet: line, reason: "invalid_citation" });
      if (citation) i++;
      continue;
    }

    // The cited line drifted, or the cited file changed after the finding was written: it may be stale.
    if (citationState === "drifted" || (citation && effectiveDate && citation.file && wasFileModifiedAfter(citation.file, effectiveDate))) {
      confidence *= 0.7;
    }

    // Uncited: no citation, or one that names no code.
    if (!checked || !citationNamesCode(checked)) confidence *= 0.8;
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
