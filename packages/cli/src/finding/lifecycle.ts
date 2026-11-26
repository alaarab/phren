import * as fs from "fs";
import { assertFindingVersions } from "./versions.js";
import * as path from "path";
import { renameOverSync } from "../phren-paths.js";
import { PhrenError, phrenErr, phrenOk, type PhrenErrorCode, type PhrenResult, type FindingTag } from "../phren-core.js";

// Phren lifecycle comment prefix. No backward compat.
const LIFECYCLE_PREFIX = "phren";
import { withFileLock } from "../shared/governance.js";
import { isValidProjectName } from "../utils.js";
import { storeAwareProjectPath } from "../store-routing.js";
import {
  isArchiveEnd,
  isArchiveStart,
  parseCreatedDate as parseCreatedDateMeta,
  parseStatusField,
  parseStatus,
  parseSupersession,
  parseContradiction,
  parseFindingId as parseFindingIdMeta,
  stripLifecycleMetadata,
  stripRelationMetadata,
  normalizeFindingText,
} from "../content/metadata.js";
import { FINDINGS_FILENAME } from "../data/access.js";
import { locateFinding, rewriteFindingLine, type FindingTier, type ProjectFinding } from "./locate.js";

interface FindingDecayConfig {
  maxAgeDays: number;
  decayMultiplier: number;
}

/**
 * Decay rule per finding tag. Keyed with `satisfies Record<FindingTag, ...>`
 * so this object is required to have exactly one row per tag in FINDING_TAGS
 * (phren-core.ts) — no more, no less. Add a tag there and TypeScript forces a
 * decay row here; remove one and the corresponding row becomes a compile
 * error instead of silently-dead data.
 *
 * Previously this table had 9 rows against a 6-entry offered enum that
 * disagreed with it in both directions: `anti-pattern`, `observation`, and
 * `tooling` had rows here but nothing ever wrote those tags, while
 * `tradeoff` and `architecture` were offered/writable but had no row here
 * (so they never decayed and had no max-age). The exported type stays
 * `Record<string, FindingDecayConfig>` so existing string-keyed lookups
 * (e.g. content/citation.ts) don't need to change.
 */
export const FINDING_TYPE_DECAY: Record<string, FindingDecayConfig> = {
  'pattern':    { maxAgeDays: 365, decayMultiplier: 1.0 },   // Slow decay, long-lived
  'decision':   { maxAgeDays: Infinity, decayMultiplier: 1.0 }, // Never decays
  'pitfall':    { maxAgeDays: 365, decayMultiplier: 1.0 },   // Slow decay
  'workaround': { maxAgeDays: 60, decayMultiplier: 0.85 },   // Medium decay
  'bug':        { maxAgeDays: 30, decayMultiplier: 0.8 },    // Medium-fast decay
  'context':    { maxAgeDays: 30, decayMultiplier: 0.75 },   // Fast decay (contextual facts)
} satisfies Record<FindingTag, FindingDecayConfig>;

export function extractFindingType(line: string): string | null {
  const match = line.match(/\[(\w[\w-]*)\]/);
  if (!match) return null;
  const tag = match[1].toLowerCase();
  return tag in FINDING_TYPE_DECAY ? tag : null;
}

export const FINDING_LIFECYCLE_STATUSES = [
  "active",
  "superseded",
  "contradicted",
  "stale",
  "invalid_citation",
  "retracted",
] as const;

export type FindingLifecycleStatus = typeof FINDING_LIFECYCLE_STATUSES[number];

export interface FindingLifecycleMetadata {
  status: FindingLifecycleStatus;
  status_updated?: string;
  status_reason?: string;
  status_ref?: string;
}

function cleanCommentValue(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function serializeCommentValue(value: string): string {
  return cleanCommentValue(value).replace(/"/g, "'");
}

function parseCreatedDate(line: string): string | undefined {
  const created = parseCreatedDateMeta(line);
  return created ? cleanCommentValue(created) : undefined;
}

function matchField(line: string, field: "status_updated" | "status_reason" | "status_ref"): string | undefined {
  return parseStatusField(line, field);
}

export function parseFindingLifecycle(line: string): FindingLifecycleMetadata {
  const created = parseCreatedDate(line);
  const normalizedStatus = parseStatus(line) as FindingLifecycleStatus | undefined;

  const normalized: FindingLifecycleMetadata = {
    status: normalizedStatus ?? "active",
    status_updated: matchField(line, "status_updated") ?? created,
    status_reason: matchField(line, "status_reason"),
    status_ref: matchField(line, "status_ref"),
  };

  if (normalizedStatus) return normalized;

  const supersession = parseSupersession(line);
  if (supersession) {
    const updated = supersession.date || normalized.status_updated;
    return {
      status: "superseded",
      status_updated: updated ? cleanCommentValue(updated) : undefined,
      status_reason: normalized.status_reason ?? "superseded_by",
      status_ref: normalized.status_ref ?? cleanCommentValue(supersession.ref || ""),
    };
  }

  const contradictionRef = parseContradiction(line);
  if (contradictionRef) {
    return {
      status: "contradicted",
      status_updated: normalized.status_updated,
      status_reason: normalized.status_reason ?? "conflicts_with",
      status_ref: normalized.status_ref ?? cleanCommentValue(contradictionRef),
    };
  }

  return normalized;
}

export function buildLifecycleComments(
  lifecycle: Partial<FindingLifecycleMetadata> | undefined,
  fallbackDate?: string
): string {
  const status: FindingLifecycleStatus = lifecycle?.status ?? "active";
  const statusUpdated = lifecycle?.status_updated ?? fallbackDate;
  const parts = [`<!-- ${LIFECYCLE_PREFIX}:status "${status}" -->`];
  if (statusUpdated) parts.push(`<!-- ${LIFECYCLE_PREFIX}:status_updated "${serializeCommentValue(statusUpdated)}" -->`);
  if (lifecycle?.status_reason) parts.push(`<!-- ${LIFECYCLE_PREFIX}:status_reason "${serializeCommentValue(lifecycle.status_reason)}" -->`);
  if (lifecycle?.status_ref) parts.push(`<!-- ${LIFECYCLE_PREFIX}:status_ref "${serializeCommentValue(lifecycle.status_ref)}" -->`);
  return parts.join(" ");
}

export function stripLifecycleComments(line: string): string {
  return stripLifecycleMetadata(line);
}

export function isInactiveFindingLine(line: string): boolean {
  return parseFindingLifecycle(line).status !== "active";
}

interface MatchedFinding {
  index: number;
  line: string;
  text: string;
  stableId?: string;
}

interface FindingBulletLine {
  archived: boolean;
  index: number;
  line: string;
}

export type ContradictionResolution = "keep_a" | "keep_b" | "keep_both" | "retract_both";

function findingTextFromLine(line: string): string {
  return line
    .replace(/^-\s+/, "")
    .replace(/<!--.*?-->/g, "")
    .trim();
}

function removeRelationComments(line: string): string {
  return stripRelationMetadata(line);
}

function collectFindingBulletLines(lines: string[]): FindingBulletLine[] {
  const bulletLines: FindingBulletLine[] = [];
  let inArchiveBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isArchiveStart(line)) {
      inArchiveBlock = true;
      continue;
    }
    if (isArchiveEnd(line)) {
      inArchiveBlock = false;
      continue;
    }
    if (!line.startsWith("- ")) continue;
    bulletLines.push({ line, index: i, archived: inArchiveBlock });
  }
  return bulletLines;
}

function selectMatchingFinding(
  bulletLines: FindingBulletLine[],
  needle: string,
  match: string,
): PhrenResult<FindingBulletLine | null> {
  const fidNeedle = needle.replace(/^fid:/, "");
  const fidMatches = /^[a-z0-9]{8}$/.test(fidNeedle)
    ? bulletLines.filter(({ line }) => new RegExp(`<!--\\s*fid:${fidNeedle}\\s*-->`, "i").test(line))
    : [];

  const exactMatches = bulletLines.filter(({ line }) => normalizeFindingText(line) === needle);
  const partialMatches = bulletLines.filter(({ line }) => {
    const clean = normalizeFindingText(line);
    return clean.includes(needle) || line.toLowerCase().includes(needle);
  });

  if (fidMatches.length === 1) return phrenOk(fidMatches[0]);
  if (exactMatches.length === 1) return phrenOk(exactMatches[0]);
  if (exactMatches.length > 1) {
    return phrenErr(`"${match}" is ambiguous (${exactMatches.length} exact matches). Use a more specific phrase.`, PhrenError.AMBIGUOUS_MATCH);
  }
  if (partialMatches.length === 1) return phrenOk(partialMatches[0]);
  if (partialMatches.length > 1) {
    return phrenErr(`"${match}" is ambiguous (${partialMatches.length} partial matches). Use a more specific phrase.`, PhrenError.AMBIGUOUS_MATCH);
  }
  return phrenOk(null);
}

function applyLifecycle(
  line: string,
  lifecycle: FindingLifecycleMetadata,
  today: string,
  opts?: { supersededBy?: string; supersedes?: string; contradicts?: string }
): string {
  let updated = stripLifecycleComments(removeRelationComments(line)).trimEnd();
  if (opts?.supersededBy) {
    updated += ` <!-- ${LIFECYCLE_PREFIX}:superseded_by "${serializeCommentValue(opts.supersededBy)}" ${today} -->`;
  }
  if (opts?.supersedes) {
    updated += ` <!-- ${LIFECYCLE_PREFIX}:supersedes "${serializeCommentValue(opts.supersedes)}" -->`;
  }
  if (opts?.contradicts) {
    const contradictionRef = serializeCommentValue(opts.contradicts);
    updated += ` <!-- conflicts_with: "${contradictionRef}" --> <!-- ${LIFECYCLE_PREFIX}:contradicts "${contradictionRef}" -->`;
  }
  updated += ` ${buildLifecycleComments(lifecycle, today)}`;
  return updated;
}

function matchFinding(lines: string[], match: string): PhrenResult<MatchedFinding> {
  const needleRaw = match.trim();
  if (!needleRaw) return phrenErr("Finding text cannot be empty.", PhrenError.EMPTY_INPUT);
  const needle = normalizeFindingText(needleRaw);

  const bulletLines = collectFindingBulletLines(lines);
  const activeMatch = selectMatchingFinding(bulletLines.filter(({ archived }) => !archived), needle, match);
  if (!activeMatch.ok) return activeMatch;
  const selected = activeMatch.data;

  if (!selected) {
    const archivedMatch = selectMatchingFinding(bulletLines.filter(({ archived }) => archived), needle, match);
    if (!archivedMatch.ok) {
      return phrenErr(
        `Finding "${match}" is archived and read-only. Restore or re-add it before mutating history.`,
        PhrenError.VALIDATION_ERROR,
      );
    }
    if (archivedMatch.data) {
      return phrenErr(
        `Finding "${match}" is archived and read-only. Restore or re-add it before mutating history.`,
        PhrenError.VALIDATION_ERROR,
      );
    }
    return phrenErr(`No finding matching "${match}".`, PhrenError.NOT_FOUND);
  }

  const stableId = parseFindingIdMeta(selected.line);
  return phrenOk({
    index: selected.index,
    line: selected.line,
    text: findingTextFromLine(selected.line),
    stableId,
  });
}

function findingsPathForProject(phrenPath: string, project: string): PhrenResult<string> {
  if (!isValidProjectName(project)) return phrenErr(`Invalid project name: "${project}"`, PhrenError.INVALID_PROJECT_NAME);
  const projectDir = storeAwareProjectPath(phrenPath, project);
  if (!projectDir) return phrenErr(`Invalid project name: "${project}"`, PhrenError.INVALID_PROJECT_NAME);
  if (!fs.existsSync(projectDir)) return phrenErr(`Project "${project}" not found.`, PhrenError.PROJECT_NOT_FOUND);
  const findingsPath = path.join(projectDir, FINDINGS_FILENAME);
  if (!fs.existsSync(findingsPath)) return phrenErr(`No FINDINGS.md found for "${project}".`, PhrenError.FILE_NOT_FOUND);
  return phrenOk(findingsPath);
}

/** One of several findings an archive lookup matched; the caller picks one by fid. */
export interface LifecycleCandidate {
  tier: FindingTier;
  file: string;
  /** 1-based line in the file. */
  line: number;
  fid?: string;
  text: string;
}

/** A PhrenResult whose ambiguous archive lookups also list the candidates. */
export type LifecycleResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: PhrenErrorCode; candidates?: LifecycleCandidate[] };

/** A finding a mutation changes: a line of the FINDINGS.md being edited, or a bullet in a topic or .older archive. */
interface Target {
  text: string;
  tier: FindingTier;
  file: string;
  lineIndex: number;
  archive?: ProjectFinding;
}

function ambiguousArchiveMatch(phrenPath: string, project: string, selector: string, matches: ProjectFinding[]): LifecycleResult<never> {
  const projectDir = storeAwareProjectPath(phrenPath, project) ?? phrenPath;
  const candidates = matches.map((f) => ({
    tier: f.tier,
    file: f.file,
    line: f.lineIndex + 1,
    ...(f.fid ? { fid: f.fid } : {}),
    text: findingTextFromLine(f.line),
  }));
  const list = candidates.map((c) => `${c.tier} ${path.relative(projectDir, c.file)}:${c.line} ${c.fid ? `fid:${c.fid}` : "(no fid)"}`).join("; ");
  return {
    ok: false,
    error: `"${selector}" matches ${candidates.length} findings, so none was changed: ${list}. Name one by fid.`,
    code: PhrenError.AMBIGUOUS_MATCH,
    candidates,
  };
}

/**
 * The finding a selector names: FINDINGS.md first, exactly as before; when
 * nothing there matches (or only a read-only <details> bullet does), exactly
 * one topic or .older bullet by fid or full text.
 */
function resolveTarget(phrenPath: string, project: string, findingsPath: string, lines: string[], selector: string): LifecycleResult<Target> {
  const matched = matchFinding(lines, selector);
  if (matched.ok) return phrenOk({ text: matched.data.text, tier: "active", file: findingsPath, lineIndex: matched.data.index });
  // NOT_FOUND is "no match", VALIDATION_ERROR "only a <details> bullet matched"; ambiguity and empty input stand.
  if (matched.code !== PhrenError.NOT_FOUND && matched.code !== PhrenError.VALIDATION_ERROR) return matched;
  const located = locateFinding(phrenPath, project, selector.trim());
  if (located.kind === "ambiguous") return ambiguousArchiveMatch(phrenPath, project, selector, located.candidates);
  if (located.kind === "not_found" || located.finding.tier === "active") return matched;
  const archive = located.finding;
  if (archive.archived) {
    return phrenErr(`Finding "${selector}" is archived and read-only. Restore or re-add it before mutating history.`, PhrenError.VALIDATION_ERROR);
  }
  return phrenOk({ text: findingTextFromLine(archive.line), tier: archive.tier, file: archive.file, lineIndex: archive.lineIndex, archive });
}

/** The superseded_by text: as given, or the text of the finding a `fid:` names in any tier. */
function supersedingRef(phrenPath: string, project: string, supersededBy: string): LifecycleResult<string> {
  const given = supersededBy.trim();
  if (!/^fid:/i.test(given)) return phrenOk(given.slice(0, 60));
  const located = locateFinding(phrenPath, project, given);
  if (located.kind === "ambiguous") return ambiguousArchiveMatch(phrenPath, project, given, located.candidates);
  if (located.kind === "not_found") return phrenErr(`No finding with ${given} to supersede with.`, PhrenError.NOT_FOUND);
  return phrenOk(findingTextFromLine(located.finding.line).slice(0, 60));
}

/**
 * Apply each edit: an archive bullet through rewriteFindingLine (that one line,
 * under its file's lock), FINDINGS.md lines in place and the file written once,
 * as before. Archive edits go first because only they can still fail.
 */
function writeTargets(
  phrenPath: string,
  project: string,
  findingsPath: string,
  lines: string[],
  edits: Array<{ target: Target; transform: (line: string) => string }>,
): PhrenResult<void> {
  const written: string[] = [];
  for (const { target, transform } of edits) {
    if (!target.archive) continue;
    const result = rewriteFindingLine(phrenPath, project, target.archive, transform);
    if (!result.ok) {
      if (!written.length) return result;
      return phrenErr(`${result.error} (already updated: ${written.join(", ")})`, result.code);
    }
    written.push(`"${target.text.slice(0, 60)}"`);
  }
  const active = edits.filter(({ target }) => !target.archive);
  if (!active.length) return phrenOk(undefined);
  for (const { target, transform } of active) lines[target.lineIndex] = transform(lines[target.lineIndex]);
  const normalized = lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  const tmpPath = findingsPath + ".tmp." + process.pid;
  fs.writeFileSync(tmpPath, normalized);
  renameOverSync(tmpPath, findingsPath);
  return phrenOk(undefined);
}

export function supersedeFinding(
  phrenPath: string,
  project: string,
  findingText: string,
  supersededBy: string,
  expectedFindings?: Record<string, string>
): LifecycleResult<{ finding: string; superseded_by: string; status: FindingLifecycleStatus; tier: FindingTier; file: string }> {
  const pathResult = findingsPathForProject(phrenPath, project);
  if (!pathResult.ok) return pathResult;
  const findingsPath = pathResult.data;
  if (!supersededBy.trim()) return phrenErr("superseded_by cannot be empty.", PhrenError.EMPTY_INPUT);

  return withFileLock(findingsPath, () => {
    assertFindingVersions(findingsPath, expectedFindings);
    const lines = fs.readFileSync(findingsPath, "utf8").split("\n");
    const target = resolveTarget(phrenPath, project, findingsPath, lines, findingText);
    if (!target.ok) return target;
    const ref = supersedingRef(phrenPath, project, supersededBy);
    if (!ref.ok) return ref;
    const today = new Date().toISOString().slice(0, 10);
    const written = writeTargets(phrenPath, project, findingsPath, lines, [{
      target: target.data,
      transform: (line) => applyLifecycle(
        line,
        { status: "superseded", status_updated: today, status_reason: "superseded_by", status_ref: ref.data },
        today,
        { supersededBy: ref.data }
      ),
    }]);
    if (!written.ok) return written;
    return phrenOk({ finding: target.data.text, superseded_by: ref.data, status: "superseded", tier: target.data.tier, file: target.data.file });
  });
}

export function retractFinding(
  phrenPath: string,
  project: string,
  findingText: string,
  reason: string,
  expectedFindings?: Record<string, string>
): LifecycleResult<{ finding: string; reason: string; status: FindingLifecycleStatus; tier: FindingTier; file: string }> {
  const pathResult = findingsPathForProject(phrenPath, project);
  if (!pathResult.ok) return pathResult;
  const findingsPath = pathResult.data;
  const reasonText = reason.trim();
  if (!reasonText) return phrenErr("reason cannot be empty.", PhrenError.EMPTY_INPUT);

  return withFileLock(findingsPath, () => {
    assertFindingVersions(findingsPath, expectedFindings);
    const lines = fs.readFileSync(findingsPath, "utf8").split("\n");
    const target = resolveTarget(phrenPath, project, findingsPath, lines, findingText);
    if (!target.ok) return target;
    const today = new Date().toISOString().slice(0, 10);
    const written = writeTargets(phrenPath, project, findingsPath, lines, [{
      target: target.data,
      transform: (line) => applyLifecycle(line, { status: "retracted", status_updated: today, status_reason: reasonText }, today),
    }]);
    if (!written.ok) return written;
    return phrenOk({ finding: target.data.text, reason: reasonText, status: "retracted", tier: target.data.tier, file: target.data.file });
  });
}

/** " (archived in reference/topics/<file>)" for a finding outside FINDINGS.md, for messages. */
export function archiveNote({ tier, file }: { tier: FindingTier; file: string }): string {
  return tier === "active" ? "" : ` (archived in reference/topics/${path.basename(file)})`;
}

type ResolvedFinding = { text: string; status: FindingLifecycleStatus; tier: FindingTier; file: string };

export function resolveFindingContradiction(
  phrenPath: string,
  project: string,
  findingA: string,
  findingB: string,
  resolution: ContradictionResolution
): LifecycleResult<{
  resolution: ContradictionResolution;
  finding_a: ResolvedFinding;
  finding_b: ResolvedFinding;
}> {
  const pathResult = findingsPathForProject(phrenPath, project);
  if (!pathResult.ok) return pathResult;
  const findingsPath = pathResult.data;

  return withFileLock(findingsPath, () => {
    const lines = fs.readFileSync(findingsPath, "utf8").split("\n");
    const matchedA = resolveTarget(phrenPath, project, findingsPath, lines, findingA);
    if (!matchedA.ok) return matchedA;
    const matchedB = resolveTarget(phrenPath, project, findingsPath, lines, findingB);
    if (!matchedB.ok) return matchedB;
    const a = matchedA.data;
    const b = matchedB.data;
    if (a.file === b.file && a.lineIndex === b.lineIndex) {
      return phrenErr("finding_a and finding_b refer to the same finding.", PhrenError.VALIDATION_ERROR);
    }

    const today = new Date().toISOString().slice(0, 10);
    const refA = a.text.slice(0, 60);
    const refB = b.text.slice(0, 60);
    let transformA: (line: string) => string;
    let transformB: (line: string) => string;
    let statusA: FindingLifecycleStatus = "active";
    let statusB: FindingLifecycleStatus = "active";

    if (resolution === "keep_a") {
      transformA = (line) => applyLifecycle(line, { status: "active", status_updated: today, status_reason: "contradiction_resolved_keep_a", status_ref: refB }, today);
      transformB = (line) => applyLifecycle(
        line,
        { status: "superseded", status_updated: today, status_reason: "contradiction_resolved_keep_a", status_ref: refA },
        today,
        { supersededBy: refA }
      );
      statusA = "active";
      statusB = "superseded";
    } else if (resolution === "keep_b") {
      transformA = (line) => applyLifecycle(
        line,
        { status: "superseded", status_updated: today, status_reason: "contradiction_resolved_keep_b", status_ref: refB },
        today,
        { supersededBy: refB }
      );
      transformB = (line) => applyLifecycle(line, { status: "active", status_updated: today, status_reason: "contradiction_resolved_keep_b", status_ref: refA }, today);
      statusA = "superseded";
      statusB = "active";
    } else if (resolution === "keep_both") {
      transformA = (line) => applyLifecycle(line, { status: "active", status_updated: today, status_reason: "contradiction_resolved_keep_both", status_ref: refB }, today);
      transformB = (line) => applyLifecycle(line, { status: "active", status_updated: today, status_reason: "contradiction_resolved_keep_both", status_ref: refA }, today);
      statusA = "active";
      statusB = "active";
    } else {
      transformA = (line) => applyLifecycle(line, { status: "retracted", status_updated: today, status_reason: "contradiction_retracted_both", status_ref: refB }, today);
      transformB = (line) => applyLifecycle(line, { status: "retracted", status_updated: today, status_reason: "contradiction_retracted_both", status_ref: refA }, today);
      statusA = "retracted";
      statusB = "retracted";
    }

    const written = writeTargets(phrenPath, project, findingsPath, lines, [
      { target: a, transform: transformA },
      { target: b, transform: transformB },
    ]);
    if (!written.ok) return written;
    return phrenOk({
      resolution,
      finding_a: { text: a.text, status: statusA, tier: a.tier, file: a.file },
      finding_b: { text: b.text, status: statusB, tier: b.tier, file: b.file },
    });
  });
}
