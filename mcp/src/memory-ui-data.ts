import * as fs from "fs";
import * as path from "path";
import {
  getProjectDirs,
  runtimeDir,
  homePath,
} from "./shared.js";
import { errorMessage } from "./utils.js";
import { readInstallPreferences } from "./init-preferences.js";
import { readCustomHooks } from "./hooks.js";
import { hookConfigPaths, hookConfigRoots } from "./provider-adapters.js";

interface GraphNode {
  id: string;
  label: string;
  fullLabel: string;
  group: "project" | "decision" | "pitfall" | "pattern" | "tradeoff" | "architecture" | "bug";
  refCount: number;
}

interface GraphLink {
  source: string;
  target: string;
}

interface ProjectInfo {
  name: string;
  findingCount: number;
  backlogCount: number;
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
    const runtimeHealth = path.join(cortexPath, ".governance", "runtime-health.json");
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

export function collectSkillsForUI(cortexPath: string, profile?: string): Array<{ name: string; source: string; path: string }> {
  const seen = new Set<string>();
  const results: Array<{ name: string; source: string; path: string }> = [];

  function scan(dir: string, label: string) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const isDir = entry.isDirectory();
      const filePath = isDir
        ? path.join(dir, entry.name, "SKILL.md")
        : entry.name.endsWith(".md") ? path.join(dir, entry.name) : null;
      if (!filePath || seen.has(filePath) || !fs.existsSync(filePath)) continue;
      seen.add(filePath);
      results.push({ name: isDir ? entry.name : entry.name.replace(/\.md$/, ""), source: label, path: filePath });
    }
  }

  scan(path.join(cortexPath, "global", "skills"), "global");
  for (const dir of getProjectDirs(cortexPath, profile)) {
    const name = path.basename(dir);
    if (name === "global") continue;
    scan(path.join(dir, "skills"), name);
    scan(path.join(dir, ".claude", "skills"), name);
  }
  return results;
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

export function buildGraph(cortexPath: string, profile?: string, focusProject?: string): { nodes: GraphNode[]; links: GraphLink[]; total: number } {
  const projects = getProjectDirs(cortexPath, profile).map((projectDir) => path.basename(projectDir)).filter((project) => project !== "global");
  const nodes: GraphNode[] = [];
  const links: GraphLink[] = [];
  const typeMap: Record<string, "decision" | "pitfall" | "pattern" | "tradeoff" | "architecture" | "bug"> = {
    decision: "decision",
    pitfall: "pitfall",
    pattern: "pattern",
    tradeoff: "tradeoff",
    architecture: "architecture",
    bug: "bug",
  };
  const projectSet = new Set(projects);

  for (const project of projects) {
    const findingsPath = path.join(cortexPath, project, "FINDINGS.md");
    if (!fs.existsSync(findingsPath)) {
      nodes.push({ id: project, label: project, fullLabel: project, group: "project", refCount: 0 });
      continue;
    }

    nodes.push({ id: project, label: project, fullLabel: project, group: "project", refCount: 1 });

    const content = fs.readFileSync(findingsPath, "utf8");
    const lines = content.split("\n");
    // No cap for focused project; high caps otherwise
    const isFocused = focusProject && project === focusProject;
    const MAX_TAGGED = isFocused ? Infinity : 200;
    const MAX_UNTAGGED = isFocused ? Infinity : 100;
    let taggedCount = 0;
    let untaggedAdded = 0;

    for (const line of lines) {
      const tagMatch = line.match(/^-\s+\[(decision|pitfall|pattern|tradeoff|architecture|bug)\]\s+(.+?)(?:\s*<!--.*-->)?$/);
      if (tagMatch) {
        if (taggedCount >= MAX_TAGGED) continue;
        const tag = tagMatch[1] as "decision" | "pitfall" | "pattern" | "tradeoff" | "architecture" | "bug";
        const text = tagMatch[2].trim();
        const label = text.length > 55 ? `${text.slice(0, 52)}...` : text;
        const nodeId = `${project}:${tag}:${nodes.length}`;
        taggedCount++;
        nodes.push({ id: nodeId, label, fullLabel: text, group: typeMap[tag], refCount: taggedCount });
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
      const nodeId = `${project}:finding:${nodes.length}`;
      untaggedAdded++;
      nodes.push({ id: nodeId, label, fullLabel: text, group: "pattern", refCount: untaggedAdded });
      links.push({ source: project, target: nodeId });
    }
  }

  const seen = new Set<string>();
  const total = nodes.length;
  const result: { nodes: GraphNode[]; links: GraphLink[]; total: number } = {
    nodes,
    links: links.filter((link) => {
      const key = [link.source, link.target].sort().join("||");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
    total,
  };
  return result;
}

export function recentUsage(cortexPath: string): string[] {
  const usage = path.join(cortexPath, ".governance", "memory-usage.log");
  if (!fs.existsSync(usage)) return [];
  const lines = fs.readFileSync(usage, "utf8").trim().split("\n").filter(Boolean);
  return lines.slice(-40).reverse();
}

export function recentAccepted(cortexPath: string): string[] {
  const newAudit = path.join(runtimeDir(cortexPath), "audit.log");
  const legacyAudit = path.join(cortexPath, ".cortex-audit.log");
  const audit = fs.existsSync(newAudit) ? newAudit : legacyAudit;
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
    const backlogPath = path.join(dir, "backlog.md");
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

    let backlogCount = 0;
    if (fs.existsSync(backlogPath)) {
      const content = fs.readFileSync(backlogPath, "utf8");
      const queueMatch = content.match(/## Queue[\s\S]*?(?=## |$)/);
      if (queueMatch) backlogCount = (queueMatch[0].match(/^- /gm) || []).length;
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
      backlogCount,
      hasClaudeMd: fs.existsSync(claudeMdPath),
      hasSummary: fs.existsSync(summaryPath),
      hasReference: fs.existsSync(refPath) && fs.statSync(refPath).isDirectory(),
      summaryText,
      githubUrl,
      sparkline,
    });
  }

  return results.sort((a, b) => (b.findingCount + b.backlogCount) - (a.findingCount + a.backlogCount));
}
