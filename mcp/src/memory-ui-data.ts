import * as fs from "fs";
import * as path from "path";
import {
  getProjectDirs,
  runtimeDir,
  runtimeHealthFile,
  memoryUsageLogFile,
  homePath,
} from "./shared.js";
import { errorMessage } from "./utils.js";
import { readInstallPreferences } from "./init-preferences.js";
import { readCustomHooks } from "./hooks.js";
import { hookConfigPaths, hookConfigRoots } from "./provider-adapters.js";
import { getAllSkills } from "./skill-registry.js";
import { resolveTaskFilePath, readTasks } from "./data-tasks.js";
import { buildIndex, queryRows } from "./shared-index.js";
import type { SqlJsDatabase } from "./shared-index.js";
import { readProjectTopics, classifyTopicForText, type ProjectTopic } from "./project-topics.js";

interface EntryScore {
  impressions: number;
  helpful: number;
  repromptPenalty: number;
  regressionPenalty: number;
  lastUsedAt: string;
}

interface GraphNode {
  id: string;
  label: string;
  fullLabel: string;
  group: string;
  refCount: number;
  project: string;
  tagged: boolean;
  priority?: string;
  section?: string;
  entityType?: string;
  refDocs?: string[];
  topicSlug?: string;
  topicLabel?: string;
}

interface GraphTopicMeta {
  slug: string;
  label: string;
}

interface GraphLink {
  source: string;
  target: string;
}

interface ProjectInfo {
  name: string;
  findingCount: number;
  taskCount: number;
  hasClaudeMd: boolean;
  hasSummary: boolean;
  hasReference: boolean;
  summaryText: string;
  githubUrl?: string;
  sparkline: number[];
}

function extractGithubUrl(content: string): string | undefined {
  const match = content.match(/https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/);
  return match ? match[0] : undefined;
}

export function readSyncSnapshot(cortexPath: string) {
  try {
    const runtimeHealth = runtimeHealthFile(cortexPath);
    if (!fs.existsSync(runtimeHealth)) return {};
    const parsed = JSON.parse(fs.readFileSync(runtimeHealth, "utf8")) as {
      lastAutoSave?: { status?: string; detail?: string };
      lastSync?: {
        lastPullAt?: string;
        lastPullStatus?: string;
        lastPushAt?: string;
        lastPushStatus?: string;
        unsyncedCommits?: number;
        lastPushDetail?: string;
      };
    };
    return {
      autoSaveStatus: parsed.lastAutoSave?.status || "",
      autoSaveDetail: parsed.lastAutoSave?.detail || "",
      lastPullAt: parsed.lastSync?.lastPullAt || "",
      lastPullStatus: parsed.lastSync?.lastPullStatus || "",
      lastPushAt: parsed.lastSync?.lastPushAt || "",
      lastPushStatus: parsed.lastSync?.lastPushStatus || "",
      unsyncedCommits: parsed.lastSync?.unsyncedCommits || 0,
      lastPushDetail: parsed.lastSync?.lastPushDetail || "",
    };
  } catch {
    return {};
  }
}

export function isAllowedFilePath(filePath: string, cortexPath: string): boolean {
  const resolved = path.resolve(filePath);
  const allowedRoots = hookConfigRoots(cortexPath);
  if (!allowedRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep))) {
    return false;
  }

  let existingAncestor = resolved;
  const pendingSegments: string[] = [];
  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    pendingSegments.unshift(path.basename(existingAncestor));
    existingAncestor = parent;
  }

  let realResolved: string;
  try {
    const realAncestor = fs.realpathSync(existingAncestor);
    realResolved = pendingSegments.length
      ? path.resolve(realAncestor, ...pendingSegments)
      : realAncestor;
  } catch {
    return false;
  }

  const allowedRealRoots = allowedRoots.map((root) => {
    try { return fs.realpathSync(root); } catch { return root; }
  });
  return allowedRealRoots.some((root) => realResolved === root || realResolved.startsWith(root + path.sep));
}

export function collectSkillsForUI(cortexPath: string, profile = ""): Array<{ name: string; source: string; path: string; enabled: boolean }> {
  return getAllSkills(cortexPath, profile).map((skill) => ({
    name: skill.name,
    source: skill.source,
    path: skill.path,
    enabled: skill.enabled,
  }));
}

export function getHooksData(cortexPath: string) {
  const prefs = readInstallPreferences(cortexPath);
  const globalEnabled = prefs.hooksEnabled !== false;
  const toolPrefs = (prefs.hookTools && typeof prefs.hookTools === "object") ? prefs.hookTools : {};
  const paths = hookConfigPaths(cortexPath);

  const tools = (["claude", "copilot", "cursor", "codex"] as const).map((tool) => ({
    tool,
    enabled: globalEnabled && toolPrefs[tool] !== false,
    configPath: paths[tool],
    exists: fs.existsSync(paths[tool]),
  }));

  return { globalEnabled, tools, customHooks: readCustomHooks(cortexPath) };
}

export async function buildGraph(cortexPath: string, profile?: string, focusProject?: string): Promise<{ nodes: GraphNode[]; links: GraphLink[]; total: number; scores: Record<string, EntryScore>; topics: GraphTopicMeta[] }> {
  const projects = getProjectDirs(cortexPath, profile).map((projectDir) => path.basename(projectDir)).filter((project) => project !== "global");
  const nodes: GraphNode[] = [];
  const links: GraphLink[] = [];
  const projectSet = new Set(projects);

  // Collect all unique topics across projects for the UI
  const topicMetaMap = new Map<string, GraphTopicMeta>();

  for (const project of projects) {
    // Load dynamic topics for this project
    const { topics: projectTopics } = readProjectTopics(cortexPath, project);
    for (const topic of projectTopics) {
      if (!topicMetaMap.has(topic.slug)) {
        topicMetaMap.set(topic.slug, { slug: topic.slug, label: topic.label });
      }
    }

    const findingsPath = path.join(cortexPath, project, "FINDINGS.md");
    if (!fs.existsSync(findingsPath)) {
      nodes.push({
        id: project,
        label: project,
        fullLabel: project,
        group: "project",
        refCount: 0,
        project,
        tagged: false,
      });
      continue;
    }

    nodes.push({
      id: project,
      label: project,
      fullLabel: project,
      group: "project",
      refCount: 1,
      project,
      tagged: false,
    });

    const content = fs.readFileSync(findingsPath, "utf8");
    const lines = content.split("\n");
    // No cap for focused project; high caps otherwise
    const isFocused = focusProject && project === focusProject;
    const MAX_TAGGED = isFocused ? Infinity : 200;
    const MAX_UNTAGGED = isFocused ? Infinity : 100;
    let taggedCount = 0;
    let untaggedAdded = 0;

    for (const line of lines) {
      // Support legacy tagged findings like [decision], [pitfall], etc.
      const tagMatch = line.match(/^-\s+\[([a-z_-]+)\]\s+(.+?)(?:\s*<!--.*-->)?$/);
      if (tagMatch) {
        if (taggedCount >= MAX_TAGGED) continue;
        const tag = tagMatch[1];
        const text = tagMatch[2].trim();
        const label = text.length > 55 ? `${text.slice(0, 52)}...` : text;
        // Classify the finding using the project's topic system
        const topic = classifyTopicForText(`[${tag}] ${text}`, projectTopics);
        const nodeId = `${project}:${tag}:${nodes.length}`;
        taggedCount++;
        nodes.push({
          id: nodeId,
          label,
          fullLabel: text,
          group: `topic:${topic.slug}`,
          refCount: taggedCount,
          project,
          tagged: true,
          topicSlug: topic.slug,
          topicLabel: topic.label,
        });
        links.push({ source: project, target: nodeId });
        for (const other of projectSet) {
          if (other !== project && text.toLowerCase().includes(other.toLowerCase())) {
            links.push({ source: project, target: other });
          }
        }
        continue;
      }

      if (untaggedAdded >= MAX_UNTAGGED) continue;
      const plainMatch = line.match(/^-\s+(.+?)(?:\s*<!--.*-->)?$/);
      if (!plainMatch) continue;
      const text = plainMatch[1].trim();
      if (text.length < 10) continue;
      const label = text.length > 55 ? `${text.slice(0, 52)}...` : text;
      // Classify using dynamic topics
      const topic = classifyTopicForText(text, projectTopics);
      const nodeId = `${project}:finding:${nodes.length}`;
      untaggedAdded++;
      nodes.push({
        id: nodeId,
        label,
        fullLabel: text,
        group: `topic:${topic.slug}`,
        refCount: untaggedAdded,
        project,
        tagged: false,
        topicSlug: topic.slug,
        topicLabel: topic.label,
      });
      links.push({ source: project, target: nodeId });
    }
  }

  // ── Tasks ──────────────────────────────────────────────────────────
  try {
    for (const project of projects) {
      const taskResult = readTasks(cortexPath, project);
      if (!taskResult.ok) continue;
      const doc = taskResult.data;
      let taskCount = 0;
      const MAX_TASKS = 50;
      for (const section of ["Active", "Queue"] as const) {
        const group = section === "Active" ? "task-active" : "task-queue";
        for (const item of doc.items[section]) {
          if (taskCount >= MAX_TASKS) break;
          const nodeId = `${project}:task:${item.id}`;
          const label = item.line.length > 55 ? `${item.line.slice(0, 52)}...` : item.line;
          nodes.push({
            id: nodeId,
            label,
            fullLabel: item.line,
            group,
            project,
            tagged: false,
            refCount: 0,
            priority: item.priority,
            section: item.section,
          });
          links.push({ source: project, target: nodeId });
          taskCount++;
        }
      }
    }
  } catch {
    // task loading failed — continue with other data sources
  }

  // ── Entities ──────────────────────────────────────────────────────
  let db: SqlJsDatabase | null = null;
  try {
    db = await buildIndex(cortexPath, profile);
    const rows = queryRows(
      db,
      `SELECT e.name, e.type, COUNT(el.source_id) as ref_count, GROUP_CONCAT(DISTINCT el.source_doc) as docs
       FROM entities e JOIN entity_links el ON el.target_id = e.id WHERE e.type != 'document'
       GROUP BY e.id, e.name, e.type ORDER BY ref_count DESC LIMIT 500`,
      [],
    );
    if (rows) {
      for (const row of rows) {
        const name = String(row[0] ?? "");
        const type = String(row[1] ?? "");
        const refCount = typeof row[2] === "number" ? row[2] : 0;
        const docsStr = String(row[3] ?? "");
        const docs = docsStr ? docsStr.split(",") : [];
        const nodeId = `entity:${name}:${type}`;
        nodes.push({
          id: nodeId,
          label: name.length > 55 ? `${name.slice(0, 52)}...` : name,
          fullLabel: name,
          group: "entity",
          project: "",
          tagged: false,
          refCount,
          entityType: type,
          refDocs: docs,
        });
        // Link entity to each project it appears in
        const linkedProjects = new Set<string>();
        for (const doc of docs) {
          const projMatch = doc.match(/^([^/]+)\//);
          if (projMatch && projectSet.has(projMatch[1])) {
            linkedProjects.add(projMatch[1]);
          }
        }
        for (const proj of linkedProjects) {
          links.push({ source: nodeId, target: proj });
        }
      }
    }
  } catch {
    // entity loading failed — continue with other data sources
  } finally {
    if (db) {
      try { db.close(); } catch { /* already closed or failed — ignore */ }
    }
  }

  // ── Reference docs ────────────────────────────────────────────────
  try {
    for (const project of projects) {
      const refDir = path.join(cortexPath, project, "reference");
      if (!fs.existsSync(refDir) || !fs.statSync(refDir).isDirectory()) continue;
      const files = fs.readdirSync(refDir);
      const MAX_REFS = 20;
      let refCount = 0;
      for (const file of files) {
        if (refCount >= MAX_REFS) break;
        const nodeId = `${project}:ref:${file}`;
        nodes.push({
          id: nodeId,
          label: file.length > 55 ? `${file.slice(0, 52)}...` : file,
          fullLabel: file,
          group: "reference",
          project,
          tagged: false,
          refCount: 0,
        });
        links.push({ source: project, target: nodeId });
        refCount++;
      }
    }
  } catch {
    // reference doc loading failed — continue
  }

  // ── Memory scores ────────────────────────────────────────────────
  let scores: Record<string, EntryScore> = {};
  try {
    const scoresPath = path.join(cortexPath, ".runtime", "memory-scores.json");
    if (fs.existsSync(scoresPath)) {
      const parsed = JSON.parse(fs.readFileSync(scoresPath, "utf8"));
      if (parsed && typeof parsed.entries === "object") {
        scores = parsed.entries;
      }
    }
  } catch {
    // scores loading failed — return empty
  }

  const seen = new Set<string>();
  const dedupedLinks = links.filter((link) => {
    const key = [link.source, link.target].sort().join("||");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Remove orphan project nodes (0 edges) to avoid scattered floaters
  const connectedIds = new Set<string>();
  for (const link of dedupedLinks) {
    connectedIds.add(link.source);
    connectedIds.add(link.target);
  }
  const filteredNodes = nodes.filter((n) => n.group !== "project" || connectedIds.has(n.id));

  const total = filteredNodes.length;
  const topics = Array.from(topicMetaMap.values());
  return { nodes: filteredNodes, links: dedupedLinks, total, scores, topics };
}

export function recentUsage(cortexPath: string): string[] {
  const usage = memoryUsageLogFile(cortexPath);
  if (!fs.existsSync(usage)) return [];
  const lines = fs.readFileSync(usage, "utf8").trim().split("\n").filter(Boolean);
  return lines.slice(-40).reverse();
}

export function recentAccepted(cortexPath: string): string[] {
  const audit = path.join(runtimeDir(cortexPath), "audit.log");
  if (!fs.existsSync(audit)) return [];
  const lines = fs.readFileSync(audit, "utf8").split("\n").filter((line) => line.includes("approve_memory"));
  return lines.slice(-40).reverse();
}

export function collectProjectsForUI(cortexPath: string, profile?: string): ProjectInfo[] {
  const projects = getProjectDirs(cortexPath, profile).map((projectDir) => path.basename(projectDir)).filter((project) => project !== "global");

  let allowedProjects: Set<string> | null = null;
  try {
    const contextPath = homePath(".cortex-context.md");
    if (fs.existsSync(contextPath)) {
      const contextContent = fs.readFileSync(contextPath, "utf8");
      const activeMatch = contextContent.match(/Active projects?:\s*(.+)/i);
      if (activeMatch) {
        const names = activeMatch[1].split(/[,;]/).map((name) => name.trim().toLowerCase()).filter(Boolean);
        if (names.length) allowedProjects = new Set(names);
      }
    }
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] memory-ui filterByProfile: ${errorMessage(err)}\n`);
  }

  const results: ProjectInfo[] = [];
  for (const project of projects) {
    if (allowedProjects && !allowedProjects.has(project.toLowerCase())) continue;

    const dir = path.join(cortexPath, project);
    const findingsPath = path.join(dir, "FINDINGS.md");
    const taskPath = resolveTaskFilePath(cortexPath, project);
    const claudeMdPath = path.join(dir, "CLAUDE.md");
    const summaryPath = path.join(dir, "summary.md");
    const refPath = path.join(dir, "reference");

    let findingCount = 0;
    if (fs.existsSync(findingsPath)) {
      const content = fs.readFileSync(findingsPath, "utf8");
      findingCount = (content.match(/^- \[/gm) || []).length;
    }

    const sparkline: number[] = new Array(8).fill(0);
    if (fs.existsSync(findingsPath)) {
      const now = Date.now();
      const weekMs = 7 * 24 * 60 * 60 * 1000;
      const sparkContent = fs.readFileSync(findingsPath, "utf8");
      const dateRe = /(?:created[_:]?\s*"?|created_at[":]+\s*)(\d{4}-\d{2}-\d{2})/g;
      let match: RegExpExecArray | null;
      while ((match = dateRe.exec(sparkContent)) !== null) {
        const age = now - new Date(match[1]).getTime();
        const weekIdx = Math.floor(age / weekMs);
        if (weekIdx >= 0 && weekIdx < 8) sparkline[7 - weekIdx]++;
      }
    }

    let taskCount = 0;
    if (taskPath && fs.existsSync(taskPath)) {
      const content = fs.readFileSync(taskPath, "utf8");
      const queueMatch = content.match(/## Queue[\s\S]*?(?=## |$)/);
      if (queueMatch) taskCount = (queueMatch[0].match(/^- /gm) || []).length;
    }

    let summaryText = "";
    if (fs.existsSync(summaryPath)) {
      summaryText = fs.readFileSync(summaryPath, "utf8").trim();
      if (summaryText.length > 300) summaryText = `${summaryText.slice(0, 300)}...`;
    }

    let githubUrl: string | undefined;
    if (fs.existsSync(claudeMdPath)) {
      githubUrl = extractGithubUrl(fs.readFileSync(claudeMdPath, "utf8"));
    }
    if (!githubUrl && fs.existsSync(summaryPath)) {
      githubUrl = extractGithubUrl(fs.readFileSync(summaryPath, "utf8"));
    }

    results.push({
      name: project,
      findingCount,
      taskCount,
      hasClaudeMd: fs.existsSync(claudeMdPath),
      hasSummary: fs.existsSync(summaryPath),
      hasReference: fs.existsSync(refPath) && fs.statSync(refPath).isDirectory(),
      summaryText,
      githubUrl,
      sparkline,
    });
  }

  return results.sort((a, b) => (b.findingCount + b.taskCount) - (a.findingCount + a.taskCount));
}
