import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import {
  addLearningToFile,
  appendAuditLog,
  checkMemoryPermission,
  getMemoryWorkflowPolicy,
  getProjectDirs,
  getRuntimeHealth,
  validateBacklogFormat,
} from "./shared.js";
import { isValidProjectName, safeProjectPath } from "./utils.js";

// TODO(v2): Many functions return `string` for errors and a typed object for success.
// Replace with a Result<T, E> type or throw typed errors for clearer call-site handling.

function withFileLock<T>(filePath: string, fn: () => T): T {
  const lockPath = filePath + ".lock";
  const maxWait = 5000;
  const pollInterval = 100;
  const staleThreshold = 30000;

  let waited = 0;
  while (waited < maxWait) {
    try {
      fs.writeFileSync(lockPath, `${process.pid}\n${Date.now()}`, { flag: "wx" });
      break;
    } catch {
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > staleThreshold) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      const start = Date.now();
      while (Date.now() - start < pollInterval) { /* busy wait */ }
      waited += pollInterval;
    }
  }

  try {
    return fn();
  } finally {
    try { fs.unlinkSync(lockPath); } catch { /* lock may not exist */ }
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
}

export interface BacklogDoc {
  project: string;
  title: string;
  items: Record<BacklogSection, BacklogItem[]>;
  issues: string[];
  path: string;
}

export interface LearningItem {
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
  view: "Projects" | "Backlog" | "Learnings" | "Memory Queue" | "Machines/Profiles" | "Health";
  project?: string;
  filter?: string;
  page?: number;
  perPage?: number;
}

const SHELL_STATE_VERSION = 1;
const BACKLOG_SECTIONS: BacklogSection[] = ["Active", "Queue", "Done"];

function normalizePriority(text: string): "high" | "medium" | "low" | undefined {
  const m = text.match(/\[(high|medium|low)\]\s*$/i);
  if (!m) return undefined;
  return m[1].toLowerCase() as "high" | "medium" | "low";
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

function ensureProject(cortexPath: string, project: string): { dir?: string; error?: string } {
  if (!isValidProjectName(project)) return { error: `Invalid project name: "${project}".` };
  const dir = safeProjectPath(cortexPath, project);
  if (!dir) return { error: `Invalid project name: "${project}".` };
  if (!fs.existsSync(dir)) return { error: `Project "${project}" not found in cortex.` };
  return { dir };
}

function backlogFilePath(cortexPath: string, project: string): string | null {
  const resolved = safeProjectPath(cortexPath, project);
  if (!resolved) return null;
  return path.join(resolved, "backlog.md");
}

function normalizeBacklogItemLine(item: BacklogItem): string {
  let text = item.line.replace(/\s*\[(high|medium|low)\]\s*$/gi, "").trim();
  if (item.priority) text = `${text} [${item.priority}]`;
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
  let counter = 1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "## Active") {
      section = "Active";
      continue;
    }
    if (line.trim() === "## Queue") {
      section = "Queue";
      continue;
    }
    if (line.trim() === "## Done") {
      section = "Done";
      continue;
    }
    if (!line.startsWith("- ")) continue;

    const parsed = stripBulletPrefix(line);
    const priority = normalizePriority(parsed.body);
    const context = parseContext(lines, i);
    const sectionPrefix = section === "Active" ? "A" : section === "Queue" ? "Q" : "D";
    items[section].push({
      id: `${sectionPrefix}${counter}`,
      section,
      line: parsed.body,
      checked: parsed.checked || section === "Done",
      priority,
      context: context.context,
    });
    counter++;
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

function findItemByMatch(doc: BacklogDoc, match: string): { section: BacklogSection; index: number } | null {
  const needle = match.toLowerCase();
  for (const section of BACKLOG_SECTIONS) {
    const idx = doc.items[section].findIndex((item) =>
      item.id.toLowerCase() === needle || item.line.toLowerCase().includes(needle)
    );
    if (idx !== -1) return { section, index: idx };
  }
  return null;
}

function writeBacklogDoc(doc: BacklogDoc): void {
  fs.writeFileSync(doc.path, renderBacklog(doc));
}

function backlogArchivePath(cortexPath: string, project: string): string {
  return path.join(cortexPath, ".governance", "backlog-archive", `${project}.md`);
}

export function readBacklog(cortexPath: string, project: string): BacklogDoc | string {
  const ensured = ensureProject(cortexPath, project);
  if (ensured.error) return ensured.error;

  const backlogPath = backlogFilePath(cortexPath, project);
  if (!backlogPath) return `Invalid project name: "${project}".`;

  if (!fs.existsSync(backlogPath)) {
    return {
      project,
      title: `# ${project} backlog`,
      path: backlogPath,
      issues: [],
      items: { Active: [], Queue: [], Done: [] },
    };
  }

  const content = fs.readFileSync(backlogPath, "utf8");
  return parseBacklogContent(project, backlogPath, content);
}

export function readBacklogs(cortexPath: string, profile?: string): BacklogDoc[] {
  const projects = getProjectDirs(cortexPath, profile).map((dir) => path.basename(dir)).sort();
  const result: BacklogDoc[] = [];
  for (const project of projects) {
    const file = backlogFilePath(cortexPath, project);
    if (!file || !fs.existsSync(file)) continue;
    const parsed = readBacklog(cortexPath, project);
    if (typeof parsed === "string") continue;
    result.push(parsed);
  }
  return result;
}

export function addBacklogItem(cortexPath: string, project: string, item: string): string {
  const bPath = backlogFilePath(cortexPath, project);
  if (!bPath) return `Invalid project name: "${project}".`;

  return withFileLock(bPath, () => {
    const parsed = readBacklog(cortexPath, project);
    if (typeof parsed === "string") return parsed;

    const line = item.replace(/^-\s*/, "").trim();
    parsed.items.Queue.push({
      id: `Q${parsed.items.Queue.length + 1}`,
      section: "Queue",
      line,
      checked: false,
      priority: normalizePriority(line),
    });
    writeBacklogDoc(parsed);
    return `Added to ${project} backlog: ${line}`;
  });
}

export function completeBacklogItem(cortexPath: string, project: string, match: string): string {
  const bPath = backlogFilePath(cortexPath, project);
  if (!bPath) return `Invalid project name: "${project}".`;

  return withFileLock(bPath, () => {
    const parsed = readBacklog(cortexPath, project);
    if (typeof parsed === "string") return parsed;

    const found = findItemByMatch(parsed, match);
    if (!found) return `No item matching "${match}" found in ${project} backlog.`;

    const [item] = parsed.items[found.section].splice(found.index, 1);
    item.section = "Done";
    item.checked = true;
    parsed.items.Done.unshift(item);
    writeBacklogDoc(parsed);
    return `Marked done in ${project}: ${item.line}`;
  });
}

export function updateBacklogItem(
  cortexPath: string,
  project: string,
  match: string,
  updates: { priority?: string; context?: string; section?: string }
): string {
  const bPath = backlogFilePath(cortexPath, project);
  if (!bPath) return `Invalid project name: "${project}".`;

  return withFileLock(bPath, () => {
    const parsed = readBacklog(cortexPath, project);
    if (typeof parsed === "string") return parsed;

    const found = findItemByMatch(parsed, match);
    if (!found) return `No item matching "${match}" found in ${project} backlog.`;

    const item = parsed.items[found.section][found.index];
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
        parsed.items[found.section].splice(found.index, 1);
        const section = target as BacklogSection;
        item.section = section;
        item.checked = section === "Done";
        parsed.items[section].unshift(item);
        changes.push(`moved to ${section}`);
      }
    }

    writeBacklogDoc(parsed);
    return `Updated item in ${project}: ${changes.join(", ") || "no changes"}`;
  });
}

export function workNextBacklogItem(cortexPath: string, project: string): string {
  const parsed = readBacklog(cortexPath, project);
  if (typeof parsed === "string") return parsed;
  if (!parsed.items.Queue.length) return `No queued items in ${project}.`;

  const item = parsed.items.Queue.shift()!;
  item.section = "Active";
  item.checked = false;
  parsed.items.Active.push(item);
  writeBacklogDoc(parsed);
  return `Moved next queue item to Active in ${project}: ${item.line}`;
}

export function tidyBacklogDone(cortexPath: string, project: string, keep: number = 30): string {
  const parsed = readBacklog(cortexPath, project);
  if (typeof parsed === "string") return parsed;

  const safeKeep = Number.isFinite(keep) ? Math.max(0, Math.floor(keep)) : 30;
  if (parsed.items.Done.length <= safeKeep) {
    return `No tidy needed for ${project}. Done=${parsed.items.Done.length}, keep=${safeKeep}.`;
  }

  const archived = parsed.items.Done.slice(safeKeep);
  parsed.items.Done = parsed.items.Done.slice(0, safeKeep);

  const archiveFile = backlogArchivePath(cortexPath, project);
  fs.mkdirSync(path.dirname(archiveFile), { recursive: true });
  const stamp = new Date().toISOString();
  const lines = archived.map((item) => `- [x] ${item.line}${item.context ? `\n  Context: ${item.context}` : ""}`);
  const block = `## ${stamp}\n\n${lines.join("\n")}\n\n`;
  const prior = fs.existsSync(archiveFile) ? fs.readFileSync(archiveFile, "utf8") : `# ${project} backlog archive\n\n`;
  fs.writeFileSync(archiveFile, prior + block);

  writeBacklogDoc(parsed);
  return `Tidied ${project}: archived ${archived.length} done item(s), kept ${safeKeep}.`;
}

export function backlogMarkdown(doc: BacklogDoc): string {
  return renderBacklog(doc);
}

export function readLearnings(cortexPath: string, project: string): LearningItem[] | string {
  const ensured = ensureProject(cortexPath, project);
  if (ensured.error) return ensured.error;

  const file = path.join(ensured.dir!, "LEARNINGS.md");
  if (!fs.existsSync(file)) return [];

  const lines = fs.readFileSync(file, "utf8").split("\n");
  const items: LearningItem[] = [];
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

  return items;
}

export function addLearning(cortexPath: string, project: string, learning: string): string {
  if (!isValidProjectName(project)) return `Invalid project name: "${project}".`;
  const resolved = safeProjectPath(cortexPath, project);
  if (!resolved) return `Invalid project name: "${project}".`;
  const learningsPath = path.join(resolved, "LEARNINGS.md");

  return withFileLock(learningsPath, () => addLearningToFile(cortexPath, project, learning));
}

export function removeLearning(cortexPath: string, project: string, match: string): string {
  const ensured = ensureProject(cortexPath, project);
  if (ensured.error) return ensured.error;

  const learningsPath = path.join(ensured.dir!, "LEARNINGS.md");
  if (!fs.existsSync(learningsPath)) return `No LEARNINGS.md found for "${project}".`;

  return withFileLock(learningsPath, () => {
    const lines = fs.readFileSync(learningsPath, "utf8").split("\n");
    const idx = lines.findIndex((line) => line.startsWith("- ") && line.toLowerCase().includes(match.toLowerCase()));
    if (idx === -1) return `No learning matching "${match}" found in ${project}.`;

    const citationComment = /^\s*<!--\s*cortex:cite\s+\{.*\}\s*-->\s*$/;
    const removeCount = citationComment.test(lines[idx + 1] || "") ? 2 : 1;
    const matched = lines[idx];
    lines.splice(idx, removeCount);
    const normalized = lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
    fs.writeFileSync(learningsPath, normalized);
    return `Removed from ${project}: ${matched}`;
  });
}

function queuePath(cortexPath: string, project: string): string {
  return path.join(cortexPath, project, "MEMORY_QUEUE.md");
}

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

export function readMemoryQueue(cortexPath: string, project: string): QueueItem[] | string {
  const ensured = ensureProject(cortexPath, project);
  if (ensured.error) return ensured.error;

  const file = queuePath(cortexPath, project);
  if (!fs.existsSync(file)) return [];

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

  return items;
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

function findQueueByMatch(cortexPath: string, project: string, match: string): { item: QueueItem; all: QueueItem[]; index: number } | string {
  const items = readMemoryQueue(cortexPath, project);
  if (typeof items === "string") return items;
  const needle = match.toLowerCase();
  const index = items.findIndex(
    (item) => item.id.toLowerCase() === needle || item.text.toLowerCase().includes(needle) || item.line === match
  );
  if (index === -1) return `No memory queue item matching "${match}" in ${project}.`;
  return { item: items[index], all: items, index };
}

export function approveMemoryQueueItem(cortexPath: string, project: string, match: string): string {
  const queueDenied = checkMemoryPermission(cortexPath, "queue");
  if (queueDenied) return queueDenied;
  const writeDenied = checkMemoryPermission(cortexPath, "write");
  if (writeDenied) return writeDenied;

  const found = findQueueByMatch(cortexPath, project, match);
  if (typeof found === "string") return found;

  const workflow = getMemoryWorkflowPolicy(cortexPath);
  const riskyBySection = workflow.riskySections.includes(found.item.section);
  const riskyByConfidence = found.item.confidence !== undefined && found.item.confidence < workflow.lowConfidenceThreshold;
  if (workflow.requireMaintainerApproval && (riskyBySection || riskyByConfidence)) {
    const pinDenied = checkMemoryPermission(cortexPath, "pin");
    if (pinDenied) return "Approval requires maintainer/admin role for risky memory entries.";
  }

  const add = addLearningToFile(cortexPath, project, found.item.text);
  if (add.startsWith("Permission denied") || add.startsWith("Invalid")) return add;

  found.all.splice(found.index, 1);
  rewriteQueue(cortexPath, project, found.all);
  appendAuditLog(cortexPath, "approve_memory", `project=${project} item=${JSON.stringify(found.item.text)}`);
  return `Approved memory in ${project}: ${found.item.text}`;
}

export function rejectMemoryQueueItem(cortexPath: string, project: string, match: string): string {
  const denial = checkMemoryPermission(cortexPath, "queue");
  if (denial) return denial;

  const found = findQueueByMatch(cortexPath, project, match);
  if (typeof found === "string") return found;

  found.all.splice(found.index, 1);
  rewriteQueue(cortexPath, project, found.all);
  appendAuditLog(cortexPath, "reject_memory", `project=${project} item=${JSON.stringify(found.item.text)}`);
  return `Rejected memory in ${project}: ${found.item.text}`;
}

export function editMemoryQueueItem(cortexPath: string, project: string, match: string, newText: string): string {
  const denial = checkMemoryPermission(cortexPath, "queue");
  if (denial) return denial;

  const trimmed = newText.trim();
  if (!trimmed) return "New memory text cannot be empty.";

  const found = findQueueByMatch(cortexPath, project, match);
  if (typeof found === "string") return found;

  const date = found.item.date === "unknown" ? new Date().toISOString().slice(0, 10) : found.item.date;
  found.item.text = trimmed;
  found.item.line = `- [${date}] ${found.item.text}`;
  found.all[found.index] = found.item;
  rewriteQueue(cortexPath, project, found.all);
  appendAuditLog(cortexPath, "edit_memory", `project=${project} item=${JSON.stringify(found.item.text)}`);
  return `Edited memory in ${project}: ${found.item.text}`;
}

export function listMachines(cortexPath: string): Record<string, string> | string {
  const machinesPath = path.join(cortexPath, "machines.yaml");
  if (!fs.existsSync(machinesPath)) return "No machines.yaml found.";
  const raw = fs.readFileSync(machinesPath, "utf8");
  const parsed = yaml.load(raw, { schema: yaml.CORE_SCHEMA }) as Record<string, string> | null;
  if (!parsed || typeof parsed !== "object") return "machines.yaml is empty or invalid.";
  return parsed;
}

function writeMachines(cortexPath: string, data: Record<string, string>): void {
  const machinesPath = path.join(cortexPath, "machines.yaml");
  const backupPath = `${machinesPath}.bak`;
  if (fs.existsSync(machinesPath)) fs.copyFileSync(machinesPath, backupPath);
  const ordered = Object.fromEntries(Object.entries(data).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(machinesPath, yaml.dump(ordered, { lineWidth: 1000 }));
}

export function setMachineProfile(cortexPath: string, machine: string, profile: string): string {
  if (!machine || !profile) return "Usage: machine + profile are required.";

  const profiles = listProfiles(cortexPath);
  if (typeof profiles !== "string") {
    const exists = profiles.some((p) => p.name === profile);
    if (!exists) return `Profile "${profile}" does not exist.`;
  }

  const current = listMachines(cortexPath);
  const data = typeof current === "string" ? {} : current;
  data[machine] = profile;
  writeMachines(cortexPath, data);
  return `Mapped machine ${machine} -> ${profile}.`;
}

export function listProfiles(cortexPath: string): ProfileInfo[] | string {
  const profilesDir = path.join(cortexPath, "profiles");
  if (!fs.existsSync(profilesDir)) return "No profiles directory found.";
  const files = fs.readdirSync(profilesDir).filter((file) => file.endsWith(".yaml")).sort();
  const profiles: ProfileInfo[] = [];

  for (const file of files) {
    const full = path.join(profilesDir, file);
    const raw = fs.readFileSync(full, "utf8");
    const parsed = yaml.load(raw, { schema: yaml.CORE_SCHEMA }) as Record<string, unknown> | null;
    const name = (parsed?.name as string) || file.replace(/\.yaml$/, "");
    const projects = Array.isArray(parsed?.projects)
      ? (parsed?.projects as unknown[]).map((project) => String(project)).filter(Boolean)
      : [];
    profiles.push({ name, file: full, projects });
  }

  return profiles;
}

function writeProfile(file: string, name: string, projects: string[]): void {
  const backup = `${file}.bak`;
  if (fs.existsSync(file)) fs.copyFileSync(file, backup);
  const normalized = [...new Set(projects)].sort();
  const out = yaml.dump({ name, projects: normalized }, { lineWidth: 1000 });
  fs.writeFileSync(file, out);
}

export function addProjectToProfile(cortexPath: string, profile: string, project: string): string {
  if (!isValidProjectName(project)) return `Invalid project name: "${project}".`;
  const profiles = listProfiles(cortexPath);
  if (typeof profiles === "string") return profiles;
  const current = profiles.find((p) => p.name === profile);
  if (!current) return `Profile "${profile}" not found.`;

  const projects = current.projects.includes(project) ? current.projects : [...current.projects, project];
  writeProfile(current.file, current.name, projects);
  return `Added ${project} to profile ${profile}.`;
}

export function removeProjectFromProfile(cortexPath: string, profile: string, project: string): string {
  const profiles = listProfiles(cortexPath);
  if (typeof profiles === "string") return profiles;
  const current = profiles.find((p) => p.name === profile);
  if (!current) return `Profile "${profile}" not found.`;

  const projects = current.projects.filter((p) => p !== project);
  writeProfile(current.file, current.name, projects);
  return `Removed ${project} from profile ${profile}.`;
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

    const docs = ["CLAUDE.md", "LEARNINGS.md", "summary.md", "backlog.md", "MEMORY_QUEUE.md"]
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

export function resetShellState(cortexPath: string): string {
  const file = shellStatePath(cortexPath);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  return "Shell state reset.";
}

export function readRuntimeHealth(cortexPath: string) {
  return getRuntimeHealth(cortexPath);
}
