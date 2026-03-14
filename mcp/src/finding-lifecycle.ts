import * as fs from "fs";
import * as path from "path";
import { PhrenError, phrenErr, phrenOk, type PhrenResult } from "./phren-core.js";

// Phren lifecycle comment prefix. No backward compat.
const LIFECYCLE_PREFIX = "phren";
import { withFileLock } from "./governance-locks.js";
import { isValidProjectName, safeProjectPath } from "./utils.js";
import {
  METADATA_REGEX,
  parseCreatedDate as parseCreatedDateMeta,
  parseStatusField,
  parseStatus,
  parseSupersession,
  parseContradiction,
  parseFindingId as parseFindingIdMeta,
  stripLifecycleMetadata,
  stripRelationMetadata,
} from "./content-metadata.js";

export const FINDING_TYPE_DECAY: Record<string, { maxAgeDays: number; decayMultiplier: number }> = {
  'pattern':      { maxAgeDays: 365, decayMultiplier: 1.0 },   // Slow decay, long-lived
  'decision':     { maxAgeDays: Infinity, decayMultiplier: 1.0 }, // Never decays
  'pitfall':      { maxAgeDays: 365, decayMultiplier: 1.0 },   // Slow decay
  'anti-pattern': { maxAgeDays: Infinity, decayMultiplier: 1.0 }, // Never decays
  'observation':  { maxAgeDays: 14, decayMultiplier: 0.7 },    // Fast decay, short-lived
  'workaround':   { maxAgeDays: 60, decayMultiplier: 0.85 },   // Medium decay
  'bug':          { maxAgeDays: 30, decayMultiplier: 0.8 },     // Medium-fast decay
  'tooling':      { maxAgeDays: 180, decayMultiplier: 0.95 },  // Medium-slow decay
  'context':      { maxAgeDays: 30, decayMultiplier: 0.75 },   // Fast decay (contextual facts)
};

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

export type ContradictionResolution = "keep_a" | "keep_b" | "keep_both" | "retract_both";

function findingTextFromLine(line: string): string {
  return line
    .replace(/^-\s+/, "")
    .replace(/<!--.*?-->/g, "")
    .trim();
}

function normalizeFindingText(value: string): string {
  return findingTextFromLine(value)
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function removeRelationComments(line: string): string {
  return stripRelationMetadata(line);
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

  const bulletLines = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.startsWith("- "));

  const fidNeedle = needle.replace(/^fid:/, "");
  const fidMatches = /^[a-z0-9]{8}$/.test(fidNeedle)
    ? bulletLines.filter(({ line }) => new RegExp(`<!--\\s*fid:${fidNeedle}\\s*-->`, "i").test(line))
    : [];

  const exactMatches = bulletLines.filter(({ line }) => normalizeFindingText(line) === needle);
  const partialMatches = bulletLines.filter(({ line }) => {
    const clean = normalizeFindingText(line);
    return clean.includes(needle) || line.toLowerCase().includes(needle);
  });

  let selected: { line: string; index: number } | undefined;
  if (fidMatches.length === 1) {
    selected = fidMatches[0];
  } else if (exactMatches.length === 1) {
    selected = exactMatches[0];
  } else if (exactMatches.length > 1) {
    return phrenErr(`"${match}" is ambiguous (${exactMatches.length} exact matches). Use a more specific phrase.`, PhrenError.AMBIGUOUS_MATCH);
  } else if (partialMatches.length === 1) {
    selected = partialMatches[0];
  } else if (partialMatches.length > 1) {
    return phrenErr(`"${match}" is ambiguous (${partialMatches.length} partial matches). Use a more specific phrase.`, PhrenError.AMBIGUOUS_MATCH);
  }

  if (!selected) {
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
  const projectDir = safeProjectPath(phrenPath, project);
  if (!projectDir) return phrenErr(`Invalid project name: "${project}"`, PhrenError.INVALID_PROJECT_NAME);
  if (!fs.existsSync(projectDir)) return phrenErr(`Project "${project}" not found.`, PhrenError.PROJECT_NOT_FOUND);
  const findingsPath = path.join(projectDir, "FINDINGS.md");
  if (!fs.existsSync(findingsPath)) return phrenErr(`No FINDINGS.md found for "${project}".`, PhrenError.FILE_NOT_FOUND);
  return phrenOk(findingsPath);
}

export function supersedeFinding(
  phrenPath: string,
  project: string,
  findingText: string,
  supersededBy: string
): PhrenResult<{ finding: string; superseded_by: string; status: FindingLifecycleStatus }> {
  const pathResult = findingsPathForProject(phrenPath, project);
  if (!pathResult.ok) return pathResult;
  const findingsPath = pathResult.data;
  const ref = supersededBy.trim().slice(0, 60);
  if (!ref) return phrenErr("superseded_by cannot be empty.", PhrenError.EMPTY_INPUT);

  return withFileLock(findingsPath, () => {
    const lines = fs.readFileSync(findingsPath, "utf8").split("\n");
    const matched = matchFinding(lines, findingText);
    if (!matched.ok) return matched;
    const today = new Date().toISOString().slice(0, 10);
    lines[matched.data.index] = applyLifecycle(
      lines[matched.data.index],
      { status: "superseded", status_updated: today, status_reason: "superseded_by", status_ref: ref },
      today,
      { supersededBy: ref }
    );
    const normalized = lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
    fs.writeFileSync(findingsPath, normalized);
    return phrenOk({ finding: matched.data.text, superseded_by: ref, status: "superseded" });
  });
}

export function retractFinding(
  phrenPath: string,
  project: string,
  findingText: string,
  reason: string
): PhrenResult<{ finding: string; reason: string; status: FindingLifecycleStatus }> {
  const pathResult = findingsPathForProject(phrenPath, project);
  if (!pathResult.ok) return pathResult;
  const findingsPath = pathResult.data;
  const reasonText = reason.trim();
  if (!reasonText) return phrenErr("reason cannot be empty.", PhrenError.EMPTY_INPUT);

  return withFileLock(findingsPath, () => {
    const lines = fs.readFileSync(findingsPath, "utf8").split("\n");
    const matched = matchFinding(lines, findingText);
    if (!matched.ok) return matched;
    const today = new Date().toISOString().slice(0, 10);
    lines[matched.data.index] = applyLifecycle(
      lines[matched.data.index],
      { status: "retracted", status_updated: today, status_reason: reasonText },
      today
    );
    const normalized = lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
    fs.writeFileSync(findingsPath, normalized);
    return phrenOk({ finding: matched.data.text, reason: reasonText, status: "retracted" });
  });
}

export function resolveFindingContradiction(
  phrenPath: string,
  project: string,
  findingA: string,
  findingB: string,
  resolution: ContradictionResolution
): PhrenResult<{
  resolution: ContradictionResolution;
  finding_a: { text: string; status: FindingLifecycleStatus };
  finding_b: { text: string; status: FindingLifecycleStatus };
}> {
  const pathResult = findingsPathForProject(phrenPath, project);
  if (!pathResult.ok) return pathResult;
  const findingsPath = pathResult.data;

  return withFileLock(findingsPath, () => {
    const lines = fs.readFileSync(findingsPath, "utf8").split("\n");
    const matchedA = matchFinding(lines, findingA);
    if (!matchedA.ok) return matchedA;
    const matchedB = matchFinding(lines, findingB);
    if (!matchedB.ok) return matchedB;
    if (matchedA.data.index === matchedB.data.index) {
      return phrenErr("finding_a and finding_b refer to the same finding.", PhrenError.VALIDATION_ERROR);
    }

    const today = new Date().toISOString().slice(0, 10);
    const refA = matchedA.data.text.slice(0, 60);
    const refB = matchedB.data.text.slice(0, 60);
    let statusA: FindingLifecycleStatus = "active";
    let statusB: FindingLifecycleStatus = "active";

    if (resolution === "keep_a") {
      lines[matchedA.data.index] = applyLifecycle(lines[matchedA.data.index], { status: "active", status_updated: today, status_reason: "contradiction_resolved_keep_a", status_ref: refB }, today);
      lines[matchedB.data.index] = applyLifecycle(
        lines[matchedB.data.index],
        { status: "superseded", status_updated: today, status_reason: "contradiction_resolved_keep_a", status_ref: refA },
        today,
        { supersededBy: refA }
      );
      statusA = "active";
      statusB = "superseded";
    } else if (resolution === "keep_b") {
      lines[matchedA.data.index] = applyLifecycle(
        lines[matchedA.data.index],
        { status: "superseded", status_updated: today, status_reason: "contradiction_resolved_keep_b", status_ref: refB },
        today,
        { supersededBy: refB }
      );
      lines[matchedB.data.index] = applyLifecycle(lines[matchedB.data.index], { status: "active", status_updated: today, status_reason: "contradiction_resolved_keep_b", status_ref: refA }, today);
      statusA = "superseded";
      statusB = "active";
    } else if (resolution === "keep_both") {
      lines[matchedA.data.index] = applyLifecycle(lines[matchedA.data.index], { status: "active", status_updated: today, status_reason: "contradiction_resolved_keep_both", status_ref: refB }, today);
      lines[matchedB.data.index] = applyLifecycle(lines[matchedB.data.index], { status: "active", status_updated: today, status_reason: "contradiction_resolved_keep_both", status_ref: refA }, today);
      statusA = "active";
      statusB = "active";
    } else {
      lines[matchedA.data.index] = applyLifecycle(lines[matchedA.data.index], { status: "retracted", status_updated: today, status_reason: "contradiction_retracted_both", status_ref: refB }, today);
      lines[matchedB.data.index] = applyLifecycle(lines[matchedB.data.index], { status: "retracted", status_updated: today, status_reason: "contradiction_retracted_both", status_ref: refA }, today);
      statusA = "retracted";
      statusB = "retracted";
    }

    const normalized = lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
    fs.writeFileSync(findingsPath, normalized);
    return phrenOk({
      resolution,
      finding_a: { text: matchedA.data.text, status: statusA },
      finding_b: { text: matchedB.data.text, status: statusB },
    });
  });
}
