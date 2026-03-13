import * as fs from "fs";
import * as path from "path";
import { randomBytes, randomUUID } from "crypto";
import {
  cortexErr,
  CortexError,
  type CortexErrorCode,
  cortexOk,
  type CortexResult,
  forwardErr,
  getProjectDirs,
} from "./shared.js";
import { withFileLock as withFileLockRaw } from "./shared-governance.js";
import { validateTaskFormat } from "./shared-content.js";
import { isValidProjectName, safeProjectPath, errorMessage } from "./utils.js";

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

const ACTIVE_HEADINGS = new Set(["active", "in progress", "in-progress", "current", "wip"]);
const QUEUE_HEADINGS = new Set(["queue", "queued", "task", "todo", "upcoming", "next"]);
const DONE_HEADINGS = new Set(["done", "completed", "finished", "archived"]);

export type TaskSection = "Active" | "Queue" | "Done";
export const TASKS_FILENAME = "tasks.md";
export const TASK_FILE_ALIASES = [TASKS_FILENAME] as const;

export interface TaskItem {
  /** Positional ID for display (e.g. "A1", "Q3"). Recomputed on every read — use stableId for persistent references. */
  id: string;
  /** Content-addressed stable ID embedded in the file as `<!-- bid:HASH -->`. Survives reordering and completions. */
  stableId?: string;
  section: TaskSection;
  line: string;
  checked: boolean;
  priority?: "high" | "medium" | "low";
  context?: string;
  pinned?: boolean;
  githubIssue?: number;
  githubUrl?: string;
  rank?: number;
  lastActivity?: string;
  createdAt?: string;
  sessionId?: string;
  scope?: string;
  childFindings?: string[];
  speculative?: boolean;
  parentFinding?: string;
}

export interface TaskDoc {
  project: string;
  title: string;
  items: Record<TaskSection, TaskItem[]>;
  issues: string[];
  path: string;
}

const TASK_SECTIONS: TaskSection[] = ["Active", "Queue", "Done"];

function normalizePriority(text: string): "high" | "medium" | "low" | undefined {
  const m = text.replace(/\s*\[pinned\]/gi, "").match(/\[(high|medium|low)\]\s*$/i);
  if (!m) return undefined;
  return m[1].toLowerCase() as "high" | "medium" | "low";
}

function detectPinned(text: string): boolean {
  return /\[pinned\]/i.test(text);
}

function stripPinnedTag(text: string): string {
  return text.replace(/\s*\[pinned\]/gi, "").trim();
}

function stripBulletPrefix(line: string): { checked: boolean; body: string } {
  const checked = /^-\s*\[[xX]\]\s+/.test(line);
  const body = line
    .replace(/^-\s*\[[ xX]\]\s+/, "")
    .replace(/^-\s+/, "")
    .trim();
  return { checked, body };
}

function parseGitHubIssueReference(raw: string): { githubIssue?: number; githubUrl?: string } {
  const trimmed = raw.trim();
  if (!trimmed) return {};

  const urlMatch = trimmed.match(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/(\d+)(?:[?#][^\s]*)?/);
  const issueMatch = trimmed.match(/#?(\d+)/);

  const githubIssue = urlMatch
    ? Number.parseInt(urlMatch[1], 10)
    : issueMatch
      ? Number.parseInt(issueMatch[1], 10)
      : undefined;
  const githubUrl = urlMatch ? urlMatch[0] : undefined;

  return {
    githubIssue: Number.isFinite(githubIssue) ? githubIssue : undefined,
    githubUrl,
  };
}

function isValidGitHubIssueUrl(raw: string): boolean {
  return Boolean(parseGitHubIssueReference(raw).githubUrl);
}

function formatGitHubIssueReference(item: TaskItem): string | undefined {
  if (!item.githubIssue && !item.githubUrl) return undefined;
  if (item.githubIssue && item.githubUrl) return `#${item.githubIssue} ${item.githubUrl}`;
  if (item.githubIssue) return `#${item.githubIssue}`;
  return item.githubUrl;
}

function parseContinuation(lines: string[], idx: number): {
  context?: string;
  githubIssue?: number;
  githubUrl?: string;
  linesToSkip: number;
} {
  let context: string | undefined;
  let githubIssue: number | undefined;
  let githubUrl: string | undefined;
  let linesToSkip = 0;

  for (let cursor = idx + 1; cursor < lines.length; cursor++) {
    const raw = lines[cursor];
    if (!raw.startsWith("  ")) break;
    const trimmed = raw.trim();
    if (!trimmed) {
      linesToSkip++;
      continue;
    }
    if (trimmed.startsWith("Context:")) {
      context = trimmed.slice("Context:".length).trim();
      linesToSkip++;
      continue;
    }
    if (trimmed.startsWith("GitHub:")) {
      const parsed = parseGitHubIssueReference(trimmed.slice("GitHub:".length));
      githubIssue = parsed.githubIssue;
      githubUrl = parsed.githubUrl;
      linesToSkip++;
      continue;
    }
    break;
  }

  return { context, githubIssue, githubUrl, linesToSkip };
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

/** Pattern that matches the task metadata comment embedded in task item lines.
 *  Format: <!-- bid:HASH [rank:N] [lastActivity:ISO] -->
 */
const METADATA_PATTERN = /\s*<!--\s*bid:([a-z0-9]{8})(?:\s+rank:(\d+))?(?:\s+lastActivity:([^\s>]+))?(?:\s+created:([^\s>]+))?(?:\s+session:([^\s>]+))?(?:\s+scope:([^\s>]+))?(?:\s+findings:((?:[a-z0-9]{8}(?::[a-z0-9]{8})?|fid:[a-z0-9]{8})(?:,[a-z0-9a-z:]{3,})*))?(?:\s+parentFinding:([^\s>]+))?(\s+speculative)?\s*-->/;

/** Generate a new 8-character random stable ID. */
function newBid(): string {
  return randomBytes(4).toString("hex");
}

/** Strip the metadata comment from a raw line, returning the clean text and any extracted fields. */
function stripBid(text: string): { clean: string; bid?: string; rank?: number; lastActivity?: string; createdAt?: string; sessionId?: string; scope?: string; childFindings?: string[]; parentFinding?: string; speculative?: boolean } {
  const m = text.match(METADATA_PATTERN);
  if (!m) return { clean: text };
  const rankNum = m[2] ? Number.parseInt(m[2], 10) : undefined;
  const childFindings = m[7] ? m[7].split(",").filter(Boolean) : undefined;
  return {
    clean: text.replace(METADATA_PATTERN, "").trimEnd(),
    bid: m[1],
    rank: Number.isFinite(rankNum) ? rankNum : undefined,
    lastActivity: m[3] || undefined,
    createdAt: m[4] || undefined,
    sessionId: m[5] || undefined,
    scope: m[6] || undefined,
    childFindings: childFindings && childFindings.length > 0 ? childFindings : undefined,
    parentFinding: m[8] || undefined,
    speculative: m[9] ? true : undefined,
  };
}

/**
 * Auto-assign numeric ranks to items without a rank.
 * high-priority items get lowest numbers, then medium, then low, then unranked.
 */
function assignMissingRanks(items: TaskItem[]): void {
  const unranked = items.filter((item) => item.rank === undefined);
  if (!unranked.length) return;
  const maxExisting = items.reduce((max, item) => (item.rank !== undefined && item.rank > max ? item.rank : max), 0);
  const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
  unranked.sort((a, b) => (priorityOrder[a.priority ?? ""] ?? 3) - (priorityOrder[b.priority ?? ""] ?? 3));
  let next = maxExisting + 1;
  for (const item of unranked) {
    item.rank = next++;
  }
}

/**
 * Apply gravity to tasks: items with stale lastActivity drift toward higher rank numbers.
 * Only affects display order — does not mutate the file.
 */
export function applyGravity(items: TaskItem[]): TaskItem[] {
  const now = Date.now();
  const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;
  const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  return items.map((item) => {
    if (!item.lastActivity || item.rank === undefined) return item;
    const age = now - new Date(item.lastActivity).getTime();
    if (age <= TWO_WEEKS_MS) return item;
    const weeksStale = Math.floor((age - TWO_WEEKS_MS) / ONE_WEEK_MS);
    return { ...item, rank: item.rank + Math.min(weeksStale, 10) };
  });
}

export function canonicalTaskFilePath(cortexPath: string, project: string): string | null {
  const resolved = safeProjectPath(cortexPath, project);
  if (!resolved) return null;
  return path.join(resolved, TASKS_FILENAME);
}

export function isTaskFileName(filename: string): boolean {
  return filename.toLowerCase() === TASKS_FILENAME;
}

export function resolveTaskFilePath(cortexPath: string, project: string): string | null {
  return canonicalTaskFilePath(cortexPath, project);
}

function normalizeTaskItemLine(item: TaskItem): string {
  let text = stripPinnedTag(item.line.replace(/\s*\[(high|medium|low)\]\s*$/gi, "")).trim();
  if (item.priority) text = `${text} [${item.priority}]`;
  if (item.pinned) text = `${text} [pinned]`;
  const prefix = item.checked || item.section === "Done" ? "- [x] " : "- [ ] ";
  const bid = item.stableId ?? newBid();
  const rankPart = item.rank !== undefined ? ` rank:${item.rank}` : "";
  const activityPart = item.lastActivity ? ` lastActivity:${item.lastActivity}` : "";
  const createdPart = item.createdAt ? ` created:${item.createdAt}` : "";
  const sessionPart = item.sessionId ? ` session:${item.sessionId}` : "";
  const scopePart = item.scope ? ` scope:${item.scope}` : "";
  const findingsPart = item.childFindings && item.childFindings.length > 0 ? ` findings:${item.childFindings.join(",")}` : "";
  const parentFindingPart = item.parentFinding ? ` parentFinding:${item.parentFinding}` : "";
  const speculativePart = item.speculative ? " speculative" : "";
  return `${prefix}${text} <!-- bid:${bid}${rankPart}${activityPart}${createdPart}${sessionPart}${scopePart}${findingsPart}${parentFindingPart}${speculativePart} -->`;
}

function parseTaskContent(project: string, taskPath: string, content: string): TaskDoc {
  const lines = content.split("\n");
  const title = lines[0]?.trim() || `# ${project} tasks`;
  const items: Record<TaskSection, TaskItem[]> = {
    Active: [],
    Queue: [],
    Done: [],
  };

  let section: TaskSection = "Queue";
  const sectionCounters: Record<TaskSection, number> = { Active: 0, Queue: 0, Done: 0 };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = line.trim().match(/^##\s+(.+?)[\s]*$/);
    if (heading) {
      const token = heading[1].replace(/\s+/g, " ").trim().toLowerCase();
      if (ACTIVE_HEADINGS.has(token)) {
        section = "Active";
      } else if (QUEUE_HEADINGS.has(token)) {
        section = "Queue";
      } else if (DONE_HEADINGS.has(token)) {
        section = "Done";
      }
      continue;
    }
    if (!line.startsWith("- ")) continue;

    const parsed = stripBulletPrefix(line);
    // Extract and strip the metadata comment before further parsing.
    const { clean: cleanBody, bid, rank, lastActivity, createdAt, sessionId, scope, childFindings, parentFinding, speculative } = stripBid(parsed.body);
    const pinned = detectPinned(cleanBody);
    const priority = normalizePriority(cleanBody);
    const continuation = parseContinuation(lines, i);
    const sectionPrefix = section === "Active" ? "A" : section === "Queue" ? "Q" : "D";
    sectionCounters[section]++;
    items[section].push({
      id: `${sectionPrefix}${sectionCounters[section]}`,
      stableId: bid,
      section,
      line: cleanBody,
      checked: parsed.checked || section === "Done",
      priority,
      rank,
      lastActivity,
      createdAt,
      sessionId,
      scope,
      childFindings,
      parentFinding,
      speculative,
      context: continuation.context,
      pinned: pinned || undefined,
      githubIssue: continuation.githubIssue,
      githubUrl: continuation.githubUrl,
    });
    i += continuation.linesToSkip;
  }

  // Assign ranks to items that don't have one yet (migration from priority-only files)
  for (const section of TASK_SECTIONS) {
    assignMissingRanks(items[section]);
  }

  return {
    project,
    title,
    path: taskPath,
    items,
    issues: validateTaskFormat(content),
  };
}

function renderTask(doc: TaskDoc): string {
  const out: string[] = [doc.title, ""];
  for (const section of TASK_SECTIONS) {
    out.push(`## ${section}`, "");
    for (const item of doc.items[section]) {
      out.push(normalizeTaskItemLine(item));
      if (item.context) out.push(`  Context: ${item.context}`);
      const githubRef = formatGitHubIssueReference(item);
      if (githubRef) out.push(`  GitHub: ${githubRef}`);
    }
    out.push("");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function findItemByMatch(
  doc: TaskDoc,
  match: string
): { match?: { section: TaskSection; index: number }; error?: string; errorCode?: CortexErrorCode } {
  const needle = match.trim().toLowerCase();
  if (!needle) return { error: `${CortexError.EMPTY_INPUT}: Please provide the item text or ID to match against.`, errorCode: CortexError.EMPTY_INPUT };

  // 1a) Stable ID match (bid:XXXX or just the 8-char hex).
  const bidNeedle = needle.replace(/^bid:/, "");
  if (/^[a-f0-9]{8}$/.test(bidNeedle)) {
    for (const section of TASK_SECTIONS) {
      const idx = doc.items[section].findIndex((item) => item.stableId === bidNeedle);
      if (idx !== -1) return { match: { section, index: idx } };
    }
  }

  // 1b) Positional ID match (A1, Q2, D3).
  for (const section of TASK_SECTIONS) {
    const idx = doc.items[section].findIndex((item) => item.id.toLowerCase() === needle);
    if (idx !== -1) return { match: { section, index: idx } };
  }

  // 2) Exact line match.
  const exact: Array<{ section: TaskSection; index: number }> = [];
  for (const section of TASK_SECTIONS) {
    doc.items[section].forEach((item, index) => {
      if (item.line.trim().toLowerCase() === needle) exact.push({ section, index });
    });
  }
  if (exact.length === 1) return { match: exact[0] };
  if (exact.length > 1) {
    return { error: `${CortexError.AMBIGUOUS_MATCH}: "${match}" is ambiguous (${exact.length} exact matches). Use item ID.`, errorCode: CortexError.AMBIGUOUS_MATCH };
  }

  // 3) Substring fallback, but only when unique.
  const partial: Array<{ section: TaskSection; index: number }> = [];
  for (const section of TASK_SECTIONS) {
    doc.items[section].forEach((item, index) => {
      if (item.line.toLowerCase().includes(needle)) partial.push({ section, index });
    });
  }
  if (partial.length === 1) return { match: partial[0] };
  if (partial.length > 1) {
    return { error: `${CortexError.AMBIGUOUS_MATCH}: "${match}" is ambiguous (${partial.length} partial matches). Use item ID.`, errorCode: CortexError.AMBIGUOUS_MATCH };
  }
  return { error: `${CortexError.NOT_FOUND}: Item not found — no task matching "${match}".`, errorCode: CortexError.NOT_FOUND };
}

function taskItemNotFound(project: string, match: string): CortexResult<never> {
  return cortexErr(
    `Item not found: no task matching "${match}" in project "${project}". Check the item text or use its ID (shown in the tasks view).`,
    CortexError.NOT_FOUND
  );
}

function writeTaskDoc(doc: TaskDoc): void {
  const tmpPath = `${doc.path}.tmp-${randomUUID()}`;
  fs.writeFileSync(tmpPath, renderTask(doc));
  fs.renameSync(tmpPath, doc.path);
}

function taskArchivePath(cortexPath: string, project: string): string {
  return path.join(cortexPath, ".governance", "task-archive", `${project}.md`);
}

export function readTasks(cortexPath: string, project: string): CortexResult<TaskDoc> {
  const ensured = ensureProject(cortexPath, project);
  if (!ensured.ok) return forwardErr(ensured);

  const taskPath = canonicalTaskFilePath(cortexPath, project);
  if (!taskPath) return cortexErr(`Project name "${project}" is not valid. Use lowercase letters, numbers, and hyphens (e.g. "my-project").`, CortexError.INVALID_PROJECT_NAME);

  if (!fs.existsSync(taskPath)) {
    return cortexOk({
      project,
      title: `# ${project} tasks`,
      path: taskPath,
      issues: [],
      items: { Active: [], Queue: [], Done: [] },
    });
  }

  const content = fs.readFileSync(taskPath, "utf8");
  return cortexOk(parseTaskContent(project, taskPath, content));
}

export function readTasksAcrossProjects(cortexPath: string, profile?: string): TaskDoc[] {
  const projects = getProjectDirs(cortexPath, profile).map((dir) => path.basename(dir)).sort();
  const result: TaskDoc[] = [];
  for (const project of projects) {
    const file = canonicalTaskFilePath(cortexPath, project);
    if (!file || !fs.existsSync(file)) continue;
    const parsed = readTasks(cortexPath, project);
    if (!parsed.ok) continue;
    result.push(parsed.data);
  }
  return result;
}

export function resolveTaskItem(cortexPath: string, project: string, match: string): CortexResult<TaskItem> {
  const parsed = readTasks(cortexPath, project);
  if (!parsed.ok) return forwardErr(parsed);
  const found = findItemByMatch(parsed.data, match);
  if (found.error) return cortexErr(found.error, found.errorCode ?? CortexError.AMBIGUOUS_MATCH);
  if (!found.match) return taskItemNotFound(project, match);
  return cortexOk(parsed.data.items[found.match.section][found.match.index]);
}

export interface AddTaskOptions {
  createdAt?: string;
  sessionId?: string;
  scope?: string;
  speculative?: boolean;
  parentFinding?: string;
}

export function addTask(cortexPath: string, project: string, item: string, opts?: AddTaskOptions): CortexResult<TaskItem> {
  const bPath = canonicalTaskFilePath(cortexPath, project);
  if (!bPath) return cortexErr(`Project name "${project}" is not valid. Use lowercase letters, numbers, and hyphens (e.g. "my-project").`, CortexError.INVALID_PROJECT_NAME);
  // Validate project exists before acquiring the lock — withFileLock creates the parent
  // directory via mkdirSync, which would silently create an unintended project directory.
  const preCheck = ensureProject(cortexPath, project);
  if (!preCheck.ok) return forwardErr(preCheck);

  return withSafeLock(bPath, () => {
    const parsed = readTasks(cortexPath, project);
    if (!parsed.ok) return forwardErr(parsed);

    const line = item.replace(/^-\s*/, "").trim();
    const newItem: TaskItem = {
      id: `Q${parsed.data.items.Queue.length + 1}`,
      stableId: newBid(),
      section: "Queue",
      line,
      checked: false,
      priority: normalizePriority(line),
      createdAt: opts?.createdAt,
      sessionId: opts?.sessionId,
      scope: opts?.scope,
      parentFinding: opts?.parentFinding,
      speculative: opts?.speculative || undefined,
    };
    parsed.data.items.Queue.push(newItem);
    writeTaskDoc(parsed.data);
    return cortexOk(newItem);
  });
}

export function addTasks(cortexPath: string, project: string, items: string[]): CortexResult<{ added: string[]; errors: string[] }> {
  const bPath = canonicalTaskFilePath(cortexPath, project);
  if (!bPath) return cortexErr(`Project name "${project}" is not valid.`, CortexError.INVALID_PROJECT_NAME);
  const preCheck = ensureProject(cortexPath, project);
  if (!preCheck.ok) return forwardErr(preCheck);

  return withSafeLock(bPath, () => {
    const parsed = readTasks(cortexPath, project);
    if (!parsed.ok) return forwardErr(parsed);

    const added: string[] = [];
    const errors: string[] = [];
    for (const item of items) {
      const line = item.replace(/^-\s*/, "").trim();
      if (!line) {
        errors.push(item);
        continue;
      }
      parsed.data.items.Queue.push({
        id: `Q${parsed.data.items.Queue.length + 1}`,
        section: "Queue",
        line,
        checked: false,
        priority: normalizePriority(line),
      });
      added.push(line);
    }
    writeTaskDoc(parsed.data);
    return cortexOk({ added, errors });
  });
}

export function completeTasks(cortexPath: string, project: string, matches: string[]): CortexResult<{ completed: string[]; errors: string[] }> {
  const bPath = canonicalTaskFilePath(cortexPath, project);
  if (!bPath) return cortexErr(`Project name "${project}" is not valid.`, CortexError.INVALID_PROJECT_NAME);

  return withSafeLock(bPath, () => {
    const parsed = readTasks(cortexPath, project);
    if (!parsed.ok) return forwardErr(parsed);

    const completed: string[] = [];
    const errors: string[] = [];
    for (const match of matches) {
      const found = findItemByMatch(parsed.data, match);
      if (found.error || !found.match) {
        errors.push(match);
        continue;
      }
      const [item] = parsed.data.items[found.match.section].splice(found.match.index, 1);
      item.section = "Done";
      item.checked = true;
      parsed.data.items.Done.unshift(item);
      completed.push(item.line);
    }
    writeTaskDoc(parsed.data);
    return cortexOk({ completed, errors });
  });
}

export function completeTask(cortexPath: string, project: string, match: string): CortexResult<string> {
  const bPath = canonicalTaskFilePath(cortexPath, project);
  if (!bPath) return cortexErr(`Project name "${project}" is not valid.`, CortexError.INVALID_PROJECT_NAME);

  return withSafeLock(bPath, () => {
    const parsed = readTasks(cortexPath, project);
    if (!parsed.ok) return forwardErr(parsed);

    const found = findItemByMatch(parsed.data, match);
    if (found.error) return cortexErr(found.error, found.errorCode ?? CortexError.AMBIGUOUS_MATCH);
    if (!found.match) return taskItemNotFound(project, match);

    const [item] = parsed.data.items[found.match.section].splice(found.match.index, 1);
    item.section = "Done";
    item.checked = true;
    parsed.data.items.Done.unshift(item);
    writeTaskDoc(parsed.data);
    return cortexOk(`Marked done in ${project}: ${item.line}`);
  });
}

export function removeTask(cortexPath: string, project: string, match: string): CortexResult<string> {
  const bPath = canonicalTaskFilePath(cortexPath, project);
  if (!bPath) return cortexErr(`Project name "${project}" is not valid.`, CortexError.INVALID_PROJECT_NAME);

  return withSafeLock(bPath, () => {
    const parsed = readTasks(cortexPath, project);
    if (!parsed.ok) return forwardErr(parsed);

    const found = findItemByMatch(parsed.data, match);
    if (found.error) return cortexErr(found.error, found.errorCode ?? CortexError.AMBIGUOUS_MATCH);
    if (!found.match) return taskItemNotFound(project, match);

    const [item] = parsed.data.items[found.match.section].splice(found.match.index, 1);
    writeTaskDoc(parsed.data);
    return cortexOk(`Removed task from ${project}: ${item.line}`);
  });
}

export function updateTask(
  cortexPath: string,
  project: string,
  match: string,
  updates: { priority?: string; context?: string; replace_context?: boolean; section?: string; github_issue?: number | string; github_url?: string; unlink_github?: boolean }
): CortexResult<string> {
  const bPath = canonicalTaskFilePath(cortexPath, project);
  if (!bPath) return cortexErr(`Project name "${project}" is not valid.`, CortexError.INVALID_PROJECT_NAME);

  return withSafeLock(bPath, () => {
    const parsed = readTasks(cortexPath, project);
    if (!parsed.ok) return forwardErr(parsed);

    const found = findItemByMatch(parsed.data, match);
    if (found.error) return cortexErr(found.error, found.errorCode ?? CortexError.AMBIGUOUS_MATCH);
    if (!found.match) return taskItemNotFound(project, match);

    const item = parsed.data.items[found.match.section][found.match.index];
    const changes: string[] = [];

    if (updates.priority) {
      const priority = updates.priority.toLowerCase();
      if (["high", "medium", "low"].includes(priority)) {
        item.priority = priority as "high" | "medium" | "low";
        item.line = item.line.replace(/\s*\[(high|medium|low)\]\s*$/gi, "").trim();
        item.line = `${item.line} [${item.priority}]`;
        changes.push(`priority -> ${priority}`);
      }
    }

    if (updates.context) {
      if (updates.replace_context || !item.context) item.context = updates.context;
      else item.context = `${item.context}; ${updates.context}`;
      changes.push("context updated");
    }

    if (updates.unlink_github) {
      item.githubIssue = undefined;
      item.githubUrl = undefined;
      changes.push("github link removed");
    } else if (updates.github_issue !== undefined || updates.github_url !== undefined) {
      if (updates.github_url && !isValidGitHubIssueUrl(updates.github_url)) {
        return cortexErr("github_url must be a valid GitHub issue URL.", CortexError.VALIDATION_ERROR);
      }
      const githubIssueRaw = typeof updates.github_issue === "string"
        ? updates.github_issue.trim()
        : updates.github_issue !== undefined
          ? String(updates.github_issue)
          : "";
      const parsedIssue = parseGitHubIssueReference([
        githubIssueRaw,
        updates.github_url?.trim() || "",
      ].filter(Boolean).join(" "));
      if (!parsedIssue.githubIssue && !parsedIssue.githubUrl) {
        return cortexErr("GitHub link update requires a valid issue number and/or GitHub issue URL.", CortexError.VALIDATION_ERROR);
      }
      item.githubIssue = parsedIssue.githubIssue;
      item.githubUrl = parsedIssue.githubUrl;
      changes.push(item.githubIssue ? `github -> #${item.githubIssue}` : "github link updated");
    }

    if (updates.section) {
      const target = updates.section[0].toUpperCase() + updates.section.slice(1).toLowerCase();
      if (["Active", "Queue", "Done"].includes(target)) {
        parsed.data.items[found.match.section].splice(found.match.index, 1);
        const section = target as TaskSection;
        item.section = section;
        item.checked = section === "Done";
        parsed.data.items[section].unshift(item);
        changes.push(`moved to ${section}`);
      }
    }

    writeTaskDoc(parsed.data);
    return cortexOk(`Updated item in ${project}: ${changes.join(", ") || "no changes"}`);
  });
}

export function pinTask(cortexPath: string, project: string, match: string): CortexResult<string> {
  const bPath = canonicalTaskFilePath(cortexPath, project);
  if (!bPath) return cortexErr(`Project name "${project}" is not valid.`, CortexError.INVALID_PROJECT_NAME);

  return withSafeLock(bPath, () => {
    const parsed = readTasks(cortexPath, project);
    if (!parsed.ok) return forwardErr(parsed);

    const found = findItemByMatch(parsed.data, match);
    if (found.error) return cortexErr(found.error, found.errorCode ?? CortexError.AMBIGUOUS_MATCH);
    if (!found.match) return taskItemNotFound(project, match);

    const section = found.match.section;
    const item = parsed.data.items[section][found.match.index];
    if (item.pinned) return cortexOk(`Already pinned in ${project}: ${item.line}`);
    item.pinned = true;
    item.line = stripPinnedTag(item.line);
    parsed.data.items[section].splice(found.match.index, 1);
    parsed.data.items[section].unshift(item);
    writeTaskDoc(parsed.data);
    return cortexOk(`Pinned in ${project}: ${item.line}`);
  });
}

export function unpinTask(cortexPath: string, project: string, match: string): CortexResult<string> {
  const bPath = canonicalTaskFilePath(cortexPath, project);
  if (!bPath) return cortexErr(`Project name "${project}" is not valid.`, CortexError.INVALID_PROJECT_NAME);

  return withSafeLock(bPath, () => {
    const parsed = readTasks(cortexPath, project);
    if (!parsed.ok) return forwardErr(parsed);

    const found = findItemByMatch(parsed.data, match);
    if (found.error) return cortexErr(found.error, found.errorCode ?? CortexError.AMBIGUOUS_MATCH);
    if (!found.match) return taskItemNotFound(project, match);

    const item = parsed.data.items[found.match.section][found.match.index];
    if (!item.pinned) return cortexOk(`Not pinned in ${project}: ${item.line}`);
    item.pinned = undefined;
    item.line = stripPinnedTag(item.line);
    writeTaskDoc(parsed.data);
    return cortexOk(`Unpinned in ${project}: ${item.line}`);
  });
}

export function reorderTask(cortexPath: string, project: string, match: string, targetRank: number): CortexResult<string> {
  const bPath = canonicalTaskFilePath(cortexPath, project);
  if (!bPath) return cortexErr(`Project name "${project}" is not valid.`, CortexError.INVALID_PROJECT_NAME);

  return withSafeLock(bPath, () => {
    const parsed = readTasks(cortexPath, project);
    if (!parsed.ok) return forwardErr(parsed);

    const found = findItemByMatch(parsed.data, match);
    if (found.error) return cortexErr(found.error, found.errorCode ?? CortexError.AMBIGUOUS_MATCH);
    if (!found.match) return taskItemNotFound(project, match);

    const section = found.match.section;
    const items = parsed.data.items[section];
    const item = items[found.match.index];
    const oldRank = item.rank ?? found.match.index + 1;
    const clampedTarget = Math.max(1, Math.min(targetRank, items.length));

    for (const other of items) {
      if (other === item || other.rank === undefined) continue;
      if (clampedTarget <= oldRank) {
        if (other.rank >= clampedTarget && other.rank < oldRank) other.rank++;
      } else {
        if (other.rank > oldRank && other.rank <= clampedTarget) other.rank--;
      }
    }
    item.rank = clampedTarget;

    // Re-sort by rank so file order reflects new priority order
    items.sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));

    writeTaskDoc(parsed.data);
    return cortexOk(`Reordered in ${project}: "${item.line}" moved to rank ${clampedTarget}`);
  });
}

export function appendChildFinding(cortexPath: string, project: string, match: string, findingId: string): CortexResult<string> {
  const bPath = canonicalTaskFilePath(cortexPath, project);
  if (!bPath) return cortexErr(`Project name "${project}" is not valid.`, CortexError.INVALID_PROJECT_NAME);

  return withSafeLock(bPath, () => {
    const parsed = readTasks(cortexPath, project);
    if (!parsed.ok) return forwardErr(parsed);

    const found = findItemByMatch(parsed.data, match);
    if (found.error) return cortexErr(found.error, found.errorCode ?? CortexError.AMBIGUOUS_MATCH);
    if (!found.match) return taskItemNotFound(project, match);

    const item = parsed.data.items[found.match.section][found.match.index];
    item.childFindings = [...(item.childFindings ?? []), findingId];
    item.lastActivity = new Date().toISOString();

    writeTaskDoc(parsed.data);
    return cortexOk(`Linked finding ${findingId} to task in ${project}: ${item.line}`);
  });
}

export function promoteTask(cortexPath: string, project: string, match: string, moveToActive: boolean): CortexResult<TaskItem> {
  const bPath = canonicalTaskFilePath(cortexPath, project);
  if (!bPath) return cortexErr(`Project name "${project}" is not valid.`, CortexError.INVALID_PROJECT_NAME);

  return withSafeLock(bPath, () => {
    const parsed = readTasks(cortexPath, project);
    if (!parsed.ok) return forwardErr(parsed);

    const found = findItemByMatch(parsed.data, match);
    if (found.error) return cortexErr(found.error, found.errorCode ?? CortexError.AMBIGUOUS_MATCH);
    if (!found.match) return taskItemNotFound(project, match);

    const item = parsed.data.items[found.match.section][found.match.index];
    item.speculative = undefined;

    if (moveToActive && item.section !== "Active") {
      parsed.data.items[found.match.section].splice(found.match.index, 1);
      item.section = "Active";
      item.checked = false;
      parsed.data.items.Active.unshift(item);
    }

    writeTaskDoc(parsed.data);
    return cortexOk(item);
  });
}

export function workNextTask(cortexPath: string, project: string): CortexResult<string> {
  const bPath = canonicalTaskFilePath(cortexPath, project);
  if (!bPath) return cortexErr(`Project name "${project}" is not valid.`, CortexError.INVALID_PROJECT_NAME);

  return withSafeLock(bPath, () => {
    const parsed = readTasks(cortexPath, project);
    if (!parsed.ok) return forwardErr(parsed);
    if (!parsed.data.items.Queue.length) {
      return cortexErr(`No queued tasks in "${project}". Add items with :add or the add_task tool.`, CortexError.NOT_FOUND);
    }

    const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
    parsed.data.items.Queue.sort((a, b) => {
      const pa = priorityOrder[a.priority ?? ""] ?? 3;
      const pb = priorityOrder[b.priority ?? ""] ?? 3;
      return pa - pb;
    });

    const item = parsed.data.items.Queue.shift()!;
    item.section = "Active";
    item.checked = false;
    parsed.data.items.Active.push(item);
    writeTaskDoc(parsed.data);
    return cortexOk(`Moved next queue item to Active in ${project}: ${item.line}`);
  });
}

export function tidyDoneTasks(cortexPath: string, project: string, keep: number = 30, dryRun?: boolean): CortexResult<string> {
  const bPath = canonicalTaskFilePath(cortexPath, project);
  if (!bPath) return cortexErr(`Project name "${project}" is not valid.`, CortexError.INVALID_PROJECT_NAME);

  return withSafeLock(bPath, () => {
    const parsed = readTasks(cortexPath, project);
    if (!parsed.ok) return forwardErr(parsed);

    const safeKeep = Number.isFinite(keep) ? Math.max(0, Math.floor(keep)) : 30;
    if (parsed.data.items.Done.length <= safeKeep) {
      return cortexOk(`No tidy needed for ${project}. Done=${parsed.data.items.Done.length}, keep=${safeKeep}.`);
    }

    const archived = parsed.data.items.Done.slice(safeKeep);
    if (dryRun) {
      return cortexOk(`[dry-run] Would archive ${archived.length} done item(s) for ${project}, keeping ${safeKeep}.`);
    }

    parsed.data.items.Done = parsed.data.items.Done.slice(0, safeKeep);

    const archiveFile = taskArchivePath(cortexPath, project);
    fs.mkdirSync(path.dirname(archiveFile), { recursive: true });
    const stamp = new Date().toISOString();
    const lines = archived.map((item) => `- [x] ${item.line}${item.context ? `\n  Context: ${item.context}` : ""}`);
    const block = `## ${stamp}\n\n${lines.join("\n")}\n\n`;
    const prior = fs.existsSync(archiveFile) ? fs.readFileSync(archiveFile, "utf8") : `# ${project} tasks archive\n\n`;
    fs.writeFileSync(archiveFile, prior + block);

    writeTaskDoc(parsed.data);
    return cortexOk(`Tidied ${project}: archived ${archived.length} done item(s), kept ${safeKeep}.`);
  });
}

export function taskMarkdown(doc: TaskDoc): string {
  return renderTask(doc);
}

export function linkTaskIssue(
  cortexPath: string,
  project: string,
  match: string,
  link: { github_issue?: number | string; github_url?: string; unlink?: boolean }
): CortexResult<TaskItem> {
  const bPath = canonicalTaskFilePath(cortexPath, project);
  if (!bPath) return cortexErr(`Project name "${project}" is not valid.`, CortexError.INVALID_PROJECT_NAME);

  return withSafeLock(bPath, () => {
    const parsed = readTasks(cortexPath, project);
    if (!parsed.ok) return forwardErr(parsed);

    const found = findItemByMatch(parsed.data, match);
    if (found.error) return cortexErr(found.error, found.errorCode ?? CortexError.AMBIGUOUS_MATCH);
    if (!found.match) return taskItemNotFound(project, match);

    const item = parsed.data.items[found.match.section][found.match.index];
    if (link.unlink) {
      item.githubIssue = undefined;
      item.githubUrl = undefined;
    } else {
      if (link.github_url && !isValidGitHubIssueUrl(link.github_url)) {
        return cortexErr("github_url must be a valid GitHub issue URL.", CortexError.VALIDATION_ERROR);
      }
      const githubIssueRaw = typeof link.github_issue === "string"
        ? link.github_issue.trim()
        : link.github_issue !== undefined
          ? String(link.github_issue)
          : "";
      const parsedLink = parseGitHubIssueReference([
        githubIssueRaw,
        link.github_url?.trim() || "",
      ].filter(Boolean).join(" "));
      if (!parsedLink.githubIssue && !parsedLink.githubUrl) {
        return cortexErr("GitHub link update requires a valid issue number and/or GitHub issue URL.", CortexError.VALIDATION_ERROR);
      }
      item.githubIssue = parsedLink.githubIssue;
      item.githubUrl = parsedLink.githubUrl;
    }

    writeTaskDoc(parsed.data);
    return cortexOk(item);
  });
}
