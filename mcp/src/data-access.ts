import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import {
  appendAuditLog,
  phrenErr,
  PhrenError,
  phrenOk,
  type PhrenResult,
  forwardErr,
  getProjectDirs,
} from "./shared.js";
import {
  normalizeQueueEntryText,
  withFileLock as withFileLockRaw,
} from "./shared-governance.js";
import {
  addFindingToFile,
} from "./shared-content.js";
import { isValidProjectName, queueFilePath, safeProjectPath, errorMessage } from "./utils.js";
import {
  type FindingCitation,
  type FindingProvenanceSource,
  parseCitationComment,
  parseSourceComment,
} from "./content-citation.js";
import {
  parseFindingLifecycle,
  type FindingLifecycleStatus,
} from "./finding-lifecycle.js";
import {
  METADATA_REGEX,
  isCitationLine,
  isArchiveStart,
  isArchiveEnd,
  parseFindingId,
  parseAllContradictions,
  stripComments,
} from "./content-metadata.js";
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
} from "./profile-store.js";
export {
  loadShellState,
  readRuntimeHealth,
  resetShellState,
  saveShellState,
  type ShellState,
} from "./shell-state-store.js";

function withSafeLock<T>(filePath: string, fn: () => PhrenResult<T>): PhrenResult<T> {
  try {
    return withFileLockRaw(filePath, fn);
  } catch (err: unknown) {
    const msg = errorMessage(err);
    if (msg.includes("could not acquire lock")) {
      return phrenErr(`Could not acquire write lock for "${path.basename(filePath)}". Another write may be in progress; please retry.`, PhrenError.LOCK_TIMEOUT);
    }
    throw err;
  }
}

function ensureProject(phrenPath: string, project: string): PhrenResult<string> {
  if (!isValidProjectName(project)) return phrenErr(`Project name "${project}" is not valid. Use lowercase letters, numbers, and hyphens (e.g. "my-project").`, PhrenError.INVALID_PROJECT_NAME);
  const dir = safeProjectPath(phrenPath, project);
  if (!dir) return phrenErr(`Project name "${project}" is not valid. Use lowercase letters, numbers, and hyphens (e.g. "my-project").`, PhrenError.INVALID_PROJECT_NAME);
  if (!fs.existsSync(dir)) {
    return phrenErr(`No project "${project}" found. Add it with 'cd ~/your-project && phren add'.`, PhrenError.PROJECT_NOT_FOUND);
  }
  return phrenOk(dir);
}

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
    const trimmed = line.trim();
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

export function addFinding(phrenPath: string, project: string, learning: string): PhrenResult<string> {
  if (!isValidProjectName(project)) return phrenErr(`Project name "${project}" is not valid. Use lowercase letters, numbers, and hyphens (e.g. "my-project").`, PhrenError.INVALID_PROJECT_NAME);
  const resolved = safeProjectPath(phrenPath, project);
  if (!resolved) return phrenErr(`Project name "${project}" is not valid. Use lowercase letters, numbers, and hyphens (e.g. "my-project").`, PhrenError.INVALID_PROJECT_NAME);

  // addFindingToFile handles its own file lock; no double-wrap
  return addFindingToFile(phrenPath, project, learning);
}

export function removeFinding(phrenPath: string, project: string, match: string): PhrenResult<string> {
  const ensured = ensureProject(phrenPath, project);
  if (!ensured.ok) return forwardErr(ensured);

  const findingsPath = path.join(ensured.data, 'FINDINGS.md');
  const filePath = findingsPath;
  if (!fs.existsSync(filePath)) return phrenErr(`No FINDINGS.md file found for "${project}". Add a finding first with add_finding or :find add.`, PhrenError.FILE_NOT_FOUND);

  return withSafeLock(filePath, () => {
    const lines = fs.readFileSync(filePath, "utf8").split("\n");
    const needle = match.trim().toLowerCase();
    const bulletLines = lines.map((line, i) => ({ line, i })).filter(({ line }) => line.startsWith("- "));

    // 0) Stable finding ID match (fid:XXXXXXXX or just the 8-char hex)
    const fidNeedle = needle.replace(/^fid:/, "");
    const fidMatch = /^[a-z0-9]{8}$/.test(fidNeedle)
      ? bulletLines.filter(({ line }) => new RegExp(`<!--\\s*fid:${fidNeedle}\\s*-->`).test(line))
      : [];

    // 1) Exact text match (strip bullet prefix + metadata for comparison)
    const exactMatches = bulletLines.filter(({ line }) =>
      line.replace(/^-\s+/, "").replace(/<!--.*?-->/g, "").trim().toLowerCase() === needle
    );
    // 2) Unique partial substring match
    const partialMatches = bulletLines.filter(({ line }) => line.toLowerCase().includes(needle));

    let idx: number;
    if (fidMatch.length === 1) {
      idx = fidMatch[0].i;
    } else if (exactMatches.length === 1) {
      idx = exactMatches[0].i;
    } else if (exactMatches.length > 1) {
      return phrenErr(`"${match}" is ambiguous (${exactMatches.length} exact matches). Use a more specific phrase.`, PhrenError.AMBIGUOUS_MATCH);
    } else if (partialMatches.length === 1) {
      idx = partialMatches[0].i;
    } else if (partialMatches.length > 1) {
      return phrenErr(`"${match}" is ambiguous (${partialMatches.length} partial matches). Use a more specific phrase.`, PhrenError.AMBIGUOUS_MATCH);
    } else {
      return phrenErr(`No finding matching "${match}" in project "${project}". Try a different search term or check :findings view.`, PhrenError.NOT_FOUND);
    }

    const removeCount = isCitationLine(lines[idx + 1] || "") ? 2 : 1;
    const matched = lines[idx];
    lines.splice(idx, removeCount);
    const normalized = lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
    fs.writeFileSync(filePath, normalized);
    return phrenOk(`Removed from ${project}: ${matched}`);
  });
}

export function editFinding(phrenPath: string, project: string, oldText: string, newText: string): PhrenResult<string> {
  const ensured = ensureProject(phrenPath, project);
  if (!ensured.ok) return forwardErr(ensured);

  const newTextTrimmed = newText.trim();
  if (!newTextTrimmed) return phrenErr("New finding text cannot be empty.", PhrenError.EMPTY_INPUT);

  const findingsPath = path.join(ensured.data, "FINDINGS.md");
  if (!fs.existsSync(findingsPath)) return phrenErr(`No FINDINGS.md file found for "${project}".`, PhrenError.FILE_NOT_FOUND);

  return withSafeLock(findingsPath, () => {
    const lines = fs.readFileSync(findingsPath, "utf8").split("\n");
    const needle = oldText.trim().toLowerCase();
    const bulletLines = lines.map((line, i) => ({ line, i })).filter(({ line }) => line.startsWith("- "));

    // Stable finding ID match
    const fidNeedle = needle.replace(/^fid:/, "");
    const fidMatch = /^[a-z0-9]{8}$/.test(fidNeedle)
      ? bulletLines.filter(({ line }) => new RegExp(`<!--\\s*fid:${fidNeedle}\\s*-->`).test(line))
      : [];

    const exactMatches = bulletLines.filter(({ line }) =>
      line.replace(/^-\s+/, "").replace(/<!--.*?-->/g, "").trim().toLowerCase() === needle
    );
    const partialMatches = bulletLines.filter(({ line }) => line.toLowerCase().includes(needle));

    let idx: number;
    if (fidMatch.length === 1) {
      idx = fidMatch[0].i;
    } else if (exactMatches.length === 1) {
      idx = exactMatches[0].i;
    } else if (exactMatches.length > 1) {
      return phrenErr(`"${oldText}" is ambiguous (${exactMatches.length} exact matches). Use a more specific phrase.`, PhrenError.AMBIGUOUS_MATCH);
    } else if (partialMatches.length === 1) {
      idx = partialMatches[0].i;
    } else if (partialMatches.length > 1) {
      return phrenErr(`"${oldText}" is ambiguous (${partialMatches.length} partial matches). Use a more specific phrase.`, PhrenError.AMBIGUOUS_MATCH);
    } else {
      return phrenErr(`No finding matching "${oldText}" in project "${project}".`, PhrenError.NOT_FOUND);
    }

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

export function readReviewQueueAcrossProjects(phrenPath: string, profile?: string): PhrenResult<ProjectQueueItem[]> {
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



