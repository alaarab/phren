import * as fs from "fs";
import * as path from "path";
import { CortexError, cortexErr, cortexOk, type CortexResult } from "./cortex-core.js";
import { withFileLock } from "./governance-locks.js";
import { isValidProjectName, safeProjectPath } from "./utils.js";

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
  const created = line.match(/<!--\s*created:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})\s*-->/i)?.[1];
  return created ? cleanCommentValue(created) : undefined;
}

function matchField(line: string, field: "status_updated" | "status_reason" | "status_ref"): string | undefined {
  const quoted = line.match(new RegExp(`<!--\\s*cortex:${field}\\s+"([^"]+)"\\s*-->`, "i"))?.[1];
  if (quoted) return cleanCommentValue(quoted);
  const raw = line.match(new RegExp(`<!--\\s*cortex:${field}\\s+([^>]+?)\\s*-->`, "i"))?.[1];
  return raw ? cleanCommentValue(raw) : undefined;
}

export function parseFindingLifecycle(line: string): FindingLifecycleMetadata {
  const created = parseCreatedDate(line);
  const normalizedStatus = line.match(
    /<!--\s*cortex:status\s+"?(active|superseded|contradicted|stale|invalid_citation|retracted)"?\s*-->/i
  )?.[1]?.toLowerCase() as FindingLifecycleStatus | undefined;

  const normalized: FindingLifecycleMetadata = {
    status: normalizedStatus ?? "active",
    status_updated: matchField(line, "status_updated") ?? created,
    status_reason: matchField(line, "status_reason"),
    status_ref: matchField(line, "status_ref"),
  };

  if (normalizedStatus) return normalized;

  const legacySupersededBy =
    line.match(/<!--\s*cortex:superseded_by\s+"([^"]+)"(?:\s+([0-9]{4}-[0-9]{2}-[0-9]{2}))?\s*-->/i) ??
    line.match(/<!--\s*superseded_by:\s*"([^"]+)"\s*-->/i);
  if (legacySupersededBy) {
    const updated = legacySupersededBy[2] || normalized.status_updated;
    return {
      status: "superseded",
      status_updated: updated ? cleanCommentValue(updated) : undefined,
      status_reason: normalized.status_reason ?? "superseded_by",
      status_ref: normalized.status_ref ?? cleanCommentValue(legacySupersededBy[1] || ""),
    };
  }

  const legacyConflict =
    line.match(/<!--\s*cortex:contradicts\s+"([^"]+)"\s*-->/i) ??
    line.match(/<!--\s*conflicts_with:\s*"([^"]+)"(?:\s*\(from project: [^)]+\))?\s*-->/i);
  if (legacyConflict) {
    return {
      status: "contradicted",
      status_updated: normalized.status_updated,
      status_reason: normalized.status_reason ?? "conflicts_with",
      status_ref: normalized.status_ref ?? cleanCommentValue(legacyConflict[1] || ""),
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
  const parts = [`<!-- cortex:status "${status}" -->`];
  if (statusUpdated) parts.push(`<!-- cortex:status_updated "${serializeCommentValue(statusUpdated)}" -->`);
  if (lifecycle?.status_reason) parts.push(`<!-- cortex:status_reason "${serializeCommentValue(lifecycle.status_reason)}" -->`);
  if (lifecycle?.status_ref) parts.push(`<!-- cortex:status_ref "${serializeCommentValue(lifecycle.status_ref)}" -->`);
  return parts.join(" ");
}

export function stripLifecycleComments(line: string): string {
  return line
    .replace(/\s*<!--\s*cortex:status\s+"?(?:active|superseded|contradicted|stale|invalid_citation|retracted)"?\s*-->/gi, "")
    .replace(/\s*<!--\s*cortex:status_updated\s+"[^"]+"\s*-->/gi, "")
    .replace(/\s*<!--\s*cortex:status_reason\s+"[^"]+"\s*-->/gi, "")
    .replace(/\s*<!--\s*cortex:status_ref\s+"[^"]+"\s*-->/gi, "");
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
  return line
    .replace(/\s*<!--\s*superseded_by:\s*"[^"]+"\s*-->/gi, "")
    .replace(/\s*<!--\s*cortex:superseded_by\s+"[^"]+"(?:\s+[0-9]{4}-[0-9]{2}-[0-9]{2})?\s*-->/gi, "")
    .replace(/\s*<!--\s*cortex:supersedes\s+"[^"]+"\s*-->/gi, "")
    .replace(/\s*<!--\s*conflicts_with:\s*"[^"]+"(?:\s*\(from project:\s*[^)]+\))?\s*-->/gi, "")
    .replace(/\s*<!--\s*cortex:contradicts\s+"[^"]+"\s*-->/gi, "");
}

function applyLifecycle(
  line: string,
  lifecycle: FindingLifecycleMetadata,
  today: string,
  opts?: { supersededBy?: string; supersedes?: string; contradicts?: string }
): string {
  let updated = stripLifecycleComments(removeRelationComments(line)).trimEnd();
  if (opts?.supersededBy) {
    updated += ` <!-- cortex:superseded_by "${serializeCommentValue(opts.supersededBy)}" ${today} -->`;
  }
  if (opts?.supersedes) {
    updated += ` <!-- cortex:supersedes "${serializeCommentValue(opts.supersedes)}" -->`;
  }
  if (opts?.contradicts) {
    const contradictionRef = serializeCommentValue(opts.contradicts);
    updated += ` <!-- conflicts_with: "${contradictionRef}" --> <!-- cortex:contradicts "${contradictionRef}" -->`;
  }
  updated += ` ${buildLifecycleComments(lifecycle, today)}`;
  return updated;
}

function matchFinding(lines: string[], match: string): CortexResult<MatchedFinding> {
  const needleRaw = match.trim();
  if (!needleRaw) return cortexErr("Finding text cannot be empty.", CortexError.EMPTY_INPUT);
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
    return cortexErr(`"${match}" is ambiguous (${exactMatches.length} exact matches). Use a more specific phrase.`, CortexError.AMBIGUOUS_MATCH);
  } else if (partialMatches.length === 1) {
    selected = partialMatches[0];
  } else if (partialMatches.length > 1) {
    return cortexErr(`"${match}" is ambiguous (${partialMatches.length} partial matches). Use a more specific phrase.`, CortexError.AMBIGUOUS_MATCH);
  }

  if (!selected) {
    return cortexErr(`No finding matching "${match}".`, CortexError.NOT_FOUND);
  }

  const stableId = selected.line.match(/<!--\s*fid:([a-z0-9]{8})\s*-->/i)?.[1];
  return cortexOk({
    index: selected.index,
    line: selected.line,
    text: findingTextFromLine(selected.line),
    stableId,
  });
}

function findingsPathForProject(cortexPath: string, project: string): CortexResult<string> {
  if (!isValidProjectName(project)) return cortexErr(`Invalid project name: "${project}"`, CortexError.INVALID_PROJECT_NAME);
  const projectDir = safeProjectPath(cortexPath, project);
  if (!projectDir) return cortexErr(`Invalid project name: "${project}"`, CortexError.INVALID_PROJECT_NAME);
  if (!fs.existsSync(projectDir)) return cortexErr(`Project "${project}" not found.`, CortexError.PROJECT_NOT_FOUND);
  const findingsPath = path.join(projectDir, "FINDINGS.md");
  if (!fs.existsSync(findingsPath)) return cortexErr(`No FINDINGS.md found for "${project}".`, CortexError.FILE_NOT_FOUND);
  return cortexOk(findingsPath);
}

export function supersedeFinding(
  cortexPath: string,
  project: string,
  findingText: string,
  supersededBy: string
): CortexResult<{ finding: string; superseded_by: string; status: FindingLifecycleStatus }> {
  const pathResult = findingsPathForProject(cortexPath, project);
  if (!pathResult.ok) return pathResult;
  const findingsPath = pathResult.data;
  const ref = supersededBy.trim().slice(0, 60);
  if (!ref) return cortexErr("superseded_by cannot be empty.", CortexError.EMPTY_INPUT);

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
    return cortexOk({ finding: matched.data.text, superseded_by: ref, status: "superseded" });
  });
}

export function retractFinding(
  cortexPath: string,
  project: string,
  findingText: string,
  reason: string
): CortexResult<{ finding: string; reason: string; status: FindingLifecycleStatus }> {
  const pathResult = findingsPathForProject(cortexPath, project);
  if (!pathResult.ok) return pathResult;
  const findingsPath = pathResult.data;
  const reasonText = reason.trim();
  if (!reasonText) return cortexErr("reason cannot be empty.", CortexError.EMPTY_INPUT);

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
    return cortexOk({ finding: matched.data.text, reason: reasonText, status: "retracted" });
  });
}

export function resolveFindingContradiction(
  cortexPath: string,
  project: string,
  findingA: string,
  findingB: string,
  resolution: ContradictionResolution
): CortexResult<{
  resolution: ContradictionResolution;
  finding_a: { text: string; status: FindingLifecycleStatus };
  finding_b: { text: string; status: FindingLifecycleStatus };
}> {
  const pathResult = findingsPathForProject(cortexPath, project);
  if (!pathResult.ok) return pathResult;
  const findingsPath = pathResult.data;

  return withFileLock(findingsPath, () => {
    const lines = fs.readFileSync(findingsPath, "utf8").split("\n");
    const matchedA = matchFinding(lines, findingA);
    if (!matchedA.ok) return matchedA;
    const matchedB = matchFinding(lines, findingB);
    if (!matchedB.ok) return matchedB;
    if (matchedA.data.index === matchedB.data.index) {
      return cortexErr("finding_a and finding_b refer to the same finding.", CortexError.VALIDATION_ERROR);
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
    return cortexOk({
      resolution,
      finding_a: { text: matchedA.data.text, status: statusA },
      finding_b: { text: matchedB.data.text, status: statusB },
    });
  });
}
