import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import {
  getProjectDirs,
  runtimeDir,
  runtimeHealthFile,
  memoryUsageLogFile,
  homePath,
} from "../shared.js";
import { getNonPrimaryStores, getStoreProjectDirs } from "../store-registry.js";
import { errorMessage } from "../utils.js";
import { readInstallPreferences } from "../init/preferences.js";
import { readCustomHooks } from "../hooks.js";
import { hookConfigPaths, hookConfigRoots } from "../provider-adapters.js";
import { readProjectConfig, isProjectHookEnabled, PROJECT_HOOK_EVENTS } from "../project-config.js";
import { getAllSkills } from "../skill/registry.js";
import { resolveTaskFilePath, readTasks, TASKS_FILENAME } from "../data/tasks.js";
import { FINDINGS_FILENAME } from "../data/access.js";
import { buildIndex, queryDocBySourceKey, queryRows } from "../shared/index.js";
import type { SqlJsDatabase } from "../shared/index.js";
import { readProjectTopics, classifyTopicForText } from "../project-topics.js";
import { entryScoreKey } from "../governance/scores.js";
import { logger } from "../logger.js";

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
  store?: string;
  tagged: boolean;
  scoreKey?: string;
  priority?: string;
  section?: string;
  entityType?: string;
  refDocs?: GraphDocRef[];
  scoreKeys?: string[];
  topicSlug?: string;
  topicLabel?: string;
}

interface GraphDocRef {
  doc: string;
  project: string;
  scoreKey?: string;
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
  storePath: string;
  store?: string;
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

function stableId(scope: string, ...parts: string[]): string {
  const hash = createHash("sha1");
  for (const part of parts) hash.update(part);
  return `${scope}:${hash.digest("hex").slice(0, 12)}`;
}

function exactProjectMentions(text: string, projectSet: Set<string>, currentProject: string): string[] {
  const tokenMatches = text.toLowerCase().match(/[a-z0-9_-]+/g) ?? [];
  const tokens = new Set(tokenMatches);
  const matches: string[] = [];
  for (const project of projectSet) {
    if (project === currentProject) continue;
    if (tokens.has(project.toLowerCase())) matches.push(project);
  }
  return matches;
}

function projectFromSourceDoc(sourceDoc: string): string {
  const slash = sourceDoc.indexOf("/");
  return slash > 0 ? sourceDoc.slice(0, slash) : "";
}

export function readSyncSnapshot(phrenPath: string) {
  try {
    const runtimeHealth = runtimeHealthFile(phrenPath);
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

export function isAllowedFilePath(filePath: string, phrenPath: string): boolean {
  const resolved = path.resolve(filePath);
  const allowedRoots = hookConfigRoots(phrenPath);
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

/**
 * Stricter path check for skill endpoints — only allows files under skills/ directories,
 * not the entire phren store.
 */
export function isAllowedSkillPath(filePath: string, phrenPath: string): boolean {
  if (!isAllowedFilePath(filePath, phrenPath)) return false;
  const resolved = path.resolve(filePath);
  // Must be under a "skills" directory segment
  const segments = resolved.split(path.sep);
  return segments.some((seg) => seg === "skills");
}

export function collectSkillsForUI(phrenPath: string, profile = ""): Array<{ name: string; source: string; path: string; enabled: boolean }> {
  return getAllSkills(phrenPath, profile).map((skill) => ({
    name: skill.name,
    source: skill.source,
    path: skill.path,
    enabled: skill.enabled,
  }));
}

export function getHooksData(phrenPath: string, profile?: string) {
  const prefs = readInstallPreferences(phrenPath);
  const globalEnabled = prefs.hooksEnabled !== false;
  const toolPrefs = (prefs.hookTools && typeof prefs.hookTools === "object") ? prefs.hookTools : {};
  const paths = hookConfigPaths(phrenPath);

  const tools = (["claude", "copilot", "cursor", "codex"] as const).map((tool) => ({
    tool,
    enabled: globalEnabled && toolPrefs[tool] !== false,
    configPath: paths[tool],
    exists: fs.existsSync(paths[tool]),
  }));

  // Collect per-project hook overrides
  const projectOverrides: Array<{
    project: string;
    baseEnabled: boolean | null;
    events: Array<{ event: string; configured: boolean | null; enabled: boolean }>;
  }> = [];
  const projects = getProjectDirs(phrenPath, profile)
    .map((dir) => path.basename(dir))
    .filter((p) => p !== "global");
  for (const project of projects) {
    const config = readProjectConfig(phrenPath, project);
    const hasOverrides =
      typeof config.hooks?.enabled === "boolean" ||
      PROJECT_HOOK_EVENTS.some((ev) => typeof config.hooks?.[ev] === "boolean");
    if (!hasOverrides) continue;
    projectOverrides.push({
      project,
      baseEnabled: typeof config.hooks?.enabled === "boolean" ? config.hooks.enabled : null,
      events: PROJECT_HOOK_EVENTS.map((event) => ({
        event,
        configured: typeof config.hooks?.[event] === "boolean" ? config.hooks[event]! : null,
        enabled: isProjectHookEnabled(phrenPath, project, event, config),
      })),
    });
  }

  return { globalEnabled, tools, customHooks: readCustomHooks(phrenPath), projectOverrides };
}

export async function buildGraph(phrenPath: string, profile?: string, focusProject?: string, existingDb?: SqlJsDatabase | null): Promise<{ nodes: GraphNode[]; links: GraphLink[]; total: number; scores: Record<string, EntryScore>; topics: GraphTopicMeta[] }> {
  // Collect projects from primary store and all readable non-primary stores
  const storeProjects: Array<{ storePath: string; project: string }> = [];
  const primaryProjects = getProjectDirs(phrenPath, profile)
    .map((projectDir) => path.basename(projectDir))
    .filter((project) => project !== "global");
  for (const project of primaryProjects) storeProjects.push({ storePath: phrenPath, project });

  // Map store paths to store names
  const storePathToName = new Map<string, string>();
  storePathToName.set(phrenPath, "primary");

  for (const store of getNonPrimaryStores(phrenPath)) {
    if (!fs.existsSync(store.path)) continue;
    storePathToName.set(store.path, store.name);
    try {
      const storeProjectDirs = getStoreProjectDirs(store)
        .map((projectDir: string) => path.basename(projectDir))
        .filter((project: string) => project !== "global");
      for (const project of storeProjectDirs) storeProjects.push({ storePath: store.path, project });
    } catch { /* store not accessible — skip */ }
  }
  const projects = storeProjects.map((sp) => sp.project);
  const nodes: GraphNode[] = [];
  const links: GraphLink[] = [];
  const projectSet = new Set(projects);

  // Collect all unique topics across projects for the UI
  const topicMetaMap = new Map<string, GraphTopicMeta>();
  // Track which project nodes have already been pushed (same name may appear in multiple stores)
  const addedProjectNodeIds = new Set<string>();

  for (const { storePath, project } of storeProjects) {
    // Load dynamic topics for this project
    const { topics: projectTopics } = readProjectTopics(storePath, project);
    for (const topic of projectTopics) {
      if (!topicMetaMap.has(topic.slug)) {
        topicMetaMap.set(topic.slug, { slug: topic.slug, label: topic.label });
      }
    }

    const findingsPath = path.join(storePath, project, FINDINGS_FILENAME);
    const storeName = storePathToName.get(storePath) || "unknown";
    if (!fs.existsSync(findingsPath)) {
      if (!addedProjectNodeIds.has(project)) {
        addedProjectNodeIds.add(project);
        nodes.push({
          id: project,
          label: project,
          fullLabel: project,
          group: "project",
          refCount: 0,
          project,
          store: storeName,
          tagged: false,
        });
      }
      continue;
    }

    if (!addedProjectNodeIds.has(project)) {
      addedProjectNodeIds.add(project);
      nodes.push({
        id: project,
        label: project,
        fullLabel: project,
        group: "project",
        refCount: 1,
        project,
        store: storeName,
        tagged: false,
      });
    }

    const content = fs.readFileSync(findingsPath, "utf8");
    const lines = content.split("\n");
    // No cap for focused project; high caps otherwise
    const isFocused = focusProject && project === focusProject;
    const MAX_TAGGED = isFocused ? Infinity : 200;
    const MAX_UNTAGGED = isFocused ? Infinity : 100;
    let taggedCount = 0;
    let untaggedAdded = 0;

    // Support heading-based findings: ## topic / ### title / paragraph
    let currentHeadingTag: string | undefined;
    let _currentHeadingTitle: string | undefined;
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];

      // Track heading context for heading-based findings
      const h2Match = line.match(/^##\s+([a-z_-]+)\s*$/i);
      if (h2Match) {
        currentHeadingTag = h2Match[1].toLowerCase();
        _currentHeadingTitle = undefined;
        continue;
      }
      const h3Match = line.match(/^###\s+(.+)$/);
      if (h3Match && currentHeadingTag) {
        // Read the next non-empty line as the body
        let body = "";
        for (let j = lineIdx + 1; j < lines.length; j++) {
          const next = lines[j].trim();
          if (!next) continue;
          if (next.startsWith("#")) break;
          body = next;
          break;
        }
        const title = h3Match[1].trim();
        const text = body ? `${title} — ${body}` : title;
        if (text.length >= 10) {
          if (taggedCount >= MAX_TAGGED) continue;
          const topic = classifyTopicForText(`[${currentHeadingTag}] ${text}`, projectTopics);
          const scoreKey = entryScoreKey(project, FINDINGS_FILENAME, `[${currentHeadingTag}] ${text}`);
          const nodeId = stableId("finding", scoreKey);
          taggedCount++;
          nodes.push({
            id: nodeId,
            label: text.length > 55 ? `${text.slice(0, 52)}...` : text,
            fullLabel: text,
            group: `topic:${topic.slug}`,
            refCount: taggedCount,
            project,
            store: storeName,
            tagged: true,
            scoreKey,
            scoreKeys: [scoreKey],
            refDocs: [{ doc: `${project}/FINDINGS.md`, project, scoreKey }],
            topicSlug: topic.slug,
            topicLabel: topic.label,
          });
          links.push({ source: project, target: nodeId });
          for (const other of exactProjectMentions(text, projectSet, project)) {
            links.push({ source: project, target: other });
          }
        }
        continue;
      }

      // Standard bullet-based findings: - [tag] text
      const tagMatch = line.match(/^-\s+\[([a-z_-]+)\]\s+(.+?)(?:\s*<!--.*-->)?$/);
      if (tagMatch) {
        if (taggedCount >= MAX_TAGGED) continue;
        const tag = tagMatch[1];
        const text = tagMatch[2].trim();
        const label = text.length > 55 ? `${text.slice(0, 52)}...` : text;
        // Classify the finding using the project's topic system
        const topic = classifyTopicForText(`[${tag}] ${text}`, projectTopics);
        const scoreKey = entryScoreKey(project, FINDINGS_FILENAME, `[${tag}] ${text}`);
        const nodeId = stableId("finding", scoreKey);
        taggedCount++;
        nodes.push({
          id: nodeId,
          label,
          fullLabel: text,
          group: `topic:${topic.slug}`,
          refCount: taggedCount,
          project,
          store: storeName,
          tagged: true,
          scoreKey,
          scoreKeys: [scoreKey],
          refDocs: [{ doc: `${project}/FINDINGS.md`, project, scoreKey }],
          topicSlug: topic.slug,
          topicLabel: topic.label,
        });
        links.push({ source: project, target: nodeId });
        for (const other of exactProjectMentions(text, projectSet, project)) {
          links.push({ source: project, target: other });
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
      const scoreKey = entryScoreKey(project, FINDINGS_FILENAME, text);
      const nodeId = stableId("finding", scoreKey);
      untaggedAdded++;
      nodes.push({
        id: nodeId,
        label,
        fullLabel: text,
        group: `topic:${topic.slug}`,
        refCount: untaggedAdded,
        project,
        store: storeName,
        tagged: false,
        scoreKey,
        scoreKeys: [scoreKey],
        refDocs: [{ doc: `${project}/FINDINGS.md`, project, scoreKey }],
        topicSlug: topic.slug,
        topicLabel: topic.label,
      });
      links.push({ source: project, target: nodeId });
    }
  }

  // ── Tasks ──────────────────────────────────────────────────────────
  try {
    for (const { storePath, project } of storeProjects) {
      const taskResult = readTasks(storePath, project);
      if (!taskResult.ok) continue;
      const taskStoreName = storePathToName.get(storePath) || "unknown";
      const doc = taskResult.data;
      let taskCount = 0;
      const MAX_TASKS = 50;
      for (const section of ["Active", "Queue"] as const) {
        const group = section === "Active" ? "task-active" : "task-queue";
        for (const item of doc.items[section]) {
          if (taskCount >= MAX_TASKS) break;
          const nodeId = `${project}:task:${item.id}`;
          const label = item.line.length > 55 ? `${item.line.slice(0, 52)}...` : item.line;
          const scoreKey = entryScoreKey(project, TASKS_FILENAME, item.line);
          nodes.push({
            id: nodeId,
            label,
            fullLabel: item.line,
            group,
            project,
            store: taskStoreName,
            tagged: false,
            scoreKey,
            scoreKeys: [scoreKey],
            refDocs: [{ doc: `${project}/${TASKS_FILENAME}`, project, scoreKey }],
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

  // ── Fragments (fragment graph) ──────────────────────────────────────
  const ownDb = !existingDb;
  let db: SqlJsDatabase | null = existingDb ?? null;
  try {
    if (!db) db = await buildIndex(phrenPath, profile);
    const rows = queryRows(
      db,
      `SELECT e.id, e.name, e.type, COUNT(DISTINCT el.source_doc) as ref_count
       FROM entities e JOIN entity_links el ON el.target_id = e.id WHERE e.type != 'document'
       GROUP BY e.id, e.name, e.type ORDER BY ref_count DESC LIMIT 5000`,
      [],
    );
    const refRows = queryRows(
      db,
      `SELECT e.id, el.source_doc
       FROM entities e
       JOIN entity_links el ON el.target_id = e.id
       WHERE e.type != 'document'`,
      [],
    );
    const refsByEntity = new Map<number, GraphDocRef[]>();
    const seenEntityDoc = new Set<string>();
    if (refRows) {
      for (const row of refRows) {
        const entityId = typeof row[0] === "number" ? row[0] : -1;
        if (entityId < 0) continue;
        const doc = String(row[1] ?? "");
        if (!doc) continue;
        const entityDocKey = `${entityId}::${doc}`;
        if (seenEntityDoc.has(entityDocKey)) continue;
        seenEntityDoc.add(entityDocKey);
        const project = projectFromSourceDoc(doc);
        const docRow = queryDocBySourceKey(db, phrenPath, doc);
        const content = docRow?.content ?? "";
        const filename = docRow?.filename ?? "";
        const scoreKey = project && filename && content ? entryScoreKey(project, filename, content) : undefined;
        const refs = refsByEntity.get(entityId) ?? [];
        refs.push({ doc, project, scoreKey });
        refsByEntity.set(entityId, refs);
      }
    }
    if (rows) {
      for (const row of rows) {
        const entityId = typeof row[0] === "number" ? row[0] : -1;
        if (entityId < 0) continue;
        const name = String(row[1] ?? "");
        const type = String(row[2] ?? "");
        const refCount = typeof row[3] === "number" ? row[3] : 0;
        const refs = (refsByEntity.get(entityId) ?? []).slice().sort((a, b) => a.doc.localeCompare(b.doc));
        const scoreKeys = refs
          .map((ref) => ref.scoreKey)
          .filter((key): key is string => Boolean(key))
          .sort();
        // Only include entities that link to at least one visible project
        const linkedProjects = new Set<string>();
        for (const ref of refs) {
          if (ref.project && projectSet.has(ref.project)) linkedProjects.add(ref.project);
        }
        if (linkedProjects.size === 0) continue; // skip orphan entities from other profiles/stores

        const nodeId = `entity:${stableId("entity", type, name)}`;
        nodes.push({
          id: nodeId,
          label: name.length > 55 ? `${name.slice(0, 52)}...` : name,
          fullLabel: name,
          group: "entity",
          project: "",
          tagged: false,
          refCount,
          scoreKey: scoreKeys[0],
          scoreKeys,
          entityType: type,
          refDocs: refs,
        });
        for (const proj of linkedProjects) {
          links.push({ source: nodeId, target: proj });
        }
      }
    }
  } catch {
    // fragment loading failed — continue with other data sources
  } finally {
    if (ownDb && db) {
      try { db.close(); } catch { /* already closed or failed — ignore */ }
    }
  }

  // ── Reference docs ────────────────────────────────────────────────
  try {
    for (const { storePath, project } of storeProjects) {
      const refStoreName = storePathToName.get(storePath) || "unknown";
      const refDir = path.join(storePath, project, "reference");
      if (!fs.existsSync(refDir) || !fs.statSync(refDir).isDirectory()) continue;
      const files = fs.readdirSync(refDir);
      const MAX_REFS = 20;
      let refCount = 0;
      for (const file of files) {
        if (refCount >= MAX_REFS) break;
        const nodeId = `${project}:ref:${file}`;
        const docRef = `${project}/reference/${file}`;
        nodes.push({
          id: nodeId,
          label: file.length > 55 ? `${file.slice(0, 52)}...` : file,
          fullLabel: file,
          group: "reference",
          project,
          store: refStoreName,
          tagged: false,
          scoreKeys: [],
          refDocs: [{ doc: docRef, project }],
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
    const scoresPath = path.join(phrenPath, ".runtime", "memory-scores.json");
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

export function recentUsage(phrenPath: string): string[] {
  const usage = memoryUsageLogFile(phrenPath);
  if (!fs.existsSync(usage)) return [];
  const lines = fs.readFileSync(usage, "utf8").trim().split("\n").filter(Boolean);
  return lines.slice(-40).reverse();
}

export function recentAccepted(phrenPath: string): string[] {
  const audit = path.join(runtimeDir(phrenPath), "audit.log");
  if (!fs.existsSync(audit)) return [];
  const lines = fs.readFileSync(audit, "utf8").split("\n").filter((line) => line.includes("approve_memory"));
  return lines.slice(-40).reverse();
}

function buildProjectInfo(basePath: string, project: string, store?: string): ProjectInfo {
  const dir = path.join(basePath, project);
  const findingsPath = path.join(dir, FINDINGS_FILENAME);
  const taskPath = resolveTaskFilePath(basePath, project);
  const claudeMdPath = path.join(dir, "CLAUDE.md");
  const summaryPath = path.join(dir, "summary.md");
  const refPath = path.join(dir, "reference");

  let findingCount = 0;
  if (fs.existsSync(findingsPath)) {
    const content = fs.readFileSync(findingsPath, "utf8");
    findingCount = (content.match(/^- /gm) || []).length;
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

  return {
    name: project,
    storePath: basePath,
    store,
    findingCount,
    taskCount,
    hasClaudeMd: fs.existsSync(claudeMdPath),
    hasSummary: fs.existsSync(summaryPath),
    hasReference: fs.existsSync(refPath) && fs.statSync(refPath).isDirectory(),
    summaryText,
    githubUrl,
    sparkline,
  };
}

export function collectProjectsForUI(phrenPath: string, profile?: string): ProjectInfo[] {
  const projects = getProjectDirs(phrenPath, profile).map((projectDir) => path.basename(projectDir)).filter((project) => project !== "global");

  let allowedProjects: Set<string> | null = null;
  try {
    const contextPath = homePath(".phren-context.md");
    if (fs.existsSync(contextPath)) {
      const contextContent = fs.readFileSync(contextPath, "utf8");
      const activeMatch = contextContent.match(/Active projects?:\s*(.+)/i);
      if (activeMatch) {
        const names = activeMatch[1].split(/[,;]/).map((name) => name.trim().toLowerCase()).filter(Boolean);
        if (names.length) allowedProjects = new Set(names);
      }
    }
  } catch (err: unknown) {
    logger.debug("memory-ui", `memory-ui filterByProfile: ${errorMessage(err)}`);
  }

  const results: ProjectInfo[] = [];
  const seen = new Set<string>();

  for (const project of projects) {
    if (allowedProjects && !allowedProjects.has(project.toLowerCase())) continue;
    seen.add(project);
    results.push(buildProjectInfo(phrenPath, project));
  }

  // Include projects from non-primary stores
  try {
    const teamStores = getNonPrimaryStores(phrenPath);
    for (const store of teamStores) {
      if (!fs.existsSync(store.path)) continue;
      const teamProjects = getStoreProjectDirs(store).map((d: string) => path.basename(d)).filter((p: string) => p !== "global");
      for (const project of teamProjects) {
        if (seen.has(project)) continue; // skip if same name exists in primary
        seen.add(project);
        results.push(buildProjectInfo(store.path, project, store.name));
      }
    }
  } catch (err: unknown) {
    logger.debug("memory-ui", `collectProjectsForUI team stores: ${errorMessage(err)}`);
  }

  return results.sort((a, b) => (b.findingCount + b.taskCount) - (a.findingCount + a.taskCount));
}
