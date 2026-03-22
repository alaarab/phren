// Barrel module: re-exports task, profile, and shell-state APIs from their
// dedicated modules (data-tasks.ts, profile-store.ts, shell-state-store.ts)
// and owns finding/queue logic directly.
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import {
  phrenErr,
  PhrenError,
  phrenOk,
  type PhrenResult,
  forwardErr,
  getProjectDirs,
  isRecord,
} from "../shared.js";
import {
  normalizeQueueEntryText,
} from "../shared/shared-governance.js";
import {
  addFindingToFile,
  type AddFindingResult,
} from "../shared/shared-content.js";
import { isValidProjectName, queueFilePath, safeProjectPath } from "../utils.js";
import {
  type FindingCitation,
  type FindingProvenanceSource,
  parseCitationComment,
  parseSourceComment,
} from "../content/content-citation.js";
import {
  parseFindingLifecycle,
  type FindingLifecycleStatus,
} from "../finding/finding-lifecycle.js";
import {
  METADATA_REGEX,
  isCitationLine,
  isArchiveStart,
  isArchiveEnd,
  parseFindingId,
  parseAllContradictions,
  stripComments,
  normalizeFindingText,
} from "../content/content-metadata.js";
import { withSafeLock, ensureProject } from "../shared/shared-data-utils.js";
export type { TaskSection, TaskItem, TaskDoc } from "./data-tasks.js";
export {
  readTasks,
  readTasksAcrossProjects,
  resolveTaskItem,
  addTask,
  addTasks,
  completeTasks,
  completeTask,
  removeTask,
  removeTasks,
  updateTask,
  linkTaskIssue,
  pinTask,
  unpinTask,
  workNextTask,
  tidyDoneTasks,
  taskMarkdown,
  appendChildFinding,
  promoteTask,
  TASKS_FILENAME,
  TASK_FILE_ALIASES,
  canonicalTaskFilePath,
  resolveTaskFilePath,
  isTaskFileName,
  type AddTaskOptions,
} from "./data-tasks.js";
export {
  addProjectToProfile,
  listMachines,
  listProfiles,
  listProjectCards,
  removeProjectFromProfile,
  setMachineProfile,
  type ProfileInfo,
  type ProjectCard,
} from "../profile-store.js";
export {
  loadShellState,
  resetShellState,
  saveShellState,
  type ShellState,
} from "../shell/shell-state-store.js";
export { getRuntimeHealth as readRuntimeHealth } from "../shared/shared-governance.js";

export interface FindingItem {
  id: string;
  /** Stable 8-char hex ID embedded as `<!-- fid:XXXXXXXX -->`. Survives reordering and consolidation. */
  stableId?: string;
  date: string;
  text: string;
  citation?: string;
  citationData?: FindingCitation;
  taskItem?: string;
  confidence?: number;
  source: FindingProvenanceSource;
  machine?: string;
  actor?: string;
  tool?: string;
  model?: string;
  sessionId?: string;
  scope?: string;
  /** First 60 chars of the newer finding that supersedes this one. Set when this finding is stale. */
  supersededBy?: string;
  /** First 60 chars of the older finding this one replaces. */
  supersedes?: string;
  /** Snippets of findings this one contradicts. */
  contradicts?: string[];
  status: FindingLifecycleStatus;
  status_updated?: string;
  status_reason?: string;
  status_ref?: string;
  /** Indicates whether this item comes from archived history blocks (<details> / phren:archive). */
  archived?: boolean;
  /** Tier marker used to distinguish current truth vs archived history. */
  tier?: "current" | "archived";
}

export interface ReadFindingsOptions {
  includeArchived?: boolean;
}

export interface FindingHistoryEntry {
  id: string;
  stableId?: string;
  text: string;
  timeline: FindingItem[];
  current?: FindingItem;
  archivedCount: number;
}

export interface QueueItem {
  id: string;
  section: "Review" | "Stale" | "Conflicts";
  date: string;
  text: string;
  line: string;
  confidence?: number;
  risky: boolean;
  machine?: string;
  model?: string;
}

export interface ProjectQueueItem extends QueueItem {
  project: string;
}

interface FindingBulletLine {
  archived: boolean;
  i: number;
  line: string;
}

type FindingBulletMatchResult =
  | { kind: "found"; idx: number }
  | { kind: "ambiguous"; error: string }
  | { kind: "not_found" };

function extractDateHeading(line: string): string | null {
  const heading = line.match(/^##\s+(.+)$/);
  if (!heading) return null;
  const raw = heading[1].trim();
  const direct = raw.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (direct) return direct[1];
  const archived = raw.match(/^Archived\s+(\d{4}-\d{2}-\d{2})$/i);
  if (archived) return archived[1];
  return null;
}

function normalizeFindingGroupKey(item: FindingItem): string {
  if (item.stableId) return `fid:${item.stableId}`;
  return item.text.replace(/\s+/g, " ").trim().toLowerCase();
}

function findingTimelineDate(item: FindingItem): string {
  return item.status_updated || item.date || "0000-00-00";
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
    bulletLines.push({ line, i, archived: inArchiveBlock });
  }
  return bulletLines;
}

function findMatchingFindingBullet(
  bulletLines: FindingBulletLine[],
  needle: string,
  match: string,
): FindingBulletMatchResult {
  const fidNeedle = needle.replace(/^fid:/, "");
  const fidMatch = /^[a-z0-9]{8}$/.test(fidNeedle)
    ? bulletLines.filter(({ line }) => new RegExp(`<!--\\s*fid:${fidNeedle}\\s*-->`).test(line))
    : [];

  const exactMatches = bulletLines.filter(({ line }) =>
    normalizeFindingText(line) === needle
  );
  const partialMatches = bulletLines.filter(({ line }) => normalizeFindingText(line).includes(needle));

  if (fidMatch.length === 1) return { kind: "found", idx: fidMatch[0].i };
  if (exactMatches.length === 1) return { kind: "found", idx: exactMatches[0].i };
  if (exactMatches.length > 1) {
    return { kind: "ambiguous", error: `"${match}" is ambiguous (${exactMatches.length} exact matches). Use a more specific phrase.` };
  }
  if (partialMatches.length === 1) return { kind: "found", idx: partialMatches[0].i };
  if (partialMatches.length > 1) {
    return { kind: "ambiguous", error: `"${match}" is ambiguous (${partialMatches.length} partial matches). Use a more specific phrase.` };
  }
  return { kind: "not_found" };
}

function validateAggregateQueueProfile(phrenPath: string, profile?: string): PhrenResult<void> {
  if (!profile) return phrenOk(undefined);
  if (!isValidProjectName(profile)) {
    return phrenErr(`Invalid PHREN_PROFILE value: ${profile}`, PhrenError.VALIDATION_ERROR);
  }

  const profilePath = path.join(phrenPath, "profiles", `${profile}.yaml`);
  if (!fs.existsSync(profilePath)) {
    return phrenErr(`Profile file not found: ${profilePath}`, PhrenError.FILE_NOT_FOUND);
  }

  let data: unknown;
  try {
    data = yaml.load(fs.readFileSync(profilePath, "utf-8"), { schema: yaml.CORE_SCHEMA });
  } catch {
    return phrenErr(`Malformed profile YAML: ${profilePath}`, PhrenError.MALFORMED_YAML);
  }

  const projects = isRecord(data) ? data.projects : undefined;
  if (!Array.isArray(projects)) {
    return phrenErr(`Profile YAML missing valid "projects" array: ${profilePath}`, PhrenError.MALFORMED_YAML);
  }

  return phrenOk(undefined);
}

export function readFindings(phrenPath: string, project: string, opts: ReadFindingsOptions = {}): PhrenResult<FindingItem[]> {
  const ensured = ensureProject(phrenPath, project);
  if (!ensured.ok) return forwardErr(ensured);

  const findingsPath = path.join(ensured.data, 'FINDINGS.md');
  const file = findingsPath;
  if (!fs.existsSync(file)) return phrenOk([]);

  const lines = fs.readFileSync(file, "utf8").split("\n");
  const items: FindingItem[] = [];
  let date = "unknown";
  let index = 1;
  let inArchiveBlock = false;
  const includeArchived = opts.includeArchived ?? false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const archiveStartMatch = isArchiveStart(line);
    const archiveEnd = isArchiveEnd(line);
    if (archiveStartMatch) {
      inArchiveBlock = true;
      continue;
    }
    if (archiveEnd) {
      inArchiveBlock = false;
      continue;
    }
    if (inArchiveBlock && !includeArchived) {
      continue;
    }

    const extractedDate = extractDateHeading(line);
    if (extractedDate) {
      date = extractedDate;
      continue;
    }
    if (!line.startsWith("- ")) continue;

    const next = lines[i + 1] || "";
    const citation = isCitationLine(next) ? next.trim() : undefined;
    const citationData = citation ? parseCitationComment(citation) ?? undefined : undefined;
    const source = parseSourceComment(line) ?? undefined;
    const stableId = parseFindingId(line);
    const rawText = line.replace(/^-\s+/, "").trim();
    const textWithoutComments = stripComments(rawText);
    const confMatch = textWithoutComments.match(/\s*\[confidence\s+([01](?:\.\d+)?)\]\s*$/i);
    const confidence = confMatch ? parseFloat(confMatch[1]) : undefined;
    const text = confMatch
      ? textWithoutComments.slice(0, textWithoutComments.length - confMatch[0].length).trim()
      : textWithoutComments;

    // Parse lifecycle annotations
    const supersededByMatch = line.match(METADATA_REGEX.supersededBy);
    const supersedesMatch = line.match(METADATA_REGEX.supersedes);
    const contradictsMatches = parseAllContradictions(line);
    const lifecycle = parseFindingLifecycle(line);

    items.push({
      id: `L${index}`,
      stableId,
      date,
      text,
      confidence,
      source: source?.source ?? "unknown",
      citation,
      citationData,
      taskItem: citationData?.task_item,
      machine: source?.machine,
      actor: source?.actor,
      tool: source?.tool,
      model: source?.model,
      sessionId: source?.session_id,
      scope: source?.scope,
      supersededBy: supersededByMatch ? supersededByMatch[1] : undefined,
      supersedes: supersedesMatch ? supersedesMatch[1] : undefined,
      contradicts: contradictsMatches.length > 0 ? contradictsMatches : undefined,
      status: lifecycle.status,
      status_updated: lifecycle.status_updated,
      status_reason: lifecycle.status_reason,
      status_ref: lifecycle.status_ref,
      archived: inArchiveBlock,
      tier: inArchiveBlock ? "archived" : "current",
    });
    if (citation) i += 1;
    index++;
  }

  return phrenOk(items);
}

export function readFindingHistory(phrenPath: string, project: string, findingId?: string): PhrenResult<FindingHistoryEntry[]> {
  const result = readFindings(phrenPath, project, { includeArchived: true });
  if (!result.ok) return forwardErr(result);

  const allItems = result.data;
  const needle = findingId?.trim().toLowerCase();
  const fidNeedle = needle ? needle.replace(/^fid:/, "") : undefined;

  const scopedItems = needle
    ? allItems.filter((item) => {
      if (fidNeedle && /^[a-z0-9]{8}$/.test(fidNeedle) && item.stableId?.toLowerCase() === fidNeedle) return true;
      if (item.id.toLowerCase() === needle) return true;
      return item.text.toLowerCase().includes(needle);
    })
    : allItems;

  if (needle && scopedItems.length === 0) {
    return phrenErr(`No finding history matching "${findingId}" in project "${project}".`, PhrenError.NOT_FOUND);
  }

  const groups = new Map<string, FindingItem[]>();
  for (const item of scopedItems) {
    const key = normalizeFindingGroupKey(item);
    const bucket = groups.get(key) ?? [];
    bucket.push(item);
    groups.set(key, bucket);
  }

  const history = [...groups.values()].map((timelineItems) => {
    const timeline = [...timelineItems].sort((a, b) => findingTimelineDate(a).localeCompare(findingTimelineDate(b)));
    const currentCandidates = timeline.filter(item => item.tier === "current");
    const current = currentCandidates.length > 0
      ? currentCandidates.sort((a, b) => findingTimelineDate(b).localeCompare(findingTimelineDate(a)))[0]
      : undefined;
    const latest = timeline[timeline.length - 1];
    const stableId = current?.stableId ?? latest.stableId;
    return {
      id: stableId ? `fid:${stableId}` : latest.id,
      stableId,
      text: current?.text ?? latest.text,
      timeline,
      current,
      archivedCount: timeline.filter(item => item.tier === "archived").length,
    };
  });

  history.sort((a, b) => {
    const aKey = a.timeline[a.timeline.length - 1] ? findingTimelineDate(a.timeline[a.timeline.length - 1]) : "";
    const bKey = b.timeline[b.timeline.length - 1] ? findingTimelineDate(b.timeline[b.timeline.length - 1]) : "";
    return bKey.localeCompare(aKey);
  });

  return phrenOk(history);
}

export function addFinding(phrenPath: string, project: string, learning: string): PhrenResult<AddFindingResult> {
  if (!isValidProjectName(project)) return phrenErr(`Project name "${project}" is not valid. Use lowercase letters, numbers, and hyphens (e.g. "my-project").`, PhrenError.INVALID_PROJECT_NAME);
  const resolved = safeProjectPath(phrenPath, project);
  if (!resolved) return phrenErr(`Project name "${project}" is not valid. Use lowercase letters, numbers, and hyphens (e.g. "my-project").`, PhrenError.INVALID_PROJECT_NAME);

  // addFindingToFile handles its own file lock; no double-wrap
  return addFindingToFile(phrenPath, project, learning);
}

export function removeFinding(phrenPath: string, project: string, match: string): PhrenResult<string> {
  const ensured = ensureProject(phrenPath, project);
  if (!ensured.ok) return forwardErr(ensured);

  const findingsPath = path.resolve(path.join(ensured.data, 'FINDINGS.md'));
  if (!findingsPath.startsWith(phrenPath + path.sep) && findingsPath !== phrenPath) {
    return phrenErr(`FINDINGS.md path escapes phren store`, PhrenError.VALIDATION_ERROR);
  }
  const filePath = findingsPath;
  if (!fs.existsSync(filePath)) return phrenErr(`No FINDINGS.md file found for "${project}". Add a finding first with add_finding or :find add.`, PhrenError.FILE_NOT_FOUND);

  return withSafeLock(filePath, () => {
    const lines = fs.readFileSync(filePath, "utf8").split("\n");
    const needle = normalizeFindingText(match);
    const bulletLines = collectFindingBulletLines(lines);
    const activeMatch = findMatchingFindingBullet(bulletLines.filter(({ archived }) => !archived), needle, match);
    if (activeMatch.kind === "ambiguous") {
      return phrenErr(activeMatch.error, PhrenError.AMBIGUOUS_MATCH);
    }
    if (activeMatch.kind === "not_found") {
      const archivedMatch = findMatchingFindingBullet(bulletLines.filter(({ archived }) => archived), needle, match);
      if (archivedMatch.kind === "ambiguous" || archivedMatch.kind === "found") {
        return phrenErr(`Finding "${match}" is archived and read-only. Restore or re-add it before mutating history.`, PhrenError.VALIDATION_ERROR);
      }
      return phrenErr(`No finding matching "${match}" in project "${project}". Try a different search term or check :findings view.`, PhrenError.NOT_FOUND);
    }
    const idx = activeMatch.idx;

    const removeCount = isCitationLine(lines[idx + 1] || "") ? 2 : 1;
    const matched = lines[idx];
    lines.splice(idx, removeCount);
    const normalized = lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
    fs.writeFileSync(filePath, normalized);
    return phrenOk(`Removed from ${project}: ${matched}`);
  });
}

export function removeFindings(phrenPath: string, project: string, matches: string[]): PhrenResult<{ removed: string[]; errors: string[] }> {
  const ensured = ensureProject(phrenPath, project);
  if (!ensured.ok) return forwardErr(ensured);

  const findingsPath = path.resolve(path.join(ensured.data, 'FINDINGS.md'));
  if (!findingsPath.startsWith(phrenPath + path.sep) && findingsPath !== phrenPath) {
    return phrenErr(`FINDINGS.md path escapes phren store`, PhrenError.VALIDATION_ERROR);
  }
  if (!fs.existsSync(findingsPath)) return phrenErr(`No FINDINGS.md file found for "${project}". Add a finding first with add_finding or :find add.`, PhrenError.FILE_NOT_FOUND);

  return withSafeLock(findingsPath, () => {
    const lines = fs.readFileSync(findingsPath, "utf8").split("\n");
    const removed: string[] = [];
    const errors: string[] = [];
    const bulletLines = collectFindingBulletLines(lines);
    const activeBullets = bulletLines.filter(({ archived }) => !archived);
    const archivedBullets = bulletLines.filter(({ archived }) => archived);

    // Collect indices to remove (with citation lines) in one pass over matches
    const indicesToRemove = new Set<number>();
    for (const match of matches) {
      const needle = normalizeFindingText(match);
      const activeMatch = findMatchingFindingBullet(
        activeBullets.filter(({ i }) => !indicesToRemove.has(i)),
        needle, match,
      );
      if (activeMatch.kind === "ambiguous") {
        errors.push(match);
        continue;
      }
      if (activeMatch.kind === "not_found") {
        const archivedMatch = findMatchingFindingBullet(archivedBullets, needle, match);
        if (archivedMatch.kind === "ambiguous" || archivedMatch.kind === "found") {
          errors.push(match);
          continue;
        }
        errors.push(match);
        continue;
      }
      const idx = activeMatch.idx;
      indicesToRemove.add(idx);
      if (isCitationLine(lines[idx + 1] || "")) indicesToRemove.add(idx + 1);
      removed.push(lines[idx]);
    }

    if (removed.length > 0) {
      const filtered = lines.filter((_, i) => !indicesToRemove.has(i));
      const normalized = filtered.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
      fs.writeFileSync(findingsPath, normalized);
    }

    return phrenOk({ removed, errors });
  });
}

export function editFinding(phrenPath: string, project: string, oldText: string, newText: string): PhrenResult<string> {
  const ensured = ensureProject(phrenPath, project);
  if (!ensured.ok) return forwardErr(ensured);

  const newTextTrimmed = newText.trim();
  if (!newTextTrimmed) return phrenErr("New finding text cannot be empty.", PhrenError.EMPTY_INPUT);

  const findingsPath = path.resolve(path.join(ensured.data, "FINDINGS.md"));
  if (!findingsPath.startsWith(phrenPath + path.sep) && findingsPath !== phrenPath) {
    return phrenErr(`FINDINGS.md path escapes phren store`, PhrenError.VALIDATION_ERROR);
  }
  if (!fs.existsSync(findingsPath)) return phrenErr(`No FINDINGS.md file found for "${project}".`, PhrenError.FILE_NOT_FOUND);

  return withSafeLock(findingsPath, () => {
    const lines = fs.readFileSync(findingsPath, "utf8").split("\n");
    const needle = normalizeFindingText(oldText);
    const bulletLines = collectFindingBulletLines(lines);
    const activeMatch = findMatchingFindingBullet(bulletLines.filter(({ archived }) => !archived), needle, oldText);
    if (activeMatch.kind === "ambiguous") {
      return phrenErr(activeMatch.error, PhrenError.AMBIGUOUS_MATCH);
    }
    if (activeMatch.kind === "not_found") {
      const archivedMatch = findMatchingFindingBullet(bulletLines.filter(({ archived }) => archived), needle, oldText);
      if (archivedMatch.kind === "ambiguous" || archivedMatch.kind === "found") {
        return phrenErr(`Finding "${oldText}" is archived and read-only. Restore or re-add it before mutating history.`, PhrenError.VALIDATION_ERROR);
      }
      return phrenErr(`No finding matching "${oldText}" in project "${project}".`, PhrenError.NOT_FOUND);
    }
    const idx = activeMatch.idx;

    // Preserve existing metadata comment (fid, citations, etc.)
    const existing = lines[idx];
    const metaMatch = existing.match(/(<!--.*?-->)/g);
    const metaSuffix = metaMatch ? " " + metaMatch.join(" ") : "";
    lines[idx] = `- ${newTextTrimmed}${metaSuffix}`;
    const normalized = lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
    fs.writeFileSync(findingsPath, normalized);
    return phrenOk(`Updated finding in ${project}`);
  });
}

// Use shared queueFilePath from utils.ts; alias for local brevity.
const queuePath = queueFilePath;

function parseQueueLine(line: string): { date?: string; text: string; confidence?: number; machine?: string; model?: string } {
  const parsed = line.match(/^- \[(\d{4}-\d{2}-\d{2})\]\s*(.+)$/);
  const rawText = parsed ? parsed[2] : line.replace(/^-\s+/, "").trim();
  const confidence = rawText.match(/\[confidence\s+([01](?:\.\d+)?)\]/i);
  const source = parseSourceComment(line);
  let machine = source?.machine;
  let model = source?.model;
  // Strip the confidence marker from the canonical text so it doesn't pollute FINDINGS.md
  const sanitized = normalizeQueueEntryText(
    rawText.replace(/\s*\[confidence\s+[01](?:\.\d+)?\]/gi, "").trim(),
    { truncate: true },
  );
  const text = sanitized.ok ? sanitized.data.text : "";
  return {
    date: parsed?.[1],
    text,
    confidence: confidence ? Number.parseFloat(confidence[1]) : undefined,
    machine,
    model,
  };
}

export function readReviewQueue(phrenPath: string, project: string): PhrenResult<QueueItem[]> {
  const ensured = ensureProject(phrenPath, project);
  if (!ensured.ok) return forwardErr(ensured);

  const file = queuePath(phrenPath, project);
  if (!fs.existsSync(file)) return phrenOk([]);

  const lines = fs.readFileSync(file, "utf8").split("\n");
  const items: QueueItem[] = [];
  let section: QueueItem["section"] = "Review";
  let index = 1;

  for (const line of lines) {
    const trimmed = line.trim();
    const queueHeading = trimmed.match(/^##\s+(.+?)[\s]*$/i);
    if (queueHeading) {
      const qToken = queueHeading[1].replace(/\s+/g, " ").trim().toLowerCase();
      if (qToken === "review") { section = "Review"; continue; }
      if (qToken === "stale") { section = "Stale"; continue; }
      if (qToken === "conflicts") { section = "Conflicts"; continue; }
    }
    if (!line.startsWith("- ")) continue;

    const parsed = parseQueueLine(line);
    const risky = section !== "Review" || (parsed.confidence !== undefined && parsed.confidence < 0.7);
    items.push({
      id: `M${index}`,
      section,
      date: parsed.date || "unknown",
      text: parsed.text,
      line,
      confidence: parsed.confidence,
      risky,
      machine: parsed.machine,
      model: parsed.model,
    });
    index++;
  }

  return phrenOk(items);
}

/** Locate a queue line and apply a mutation within a file lock. */
function withQueueLineOp<T>(
  phrenPath: string, project: string, lineText: string,
  op: (lines: string[], idx: number, file: string) => PhrenResult<T>,
): PhrenResult<T> {
  const ensured = ensureProject(phrenPath, project);
  if (!ensured.ok) return forwardErr(ensured);

  const file = queuePath(phrenPath, project);
  if (!fs.existsSync(file)) return phrenErr(`No review queue found for "${project}".`, PhrenError.FILE_NOT_FOUND);

  return withSafeLock(file, () => {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    const idx = lines.findIndex((l) => l.trim() === lineText.trim());
    if (idx === -1) return phrenErr(`Queue item not found in "${project}".`, PhrenError.NOT_FOUND);
    return op(lines, idx, file);
  });
}

function writeQueueLines(file: string, lines: string[]): void {
  fs.writeFileSync(file, lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n");
}

/** Remove a queue item's line from review.md (finding stays in FINDINGS.md). */
export function approveQueueItem(phrenPath: string, project: string, lineText: string): PhrenResult<string> {
  return withQueueLineOp(phrenPath, project, lineText, (lines, idx, file) => {
    lines.splice(idx, 1);
    writeQueueLines(file, lines);
    return phrenOk(`Approved queue item in ${project}`);
  });
}

/** Remove a queue item from review.md AND remove the corresponding finding from FINDINGS.md. */
export function rejectQueueItem(phrenPath: string, project: string, lineText: string): PhrenResult<string> {
  const lockResult = withQueueLineOp(phrenPath, project, lineText, (lines, idx, file) => {
    lines.splice(idx, 1);
    writeQueueLines(file, lines);
    return phrenOk("ok");
  });
  if (!lockResult.ok) return lockResult;

  const parsed = parseQueueLine(lineText);
  if (parsed.text) {
    const removeResult = removeFinding(phrenPath, project, parsed.text);
    if (!removeResult.ok) {
      return phrenOk(`Rejected queue item from ${project} (note: finding not found in FINDINGS.md — may have already been removed)`);
    }
  }
  return phrenOk(`Rejected and removed queue item from ${project}`);
}

/** Edit a queue item's text in review.md and the corresponding finding in FINDINGS.md. */
export function editQueueItem(phrenPath: string, project: string, lineText: string, newText: string): PhrenResult<string> {
  const trimmed = newText.replace(/[\r\n]+/g, " ").trim();
  if (!trimmed) return phrenErr("New text cannot be empty.", PhrenError.EMPTY_INPUT);

  const parsed = parseQueueLine(lineText);

  const lockResult = withQueueLineOp(phrenPath, project, lineText, (lines, idx, file) => {
    const dateMatch = lines[idx].match(/^- \[(\d{4}-\d{2}-\d{2})\]\s*/);
    lines[idx] = dateMatch ? `- [${dateMatch[1]}] ${trimmed}` : `- ${trimmed}`;
    writeQueueLines(file, lines);
    return phrenOk("ok");
  });
  if (!lockResult.ok) return lockResult;

  if (parsed.text) {
    const editResult = editFinding(phrenPath, project, parsed.text, trimmed);
    if (!editResult.ok) {
      return phrenOk(`Updated queue item in ${project} (note: corresponding finding not found in FINDINGS.md)`);
    }
  }
  return phrenOk(`Updated queue item in ${project}`);
}

export function readReviewQueueAcrossProjects(phrenPath: string, profile?: string): PhrenResult<ProjectQueueItem[]> {
  const validation = validateAggregateQueueProfile(phrenPath, profile);
  if (!validation.ok) return validation;

  const projects = getProjectDirs(phrenPath, profile)
    .map((dir) => path.basename(dir))
    .filter((project) => project !== "global")
    .sort();
  const sectionOrder: Record<ProjectQueueItem["section"], number> = {
    Review: 0,
    Stale: 1,
    Conflicts: 2,
  };

  const items: ProjectQueueItem[] = [];
  for (const project of projects) {
    const result = readReviewQueue(phrenPath, project);
    if (!result.ok) continue;
    for (const item of result.data) {
      items.push({ project, ...item });
    }
  }

  items.sort((a, b) => {
    const aDate = a.date === "unknown" ? "" : a.date;
    const bDate = b.date === "unknown" ? "" : b.date;
    if (a.section !== b.section) return sectionOrder[a.section] - sectionOrder[b.section];
    if (aDate !== bDate) return bDate.localeCompare(aDate);
    const projectCmp = a.project.localeCompare(b.project);
    if (projectCmp !== 0) return projectCmp;
    return a.id.localeCompare(b.id);
  });

  return phrenOk(items);
}

