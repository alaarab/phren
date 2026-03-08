import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
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
  getRuntimeHealth,
  withFileLock as withFileLockRaw,
} from "./shared-governance.js";
import {
  addFindingToFile,
  validateBacklogFormat,
} from "./shared-content.js";
import { isValidProjectName, queueFilePath, safeProjectPath } from "./utils.js";

function withFileLock<T>(filePath: string, fn: () => CortexResult<T>): CortexResult<T> {
  try {
    return withFileLockRaw(filePath, fn);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("could not acquire lock")) {
      return cortexErr(`Could not acquire write lock for "${path.basename(filePath)}". Another write may be in progress; please retry.`, CortexError.LOCK_TIMEOUT);
    }
    throw err;
  }
}

export type BacklogSection = "Active" | "Queue" | "Done";

export interface BacklogItem {
  id: string;
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
}

export interface QueueItem {
  id: string;
  section: "Review" | "Stale" | "Conflicts";
  date: string;
  text: string;
  line: string;
  confidence?: number;
  risky: boolean;
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

function parseContext(lines: string[], idx: number): { context?: string; consume: number } {
  const next = lines[idx + 1] || "";
  if (!next.trim().startsWith("Context:")) return { consume: 0 };
  return {
    context: next.trim().slice("Context:".length).trim(),
    consume: 1,
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
  return `${prefix}${text}`;
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
    const heading = line.trim().match(/^##\s+(.+)$/);
    if (heading) {
      const token = heading[1].trim().toLowerCase();
      if (["active", "in progress", "in-progress", "current", "wip"].includes(token)) {
        section = "Active";
      } else if (["queue", "queued", "backlog", "todo", "upcoming", "next"].includes(token)) {
        section = "Queue";
      } else if (["done", "completed", "finished", "archived"].includes(token)) {
        section = "Done";
      }
      continue;
    }
    if (!line.startsWith("- ")) continue;

    const parsed = stripBulletPrefix(line);
    const pinned = detectPinned(parsed.body);
    const priority = normalizePriority(parsed.body);
    const context = parseContext(lines, i);
    const sectionPrefix = section === "Active" ? "A" : section === "Queue" ? "Q" : "D";
    sectionCounters[section]++;
    items[section].push({
      id: `${sectionPrefix}${sectionCounters[section]}`,
      section,
      line: parsed.body,
      checked: parsed.checked || section === "Done",
      priority,
      context: context.context,
      pinned: pinned || undefined,
    });
    i += context.consume;
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
): { match?: { section: BacklogSection; index: number }; error?: string } {
  const needle = match.trim().toLowerCase();
  if (!needle) return { error: `${CortexError.EMPTY_INPUT}: Please provide the item text or ID to match against.` };

  // 1) Exact ID match wins immediately.
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
    return { error: `${CortexError.AMBIGUOUS_MATCH}: "${match}" is ambiguous (${exact.length} exact matches). Use item ID.` };
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
    return { error: `${CortexError.AMBIGUOUS_MATCH}: "${match}" is ambiguous (${partial.length} partial matches). Use item ID.` };
  }
  return {};
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

  return withFileLock(bPath, () => {
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

  return withFileLock(bPath, () => {
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

  return withFileLock(bPath, () => {
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

  return withFileLock(bPath, () => {
    const parsed = readBacklog(cortexPath, project);
    if (!parsed.ok) return forwardErr(parsed);

    const found = findItemByMatch(parsed.data, match);
    if (found.error) return cortexErr(found.error, CortexError.AMBIGUOUS_MATCH);
    if (!found.match) return cortexErr(`No backlog item matching "${match}" in project "${project}". Check the item text or use its ID (shown in the backlog view).`, CortexError.NOT_FOUND);

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

  return withFileLock(bPath, () => {
    const parsed = readBacklog(cortexPath, project);
    if (!parsed.ok) return forwardErr(parsed);

    const found = findItemByMatch(parsed.data, match);
    if (found.error) return cortexErr(found.error, CortexError.AMBIGUOUS_MATCH);
    if (!found.match) return cortexErr(`No backlog item matching "${match}" in project "${project}". Check the item text or use its ID (shown in the backlog view).`, CortexError.NOT_FOUND);

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

  return withFileLock(bPath, () => {
    const parsed = readBacklog(cortexPath, project);
    if (!parsed.ok) return forwardErr(parsed);

    const found = findItemByMatch(parsed.data, match);
    if (found.error) return cortexErr(found.error, CortexError.AMBIGUOUS_MATCH);
    if (!found.match) return cortexErr(`No backlog item matching "${match}" in project "${project}". Check the item text or use its ID (shown in the backlog view).`, CortexError.NOT_FOUND);

    const item = parsed.data.items[found.match.section][found.match.index];
    if (item.pinned) return cortexOk(`Already pinned in ${project}: ${item.line}`);
    item.pinned = true;
    item.line = stripPinnedTag(item.line);
    writeBacklogDoc(parsed.data);
    return cortexOk(`Pinned in ${project}: ${item.line}`);
  });
}

export function unpinBacklogItem(cortexPath: string, project: string, match: string): CortexResult<string> {
  const bPath = backlogFilePath(cortexPath, project);
  if (!bPath) return cortexErr(`Project name "${project}" is not valid. Use lowercase letters, numbers, and hyphens (e.g. "my-project").`, CortexError.INVALID_PROJECT_NAME);

  return withFileLock(bPath, () => {
    const parsed = readBacklog(cortexPath, project);
    if (!parsed.ok) return forwardErr(parsed);

    const found = findItemByMatch(parsed.data, match);
    if (found.error) return cortexErr(found.error, CortexError.AMBIGUOUS_MATCH);
    if (!found.match) return cortexErr(`No backlog item matching "${match}" in project "${project}". Check the item text or use its ID (shown in the backlog view).`, CortexError.NOT_FOUND);

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

  return withFileLock(bPath, () => {
    const parsed = readBacklog(cortexPath, project);
    if (!parsed.ok) return forwardErr(parsed);
    if (!parsed.data.items.Queue.length) return cortexErr(`No queued items in "${project}". Add items with :add or the add_backlog_item tool.`, CortexError.NOT_FOUND);

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

  return withFileLock(bPath, () => {
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

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("## ")) {
      date = line.slice(3).trim();
      continue;
    }
    if (!line.startsWith("- ")) continue;

    const next = lines[i + 1] || "";
    const citation = /^\s*<!--\s*cortex:cite\s+\{.*\}\s*-->\s*$/.test(next.trim()) ? next.trim() : undefined;
    items.push({
      id: `L${index}`,
      date,
      text: line.replace(/^-\s+/, "").trim(),
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
  const findingsPath = path.join(resolved, "FINDINGS.md");

  // addFindingToFile handles its own file lock; no double-wrap
  return addFindingToFile(cortexPath, project, learning);
}

export function removeFinding(cortexPath: string, project: string, match: string): CortexResult<string> {
  const ensured = ensureProject(cortexPath, project);
  if (!ensured.ok) return forwardErr(ensured);

  const findingsPath = path.join(ensured.data, 'FINDINGS.md');
  const legacyPath = path.join(ensured.data, 'LEARNINGS.md');
  const filePath = fs.existsSync(findingsPath) ? findingsPath : fs.existsSync(legacyPath) ? legacyPath : findingsPath;
  if (!fs.existsSync(filePath)) return cortexErr(`No FINDINGS.md file found for "${project}". Add a finding first with add_finding or :learn add.`, CortexError.FILE_NOT_FOUND);

  return withFileLock(filePath, () => {
    const lines = fs.readFileSync(filePath, "utf8").split("\n");
    const idx = lines.findIndex((line) => line.startsWith("- ") && line.toLowerCase().includes(match.toLowerCase()));
    if (idx === -1) return cortexErr(`No finding matching "${match}" in project "${project}". Try a different search term or check :findings view.`, CortexError.NOT_FOUND);

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

function parseQueueLine(line: string): { date?: string; text: string; confidence?: number } {
  const parsed = line.match(/^- \[(\d{4}-\d{2}-\d{2})\]\s*(.+)$/);
  const text = parsed ? parsed[2] : line.replace(/^-\s+/, "").trim();
  const confidence = text.match(/\[confidence\s+([01](?:\.\d+)?)\]/i);
  return {
    date: parsed?.[1],
    text,
    confidence: confidence ? Number.parseFloat(confidence[1]) : undefined,
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
    if (trimmed === "## Review") {
      section = "Review";
      continue;
    }
    if (trimmed === "## Stale") {
      section = "Stale";
      continue;
    }
    if (trimmed === "## Conflicts") {
      section = "Conflicts";
      continue;
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

  const out: string[] = [`# ${project} Memory Queue`, "", "## Review", ""];
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
  const needle = match.toLowerCase();
  const index = items.data.findIndex(
    (item) => item.id.toLowerCase() === needle || item.text.toLowerCase().includes(needle) || item.line === match
  );
  if (index === -1) return cortexErr(`No memory queue item matching "${match}" in "${project}". Check the memory queue view with :memory or use the item ID.`, CortexError.NOT_FOUND);
  return cortexOk({ item: items.data[index], all: items.data, index });
}

export function approveQueueItem(cortexPath: string, project: string, match: string): CortexResult<string> {
  const queueDenied = checkPermission(cortexPath, "queue");
  if (queueDenied) return cortexErr(queueDenied, CortexError.PERMISSION_DENIED);
  const writeDenied = checkPermission(cortexPath, "write");
  if (writeDenied) return cortexErr(writeDenied, CortexError.PERMISSION_DENIED);

  const ensured = ensureProject(cortexPath, project);
  if (!ensured.ok) return forwardErr(ensured);
  const qPath = queuePath(cortexPath, project);
  return withFileLock(qPath, () => {
    const found = findQueueByMatch(cortexPath, project, match);
    if (!found.ok) return forwardErr(found);

    const workflow = getWorkflowPolicy(cortexPath);
    const riskyBySection = workflow.riskySections.includes(found.data.item.section);
    const riskyByConfidence = found.data.item.confidence !== undefined && found.data.item.confidence < workflow.lowConfidenceThreshold;
    if (workflow.requireMaintainerApproval && (riskyBySection || riskyByConfidence)) {
      const pinDenied = checkPermission(cortexPath, "pin");
      if (pinDenied) return cortexErr(`This memory is flagged as risky and requires a maintainer or admin to approve. Check your role in .governance/access-control.json.`, CortexError.PERMISSION_DENIED);
    }

    const findingsFilePath = path.join(ensured.data, "FINDINGS.md");
    // addFindingToFile handles its own file lock; no double-wrap
    const add = addFindingToFile(cortexPath, project, found.data.item.text);
    if (!add.ok) return forwardErr(add);

    found.data.all.splice(found.data.index, 1);
    rewriteQueue(cortexPath, project, found.data.all);
    appendAuditLog(cortexPath, "approve_memory", `project=${project} item=${JSON.stringify(found.data.item.text)}`);
    return cortexOk(`Approved memory in ${project}: ${found.data.item.text}`);
  });
}

export function rejectQueueItem(cortexPath: string, project: string, match: string): CortexResult<string> {
  const denial = checkPermission(cortexPath, "queue");
  if (denial) return cortexErr(denial, CortexError.PERMISSION_DENIED);

  const ensured = ensureProject(cortexPath, project);
  if (!ensured.ok) return forwardErr(ensured);
  const qPath = queuePath(cortexPath, project);
  return withFileLock(qPath, () => {
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
  return withFileLock(qPath, () => {
    const found = findQueueByMatch(cortexPath, project, match);
    if (!found.ok) return forwardErr(found);

    const date = found.data.item.date === "unknown" ? new Date().toISOString().slice(0, 10) : found.data.item.date;
    found.data.item.text = trimmed;
    found.data.item.line = `- [${date}] ${found.data.item.text}`;
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
  } catch {
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
  return withFileLock(machinesPath, () => {
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
    } catch {
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

  return withFileLock(current.file, () => {
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

  return withFileLock(current.file, () => {
    const refreshed = listProfiles(cortexPath);
    if (!refreshed.ok) return forwardErr(refreshed);
    const latest = refreshed.data.find((p) => p.name === profile);
    if (!latest) return cortexErr(`Profile "${profile}" not found.`, CortexError.NOT_FOUND);

    const projects = latest.projects.filter((p) => p !== project);
    writeProfile(latest.file, latest.name, projects);
    return cortexOk(`Removed ${project} from profile ${profile}.`);
  });
}

export function listProjectCards(cortexPath: string, profile?: string): ProjectCard[] {
  const dirs = getProjectDirs(cortexPath, profile).sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  const cards: ProjectCard[] = [];
  for (const dir of dirs) {
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
    cards.push({ name, summary, docs });
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
  } catch {
    return fallback;
  }
}

export function saveShellState(cortexPath: string, state: ShellState): void {
  const file = shellStatePath(cortexPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const out: ShellState = {
    version: SHELL_STATE_VERSION,
    view: state.view,
    project: state.project,
    filter: state.filter,
    page: state.page,
    perPage: state.perPage,
  };
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
}

export function resetShellState(cortexPath: string): CortexResult<string> {
  const file = shellStatePath(cortexPath);
  return withFileLock(file, () => {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return cortexOk("Shell state reset.");
  });
}

export function readRuntimeHealth(cortexPath: string) {
  return getRuntimeHealth(cortexPath);
}
