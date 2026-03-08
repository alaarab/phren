import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { randomBytes } from "crypto";
import {
  appendAuditLog,
  cortexErr,
  CortexError,
  type CortexErrorCode,
  cortexOk,
  type CortexResult,
  forwardErr,
  getProjectDirs,
} from "./shared.js";
import {
  checkPermission,
  getWorkflowPolicy,
  getRuntimeHealth,
  withFileLock as withFileLockRaw,
} from "./shared-governance.js";
import {
  addFindingToFile,
  validateBacklogFormat,
} from "./shared-content.js";
import { isValidProjectName, queueFilePath, safeProjectPath, errorMessage } from "./utils.js";

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
const QUEUE_HEADINGS = new Set(["queue", "queued", "backlog", "todo", "upcoming", "next"]);
const DONE_HEADINGS = new Set(["done", "completed", "finished", "archived"]);

export type BacklogSection = "Active" | "Queue" | "Done";

export interface BacklogItem {
  /** Positional ID for display (e.g. "A1", "Q3"). Recomputed on every read — use stableId for persistent references. */
  id: string;
  /** Content-addressed stable ID embedded in the file as `<!-- bid:HASH -->`. Survives reordering and completions. */
  stableId?: string;
  section: BacklogSection;
  line: string;
  checked: boolean;
  priority?: "high" | "medium" | "low";
  context?: string;
  pinned?: boolean;
}

export interface BacklogDoc {
  project: string;
  title: string;
  items: Record<BacklogSection, BacklogItem[]>;
  issues: string[];
  path: string;
}

export interface FindingItem {
  id: string;
  date: string;
  text: string;
  citation?: string;
  confidence?: number;
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

export interface ProfileInfo {
  name: string;
  file: string;
  projects: string[];
}

export interface ProjectCard {
  name: string;
  summary: string;
  docs: string[];
}

export interface ShellState {
  version: number;
  view: "Projects" | "Backlog" | "Findings" | "Review Queue" | "Skills" | "Hooks" | "Machines/Profiles" | "Health";
  project?: string;
  filter?: string;
  page?: number;
  perPage?: number;
}

const SHELL_STATE_VERSION = 1;
const BACKLOG_SECTIONS: BacklogSection[] = ["Active", "Queue", "Done"];

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

function parseContext(lines: string[], idx: number): { context?: string; linesToSkip: number } {
  const next = lines[idx + 1] || "";
  if (!next.trim().startsWith("Context:")) return { linesToSkip: 0 };
  return {
    context: next.trim().slice("Context:".length).trim(),
    linesToSkip: 1,
  };
}

function ensureProject(cortexPath: string, project: string): CortexResult<string> {
  if (!isValidProjectName(project)) return cortexErr(`Project name "${project}" is not valid. Use lowercase letters, numbers, and hyphens (e.g. "my-project").`, CortexError.INVALID_PROJECT_NAME);
  const dir = safeProjectPath(cortexPath, project);
  if (!dir) return cortexErr(`Project name "${project}" is not valid. Use lowercase letters, numbers, and hyphens (e.g. "my-project").`, CortexError.INVALID_PROJECT_NAME);
  if (!fs.existsSync(dir)) {
    return cortexErr(`No project "${project}" found. Create it with 'npx @alaarab/cortex init' then '/cortex-init ${project}'.`, CortexError.PROJECT_NOT_FOUND);
  }
  return cortexOk(dir);
}

/** Pattern that matches the stable-ID comment embedded in backlog item lines. */
const BID_PATTERN = /\s*<!--\s*bid:([a-z0-9]{8})\s*-->/;

/** Generate a new 8-character random stable ID. */
function newBid(): string {
  return randomBytes(4).toString("hex");
}

/** Strip the stable-ID comment from a raw line, returning the clean text and any extracted bid. */
function stripBid(text: string): { clean: string; bid?: string } {
  const m = text.match(BID_PATTERN);
  if (!m) return { clean: text };
  return { clean: text.replace(BID_PATTERN, "").trimEnd(), bid: m[1] };
}

function backlogFilePath(cortexPath: string, project: string): string | null {
  const resolved = safeProjectPath(cortexPath, project);
  if (!resolved) return null;
  return path.join(resolved, "backlog.md");
}

function normalizeBacklogItemLine(item: BacklogItem): string {
  let text = stripPinnedTag(item.line.replace(/\s*\[(high|medium|low)\]\s*$/gi, "")).trim();
  if (item.priority) text = `${text} [${item.priority}]`;
  if (item.pinned) text = `${text} [pinned]`;
  const prefix = item.checked || item.section === "Done" ? "- [x] " : "- [ ] ";
  // Embed a stable ID so LLMs can reference this item persistently across mutations.
  const bid = item.stableId ?? newBid();
  return `${prefix}${text} <!-- bid:${bid} -->`;
}

function parseBacklogContent(project: string, backlogPath: string, content: string): BacklogDoc {
  const lines = content.split("\n");
  const title = lines[0]?.trim() || `# ${project} backlog`;
  const items: Record<BacklogSection, BacklogItem[]> = {
    Active: [],
    Queue: [],
    Done: [],
  };

  let section: BacklogSection = "Queue";
  const sectionCounters: Record<BacklogSection, number> = { Active: 0, Queue: 0, Done: 0 };
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
    // Extract and strip the stable-ID comment before further parsing.
    const { clean: cleanBody, bid } = stripBid(parsed.body);
    const pinned = detectPinned(cleanBody);
    const priority = normalizePriority(cleanBody);
    const context = parseContext(lines, i);
    const sectionPrefix = section === "Active" ? "A" : section === "Queue" ? "Q" : "D";
    sectionCounters[section]++;
    items[section].push({
      id: `${sectionPrefix}${sectionCounters[section]}`,
      stableId: bid,
      section,
      line: cleanBody,
      checked: parsed.checked || section === "Done",
      priority,
      context: context.context,
      pinned: pinned || undefined,
    });
    i += context.linesToSkip;
  }

  return {
    project,
    title,
    path: backlogPath,
    items,
    issues: validateBacklogFormat(content),
  };
}

function renderBacklog(doc: BacklogDoc): string {
  const out: string[] = [doc.title, ""];
  for (const section of BACKLOG_SECTIONS) {
    out.push(`## ${section}`, "");
    for (const item of doc.items[section]) {
      out.push(normalizeBacklogItemLine(item));
      if (item.context) out.push(`  Context: ${item.context}`);
    }
    out.push("");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function findItemByMatch(
  doc: BacklogDoc,
  match: string
): { match?: { section: BacklogSection; index: number }; error?: string; errorCode?: CortexErrorCode } {
  const needle = match.trim().toLowerCase();
  if (!needle) return { error: `${CortexError.EMPTY_INPUT}: Please provide the item text or ID to match against.`, errorCode: CortexError.EMPTY_INPUT };

  // 1a) Stable ID match (bid:XXXX or just the 8-char hex).
  const bidNeedle = needle.replace(/^bid:/, "");
  if (/^[a-f0-9]{8}$/.test(bidNeedle)) {
    for (const section of BACKLOG_SECTIONS) {
      const idx = doc.items[section].findIndex((item) => item.stableId === bidNeedle);
      if (idx !== -1) return { match: { section, index: idx } };
    }
  }

  // 1b) Positional ID match (A1, Q2, D3).
  for (const section of BACKLOG_SECTIONS) {
    const idx = doc.items[section].findIndex((item) => item.id.toLowerCase() === needle);
    if (idx !== -1) return { match: { section, index: idx } };
  }

  // 2) Exact line match.
  const exact: Array<{ section: BacklogSection; index: number }> = [];
  for (const section of BACKLOG_SECTIONS) {
    doc.items[section].forEach((item, index) => {
      if (item.line.trim().toLowerCase() === needle) exact.push({ section, index });
    });
  }
  if (exact.length === 1) return { match: exact[0] };
  if (exact.length > 1) {
    return { error: `${CortexError.AMBIGUOUS_MATCH}: "${match}" is ambiguous (${exact.length} exact matches). Use item ID.`, errorCode: CortexError.AMBIGUOUS_MATCH };
  }

  // 3) Substring fallback, but only when unique.
  const partial: Array<{ section: BacklogSection; index: number }> = [];
  for (const section of BACKLOG_SECTIONS) {
    doc.items[section].forEach((item, index) => {
      if (item.line.toLowerCase().includes(needle)) partial.push({ section, index });
    });
  }
  if (partial.length === 1) return { match: partial[0] };
  if (partial.length > 1) {
    return { error: `${CortexError.AMBIGUOUS_MATCH}: "${match}" is ambiguous (${partial.length} partial matches). Use item ID.`, errorCode: CortexError.AMBIGUOUS_MATCH };
  }
  return { error: `${CortexError.NOT_FOUND}: Item not found — no backlog item matching "${match}".`, errorCode: CortexError.NOT_FOUND };
}

function backlogItemNotFound(project: string, match: string): CortexResult<never> {
  return cortexErr(
    `Item not found: no backlog item matching "${match}" in project "${project}". Check the item text or use its ID (shown in the backlog view).`,
    CortexError.NOT_FOUND
  );
}

function writeBacklogDoc(doc: BacklogDoc): void {
  fs.writeFileSync(doc.path, renderBacklog(doc));
}

function backlogArchivePath(cortexPath: string, project: string): string {
  return path.join(cortexPath, ".governance", "backlog-archive", `${project}.md`);
}

export function readBacklog(cortexPath: string, project: string): CortexResult<BacklogDoc> {
  const ensured = ensureProject(cortexPath, project);
  if (!ensured.ok) return forwardErr(ensured);

  const backlogPath = backlogFilePath(cortexPath, project);
  if (!backlogPath) return cortexErr(`Project name "${project}" is not valid. Use lowercase letters, numbers, and hyphens (e.g. "my-project").`, CortexError.INVALID_PROJECT_NAME);

  if (!fs.existsSync(backlogPath)) {
    return cortexOk({
      project,
      title: `# ${project} backlog`,
      path: backlogPath,
      issues: [],
      items: { Active: [], Queue: [], Done: [] },
    });
  }

  const content = fs.readFileSync(backlogPath, "utf8");
  return cortexOk(parseBacklogContent(project, backlogPath, content));
}

export function readBacklogs(cortexPath: string, profile?: string): BacklogDoc[] {
  const projects = getProjectDirs(cortexPath, profile).map((dir) => path.basename(dir)).sort();
  const result: BacklogDoc[] = [];
  for (const project of projects) {
    const file = backlogFilePath(cortexPath, project);
    if (!file || !fs.existsSync(file)) continue;
    const parsed = readBacklog(cortexPath, project);
    if (!parsed.ok) continue;
    result.push(parsed.data);
  }
  return result;
}

export function addBacklogItem(cortexPath: string, project: string, item: string): CortexResult<string> {
  const bPath = backlogFilePath(cortexPath, project);
  if (!bPath) return cortexErr(`Project name "${project}" is not valid. Use lowercase letters, numbers, and hyphens (e.g. "my-project").`, CortexError.INVALID_PROJECT_NAME);
  // Validate project exists before acquiring the lock — withFileLock creates the parent
  // directory via mkdirSync, which would silently create an unintended project directory.
  const preCheck = ensureProject(cortexPath, project);
  if (!preCheck.ok) return forwardErr(preCheck);

  return withSafeLock(bPath, () => {
    const parsed = readBacklog(cortexPath, project);
    if (!parsed.ok) return forwardErr(parsed);

    const line = item.replace(/^-\s*/, "").trim();
    parsed.data.items.Queue.push({
      id: `Q${parsed.data.items.Queue.length + 1}`,
      section: "Queue",
      line,
      checked: false,
      priority: normalizePriority(line),
    });
    writeBacklogDoc(parsed.data);
    return cortexOk(`Added to ${project} backlog: ${line}`);
  });
}

export function addBacklogItems(cortexPath: string, project: string, items: string[]): CortexResult<{ added: string[]; errors: string[] }> {
  const bPath = backlogFilePath(cortexPath, project);
  if (!bPath) return cortexErr(`Project name "${project}" is not valid.`, CortexError.INVALID_PROJECT_NAME);
  const preCheck = ensureProject(cortexPath, project);
  if (!preCheck.ok) return forwardErr(preCheck);

  return withSafeLock(bPath, () => {
    const parsed = readBacklog(cortexPath, project);
    if (!parsed.ok) return forwardErr(parsed);

    const added: string[] = [];
    const errors: string[] = [];
    for (const item of items) {
      const line = item.replace(/^-\s*/, "").trim();
      if (!line) { errors.push(item); continue; }
      parsed.data.items.Queue.push({
        id: `Q${parsed.data.items.Queue.length + 1}`,
        section: "Queue",
        line,
        checked: false,
        priority: normalizePriority(line),
      });
      added.push(line);
    }
    writeBacklogDoc(parsed.data);
    return cortexOk({ added, errors });
  });
}

export function completeBacklogItems(cortexPath: string, project: string, matches: string[]): CortexResult<{ completed: string[]; errors: string[] }> {
  const bPath = backlogFilePath(cortexPath, project);
  if (!bPath) return cortexErr(`Project name "${project}" is not valid.`, CortexError.INVALID_PROJECT_NAME);

  return withSafeLock(bPath, () => {
    const parsed = readBacklog(cortexPath, project);
    if (!parsed.ok) return forwardErr(parsed);

    const completed: string[] = [];
    const errors: string[] = [];
    for (const match of matches) {
      const found = findItemByMatch(parsed.data, match);
      if (found.error || !found.match) { errors.push(match); continue; }
      const [item] = parsed.data.items[found.match.section].splice(found.match.index, 1);
      item.section = "Done";
      item.checked = true;
      parsed.data.items.Done.unshift(item);
      completed.push(item.line);
    }
    writeBacklogDoc(parsed.data);
    return cortexOk({ completed, errors });
  });
}

export function completeBacklogItem(cortexPath: string, project: string, match: string): CortexResult<string> {
  const bPath = backlogFilePath(cortexPath, project);
  if (!bPath) return cortexErr(`Project name "${project}" is not valid. Use lowercase letters, numbers, and hyphens (e.g. "my-project").`, CortexError.INVALID_PROJECT_NAME);

  return withSafeLock(bPath, () => {
    const parsed = readBacklog(cortexPath, project);
    if (!parsed.ok) return forwardErr(parsed);

    const found = findItemByMatch(parsed.data, match);
    if (found.error) return cortexErr(found.error, found.errorCode ?? CortexError.AMBIGUOUS_MATCH);
    if (!found.match) return backlogItemNotFound(project, match);

    const [item] = parsed.data.items[found.match.section].splice(found.match.index, 1);
    item.section = "Done";
    item.checked = true;
    parsed.data.items.Done.unshift(item);
    writeBacklogDoc(parsed.data);
    return cortexOk(`Marked done in ${project}: ${item.line}`);
  });
}

export function updateBacklogItem(
  cortexPath: string,
  project: string,
  match: string,
  updates: { priority?: string; context?: string; section?: string }
): CortexResult<string> {
  const bPath = backlogFilePath(cortexPath, project);
  if (!bPath) return cortexErr(`Project name "${project}" is not valid. Use lowercase letters, numbers, and hyphens (e.g. "my-project").`, CortexError.INVALID_PROJECT_NAME);

  return withSafeLock(bPath, () => {
    const parsed = readBacklog(cortexPath, project);
    if (!parsed.ok) return forwardErr(parsed);

    const found = findItemByMatch(parsed.data, match);
    if (found.error) return cortexErr(found.error, found.errorCode ?? CortexError.AMBIGUOUS_MATCH);
    if (!found.match) return backlogItemNotFound(project, match);

    const item = parsed.data.items[found.match.section][found.match.index];
    const changes: string[] = [];

    if (updates.priority) {
      const p = updates.priority.toLowerCase();
      if (["high", "medium", "low"].includes(p)) {
        item.priority = p as "high" | "medium" | "low";
        item.line = item.line.replace(/\s*\[(high|medium|low)\]\s*$/gi, "").trim();
        item.line = `${item.line} [${item.priority}]`;
        changes.push(`priority -> ${p}`);
      }
    }

    if (updates.context) {
      if (item.context) item.context = `${item.context}; ${updates.context}`;
      else item.context = updates.context;
      changes.push("context updated");
    }

    if (updates.section) {
      const target = updates.section[0].toUpperCase() + updates.section.slice(1).toLowerCase();
      if (["Active", "Queue", "Done"].includes(target)) {
        parsed.data.items[found.match.section].splice(found.match.index, 1);
        const section = target as BacklogSection;
        item.section = section;
        item.checked = section === "Done";
        parsed.data.items[section].unshift(item);
        changes.push(`moved to ${section}`);
      }
    }

    writeBacklogDoc(parsed.data);
    return cortexOk(`Updated item in ${project}: ${changes.join(", ") || "no changes"}`);
  });
}

export function pinBacklogItem(cortexPath: string, project: string, match: string): CortexResult<string> {
  const bPath = backlogFilePath(cortexPath, project);
  if (!bPath) return cortexErr(`Project name "${project}" is not valid. Use lowercase letters, numbers, and hyphens (e.g. "my-project").`, CortexError.INVALID_PROJECT_NAME);

  return withSafeLock(bPath, () => {
    const parsed = readBacklog(cortexPath, project);
    if (!parsed.ok) return forwardErr(parsed);

    const found = findItemByMatch(parsed.data, match);
    if (found.error) return cortexErr(found.error, found.errorCode ?? CortexError.AMBIGUOUS_MATCH);
    if (!found.match) return backlogItemNotFound(project, match);

    const section = found.match.section;
    const item = parsed.data.items[section][found.match.index];
    if (item.pinned) return cortexOk(`Already pinned in ${project}: ${item.line}`);
    item.pinned = true;
    item.line = stripPinnedTag(item.line);
    // Move pinned item to the top of its section
    parsed.data.items[section].splice(found.match.index, 1);
    parsed.data.items[section].unshift(item);
    writeBacklogDoc(parsed.data);
    return cortexOk(`Pinned in ${project}: ${item.line}`);
  });
}

export function unpinBacklogItem(cortexPath: string, project: string, match: string): CortexResult<string> {
  const bPath = backlogFilePath(cortexPath, project);
  if (!bPath) return cortexErr(`Project name "${project}" is not valid. Use lowercase letters, numbers, and hyphens (e.g. "my-project").`, CortexError.INVALID_PROJECT_NAME);

  return withSafeLock(bPath, () => {
    const parsed = readBacklog(cortexPath, project);
    if (!parsed.ok) return forwardErr(parsed);

    const found = findItemByMatch(parsed.data, match);
    if (found.error) return cortexErr(found.error, found.errorCode ?? CortexError.AMBIGUOUS_MATCH);
    if (!found.match) return backlogItemNotFound(project, match);

    const item = parsed.data.items[found.match.section][found.match.index];
    if (!item.pinned) return cortexOk(`Not pinned in ${project}: ${item.line}`);
    item.pinned = undefined;
    item.line = stripPinnedTag(item.line);
    writeBacklogDoc(parsed.data);
    return cortexOk(`Unpinned in ${project}: ${item.line}`);
  });
}

export function workNextBacklogItem(cortexPath: string, project: string): CortexResult<string> {
  const bPath = backlogFilePath(cortexPath, project);
  if (!bPath) return cortexErr(`Project name "${project}" is not valid. Use lowercase letters, numbers, and hyphens (e.g. "my-project").`, CortexError.INVALID_PROJECT_NAME);

  return withSafeLock(bPath, () => {
    const parsed = readBacklog(cortexPath, project);
    if (!parsed.ok) return forwardErr(parsed);
    if (!parsed.data.items.Queue.length) return cortexErr(`No queued items in "${project}". Add items with :add or the add_backlog_item tool.`, CortexError.NOT_FOUND);

    // Sort by priority so we take the highest-priority item, not just the first
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
    writeBacklogDoc(parsed.data);
    return cortexOk(`Moved next queue item to Active in ${project}: ${item.line}`);
  });
}

export function tidyBacklogDone(cortexPath: string, project: string, keep: number = 30, dryRun?: boolean): CortexResult<string> {
  const bPath = backlogFilePath(cortexPath, project);
  if (!bPath) return cortexErr(`Project name "${project}" is not valid. Use lowercase letters, numbers, and hyphens (e.g. "my-project").`, CortexError.INVALID_PROJECT_NAME);

  return withSafeLock(bPath, () => {
    const parsed = readBacklog(cortexPath, project);
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

    const archiveFile = backlogArchivePath(cortexPath, project);
    fs.mkdirSync(path.dirname(archiveFile), { recursive: true });
    const stamp = new Date().toISOString();
    const lines = archived.map((item) => `- [x] ${item.line}${item.context ? `\n  Context: ${item.context}` : ""}`);
    const block = `## ${stamp}\n\n${lines.join("\n")}\n\n`;
    const prior = fs.existsSync(archiveFile) ? fs.readFileSync(archiveFile, "utf8") : `# ${project} backlog archive\n\n`;
    fs.writeFileSync(archiveFile, prior + block);

    writeBacklogDoc(parsed.data);
    return cortexOk(`Tidied ${project}: archived ${archived.length} done item(s), kept ${safeKeep}.`);
  });
}

export function backlogMarkdown(doc: BacklogDoc): string {
  return renderBacklog(doc);
}

export function readFindings(cortexPath: string, project: string): CortexResult<FindingItem[]> {
  const ensured = ensureProject(cortexPath, project);
  if (!ensured.ok) return forwardErr(ensured);

  const findingsPath = path.join(ensured.data, 'FINDINGS.md');
  const legacyPath = path.join(ensured.data, 'LEARNINGS.md');
  const file = fs.existsSync(findingsPath) ? findingsPath : fs.existsSync(legacyPath) ? legacyPath : findingsPath;
  if (!fs.existsSync(file)) return cortexOk([]);

  const lines = fs.readFileSync(file, "utf8").split("\n");
  const items: FindingItem[] = [];
  let date = "unknown";
  let index = 1;
  let inArchiveBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip archived content wrapped in <!-- cortex:archive:start/end --> or <details> blocks
    if (/<!--\s*cortex:archive:start\s*-->/.test(line) || /^<details>/i.test(line.trim())) {
      inArchiveBlock = true;
      continue;
    }
    if (inArchiveBlock) {
      if (/<!--\s*cortex:archive:end\s*-->/.test(line) || /^<\/details>/i.test(line.trim())) {
        inArchiveBlock = false;
      }
      continue;
    }
    if (line.startsWith("## ")) {
      date = line.slice(3).trim();
      continue;
    }
    if (!line.startsWith("- ")) continue;

    const next = lines[i + 1] || "";
    const citation = /^\s*<!--\s*cortex:cite\s+\{.*\}\s*-->\s*$/.test(next.trim()) ? next.trim() : undefined;
    const rawText = line.replace(/^-\s+/, "").trim();
    const confMatch = rawText.match(/\s*\[confidence\s+([01](?:\.\d+)?)\]\s*$/i);
    const confidence = confMatch ? parseFloat(confMatch[1]) : undefined;
    const text = confMatch ? rawText.slice(0, rawText.length - confMatch[0].length).trim() : rawText;
    items.push({
      id: `L${index}`,
      date,
      text,
      confidence,
      citation,
    });
    if (citation) i += 1;
    index++;
  }

  return cortexOk(items);
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
  const legacyPath = path.join(ensured.data, 'LEARNINGS.md');
  const filePath = fs.existsSync(findingsPath) ? findingsPath : fs.existsSync(legacyPath) ? legacyPath : findingsPath;
  if (!fs.existsSync(filePath)) return cortexErr(`No FINDINGS.md file found for "${project}". Add a finding first with add_finding or :find add.`, CortexError.FILE_NOT_FOUND);

  return withSafeLock(filePath, () => {
    const lines = fs.readFileSync(filePath, "utf8").split("\n");
    const needle = match.trim().toLowerCase();
    const bulletLines = lines.map((line, i) => ({ line, i })).filter(({ line }) => line.startsWith("- "));

    // 1) Exact text match (strip bullet prefix + metadata for comparison)
    const exactMatches = bulletLines.filter(({ line }) =>
      line.replace(/^-\s+/, "").replace(/<!--.*?-->/g, "").trim().toLowerCase() === needle
    );
    // 2) Unique partial substring match
    const partialMatches = bulletLines.filter(({ line }) => line.toLowerCase().includes(needle));

    let idx: number;
    if (exactMatches.length === 1) {
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

// Use shared queueFilePath from utils.ts; alias for local brevity.
const queuePath = queueFilePath;

function parseQueueLine(line: string): { date?: string; text: string; confidence?: number; machine?: string; model?: string } {
  const parsed = line.match(/^- \[(\d{4}-\d{2}-\d{2})\]\s*(.+)$/);
  const rawText = parsed ? parsed[2] : line.replace(/^-\s+/, "").trim();
  const confidence = rawText.match(/\[confidence\s+([01](?:\.\d+)?)\]/i);
  // Parse combined source annotation: <!-- source: machine:hostname model:model-name -->
  const sourceMatch = line.match(/<!--\s*source:\s*(.*?)\s*-->/);
  let machine: string | undefined;
  let model: string | undefined;
  if (sourceMatch) {
    const machineField = sourceMatch[1].match(/machine:(\S+)/);
    const modelField = sourceMatch[1].match(/model:(\S+)/);
    machine = machineField?.[1];
    model = modelField?.[1];
  } else {
    // Backward compat: legacy <!-- machine: hostname --> format
    const legacyMachine = line.match(/<!--\s*machine:\s*([^>]+?)\s*-->/);
    machine = legacyMachine?.[1]?.trim();
  }
  // Strip the confidence marker from the canonical text so it doesn't pollute FINDINGS.md
  const text = rawText.replace(/\s*\[confidence\s+[01](?:\.\d+)?\]/gi, "").trim();
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
  fs.writeFileSync(queuePath(cortexPath, project), out.join("\n").replace(/\n{3,}/g, "\n\n"));
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

  const trimmed = newText.trim();
  if (!trimmed) return cortexErr(`New memory text cannot be empty.`, CortexError.EMPTY_INPUT);

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

export function listMachines(cortexPath: string): CortexResult<Record<string, string>> {
  const machinesPath = path.join(cortexPath, "machines.yaml");
  if (!fs.existsSync(machinesPath)) return cortexErr(`machines.yaml not found. Run 'npx @alaarab/cortex init' to set up your cortex.`, CortexError.FILE_NOT_FOUND);
  try {
    const raw = fs.readFileSync(machinesPath, "utf8");
    const parsed = yaml.load(raw, { schema: yaml.CORE_SCHEMA });
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return cortexErr(`machines.yaml is empty or not valid YAML. Check the file format or run 'cortex doctor --fix'.`, CortexError.MALFORMED_YAML);

    const cleaned: Record<string, string> = {};
    for (const [machine, profile] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof machine !== "string" || !machine.trim()) continue;
      if (typeof profile !== "string" || !profile.trim()) continue;
      cleaned[machine] = profile;
    }
    return cortexOk(cleaned);
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] listMachines yaml parse: ${errorMessage(err)}\n`);
    return cortexErr(`Could not parse machines.yaml. Check the file for syntax errors or run 'cortex doctor --fix'.`, CortexError.MALFORMED_YAML);
  }
}

function writeMachines(cortexPath: string, data: Record<string, string>): void {
  const machinesPath = path.join(cortexPath, "machines.yaml");
  const backupPath = `${machinesPath}.bak`;
  if (fs.existsSync(machinesPath)) fs.copyFileSync(machinesPath, backupPath);
  const ordered = Object.fromEntries(Object.entries(data).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(machinesPath, yaml.dump(ordered, { lineWidth: 1000 }));
}

export function setMachineProfile(cortexPath: string, machine: string, profile: string): CortexResult<string> {
  if (!machine || !profile) return cortexErr(`Both machine name and profile name are required. Example: :machine map my-laptop personal`, CortexError.EMPTY_INPUT);

  const profiles = listProfiles(cortexPath);
  if (profiles.ok) {
    const exists = profiles.data.some((p) => p.name === profile);
    if (!exists) return cortexErr(`Profile "${profile}" does not exist. Check available profiles in the profiles/ directory.`, CortexError.NOT_FOUND);
  }

  const machinesPath = path.join(cortexPath, "machines.yaml");
  return withSafeLock(machinesPath, () => {
    const current = listMachines(cortexPath);
    const data = current.ok ? current.data : {};
    data[machine] = profile;
    writeMachines(cortexPath, data);
    return cortexOk(`Mapped machine ${machine} -> ${profile}.`);
  });
}

export function listProfiles(cortexPath: string): CortexResult<ProfileInfo[]> {
  const profilesDir = path.join(cortexPath, "profiles");
  if (!fs.existsSync(profilesDir)) return cortexErr(`No profiles/ directory found. Run 'npx @alaarab/cortex init' to set up your cortex.`, CortexError.FILE_NOT_FOUND);
  const files = fs.readdirSync(profilesDir).filter((file) => file.endsWith(".yaml")).sort();
  const profiles: ProfileInfo[] = [];

  for (const file of files) {
    const full = path.join(profilesDir, file);
    try {
      const raw = fs.readFileSync(full, "utf8");
      const parsed = yaml.load(raw, { schema: yaml.CORE_SCHEMA });
      const data = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
      const name = (typeof data?.name === "string" && data.name.trim())
        ? data.name
        : file.replace(/\.yaml$/, "");
      const projects = Array.isArray(data?.projects)
        ? (data.projects as unknown[]).map((project) => String(project)).filter(Boolean)
        : [];
      profiles.push({ name, file: full, projects });
    } catch (err: unknown) {
      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] listProfiles yamlParse: ${errorMessage(err)}\n`);
      return cortexErr(`profiles/${file}`, CortexError.MALFORMED_YAML);
    }
  }

  return cortexOk(profiles);
}

function writeProfile(file: string, name: string, projects: string[]): void {
  const backup = `${file}.bak`;
  if (fs.existsSync(file)) fs.copyFileSync(file, backup);
  const normalized = [...new Set(projects)].sort();
  const out = yaml.dump({ name, projects: normalized }, { lineWidth: 1000 });
  fs.writeFileSync(file, out);
}

export function addProjectToProfile(cortexPath: string, profile: string, project: string): CortexResult<string> {
  if (!isValidProjectName(project)) return cortexErr(`Project name "${project}" is not valid. Use lowercase letters, numbers, and hyphens (e.g. "my-project").`, CortexError.INVALID_PROJECT_NAME);
  const profiles = listProfiles(cortexPath);
  if (!profiles.ok) return forwardErr(profiles);
  const current = profiles.data.find((p) => p.name === profile);
  if (!current) return cortexErr(`Profile "${profile}" not found.`, CortexError.NOT_FOUND);

  return withSafeLock(current.file, () => {
    const refreshed = listProfiles(cortexPath);
    if (!refreshed.ok) return forwardErr(refreshed);
    const latest = refreshed.data.find((p) => p.name === profile);
    if (!latest) return cortexErr(`Profile "${profile}" not found.`, CortexError.NOT_FOUND);

    const projects = latest.projects.includes(project) ? latest.projects : [...latest.projects, project];
    writeProfile(latest.file, latest.name, projects);
    return cortexOk(`Added ${project} to profile ${profile}.`);
  });
}

export function removeProjectFromProfile(cortexPath: string, profile: string, project: string): CortexResult<string> {
  const profiles = listProfiles(cortexPath);
  if (!profiles.ok) return forwardErr(profiles);
  const current = profiles.data.find((p) => p.name === profile);
  if (!current) return cortexErr(`Profile "${profile}" not found.`, CortexError.NOT_FOUND);

  return withSafeLock(current.file, () => {
    const refreshed = listProfiles(cortexPath);
    if (!refreshed.ok) return forwardErr(refreshed);
    const latest = refreshed.data.find((p) => p.name === profile);
    if (!latest) return cortexErr(`Profile "${profile}" not found.`, CortexError.NOT_FOUND);

    const projects = latest.projects.filter((p) => p !== project);
    writeProfile(latest.file, latest.name, projects);
    return cortexOk(`Removed ${project} from profile ${profile}.`);
  });
}

function buildProjectCard(dir: string): ProjectCard {
  const name = path.basename(dir);
  const summaryFile = path.join(dir, "summary.md");
  const claudeFile = path.join(dir, "CLAUDE.md");
  const summarySource = fs.existsSync(summaryFile)
    ? fs.readFileSync(summaryFile, "utf8")
    : fs.existsSync(claudeFile)
      ? fs.readFileSync(claudeFile, "utf8")
      : "";
  const summary = summarySource
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#")) || "";
  const docs = ["CLAUDE.md", "FINDINGS.md", "LEARNINGS.md", "summary.md", "backlog.md", "MEMORY_QUEUE.md"]
    .filter((file) => fs.existsSync(path.join(dir, file)));
  return { name, summary, docs };
}

export function listProjectCards(cortexPath: string, profile?: string): ProjectCard[] {
  const dirs = getProjectDirs(cortexPath, profile).sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  const cards: ProjectCard[] = dirs.map(buildProjectCard);

  // Prepend global as a pinned entry so it's always accessible from the shell
  const globalDir = path.join(cortexPath, "global");
  if (fs.existsSync(globalDir)) {
    cards.unshift(buildProjectCard(globalDir));
  }

  return cards;
}

function shellStatePath(cortexPath: string): string {
  return path.join(cortexPath, ".governance", "shell-state.json");
}

export function loadShellState(cortexPath: string): ShellState {
  const file = shellStatePath(cortexPath);
  const fallback: ShellState = {
    version: SHELL_STATE_VERSION,
    view: "Projects",
    page: 1,
    perPage: 40,
  };

  if (!fs.existsSync(file)) return fallback;

  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ShellState> & { lastView?: ShellState["view"] };

    const migratedView = raw.view || raw.lastView || fallback.view;
    return {
      version: SHELL_STATE_VERSION,
      view: migratedView,
      project: raw.project,
      filter: raw.filter,
      page: Number.isFinite(raw.page) ? Number(raw.page) : fallback.page,
      perPage: Number.isFinite(raw.perPage) ? Number(raw.perPage) : fallback.perPage,
    };
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] loadShellState parse: ${errorMessage(err)}\n`);
    return fallback;
  }
}

export function saveShellState(cortexPath: string, state: ShellState): void {
  const file = shellStatePath(cortexPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  withSafeLock(file, () => {
    const out: ShellState = {
      version: SHELL_STATE_VERSION,
      view: state.view,
      project: state.project,
      filter: state.filter,
      page: state.page,
      perPage: state.perPage,
    };
    fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
    return cortexOk(undefined);
  });
}

export function resetShellState(cortexPath: string): CortexResult<string> {
  const file = shellStatePath(cortexPath);
  return withSafeLock(file, () => {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return cortexOk("Shell state reset.");
  });
}

export function readRuntimeHealth(cortexPath: string) {
  return getRuntimeHealth(cortexPath);
}
