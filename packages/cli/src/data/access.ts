// Barrel module: re-exports task, profile, and shell-state APIs from their
// dedicated modules (data-tasks.ts, profile-store.ts, shell-state-store.ts)
// and owns finding/queue logic directly.
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import {
  appendAuditLog,
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
} from "../shared/governance.js";
import {
  addFindingToFile,
  type AddFindingResult,
} from "../shared/content.js";
import { isValidProjectName, QUEUE_FILENAME, safeProjectPath } from "../utils.js";
import {
  type FindingCitation,
  type FindingProvenance,
  parseCitationComment,
  parseScopeComment,
  parseSourceComment,
} from "../content/citation.js";
import {
  parseFindingLifecycle,
  type FindingLifecycleStatus,
} from "../finding/lifecycle.js";
import {
  METADATA_REGEX,
  isCitationLine,
  isArchiveStart,
  isArchiveEnd,
  parseFindingId,
  parseAllContradictions,
  stripComments,
  normalizeFindingText,
} from "../content/metadata.js";
import { withSafeLock, ensureProject, walkDirectory } from "../shared/data-utils.js";
import { getNonPrimaryStores, getStoreProjectDirs } from "../store-registry.js";
export type { TaskSection, TaskItem, TaskDoc } from "./tasks.js";
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
} from "./tasks.js";
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
} from "../shell/state-store.js";
export { getRuntimeHealth as readRuntimeHealth } from "../shared/governance.js";

export const FINDINGS_FILENAME = "FINDINGS.md";

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
  scope?: string;
  /** Machine hostname where this finding was originally recorded. */
  machine?: string;
  /** Actor (username) who recorded this finding. */
  actor?: string;
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

/** Bullet content with metadata comments removed — what the user actually sees. */
function bulletContentKey(line: string): string {
  return line.replace(/<!--.*?-->/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Multiple matches are only truly ambiguous when their CONTENT differs. When a
 * store carries literal duplicate bullets (same text, same tag), acting on the
 * first occurrence is what the caller means — refusing made duplicate findings
 * uneditable/undeletable from every host UI.
 */
function resolveDuplicateMatches(matches: FindingBulletLine[]): FindingBulletLine | null {
  const first = bulletContentKey(matches[0].line);
  return matches.every(({ line }) => bulletContentKey(line) === first) ? matches[0] : null;
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
    const dup = resolveDuplicateMatches(exactMatches);
    if (dup) return { kind: "found", idx: dup.i };
    return { kind: "ambiguous", error: `"${match}" is ambiguous (${exactMatches.length} exact matches). Use a more specific phrase.` };
  }
  if (partialMatches.length === 1) return { kind: "found", idx: partialMatches[0].i };
  if (partialMatches.length > 1) {
    const dup = resolveDuplicateMatches(partialMatches);
    if (dup) return { kind: "found", idx: dup.i };
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

  const findingsPath = path.join(ensured.data, FINDINGS_FILENAME);
  const file = findingsPath;
  if (!fs.existsSync(file)) return phrenOk([]);

  const lines = fs.readFileSync(file, "utf8").split("\n");
  const items: FindingItem[] = [];
  let date = "unknown";
  let index = 1;
  let inArchiveBlock = false;
  let headingTag: string | undefined;
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

    // Support heading-based findings: ## topic / ### title / paragraph
    const h2TagMatch = line.match(/^##\s+([a-z_-]+)\s*$/i);
    if (h2TagMatch && !line.match(/^##\s+\d{4}/)) {
      // Track topic heading (but not date headings like ## 2026-03-22)
      headingTag = h2TagMatch[1].toLowerCase();
      continue;
    }
    const h3Match = line.match(/^###\s+(.+)$/);
    if (h3Match && headingTag) {
      let body = "";
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j].trim();
        if (!next) continue;
        if (next.startsWith("#") || next.startsWith("- ")) break;
        body = next;
        break;
      }
      const title = h3Match[1].trim();
      const syntheticText = body ? `[${headingTag}] ${title} — ${body}` : `[${headingTag}] ${title}`;
      items.push({
        id: `L${index}`,
        date,
        text: syntheticText,
        status: "active" as FindingLifecycleStatus,
        archived: inArchiveBlock,
        tier: inArchiveBlock ? "archived" : "current",
      });
      index++;
      continue;
    }

    if (!line.startsWith("- ")) continue;

    const next = lines[i + 1] || "";
    const citation = isCitationLine(next) ? next.trim() : undefined;
    const citationData = citation ? parseCitationComment(citation) ?? undefined : undefined;
    const provenance = parseSourceComment(line);
    const scope = parseScopeComment(line) ?? provenance?.scope;
    const machine = provenance?.machine;
    const actor = provenance?.actor;
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
      citation,
      citationData,
      taskItem: citationData?.task_item,
      scope,
      machine,
      actor,
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

  const findingsPath = path.resolve(path.join(ensured.data, FINDINGS_FILENAME));
  if (!findingsPath.startsWith(path.resolve(ensured.data) + path.sep)) {
    return phrenErr(`${FINDINGS_FILENAME} path escapes phren store`, PhrenError.VALIDATION_ERROR);
  }
  const filePath = findingsPath;
  if (!fs.existsSync(filePath)) return phrenErr(`No ${FINDINGS_FILENAME} file found for "${project}". Add a finding first with add_finding or :find add.`, PhrenError.FILE_NOT_FOUND);

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
    const tmp = filePath + ".tmp." + process.pid;
    fs.writeFileSync(tmp, normalized);
    fs.renameSync(tmp, filePath);
    return phrenOk(`Removed from ${project}: ${matched}`);
  });
}

export function removeFindings(phrenPath: string, project: string, matches: string[]): PhrenResult<{ removed: string[]; errors: string[] }> {
  const ensured = ensureProject(phrenPath, project);
  if (!ensured.ok) return forwardErr(ensured);

  const findingsPath = path.resolve(path.join(ensured.data, FINDINGS_FILENAME));
  if (!findingsPath.startsWith(path.resolve(ensured.data) + path.sep)) {
    return phrenErr(`${FINDINGS_FILENAME} path escapes phren store`, PhrenError.VALIDATION_ERROR);
  }
  if (!fs.existsSync(findingsPath)) return phrenErr(`No ${FINDINGS_FILENAME} file found for "${project}". Add a finding first with add_finding or :find add.`, PhrenError.FILE_NOT_FOUND);

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
      const tmp = findingsPath + ".tmp." + process.pid;
      fs.writeFileSync(tmp, normalized);
      fs.renameSync(tmp, findingsPath);
    }

    return phrenOk({ removed, errors });
  });
}

export function editFinding(phrenPath: string, project: string, oldText: string, newText: string): PhrenResult<string> {
  const ensured = ensureProject(phrenPath, project);
  if (!ensured.ok) return forwardErr(ensured);

  const newTextTrimmed = newText.trim();
  if (!newTextTrimmed) return phrenErr("New finding text cannot be empty.", PhrenError.EMPTY_INPUT);

  const findingsPath = path.resolve(path.join(ensured.data, FINDINGS_FILENAME));
  if (!findingsPath.startsWith(path.resolve(ensured.data) + path.sep)) {
    return phrenErr(`${FINDINGS_FILENAME} path escapes phren store`, PhrenError.VALIDATION_ERROR);
  }
  if (!fs.existsSync(findingsPath)) return phrenErr(`No ${FINDINGS_FILENAME} file found for "${project}".`, PhrenError.FILE_NOT_FOUND);

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
    // Preserve the bullet's [tag] prefix: host UIs display (and send back)
    // tag-stripped text, and losing the tag silently demoted the finding to
    // untagged. Keep the old tag unless the new text supplies its own.
    const existingTag = existing.match(/^-\s*(\[[a-z][a-z0-9_-]*\])\s/)?.[1];
    const tagPrefix = existingTag && !/^\[[a-z][a-z0-9_-]*\]/.test(newTextTrimmed) ? `${existingTag} ` : "";
    lines[idx] = `- ${tagPrefix}${newTextTrimmed}${metaSuffix}`;
    const normalized = lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
    const tmp = findingsPath + ".tmp." + process.pid;
    fs.writeFileSync(tmp, normalized);
    fs.renameSync(tmp, findingsPath);
    return phrenOk(`Updated finding in ${project}`);
  });
}

// Queue paths derive from the store-resolved project dir (ensureProject),
// so secondary-store projects hit their own store's review.md.
const queuePath = (projectDir: string): string => path.join(projectDir, QUEUE_FILENAME);

interface ParsedQueueLine {
  date?: string;
  text: string;
  confidence?: number;
  machine?: string;
  model?: string;
  /** Structured provenance from a `<!-- source:... -->` comment, when the producer wrote one. */
  provenance?: FindingProvenance;
  /** Repo/commit/file provenance from a `<!-- phren:cite {...} -->` comment. */
  citation?: FindingCitation;
}

function parseQueueLine(line: string): ParsedQueueLine {
  const parsed = line.match(/^- \[(\d{4}-\d{2}-\d{2})\]\s*(.+)$/);
  const rawText = parsed ? parsed[2] : line.replace(/^-\s+/, "").trim();
  const confidence = rawText.match(/\[confidence\s+([01](?:\.\d+)?)\]/i);
  const source = parseSourceComment(line);
  const citation = parseCitationComment(line);
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
    machine: source?.machine,
    model: source?.model,
    provenance: source ?? undefined,
    citation: citation ?? undefined,
  };
}

export function readReviewQueue(phrenPath: string, project: string): PhrenResult<QueueItem[]> {
  const ensured = ensureProject(phrenPath, project);
  if (!ensured.ok) return forwardErr(ensured);

  const file = queuePath(ensured.data);
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

  const file = queuePath(ensured.data);
  if (!fs.existsSync(file)) return phrenErr(`No review queue found for "${project}".`, PhrenError.FILE_NOT_FOUND);

  return withSafeLock(file, () => {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    const idx = lines.findIndex((l) => l.trim() === lineText.trim());
    if (idx === -1) return phrenErr(`Queue item not found in "${project}".`, PhrenError.NOT_FOUND);
    return op(lines, idx, file);
  });
}

function writeQueueLines(file: string, lines: string[]): void {
  const content = lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  const tmp = file + ".tmp." + process.pid;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

/**
 * Read-only lookup of a queue line. Returns the *stored* line (not the caller's
 * approximation of it) so callers can read metadata comments the caller never had.
 *
 * Approve and reject both resolve the line first, act on FINDINGS.md second, and
 * dequeue last. Dequeuing first — the old order — meant a failed content operation
 * still destroyed the queue entry, which is how "approve" became a silent discard.
 */
function locateQueueLine(phrenPath: string, project: string, lineText: string): PhrenResult<string> {
  const ensured = ensureProject(phrenPath, project);
  if (!ensured.ok) return forwardErr(ensured);

  const file = queuePath(ensured.data);
  if (!fs.existsSync(file)) return phrenErr(`No review queue found for "${project}".`, PhrenError.FILE_NOT_FOUND);

  const lines = fs.readFileSync(file, "utf8").split("\n");
  const idx = lines.findIndex((l) => l.trim() === lineText.trim());
  if (idx === -1) return phrenErr(`Queue item not found in "${project}".`, PhrenError.NOT_FOUND);
  return phrenOk(lines[idx]);
}

/** Drop a queue line from review.md. */
function dequeueLine(phrenPath: string, project: string, lineText: string): PhrenResult<void> {
  return withQueueLineOp(phrenPath, project, lineText, (lines, idx, file) => {
    lines.splice(idx, 1);
    writeQueueLines(file, lines);
    return phrenOk(undefined);
  });
}

/** Does this text already exist as a live (non-archived) bullet in FINDINGS.md? */
function existsAsLiveFinding(phrenPath: string, project: string, text: string): boolean {
  const dir = safeProjectPath(phrenPath, project);
  if (!dir) return false;
  const findingsPath = path.join(dir, FINDINGS_FILENAME);
  if (!fs.existsSync(findingsPath)) return false;

  const lines = fs.readFileSync(findingsPath, "utf8").split("\n");
  const active = collectFindingBulletLines(lines).filter(({ archived }) => !archived);
  const match = findMatchingFindingBullet(active, normalizeFindingText(text), text);
  // "ambiguous" means several bullets matched — it is still present, just not uniquely
  // addressable, so approve must not write yet another copy.
  return match.kind === "found" || match.kind === "ambiguous";
}

interface ArchivedReferenceMatch {
  file: string;
  /** True when the file lives under reference/topics/ — the tier auto-archive writes. */
  autoArchived: boolean;
  idx: number;
  line: string;
}

/**
 * Find a queue item's content in the project's `reference/` tier.
 *
 * `autoArchiveToReference` moves findings out of FINDINGS.md into
 * `reference/topics/*.md` once a project exceeds the findings cap, without touching
 * the review queue lines that point at them. Those queue items are the reason
 * approve and reject used to be no-ops, so both verbs have to look here.
 */
function findArchivedReferenceMatches(phrenPath: string, project: string, text: string): ArchivedReferenceMatch[] {
  const referenceDir = safeProjectPath(phrenPath, project, "reference");
  if (!referenceDir || !fs.existsSync(referenceDir)) return [];

  const needle = normalizeFindingText(text);
  if (!needle) return [];
  const topicsDir = path.join(referenceDir, "topics") + path.sep;

  const exact: ArchivedReferenceMatch[] = [];
  const partial: ArchivedReferenceMatch[] = [];
  for (const filePath of walkDirectory(referenceDir)) {
    const lines = fs.readFileSync(filePath, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith("- ")) continue;
      const normalized = normalizeFindingText(lines[i]);
      if (!normalized) continue;
      const hit: ArchivedReferenceMatch = {
        file: filePath,
        autoArchived: filePath.startsWith(topicsDir),
        idx: i,
        line: lines[i],
      };
      if (normalized === needle) exact.push(hit);
      else if (normalized.includes(needle)) partial.push(hit);
    }
  }
  return exact.length > 0 ? exact : partial;
}

/** Bullet content of archived matches, ignoring metadata — used to detect true ambiguity. */
function archivedMatchesAreIdentical(matches: ArchivedReferenceMatch[]): boolean {
  const first = bulletContentKey(matches[0].line);
  return matches.every(({ line }) => bulletContentKey(line) === first);
}

export type QueueApproveOutcome = "promoted" | "already_present" | "already_archived";

export interface QueueApproveResult {
  outcome: QueueApproveOutcome;
  message: string;
  /** Canonical finding text the verb acted on (confidence marker stripped, type tag kept). */
  text: string;
}

export type QueueRejectOutcome =
  /** Removed from the live FINDINGS.md tier. */
  | "removed"
  /** Removed from reference/topics/*.md, where auto-archive had moved it. */
  | "removed_from_archive"
  /** Nothing to remove: the candidate was never written anywhere. Dequeuing *is* the rejection. */
  | "discarded";

export interface QueueRejectResult {
  outcome: QueueRejectOutcome;
  message: string;
  text: string;
}

/**
 * Approve a queue item: make it real, then dequeue.
 *
 * Three outcomes, because a queue line can point at three different realities:
 *
 * - `promoted` — the text is not in FINDINGS.md, so approving *writes* it. This is the
 *   case for every extraction candidate that scored below `autoAcceptThreshold`:
 *   extraction queues those without ever adding them, so the old "just splice the line
 *   out" behaviour silently discarded them. Promotion goes through `addFindingToFile`,
 *   the same path a direct add uses, so dedup, fid assignment, citation metadata, and
 *   the findings-cap auto-archive all behave identically.
 * - `already_present` — the text is already a live finding (govern queues existing
 *   findings for Stale/Conflicts review). Approving means "keep it"; just dequeue.
 * - `already_archived` — the content only exists in `reference/topics/`, because
 *   auto-archive moved it after it was queued. It is still live for retrieval, so the
 *   archive is left untouched and the item is dequeued.
 */
export function approveQueueItemDetailed(
  phrenPath: string,
  project: string,
  lineText: string,
): PhrenResult<QueueApproveResult> {
  const located = locateQueueLine(phrenPath, project, lineText);
  if (!located.ok) return forwardErr(located);

  const parsed = parseQueueLine(located.data);
  const text = parsed.text;
  if (!text) {
    // Nothing usable to promote — dequeue so the malformed line stops blocking the queue.
    const dequeued = dequeueLine(phrenPath, project, lineText);
    if (!dequeued.ok) return forwardErr(dequeued);
    appendAuditLog(phrenPath, "review_approve", `project=${project} outcome=empty`);
    return phrenOk({
      outcome: "already_present",
      message: `Approved queue item in ${project} (empty entry, nothing to promote)`,
      text: "",
    });
  }

  const finish = (outcome: QueueApproveOutcome, message: string): PhrenResult<QueueApproveResult> => {
    const dequeued = dequeueLine(phrenPath, project, lineText);
    if (!dequeued.ok) return forwardErr(dequeued);
    appendAuditLog(phrenPath, "review_approve", `project=${project} outcome=${outcome}`);
    return phrenOk({ outcome, message, text });
  };

  if (existsAsLiveFinding(phrenPath, project, text)) {
    return finish("already_present", `Approved queue item in ${project} (already in ${FINDINGS_FILENAME}; kept as-is)`);
  }

  const archived = findArchivedReferenceMatches(phrenPath, project, text);
  if (archived.length > 0) {
    return finish(
      "already_archived",
      `Approved queue item in ${project} (already archived to ${path.basename(archived[0].file)}; still available for retrieval, archive left untouched)`,
    );
  }

  // Not anywhere: this queue line IS the only copy. Write it as a finding, preserving
  // the entry's type tag (carried in the text) and its capture provenance.
  const citationInput: Partial<FindingCitation> | undefined = parsed.citation
    ? {
      ...(parsed.citation.repo ? { repo: parsed.citation.repo } : {}),
      ...(parsed.citation.file ? { file: parsed.citation.file } : {}),
      ...(parsed.citation.line !== undefined ? { line: parsed.citation.line } : {}),
      ...(parsed.citation.commit ? { commit: parsed.citation.commit } : {}),
    }
    : undefined;
  // The queue entry's own date is the day the observation was captured; the finding is
  // written today, so keep the original date as an explicit annotation rather than
  // losing it.
  const extraAnnotations = parsed.date ? [`<!-- phren:queued "${parsed.date}" -->`] : undefined;

  const added = addFindingToFile(phrenPath, project, text, citationInput, {
    ...(parsed.provenance ? { provenance: parsed.provenance } : {}),
    ...(parsed.provenance?.session_id ? { sessionId: parsed.provenance.session_id } : {}),
    ...(extraAnnotations ? { extraAnnotations } : {}),
  });
  if (!added.ok) return forwardErr(added);

  // A fuzzy-dedup skip means an equivalent finding already exists — the item is
  // effectively already present, not newly promoted.
  if (added.data.status === "skipped") {
    return finish("already_present", `Approved queue item in ${project} (equivalent finding already in ${FINDINGS_FILENAME}; not duplicated)`);
  }
  return finish("promoted", `Approved and promoted queue item to ${FINDINGS_FILENAME} in ${project}`);
}

/** Remove a queue item's line from review.md, promoting it to a finding when needed. */
export function approveQueueItem(phrenPath: string, project: string, lineText: string): PhrenResult<string> {
  const result = approveQueueItemDetailed(phrenPath, project, lineText);
  return result.ok ? phrenOk(result.data.message) : result;
}

/**
 * Reject a queue item: destroy the content wherever it actually lives, then dequeue.
 *
 * Rejection removes from the live FINDINGS.md tier *and* from `reference/topics/*.md`,
 * because auto-archive moves findings there without reconciling their queue lines and
 * archived content is still injected into agent prompts. Leaving it would make reject a
 * lie — the hosts tell users rejection removes the finding permanently.
 *
 * Two situations deliberately do NOT succeed quietly:
 * - the content sits in a FINDINGS.md archive block (`<details>` / `phren:archive`),
 *   which the rest of the codebase treats as read-only history; and
 * - several *different* bullets match, so deleting one would be a guess.
 *
 * Both return an error and leave the queue line in place, so the user sees the problem
 * instead of a success message over undeleted content.
 */
export function rejectQueueItemDetailed(
  phrenPath: string,
  project: string,
  lineText: string,
): PhrenResult<QueueRejectResult> {
  const located = locateQueueLine(phrenPath, project, lineText);
  if (!located.ok) return forwardErr(located);

  const parsed = parseQueueLine(located.data);
  const text = parsed.text;

  const finish = (outcome: QueueRejectOutcome, message: string): PhrenResult<QueueRejectResult> => {
    const dequeued = dequeueLine(phrenPath, project, lineText);
    if (!dequeued.ok) return forwardErr(dequeued);
    appendAuditLog(phrenPath, "review_reject", `project=${project} outcome=${outcome}`);
    return phrenOk({ outcome, message, text });
  };

  if (!text) return finish("discarded", `Rejected queue item from ${project} (empty entry)`);

  const removed = removeFinding(phrenPath, project, text);
  if (removed.ok) {
    return finish("removed", `Rejected and removed finding from ${FINDINGS_FILENAME} in ${project}`);
  }
  // Anything other than "it isn't there" is a real problem — an ambiguous match, a
  // read-only FINDINGS.md archive block, a lock timeout. Surface it and keep the queue
  // line so the user can act on it, rather than reporting success over live content.
  if (removed.code !== PhrenError.NOT_FOUND && removed.code !== PhrenError.FILE_NOT_FOUND) {
    return forwardErr(removed);
  }

  const matches = findArchivedReferenceMatches(phrenPath, project, text);
  if (matches.length === 0) {
    return finish(
      "discarded",
      `Rejected and discarded queue item from ${project} (candidate was never added to ${FINDINGS_FILENAME}; nothing to remove)`,
    );
  }

  const external = matches.filter((match) => !match.autoArchived);
  if (external.length > 0) {
    return phrenErr(
      `Cannot reject: "${text.slice(0, 60)}" lives in ${path.relative(phrenPath, external[0].file)}, which phren does not auto-manage. Remove it there, then reject again.`,
      PhrenError.VALIDATION_ERROR,
    );
  }
  if (matches.length > 1 && !archivedMatchesAreIdentical(matches)) {
    return phrenErr(
      `Cannot reject: "${text.slice(0, 60)}" matches ${matches.length} different archived entries. Remove the right one manually, then reject again.`,
      PhrenError.AMBIGUOUS_MATCH,
    );
  }

  const target = matches[0];
  const purge = withSafeLock(target.file, () => {
    const lines = fs.readFileSync(target.file, "utf8").split("\n");
    // Re-resolve under the lock — the file may have moved since the scan.
    const idx = lines[target.idx] === target.line ? target.idx : lines.indexOf(target.line);
    if (idx === -1) return phrenErr(`Archived entry vanished from ${path.basename(target.file)} before it could be removed.`, PhrenError.NOT_FOUND);
    const removeCount = isCitationLine(lines[idx + 1] || "") ? 2 : 1;
    lines.splice(idx, removeCount);
    const normalized = lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
    const tmp = `${target.file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, normalized);
    fs.renameSync(tmp, target.file);
    return phrenOk(undefined);
  });
  if (!purge.ok) return forwardErr(purge);

  return finish(
    "removed_from_archive",
    `Rejected and removed archived finding from reference/topics/${path.basename(target.file)} in ${project}`,
  );
}

/** Remove a queue item from review.md AND the corresponding finding wherever it lives. */
export function rejectQueueItem(phrenPath: string, project: string, lineText: string): PhrenResult<string> {
  const result = rejectQueueItemDetailed(phrenPath, project, lineText);
  return result.ok ? phrenOk(result.data.message) : result;
}

/**
 * Drop a queue line and nothing else.
 *
 * Unlike `rejectQueueItem`, this never touches FINDINGS.md or `reference/topics/`.
 * It is the verb for "stop asking me about this", not "this is wrong" — which is
 * what automated expiry needs: a governance-queued finding that already lives in
 * FINDINGS.md must survive its queue line timing out.
 */
export function dequeueQueueItem(phrenPath: string, project: string, lineText: string): PhrenResult<string> {
  const located = locateQueueLine(phrenPath, project, lineText);
  if (!located.ok) return forwardErr(located);

  const dequeued = dequeueLine(phrenPath, project, lineText);
  if (!dequeued.ok) return forwardErr(dequeued);

  appendAuditLog(phrenPath, "review_dequeue", `project=${project}`);
  return phrenOk(`Removed queue item from ${project} (content left untouched)`);
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
  const seen = new Set(projects);

  for (const project of projects) {
    const result = readReviewQueue(phrenPath, project);
    if (!result.ok) continue;
    for (const item of result.data) {
      items.push({ project, ...item });
    }
  }

  // Include projects from team stores
  try {
    for (const store of getNonPrimaryStores(phrenPath)) {
      if (!fs.existsSync(store.path)) continue;
      const storeDirs = getStoreProjectDirs(store)
        .map((d: string) => path.basename(d))
        .filter((p: string) => p !== "global");
      for (const storeProject of storeDirs) {
        if (seen.has(storeProject)) continue;
        seen.add(storeProject);
        const result = readReviewQueue(store.path, storeProject);
        if (!result.ok) continue;
        for (const item of result.data) {
          items.push({ project: storeProject, ...item });
        }
      }
    }
  } catch {
    // store-registry not available or error loading, continue with primary only
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

