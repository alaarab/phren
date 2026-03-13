import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import {
  appendAuditLog,
  cortexErr,
  CortexError,
  cortexOk,
  type CortexResult,
  forwardErr,
  getProjectDirs,
} from "./shared.js";
import {
  checkPermission,
  getWorkflowPolicy,
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

function withSafeLock<T>(filePath: string, fn: () => CortexResult<T>): CortexResult<T> {
  try {
    return withFileLockRaw(filePath, fn);
  } catch (err: unknown) {
    const msg = errorMessage(err);
    if (msg.includes("could not acquire lock")) {
      return cortexErr(`Could not acquire write lock for "${path.basename(filePath)}". Another write may be in progress; please retry.`, CortexError.LOCK_TIMEOUT);
    }
    throw err;
  }
}

function ensureProject(cortexPath: string, project: string): CortexResult<string> {
  if (!isValidProjectName(project)) return cortexErr(`Project name "${project}" is not valid. Use lowercase letters, numbers, and hyphens (e.g. "my-project").`, CortexError.INVALID_PROJECT_NAME);
  const dir = safeProjectPath(cortexPath, project);
  if (!dir) return cortexErr(`Project name "${project}" is not valid. Use lowercase letters, numbers, and hyphens (e.g. "my-project").`, CortexError.INVALID_PROJECT_NAME);
  if (!fs.existsSync(dir)) {
    return cortexErr(`No project "${project}" found. Add it with 'cd ~/your-project && cortex add'.`, CortexError.PROJECT_NOT_FOUND);
  }
  return cortexOk(dir);
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
  /** Indicates whether this item comes from archived history blocks (<details> / cortex:archive). */
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

export function readFindings(cortexPath: string, project: string, opts: ReadFindingsOptions = {}): CortexResult<FindingItem[]> {
  const ensured = ensureProject(cortexPath, project);
  if (!ensured.ok) return forwardErr(ensured);

  const findingsPath = path.join(ensured.data, 'FINDINGS.md');
  const file = findingsPath;
  if (!fs.existsSync(file)) return cortexOk([]);

  const lines = fs.readFileSync(file, "utf8").split("\n");
  const items: FindingItem[] = [];
  let date = "unknown";
  let index = 1;
  let inArchiveBlock = false;
  const includeArchived = opts.includeArchived ?? false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const archiveStart = /<!--\s*cortex:archive:start\s*-->/.test(line) || /^<details(?:\s|>)/i.test(trimmed);
    const archiveEnd = /<!--\s*cortex:archive:end\s*-->/.test(line) || /^<\/details>/i.test(trimmed);
    if (archiveStart) {
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
    const citation = /^\s*<!--\s*cortex:cite\s+\{.*\}\s*-->\s*$/.test(next.trim()) ? next.trim() : undefined;
    const citationData = citation ? parseCitationComment(citation) ?? undefined : undefined;
    const source = parseSourceComment(line) ?? undefined;
    const fidMatch = line.match(/<!--\s*fid:([a-z0-9]{8})\s*-->/);
    const rawText = line.replace(/^-\s+/, "").trim();
    const textWithoutComments = rawText.replace(/<!--.*?-->/g, "").trim();
    const confMatch = textWithoutComments.match(/\s*\[confidence\s+([01](?:\.\d+)?)\]\s*$/i);
    const confidence = confMatch ? parseFloat(confMatch[1]) : undefined;
    const text = confMatch
      ? textWithoutComments.slice(0, textWithoutComments.length - confMatch[0].length).trim()
      : textWithoutComments;

    // Parse lifecycle annotations
    const supersededByMatch = line.match(/<!--\s*cortex:superseded_by\s+"([^"]+)"\s+[\d-]+\s*-->/);
    const supersedesMatch = line.match(/<!--\s*cortex:supersedes\s+"([^"]+)"\s*-->/);
    const contradictsMatches = [...line.matchAll(/<!--\s*cortex:contradicts\s+"([^"]+)"\s*-->/g)];
    const lifecycle = parseFindingLifecycle(line);

    items.push({
      id: `L${index}`,
      stableId: fidMatch ? fidMatch[1] : undefined,
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
      contradicts: contradictsMatches.length > 0 ? contradictsMatches.map(m => m[1]) : undefined,
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

  return cortexOk(items);
}

export function readFindingHistory(cortexPath: string, project: string, findingId?: string): CortexResult<FindingHistoryEntry[]> {
  const result = readFindings(cortexPath, project, { includeArchived: true });
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
    return cortexErr(`No finding history matching "${findingId}" in project "${project}".`, CortexError.NOT_FOUND);
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

  return cortexOk(history);
}

export function addFinding(cortexPath: string, project: string, learning: string): CortexResult<string> {
  if (!isValidProjectName(project)) return cortexErr(`Project name "${project}" is not valid. Use lowercase letters, numbers, and hyphens (e.g. "my-project").`, CortexError.INVALID_PROJECT_NAME);
  const resolved = safeProjectPath(cortexPath, project);
  if (!resolved) return cortexErr(`Project name "${project}" is not valid. Use lowercase letters, numbers, and hyphens (e.g. "my-project").`, CortexError.INVALID_PROJECT_NAME);

  // addFindingToFile handles its own file lock; no double-wrap
  return addFindingToFile(cortexPath, project, learning);
}

export function removeFinding(cortexPath: string, project: string, match: string): CortexResult<string> {
  const ensured = ensureProject(cortexPath, project);
  if (!ensured.ok) return forwardErr(ensured);

  const findingsPath = path.join(ensured.data, 'FINDINGS.md');
  const filePath = findingsPath;
  if (!fs.existsSync(filePath)) return cortexErr(`No FINDINGS.md file found for "${project}". Add a finding first with add_finding or :find add.`, CortexError.FILE_NOT_FOUND);

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
      return cortexErr(`"${match}" is ambiguous (${exactMatches.length} exact matches). Use a more specific phrase.`, CortexError.AMBIGUOUS_MATCH);
    } else if (partialMatches.length === 1) {
      idx = partialMatches[0].i;
    } else if (partialMatches.length > 1) {
      return cortexErr(`"${match}" is ambiguous (${partialMatches.length} partial matches). Use a more specific phrase.`, CortexError.AMBIGUOUS_MATCH);
    } else {
      return cortexErr(`No finding matching "${match}" in project "${project}". Try a different search term or check :findings view.`, CortexError.NOT_FOUND);
    }

    const citationComment = /^\s*<!--\s*cortex:cite\s+\{.*\}\s*-->\s*$/;
    const removeCount = citationComment.test(lines[idx + 1] || "") ? 2 : 1;
    const matched = lines[idx];
    lines.splice(idx, removeCount);
    const normalized = lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
    fs.writeFileSync(filePath, normalized);
    return cortexOk(`Removed from ${project}: ${matched}`);
  });
}

export function editFinding(cortexPath: string, project: string, oldText: string, newText: string): CortexResult<string> {
  const ensured = ensureProject(cortexPath, project);
  if (!ensured.ok) return forwardErr(ensured);

  const newTextTrimmed = newText.trim();
  if (!newTextTrimmed) return cortexErr("New finding text cannot be empty.", CortexError.EMPTY_INPUT);

  const findingsPath = path.join(ensured.data, "FINDINGS.md");
  if (!fs.existsSync(findingsPath)) return cortexErr(`No FINDINGS.md file found for "${project}".`, CortexError.FILE_NOT_FOUND);

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
      return cortexErr(`"${oldText}" is ambiguous (${exactMatches.length} exact matches). Use a more specific phrase.`, CortexError.AMBIGUOUS_MATCH);
    } else if (partialMatches.length === 1) {
      idx = partialMatches[0].i;
    } else if (partialMatches.length > 1) {
      return cortexErr(`"${oldText}" is ambiguous (${partialMatches.length} partial matches). Use a more specific phrase.`, CortexError.AMBIGUOUS_MATCH);
    } else {
      return cortexErr(`No finding matching "${oldText}" in project "${project}".`, CortexError.NOT_FOUND);
    }

    // Preserve existing metadata comment (fid, citations, etc.)
    const existing = lines[idx];
    const metaMatch = existing.match(/(<!--.*?-->)/g);
    const metaSuffix = metaMatch ? " " + metaMatch.join(" ") : "";
    lines[idx] = `- ${newTextTrimmed}${metaSuffix}`;
    const normalized = lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
    fs.writeFileSync(findingsPath, normalized);
    return cortexOk(`Updated finding in ${project}`);
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

export function readReviewQueue(cortexPath: string, project: string): CortexResult<QueueItem[]> {
  const ensured = ensureProject(cortexPath, project);
  if (!ensured.ok) return forwardErr(ensured);

  const file = queuePath(cortexPath, project);
  if (!fs.existsSync(file)) return cortexOk([]);

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

  return cortexOk(items);
}

export function readReviewQueueAcrossProjects(cortexPath: string, profile?: string): CortexResult<ProjectQueueItem[]> {
  const projects = getProjectDirs(cortexPath, profile)
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
    const result = readReviewQueue(cortexPath, project);
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

  return cortexOk(items);
}

function rewriteQueue(cortexPath: string, project: string, items: QueueItem[]): void {
  const grouped: Record<QueueItem["section"], QueueItem[]> = {
    Review: [],
    Stale: [],
    Conflicts: [],
  };
  for (const item of items) grouped[item.section].push(item);

  const out: string[] = [`# ${project} Review Queue`, "", "## Review", ""];
  for (const item of grouped.Review) out.push(item.line);
  out.push("", "## Stale", "");
  for (const item of grouped.Stale) out.push(item.line);
  out.push("", "## Conflicts", "");
  for (const item of grouped.Conflicts) out.push(item.line);
  out.push("");
  const filePath = queuePath(cortexPath, project);
  const tmpPath = `${filePath}.tmp-${crypto.randomUUID()}`;
  fs.writeFileSync(tmpPath, out.join("\n").replace(/\n{3,}/g, "\n\n"));
  fs.renameSync(tmpPath, filePath);
}

function findQueueByMatch(cortexPath: string, project: string, match: string): CortexResult<{ item: QueueItem; all: QueueItem[]; index: number }> {
  const items = readReviewQueue(cortexPath, project);
  if (!items.ok) return forwardErr(items);
  const needle = match.trim().toLowerCase();

  // 1) Exact ID match
  const idIndex = items.data.findIndex((item) => item.id.toLowerCase() === needle);
  if (idIndex !== -1) return cortexOk({ item: items.data[idIndex], all: items.data, index: idIndex });

  // 2) Exact text match
  const exactMatches = items.data.reduce<number[]>((acc, item, i) => {
    if (item.text.toLowerCase() === needle || item.line === match) acc.push(i);
    return acc;
  }, []);
  if (exactMatches.length === 1) return cortexOk({ item: items.data[exactMatches[0]], all: items.data, index: exactMatches[0] });
  if (exactMatches.length > 1) return cortexErr(`"${match}" is ambiguous (${exactMatches.length} exact matches in review queue). Use the item ID (e.g. M1).`, CortexError.AMBIGUOUS_MATCH);

  // 3) Unique partial substring match
  const partialMatches = items.data.reduce<number[]>((acc, item, i) => {
    if (item.text.toLowerCase().includes(needle)) acc.push(i);
    return acc;
  }, []);
  if (partialMatches.length === 1) return cortexOk({ item: items.data[partialMatches[0]], all: items.data, index: partialMatches[0] });
  if (partialMatches.length > 1) return cortexErr(`"${match}" is ambiguous (${partialMatches.length} partial matches in review queue). Use the item ID (e.g. M1).`, CortexError.AMBIGUOUS_MATCH);

  return cortexErr(`No review queue item matching "${match}" in "${project}". Check the review queue view or use the item ID.`, CortexError.NOT_FOUND);
}

export function approveQueueItem(cortexPath: string, project: string, match: string): CortexResult<string> {
  const queueDenied = checkPermission(cortexPath, "queue");
  if (queueDenied) return cortexErr(queueDenied, CortexError.PERMISSION_DENIED);
  const writeDenied = checkPermission(cortexPath, "write");
  if (writeDenied) return cortexErr(writeDenied, CortexError.PERMISSION_DENIED);

  const ensured = ensureProject(cortexPath, project);
  if (!ensured.ok) return forwardErr(ensured);
  const qPath = queuePath(cortexPath, project);

  // Step 1: Acquire queue lock only to read and validate the item.
  // addFindingToFile acquires its own lock on FINDINGS.md; to avoid
  // inconsistent lock ordering (queue lock -> findings lock vs findings lock -> queue lock),
  // we release the queue lock before writing to FINDINGS.md, then re-acquire it to remove the item.
  const lookupResult = withSafeLock<{ item: QueueItem; all: QueueItem[]; index: number }>(qPath, () => {
    const found = findQueueByMatch(cortexPath, project, match);
    if (!found.ok) return forwardErr(found);

    const workflow = getWorkflowPolicy(cortexPath);
    const riskyBySection = workflow.riskySections.includes(found.data.item.section);
    const riskyByConfidence = found.data.item.confidence !== undefined && found.data.item.confidence < workflow.lowConfidenceThreshold;
    if (workflow.requireMaintainerApproval && (riskyBySection || riskyByConfidence)) {
      const pinDenied = checkPermission(cortexPath, "pin");
      if (pinDenied) return cortexErr(`This memory is flagged as risky and requires a maintainer or admin to approve. Check your role in .governance/access-control.json.`, CortexError.PERMISSION_DENIED);
    }

    return cortexOk(found.data);
  });
  if (!lookupResult.ok) return forwardErr(lookupResult);

  // Step 2: Write to FINDINGS.md with its own lock (no queue lock held).
  const add = addFindingToFile(cortexPath, project, lookupResult.data.item.text);
  if (!add.ok) return forwardErr(add);

  // Step 3: Re-acquire queue lock to remove the approved item.
  return withSafeLock(qPath, () => {
    // Re-read queue in case it changed while findings lock was held.
    const refreshed = readReviewQueue(cortexPath, project);
    if (!refreshed.ok) return forwardErr(refreshed);
    const refreshedIndex = refreshed.data.findIndex((i) => i.text === lookupResult.data.item.text && i.section === lookupResult.data.item.section);
    if (refreshedIndex !== -1) refreshed.data.splice(refreshedIndex, 1);
    rewriteQueue(cortexPath, project, refreshed.data);
    appendAuditLog(cortexPath, "approve_memory", `project=${project} item=${JSON.stringify(lookupResult.data.item.text)}`);
    return cortexOk(`Approved memory in ${project}: ${lookupResult.data.item.text}`);
  });
}

export function rejectQueueItem(cortexPath: string, project: string, match: string): CortexResult<string> {
  const denial = checkPermission(cortexPath, "queue");
  if (denial) return cortexErr(denial, CortexError.PERMISSION_DENIED);

  const ensured = ensureProject(cortexPath, project);
  if (!ensured.ok) return forwardErr(ensured);
  const qPath = queuePath(cortexPath, project);
  return withSafeLock(qPath, () => {
    const found = findQueueByMatch(cortexPath, project, match);
    if (!found.ok) return forwardErr(found);

    found.data.all.splice(found.data.index, 1);
    rewriteQueue(cortexPath, project, found.data.all);
    appendAuditLog(cortexPath, "reject_memory", `project=${project} item=${JSON.stringify(found.data.item.text)}`);
    return cortexOk(`Rejected memory in ${project}: ${found.data.item.text}`);
  });
}

export function editQueueItem(cortexPath: string, project: string, match: string, newText: string): CortexResult<string> {
  const denial = checkPermission(cortexPath, "queue");
  if (denial) return cortexErr(denial, CortexError.PERMISSION_DENIED);

  const normalized = normalizeQueueEntryText(newText);
  if (!normalized.ok) return forwardErr(normalized);
  const trimmed = normalized.data.text;

  const ensured = ensureProject(cortexPath, project);
  if (!ensured.ok) return forwardErr(ensured);
  const qPath = queuePath(cortexPath, project);
  return withSafeLock(qPath, () => {
    const found = findQueueByMatch(cortexPath, project, match);
    if (!found.ok) return forwardErr(found);

    const date = found.data.item.date === "unknown" ? new Date().toISOString().slice(0, 10) : found.data.item.date;
    found.data.item.text = trimmed;
    // Preserve the [confidence X.XX] marker so the approval gate can still evaluate risk.
    const confidencePart = found.data.item.confidence !== undefined
      ? ` [confidence ${found.data.item.confidence.toFixed(2)}]`
      : "";
    found.data.item.line = `- [${date}] ${found.data.item.text}${confidencePart}`;
    found.data.all[found.data.index] = found.data.item;
    rewriteQueue(cortexPath, project, found.data.all);
    appendAuditLog(cortexPath, "edit_memory", `project=${project} item=${JSON.stringify(found.data.item.text)}`);
    return cortexOk(`Edited memory in ${project}: ${found.data.item.text}`);
  });
}
