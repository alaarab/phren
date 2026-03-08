import * as http from "http";
import * as crypto from "crypto";
import { timingSafeEqual } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as querystring from "querystring";
import {
  CortexError,
  getProjectDirs,
  runtimeDir,
} from "./shared.js";
import {
  approveQueueItem,
  editQueueItem,
  readReviewQueue,
  rejectQueueItem,
} from "./data-access.js";
import { isValidProjectName, errorMessage } from "./utils.js";
import { readInstallPreferences, writeInstallPreferences, type InstallPreferences } from "./init-preferences.js";
import { readCustomHooks } from "./hooks.js";

export interface ReviewUiOptions {
  authToken?: string;
  csrfTokens?: Map<string, number>;
}

const CSRF_TOKEN_TTL_MS = 15 * 60 * 1000;

function pruneExpiredCsrfTokens(csrfTokens?: Map<string, number>): void {
  if (!csrfTokens) return;
  const now = Date.now();
  for (const [token, createdAt] of csrfTokens) {
    if (now - createdAt > CSRF_TOKEN_TTL_MS) csrfTokens.delete(token);
  }
}

function setCommonHeaders(res: http.ServerResponse): void {
  res.setHeader("Referrer-Policy", "no-referrer");
}

function getSubmittedAuthToken(req: http.IncomingMessage, url: string, parsedBody?: querystring.ParsedUrlQuery): string {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string") {
    const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    if (bearerMatch) return bearerMatch[1];
  }

  const query = url.includes("?") ? querystring.parse(url.slice(url.indexOf("?") + 1)) : {};
  const queryAuth = query._auth;
  if (typeof queryAuth === "string") return queryAuth;

  const bodyAuth = parsedBody?._auth;
  if (typeof bodyAuth === "string") return bodyAuth;

  return "";
}

function authTokensMatch(submitted: string, authToken?: string): boolean {
  if (!authToken || !submitted) return false;
  const submittedBuffer = Buffer.from(submitted);
  const authTokenBuffer = Buffer.from(authToken);
  if (submittedBuffer.length !== authTokenBuffer.length) return false;
  return timingSafeEqual(submittedBuffer, authTokenBuffer);
}

function recentUsage(cortexPath: string): string[] {
  const usage = path.join(cortexPath, ".governance", "memory-usage.log");
  if (!fs.existsSync(usage)) return [];
  const lines = fs.readFileSync(usage, "utf8").trim().split("\n").filter(Boolean);
  return lines.slice(-40).reverse();
}

function recentAccepted(cortexPath: string): string[] {
  const newAudit = path.join(runtimeDir(cortexPath), "audit.log");
  const legacyAudit = path.join(cortexPath, ".cortex-audit.log");
  const audit = fs.existsSync(newAudit) ? newAudit : legacyAudit;
  if (!fs.existsSync(audit)) return [];
  const lines = fs.readFileSync(audit, "utf8").split("\n").filter((l) => l.includes("approve_memory"));
  return lines.slice(-40).reverse();
}

function h(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Skills & Hooks helpers ──────────────────────────────────────────────────

const HOOK_CONFIG_PATHS = (cortexPath: string): Record<string, string> => ({
  claude: path.join(cortexPath, "cortex.SKILL.md"),
  copilot: path.join(os.homedir(), ".github", "hooks", "cortex.json"),
  cursor: path.join(os.homedir(), ".cursor", "hooks.json"),
  codex: path.join(cortexPath, "codex.json"),
});

function isAllowedFilePath(filePath: string, cortexPath: string): boolean {
  const resolved = path.resolve(filePath);
  const allowedRoots = [
    path.resolve(cortexPath),
    path.resolve(path.join(os.homedir(), ".github", "hooks")),
    path.resolve(path.join(os.homedir(), ".cursor")),
  ];
  if (!allowedRoots.some(root => resolved === root || resolved.startsWith(root + path.sep))) {
    return false;
  }
  // Resolve symlinks to prevent escaping the allowed boundary (Q8)
  let realResolved: string;
  try {
    realResolved = fs.realpathSync(resolved);
  } catch {
    // File doesn't exist yet (e.g. new skill); use the lexically resolved path
    realResolved = resolved;
  }
  const allowedRealRoots = allowedRoots.map(r => {
    try { return fs.realpathSync(r); } catch { return r; }
  });
  return allowedRealRoots.some(root => realResolved === root || realResolved.startsWith(root + path.sep));
}

function collectSkillsForUI(cortexPath: string): Array<{ name: string; source: string; path: string }> {
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
  for (const dir of getProjectDirs(cortexPath)) {
    const name = path.basename(dir);
    if (name === "global") continue;
    scan(path.join(dir, "skills"), name);
    scan(path.join(dir, ".claude", "skills"), name);
  }
  return results;
}

function getHooksData(cortexPath: string) {
  const prefs = readInstallPreferences(cortexPath);
  const globalEnabled = prefs.hooksEnabled !== false;
  const toolPrefs = (prefs.hookTools && typeof prefs.hookTools === "object") ? prefs.hookTools : {};
  const paths = HOOK_CONFIG_PATHS(cortexPath);

  const tools = (["claude", "copilot", "cursor", "codex"] as const).map(tool => ({
    tool,
    enabled: globalEnabled && toolPrefs[tool] !== false,
    configPath: paths[tool],
    exists: fs.existsSync(paths[tool]),
  }));

  return { globalEnabled, tools, customHooks: readCustomHooks(cortexPath) };
}

// ── Graph data ──────────────────────────────────────────────────────────────

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

function buildGraph(cortexPath: string): { nodes: GraphNode[]; links: GraphLink[] } {
  const projects = getProjectDirs(cortexPath).map((p) => path.basename(p)).filter((p) => p !== "global");
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
      // Still add project node even with no findings
      nodes.push({ id: project, label: project, fullLabel: project, group: "project", refCount: 0 });
      continue;
    }

    nodes.push({ id: project, label: project, fullLabel: project, group: "project", refCount: 1 });

    const content = fs.readFileSync(findingsPath, "utf8");
    const lines = content.split("\n");
    let taggedCount = 0;
    let untaggedAdded = 0;

    for (const line of lines) {
      // Tagged findings: [decision], [pitfall], [pattern], [tradeoff], [architecture], [bug]
      const tagMatch = line.match(/^-\s+\[(decision|pitfall|pattern|tradeoff|architecture|bug)\]\s+(.+?)(?:\s*<!--.*-->)?$/);
      if (tagMatch) {
        const tag = tagMatch[1] as "decision" | "pitfall" | "pattern" | "tradeoff" | "architecture" | "bug";
        const text = tagMatch[2].trim();
        const label = text.length > 55 ? text.slice(0, 52) + "..." : text;
        const nodeId = `${project}:${tag}:${nodes.length}`;
        taggedCount++;
        nodes.push({ id: nodeId, label, fullLabel: text, group: typeMap[tag], refCount: taggedCount });
        links.push({ source: project, target: nodeId });
        // Cross-project link: if this finding mentions another project
        for (const other of projectSet) {
          if (other !== project && text.toLowerCase().includes(other.toLowerCase())) {
            links.push({ source: project, target: other });
          }
        }
        continue;
      }

      // Untagged regular findings (up to 12 per project to avoid overcrowding)
      if (untaggedAdded < 12) {
        const plainMatch = line.match(/^-\s+(.+?)(?:\s*<!--.*-->)?$/);
        if (plainMatch) {
          const text = plainMatch[1].trim();
          if (text.length < 10) continue; // skip very short lines
          const label = text.length > 55 ? text.slice(0, 52) + "..." : text;
          const nodeId = `${project}:finding:${nodes.length}`;
          untaggedAdded++;
          nodes.push({ id: nodeId, label, fullLabel: text, group: "pattern", refCount: untaggedAdded });
          links.push({ source: project, target: nodeId });
        }
      }
    }
  }

  // Deduplicate links
  const seen = new Set<string>();
  return {
    nodes,
    links: links.filter((l) => {
      const key = [l.source, l.target].sort().join("||");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  };
}

// ── Projects data ───────────────────────────────────────────────────────────

interface ProjectInfo {
  name: string;
  findingCount: number;
  backlogCount: number;
  hasClaudeMd: boolean;
  hasSummary: boolean;
  hasReference: boolean;
  summaryText: string;
  githubUrl?: string;
}

function extractGithubUrl(content: string): string | undefined {
  const match = content.match(/https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/);
  return match ? match[0] : undefined;
}

function collectProjectsForUI(cortexPath: string): ProjectInfo[] {
  const projects = getProjectDirs(cortexPath).map((p) => path.basename(p)).filter((p) => p !== "global");

  // Q34: Filter by machine profile if available
  let allowedProjects: Set<string> | null = null;
  try {
    const contextPath = path.join(os.homedir(), ".cortex-context.md");
    if (fs.existsSync(contextPath)) {
      const contextContent = fs.readFileSync(contextPath, "utf8");
      const activeMatch = contextContent.match(/Active projects?:\s*(.+)/i);
      if (activeMatch) {
        const names = activeMatch[1].split(/[,;]/).map((s) => s.trim().toLowerCase()).filter(Boolean);
        if (names.length) {
          allowedProjects = new Set(names);
        }
      }
    }
  } catch (err: unknown) {
    // If unparseable, return all projects
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

    let backlogCount = 0;
    if (fs.existsSync(backlogPath)) {
      const content = fs.readFileSync(backlogPath, "utf8");
      const queueMatch = content.match(/## Queue[\s\S]*?(?=## |$)/);
      if (queueMatch) {
        backlogCount = (queueMatch[0].match(/^- /gm) || []).length;
      }
    }

    let summaryText = "";
    if (fs.existsSync(summaryPath)) {
      summaryText = fs.readFileSync(summaryPath, "utf8").trim();
      if (summaryText.length > 300) summaryText = summaryText.slice(0, 300) + "...";
    }

    // Q33: Extract GitHub URL from CLAUDE.md or summary.md
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
    });
  }

  return results.sort((a, b) => (b.findingCount + b.backlogCount) - (a.findingCount + a.backlogCount));
}

// ── Render ───────────────────────────────────────────────────────────────────

function renderPage(cortexPath: string, csrfToken?: string, authToken?: string): string {
  const projects = getProjectDirs(cortexPath).map((p) => path.basename(p)).filter((p) => p !== "global");
  const usage = recentUsage(cortexPath);
  const accepted = recentAccepted(cortexPath);
  const rows: string[] = [];

  const csrfField = csrfToken ? `<input type="hidden" name="_csrf" value="${h(csrfToken)}" />` : "";
  const authField = authToken ? `<input type="hidden" name="_auth" value="${h(authToken)}" />` : "";
  const hiddenFields = csrfField + authField;

  for (const project of projects) {
    const queueResult = readReviewQueue(cortexPath, project);
    const items = queueResult.ok ? queueResult.data : [];
    if (!items.length) continue;
    for (const item of items) {
      rows.push(`
        <div class="review-card">
          <div class="review-card-header">
            <span class="badge badge-project">${h(project)}</span>
            <span class="badge">${h(item.section)}</span>${item.machine ? `
            <span class="badge" style="background:#e0e7ff;color:#3730a3;font-size:11px" title="Captured on machine: ${h(item.machine)}">${h(item.machine)}</span>` : ""}
            <span class="text-muted" style="font-size:12px;margin-left:auto">${h(item.date)}</span>
          </div>
          <div class="review-card-text">${h(item.text)}</div>
          <div class="review-card-actions">
            <form method="POST" action="/approve">
              ${hiddenFields}
              <input type="hidden" name="project" value="${h(project)}" />
              <input type="hidden" name="line" value="${h(item.line)}" />
              <button type="submit" class="btn btn-sm btn-approve">Approve</button>
            </form>
            <form method="POST" action="/reject">
              ${hiddenFields}
              <input type="hidden" name="project" value="${h(project)}" />
              <input type="hidden" name="line" value="${h(item.line)}" />
              <button type="submit" class="btn btn-sm btn-reject">Reject</button>
            </form>
            <button type="button" class="btn btn-sm" onclick="toggleReviewEdit(this)">Edit</button>
          </div>
          <div class="review-card-edit" style="display:none">
            <form method="POST" action="/edit">
              ${hiddenFields}
              <input type="hidden" name="project" value="${h(project)}" />
              <input type="hidden" name="line" value="${h(item.line)}" />
              <textarea name="new_text" class="review-edit-textarea">${h(item.text)}</textarea>
              <div style="display:flex;gap:8px;margin-top:8px">
                <button type="submit" class="btn btn-sm btn-primary">Save</button>
                <button type="button" class="btn btn-sm" onclick="toggleReviewEdit(this)">Cancel</button>
              </div>
            </form>
          </div>
        </div>
      `);
    }
  }

  const acceptedItems = accepted.map((l) => `<li>${h(l)}</li>`).join("\n");
  const usageItems = usage.map((l) => `<li>${h(l)}</li>`).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Cortex Dashboard</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #f1f5f9;
      --surface: #ffffff;
      --ink: #0f172a;
      --muted: #64748b;
      --accent: #0d9488;
      --accent-hover: #0f766e;
      --border: #e2e8f0;
      --border-light: #f1f5f9;
      --danger: #ef4444;
      --warning: #f59e0b;
      --success: #10b981;
      --purple: #7c3aed;
      --blue: #3b82f6;
      --red: #ef4444;
      --green: #10b981;
      --radius: 8px;
      --radius-sm: 4px;
      --shadow-sm: 0 1px 2px rgba(0,0,0,.05);
      --shadow: 0 1px 3px rgba(0,0,0,.1), 0 1px 2px rgba(0,0,0,.06);
      --shadow-lg: 0 4px 6px -1px rgba(0,0,0,.1), 0 2px 4px -2px rgba(0,0,0,.1);
      --font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      --mono: "JetBrains Mono", "Fira Code", "Cascadia Code", monospace;
    }

    body {
      font-family: var(--font);
      background: var(--bg);
      color: var(--ink);
      line-height: 1.5;
      min-height: 100vh;
    }

    /* ── Header ─────────────────────────────────────────────── */
    .header {
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      padding: 0 24px;
      display: flex;
      align-items: center;
      gap: 32px;
      height: 56px;
      position: sticky;
      top: 0;
      z-index: 100;
      box-shadow: var(--shadow-sm);
    }
    .header-brand {
      font-size: 18px;
      font-weight: 700;
      color: var(--accent);
      display: flex;
      align-items: center;
      gap: 8px;
      letter-spacing: -0.02em;
    }
    .header-brand svg { width: 22px; height: 22px; }
    .nav { display: flex; gap: 0; height: 100%; }
    .nav-item {
      padding: 0 16px;
      font-size: 13px;
      font-weight: 500;
      color: var(--muted);
      cursor: pointer;
      border: none;
      background: none;
      height: 100%;
      display: flex;
      align-items: center;
      border-bottom: 2px solid transparent;
      transition: color .15s, border-color .15s;
      font-family: var(--font);
    }
    .nav-item:hover { color: var(--ink); }
    .nav-item.active { color: var(--accent); border-bottom-color: var(--accent); }
    .nav-item .count {
      background: var(--bg);
      color: var(--muted);
      font-size: 11px;
      padding: 1px 6px;
      border-radius: 10px;
      margin-left: 6px;
      font-weight: 600;
    }

    /* ── Main ────────────────────────────────────────────────── */
    .main { padding: 24px; max-width: 1400px; margin: 0 auto; }
    .tab-content { display: none; }
    .tab-content.active { display: block; }

    /* ── Cards ───────────────────────────────────────────────── */
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow-sm);
    }
    .card-header {
      padding: 16px 20px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .card-header h2 { font-size: 15px; font-weight: 600; }
    .card-body { padding: 20px; }

    /* ── Projects Tab ────────────────────────────────────────── */
    .projects-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 16px;
    }
    .project-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 20px;
      cursor: pointer;
      transition: box-shadow .2s, border-color .2s, transform .15s;
      position: relative;
    }
    .project-card:hover {
      box-shadow: var(--shadow-lg);
      border-color: var(--accent);
      transform: translateY(-1px);
    }
    .project-card.selected {
      border-color: var(--accent);
      box-shadow: 0 0 0 1px var(--accent), var(--shadow-lg);
    }
    .project-card-name {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 6px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .project-card-summary {
      font-size: 13px;
      color: var(--muted);
      line-height: 1.5;
      margin-bottom: 12px;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .project-card-stats {
      display: flex;
      gap: 16px;
      font-size: 12px;
      color: var(--muted);
    }
    .project-card-stat {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .project-card-stat strong { color: var(--ink); font-weight: 600; }

    /* Project detail panel */
    .project-detail {
      margin-top: 20px;
    }
    .project-detail-header {
      display: flex;
      align-items: center;
      gap: 16px;
      margin-bottom: 16px;
    }
    .project-detail-header h2 { font-size: 20px; font-weight: 700; }
    .project-detail-header .btn { font-size: 12px; }
    .project-detail-tabs {
      display: flex;
      gap: 0;
      border-bottom: 1px solid var(--border);
      margin-bottom: 0;
    }
    .project-detail-tab {
      padding: 10px 20px;
      font-size: 13px;
      font-weight: 500;
      color: var(--muted);
      cursor: pointer;
      border: none;
      background: none;
      border-bottom: 2px solid transparent;
      font-family: var(--font);
      transition: color .15s;
    }
    .project-detail-tab:hover { color: var(--ink); }
    .project-detail-tab.active { color: var(--accent); border-bottom-color: var(--accent); }
    .project-detail-content {
      background: var(--surface);
      border: 1px solid var(--border);
      border-top: none;
      border-radius: 0 0 var(--radius) var(--radius);
      min-height: 400px;
    }
    .project-detail-content pre {
      margin: 0;
      padding: 20px;
      font-family: var(--mono);
      font-size: 12.5px;
      line-height: 1.7;
      white-space: pre-wrap;
      word-break: break-word;
      overflow: auto;
      max-height: 600px;
    }
    .project-detail-empty {
      padding: 60px 20px;
      text-align: center;
      color: var(--muted);
      font-size: 14px;
    }

    /* ── Review Tab ──────────────────────────────────────────── */
    .review-cards { display: flex; flex-direction: column; gap: 12px; }
    .review-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 16px 20px;
      box-shadow: var(--shadow-sm);
    }
    .review-card-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 12px;
    }
    .review-card-text {
      font-size: 14px;
      line-height: 1.6;
      margin-bottom: 12px;
      color: var(--ink);
    }
    .review-card-actions {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .review-card-edit {
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid var(--border-light);
    }
    .review-edit-textarea {
      width: 100%;
      min-height: 80px;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      font-size: 13px;
      font-family: var(--font);
      line-height: 1.5;
      resize: vertical;
    }
    .review-help summary {
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      color: var(--muted);
      padding: 8px 0;
    }
    .review-help dl { margin: 8px 0 0; font-size: 13px; }
    .review-help dt { font-weight: 600; margin-top: 10px; color: var(--ink); }
    .review-help dd { margin: 2px 0 0 16px; color: var(--muted); line-height: 1.5; }
    .panes { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 20px; }
    .card ul { margin: 0; padding-left: 18px; max-height: 220px; overflow: auto; font-size: 13px; }
    .card li { padding: 2px 0; color: var(--muted); }

    /* ── Star button ─────────────────────────────────────────── */
    .star-btn {
      position: absolute;
      top: 10px;
      right: 10px;
      background: none;
      border: none;
      font-size: 18px;
      cursor: pointer;
      color: var(--border);
      transition: color .15s;
      padding: 2px 4px;
      line-height: 1;
    }
    .star-btn:hover { color: var(--warning); }
    .star-btn.starred { color: var(--warning); }

    /* ── Project search ──────────────────────────────────────── */
    .projects-search {
      width: 100%;
      padding: 10px 14px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      font-size: 14px;
      font-family: var(--font);
      margin-bottom: 16px;
      background: var(--surface);
      outline: none;
      transition: border-color .15s;
    }
    .projects-search:focus { border-color: var(--accent); }

    /* ── GitHub link ──────────────────────────────────────────── */
    .github-link {
      font-size: 12px;
      color: var(--muted);
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .github-link:hover { color: var(--ink); }

    /* ── Graph Tab ───────────────────────────────────────────── */
    .graph-container {
      background: #0f172a;
      border-radius: var(--radius);
      border: 1px solid var(--border);
      overflow: hidden;
      position: relative;
    }
    #graph-canvas {
      width: 100%;
      height: calc(100vh - 160px);
      min-height: 800px;
      display: block;
      cursor: grab;
    }
    #graph-canvas:active { cursor: grabbing; }
    .graph-controls {
      position: absolute;
      top: 12px;
      right: 12px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .graph-controls button {
      width: 32px;
      height: 32px;
      background: rgba(255,255,255,.1);
      border: 1px solid rgba(255,255,255,.15);
      border-radius: 6px;
      color: #e2e8f0;
      font-size: 16px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      backdrop-filter: blur(8px);
      transition: background .15s;
    }
    .graph-controls button:hover { background: rgba(255,255,255,.2); }
    .graph-legend {
      display: flex;
      gap: 20px;
      padding: 12px 20px;
      background: rgba(15,23,42,.8);
      border-top: 1px solid rgba(255,255,255,.1);
      backdrop-filter: blur(8px);
    }
    .graph-legend-item {
      display: flex;
      align-items: center;
      gap: 6px;
      color: #94a3b8;
      font-size: 12px;
      font-weight: 500;
    }
    .graph-legend-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      display: inline-block;
    }
    .graph-tooltip {
      position: absolute;
      background: rgba(15,23,42,.95);
      color: #e2e8f0;
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 12px;
      max-width: 300px;
      pointer-events: none;
      opacity: 0;
      transition: opacity .15s;
      border: 1px solid rgba(255,255,255,.1);
      line-height: 1.4;
      z-index: 10;
    }
    .graph-tooltip.visible { opacity: 1; }
    .graph-filter {
      position: absolute;
      top: 12px;
      left: 12px;
      display: flex;
      gap: 6px;
    }
    .graph-filter-btn {
      padding: 4px 12px;
      background: rgba(255,255,255,.08);
      border: 1px solid rgba(255,255,255,.12);
      border-radius: 20px;
      color: #94a3b8;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      transition: all .15s;
      font-family: var(--font);
    }
    .graph-filter-btn:hover, .graph-filter-btn.active {
      background: rgba(255,255,255,.15);
      color: #e2e8f0;
    }

    /* ── Two-pane (Skills/Hooks) ─────────────────────────────── */
    .split-view {
      display: grid;
      grid-template-columns: 280px 1fr;
      gap: 0;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--surface);
      height: calc(100vh - 140px);
      min-height: 520px;
      overflow: hidden;
    }
    .split-sidebar {
      border-right: 1px solid var(--border);
      overflow-y: auto;
      background: #fafbfc;
    }
    .split-group-label {
      padding: 10px 16px 6px;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: .06em;
      color: var(--muted);
      font-weight: 600;
      background: #f3f4f6;
      border-bottom: 1px solid var(--border);
      position: sticky;
      top: 0;
    }
    .split-item {
      padding: 10px 16px;
      cursor: pointer;
      border-bottom: 1px solid var(--border-light);
      font-size: 13px;
      transition: background .1s;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .split-item:hover { background: #f1f5f9; }
    .split-item.selected { background: #ecfdf5; border-left: 3px solid var(--accent); padding-left: 13px; }
    .split-reader {
      display: flex;
      flex-direction: column;
    }
    .reader-toolbar {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
      background: #fafbfc;
    }
    .reader-title { font-weight: 600; font-size: 14px; flex-shrink: 0; }
    .reader-path {
      font-size: 11px;
      color: var(--muted);
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: var(--mono);
    }
    .reader-content {
      flex: 1;
      overflow: auto;
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
    .reader-content pre {
      margin: 0;
      padding: 20px;
      font-size: 12.5px;
      line-height: 1.7;
      font-family: var(--mono);
      white-space: pre-wrap;
      word-break: break-word;
    }
    .reader-content textarea {
      flex: 1;
      width: 100%;
      min-height: 300px;
      padding: 20px;
      font-size: 12.5px;
      line-height: 1.7;
      font-family: var(--mono);
      border: none;
      outline: none;
      resize: none;
    }
    .reader-empty {
      padding: 60px 20px;
      text-align: center;
      color: var(--muted);
      font-size: 14px;
    }

    /* Hook items */
    .hook-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 16px;
      border-bottom: 1px solid var(--border-light);
      cursor: pointer;
      transition: background .1s;
    }
    .hook-item:hover { background: #f1f5f9; }
    .hook-item.selected { background: #ecfdf5; border-left: 3px solid var(--accent); padding-left: 13px; }
    .hook-name { flex: 1; font-size: 13px; font-weight: 500; }
    .hook-custom-event { font-size: 12px; font-weight: 600; color: var(--ink); }
    .hook-custom-cmd { font-size: 11px; color: var(--muted); word-break: break-all; margin-top: 2px; }

    /* ── Badges & Buttons ────────────────────────────────────── */
    .badge {
      display: inline-flex;
      align-items: center;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 600;
      background: var(--bg);
      color: var(--muted);
    }
    .badge-project { background: #ede9fe; color: #6d28d9; }
    .badge-on { background: #d1fae5; color: #065f46; }
    .badge-off { background: #fee2e2; color: #991b1b; }
    .badge-count { background: var(--accent); color: white; min-width: 20px; text-align: center; }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 6px 14px;
      border-radius: var(--radius-sm);
      font-size: 13px;
      font-weight: 500;
      font-family: var(--font);
      cursor: pointer;
      transition: all .15s;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--ink);
    }
    .btn:hover { background: var(--bg); }
    .btn-primary { background: var(--accent); color: white; border-color: var(--accent); }
    .btn-primary:hover { background: var(--accent-hover); }
    .btn-approve { background: var(--success); color: white; border-color: var(--success); }
    .btn-reject { background: var(--danger); color: white; border-color: var(--danger); }
    .btn-sm { padding: 4px 10px; font-size: 12px; }

    .text-muted { color: var(--muted); }
    .status-msg { font-size: 12px; padding: 3px 8px; border-radius: var(--radius-sm); }
    .status-msg.ok { background: #d1fae5; color: #065f46; }
    .status-msg.err { background: #fee2e2; color: #991b1b; }

    @media (max-width: 900px) {
      .projects-grid { grid-template-columns: 1fr; }
      .split-view { grid-template-columns: 1fr; }
      .panes { grid-template-columns: 1fr; }
      .header { padding: 0 12px; gap: 12px; }
      .main { padding: 16px; }
    }
  </style>
</head>
<body>

<div class="header">
  <div class="header-brand">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/>
      <path d="M2 12h20"/>
    </svg>
    Cortex
  </div>
  <nav class="nav">
    <button class="nav-item active" onclick="switchTab('projects')">Projects</button>
    <button class="nav-item" onclick="switchTab('review')">Review${rows.length ? `<span class="count">${rows.length}</span>` : ""}</button>
    <button class="nav-item" onclick="switchTab('graph')">Graph</button>
    <button class="nav-item" onclick="switchTab('skills')">Skills</button>
    <button class="nav-item" onclick="switchTab('hooks')">Hooks</button>
  </nav>
</div>

<div class="main">
  <!-- ── Projects Tab ──────────────────────────────────────── -->
  <div id="tab-projects" class="tab-content active">
    <input type="text" id="projects-search" placeholder="Search projects..." oninput="filterProjects(this.value)" class="projects-search" />
    <div class="projects-grid" id="projects-grid">
      <div style="padding:40px;color:var(--muted);grid-column:1/-1;text-align:center">Loading projects...</div>
    </div>
    <div id="project-detail-area"></div>
  </div>

  <!-- ── Review Tab ────────────────────────────────────────── -->
  <div id="tab-review" class="tab-content">
    <details class="review-help" style="margin-bottom:16px">
      <summary>Help: How the Review Queue works</summary>
      <dl>
        <dt>What is the Review Queue?</dt>
        <dd>Memories flagged by governance for human review. Items accumulate here when <code>cortex maintain govern</code> is run.</dd>
        <dt>What does Approve do?</dt>
        <dd>Keeps the memory and marks it as reviewed. It stays in your project findings.</dd>
        <dt>What does Reject do?</dt>
        <dd>Permanently removes the memory from your project.</dd>
        <dt>Is this automatic?</dt>
        <dd>No. Agents do not auto-approve. You review each item manually.</dd>
        <dt>How do items get here?</dt>
        <dd><code>cortex maintain govern</code> flags stale or low-confidence memories for review.</dd>
        <dt>How to clear the queue faster?</dt>
        <dd>Run <code>cortex maintain prune</code> to auto-remove expired items without manual review.</dd>
      </dl>
    </details>

    <p style="font-size:13px;color:var(--muted);margin-bottom:16px">Items here are memories flagged for review. Approve to keep, Reject to discard.</p>

    <div class="review-cards">
      ${rows.join("\n") || '<div style="text-align:center;padding:40px;color:var(--muted)">No items in the review queue.</div>'}
    </div>

    <div class="panes">
      <div class="card">
        <div class="card-header"><h2>Recently Accepted</h2></div>
        <div class="card-body"><ul>${acceptedItems || "<li>None yet.</li>"}</ul></div>
      </div>
      <div class="card">
        <div class="card-header"><h2>Recently Used</h2></div>
        <div class="card-body"><ul>${usageItems || "<li>No usage events yet.</li>"}</ul></div>
      </div>
    </div>
  </div>

  <!-- ── Graph Tab ─────────────────────────────────────────── -->
  <div id="tab-graph" class="tab-content">
    <div class="graph-container">
      <canvas id="graph-canvas"></canvas>
      <div class="graph-tooltip" id="graph-tooltip"></div>
      <div class="graph-controls">
        <button onclick="graphZoom(1.2)" title="Zoom in">+</button>
        <button onclick="graphZoom(0.8)" title="Zoom out">-</button>
        <button onclick="graphReset()" title="Reset view">R</button>
      </div>
      <div class="graph-filter" id="graph-filter"></div>
      <div class="graph-legend">
        <span class="graph-legend-item"><span class="graph-legend-dot" style="background:#7c3aed"></span> Project</span>
        <span class="graph-legend-item"><span class="graph-legend-dot" style="background:#3b82f6"></span> Decision</span>
        <span class="graph-legend-item"><span class="graph-legend-dot" style="background:#ef4444"></span> Pitfall</span>
        <span class="graph-legend-item"><span class="graph-legend-dot" style="background:#10b981"></span> Pattern</span>
      </div>
    </div>
  </div>

  <!-- ── Skills Tab ────────────────────────────────────────── -->
  <div id="tab-skills" class="tab-content">
    <div class="split-view">
      <div class="split-sidebar" id="skills-list">
        <div style="padding:20px;color:var(--muted)">Loading...</div>
      </div>
      <div class="split-reader" id="skills-reader">
        <div class="reader-empty">Select a skill to view its contents.</div>
      </div>
    </div>
  </div>

  <!-- ── Hooks Tab ─────────────────────────────────────────── -->
  <div id="tab-hooks" class="tab-content">
    <div class="split-view">
      <div class="split-sidebar" id="hooks-list">
        <div style="padding:20px;color:var(--muted)">Loading...</div>
      </div>
      <div class="split-reader" id="hooks-reader">
        <div class="reader-empty">Select a hook config to view its contents.</div>
      </div>
    </div>
  </div>
</div>

<script>
(function() {
  // ── State ────────────────────────────────────────────────────
  var _authToken = '${h(authToken || '')}';
  var _skillsLoaded = false, _hooksLoaded = false, _graphLoaded = false;
  var _currentSkillPath = null, _currentHookPath = null;
  var _editingSkill = false, _editingHook = false;
  var _selectedProject = null;

  // ── Tab switching ────────────────────────────────────────────
  window.switchTab = function(tab) {
    document.querySelectorAll('.tab-content').forEach(function(el) { el.classList.remove('active'); });
    document.querySelectorAll('.nav-item').forEach(function(el) { el.classList.remove('active'); });
    var tabEl = document.getElementById('tab-' + tab);
    if (tabEl) tabEl.classList.add('active');
    var navBtn = document.querySelector('.nav-item[onclick*="' + tab + '"]');
    if (navBtn) navBtn.classList.add('active');
    if (tab === 'projects' && !document.querySelector('.project-card')) loadProjects();
    if (tab === 'skills' && !_skillsLoaded) loadSkills();
    if (tab === 'hooks' && !_hooksLoaded) loadHooks();
    if (tab === 'graph' && !_graphLoaded) loadGraph();
  };

  // ── Projects ─────────────────────────────────────────────────
  function getStarredProjects() {
    try { return JSON.parse(localStorage.getItem('cortex-starred-projects') || '[]'); } catch { return []; }
  }
  function setStarredProjects(arr) {
    localStorage.setItem('cortex-starred-projects', JSON.stringify(arr));
  }

  function renderProjectCards(data) {
    var grid = document.getElementById('projects-grid');
    if (!data.length) {
      grid.innerHTML = '<div style="padding:60px;color:var(--muted);grid-column:1/-1;text-align:center">No projects found. Run <code>npx @alaarab/cortex init</code> to create one.</div>';
      return;
    }
    var starred = getStarredProjects();
    // Sort: starred first, then by activity
    var sorted = data.slice().sort(function(a, b) {
      var aStarred = starred.indexOf(a.name) !== -1 ? 1 : 0;
      var bStarred = starred.indexOf(b.name) !== -1 ? 1 : 0;
      if (aStarred !== bStarred) return bStarred - aStarred;
      return 0; // preserve server sort order
    });
    grid.innerHTML = sorted.map(function(p) {
      var isStarred = starred.indexOf(p.name) !== -1;
      var githubHtml = p.githubUrl ? '<a class="github-link" href="'+esc(p.githubUrl)+'" target="_blank" rel="noopener" onclick="event.stopPropagation()">GitHub</a>' : '';
      return '<div class="project-card" onclick="selectProject(\\''+esc(p.name)+'\\', this)" data-project="'+esc(p.name)+'" data-summary="'+esc(p.summaryText || '')+'">' +
        '<button class="star-btn'+(isStarred ? ' starred' : '')+'" onclick="event.stopPropagation();toggleStar(\\''+esc(p.name)+'\\')" title="Star project">&#9733;</button>' +
        '<div class="project-card-name">' + esc(p.name) + '</div>' +
        (p.summaryText ? '<div class="project-card-summary">' + esc(p.summaryText) + '</div>' : '<div class="project-card-summary" style="font-style:italic">No summary</div>') +
        '<div class="project-card-stats">' +
          '<span class="project-card-stat"><strong>' + p.findingCount + '</strong> findings</span>' +
          '<span class="project-card-stat"><strong>' + p.backlogCount + '</strong> backlog</span>' +
          (p.hasClaudeMd ? '<span class="project-card-stat">CLAUDE.md</span>' : '') +
          (p.hasReference ? '<span class="project-card-stat">reference/</span>' : '') +
          githubHtml +
        '</div>' +
      '</div>';
    }).join('');
  }

  var _projectData = [];

  function loadProjects() {
    fetch('/api/projects').then(function(r) { return r.json(); }).then(function(data) {
      _projectData = data;
      renderProjectCards(data);
    });
  }

  window.toggleStar = function(name) {
    var starred = getStarredProjects();
    var idx = starred.indexOf(name);
    if (idx !== -1) starred.splice(idx, 1); else starred.push(name);
    setStarredProjects(starred);
    renderProjectCards(_projectData);
  };

  window.filterProjects = function(query) {
    var cards = document.querySelectorAll('.project-card');
    var q = query.toLowerCase();
    cards.forEach(function(card) {
      var name = (card.getAttribute('data-project') || '').toLowerCase();
      var summary = (card.getAttribute('data-summary') || '').toLowerCase();
      card.style.display = (!q || name.indexOf(q) !== -1 || summary.indexOf(q) !== -1) ? '' : 'none';
    });
  };

  window.toggleReviewEdit = function(btn) {
    var card = btn.closest('.review-card');
    if (!card) return;
    var editSection = card.querySelector('.review-card-edit');
    if (!editSection) return;
    var isVisible = editSection.style.display !== 'none';
    editSection.style.display = isVisible ? 'none' : 'block';
  };

  window.selectProject = function(name, el) {
    _selectedProject = name;
    document.querySelectorAll('.project-card').forEach(function(c) { c.classList.remove('selected'); });
    if (el) el.classList.add('selected');
    var area = document.getElementById('project-detail-area');
    area.innerHTML =
      '<div class="project-detail">' +
        '<div class="project-detail-header"><h2>' + esc(name) + '</h2></div>' +
        '<div class="project-detail-tabs">' +
          '<button class="project-detail-tab active" onclick="loadProjectFile(\\'FINDINGS.md\\', this)">Findings</button>' +
          '<button class="project-detail-tab" onclick="loadProjectFile(\\'backlog.md\\', this)">Backlog</button>' +
          '<button class="project-detail-tab" onclick="loadProjectFile(\\'CLAUDE.md\\', this)">CLAUDE.md</button>' +
          '<button class="project-detail-tab" onclick="loadProjectFile(\\'summary.md\\', this)">Summary</button>' +
        '</div>' +
        '<div class="project-detail-content" id="project-content"><div class="project-detail-empty">Loading...</div></div>' +
      '</div>';
    loadProjectFile('FINDINGS.md', area.querySelector('.project-detail-tab'));
    area.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  window.loadProjectFile = function(file, btn) {
    if (!_selectedProject) return;
    document.querySelectorAll('.project-detail-tab').forEach(function(b) { b.classList.remove('active'); });
    if (btn) btn.classList.add('active');
    var container = document.getElementById('project-content');
    container.innerHTML = '<div class="project-detail-empty">Loading...</div>';
    fetch('/api/project-content?project=' + encodeURIComponent(_selectedProject) + '&file=' + encodeURIComponent(file))
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!data.ok) {
          container.innerHTML = '<div class="project-detail-empty">' + esc(data.error || 'File not found') + '</div>';
          return;
        }
        container.innerHTML = '<pre>' + esc(data.content) + '</pre>';
      });
  };

  loadProjects();

  // ── Skills ───────────────────────────────────────────────────
  function loadSkills() {
    fetch('/api/skills').then(function(r) { return r.json(); }).then(function(data) {
      _skillsLoaded = true;
      var list = document.getElementById('skills-list');
      if (!data.length) { list.innerHTML = '<div style="padding:20px;color:var(--muted)">No skills found.</div>'; return; }
      var bySource = {};
      data.forEach(function(s) { (bySource[s.source] = bySource[s.source] || []).push(s); });
      var html = '';
      Object.keys(bySource).sort().forEach(function(src) {
        html += '<div class="split-group-label">' + esc(src) + '</div>';
        bySource[src].forEach(function(s) {
          html += '<div class="split-item" onclick="selectSkill(' + JSON.stringify(s.path).replace(/"/g, "'") + ', this, ' + JSON.stringify(s.name).replace(/"/g, "'") + ')">' +
            '<span>' + esc(s.name) + '</span>' +
            '<span class="text-muted" style="font-size:11px">' + esc(s.source) + '</span>' +
          '</div>';
        });
      });
      list.innerHTML = html;
    });
  }

  window.selectSkill = function(filePath, el, name) {
    if (_editingSkill && !confirm('Discard unsaved changes?')) return;
    _editingSkill = false;
    _currentSkillPath = filePath;
    document.querySelectorAll('#skills-list .split-item').forEach(function(i) { i.classList.remove('selected'); });
    if (el) el.classList.add('selected');
    var reader = document.getElementById('skills-reader');
    reader.innerHTML = '<div class="reader-empty">Loading...</div>';
    fetch('/api/skill-content?path=' + encodeURIComponent(filePath))
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!data.ok) { reader.innerHTML = '<div class="reader-empty">' + esc(data.error || 'Error loading file') + '</div>'; return; }
        reader.innerHTML =
          '<div class="reader-toolbar">' +
            '<span class="reader-title">' + esc(name) + '</span>' +
            '<span class="reader-path">' + esc(filePath) + '</span>' +
            '<span id="skill-status"></span>' +
            '<button class="btn btn-sm" onclick="editSkill()">Edit</button>' +
          '</div>' +
          '<div class="reader-content"><pre id="skill-pre">' + esc(data.content) + '</pre></div>';
      });
  };

  window.editSkill = function() {
    var pre = document.getElementById('skill-pre');
    if (!pre) return;
    _editingSkill = true;
    var content = pre.textContent;
    var toolbar = document.querySelector('#skills-reader .reader-toolbar');
    var btns = toolbar.querySelectorAll('.btn');
    btns.forEach(function(b) { b.remove(); });
    var saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-sm btn-primary';
    saveBtn.textContent = 'Save';
    saveBtn.onclick = saveSkill;
    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-sm';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = cancelSkillEdit;
    toolbar.appendChild(saveBtn);
    toolbar.appendChild(cancelBtn);
    var ta = document.createElement('textarea');
    ta.id = 'skill-textarea';
    ta.value = content;
    pre.replaceWith(ta);
    ta.focus();
  };

  window.cancelSkillEdit = function() {
    _editingSkill = false;
    if (_currentSkillPath) {
      var items = document.querySelectorAll('#skills-list .split-item.selected');
      if (items.length) items[0].click();
    }
  };

  window.saveSkill = function() {
    var ta = document.getElementById('skill-textarea');
    if (!ta || !_currentSkillPath) return;
    fetch('/api/skill-save', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'path=' + encodeURIComponent(_currentSkillPath) + '&content=' + encodeURIComponent(ta.value)
    }).then(function(r) { return r.json(); }).then(function(data) {
      if (data.ok) {
        _editingSkill = false;
        setStatus('skill-status', 'Saved', 'ok');
        var pre = document.createElement('pre');
        pre.id = 'skill-pre';
        pre.textContent = ta.value;
        ta.replaceWith(pre);
        var toolbar = document.querySelector('#skills-reader .reader-toolbar');
        var btns = toolbar.querySelectorAll('.btn');
        btns.forEach(function(b) { b.remove(); });
        var editBtn = document.createElement('button');
        editBtn.className = 'btn btn-sm';
        editBtn.textContent = 'Edit';
        editBtn.onclick = window.editSkill;
        toolbar.appendChild(editBtn);
      } else {
        setStatus('skill-status', data.error || 'Save failed', 'err');
      }
    });
  };

  // ── Hooks ────────────────────────────────────────────────────
  function loadHooks() {
    fetch('/api/hooks').then(function(r) { return r.json(); }).then(function(data) {
      _hooksLoaded = true;
      var list = document.getElementById('hooks-list');
      var html = '<div class="split-group-label">Lifecycle Hooks</div>';
      data.tools.forEach(function(t) {
        html += '<div class="hook-item" onclick="selectHook(' + JSON.stringify(t.configPath).replace(/"/g,"'") + ', this, ' + JSON.stringify(t.tool).replace(/"/g,"'") + ', ' + t.exists + ')">' +
          '<span class="hook-name">' + esc(t.tool) + '</span>' +
          '<span class="badge ' + (t.enabled ? 'badge-on' : 'badge-off') + '">' + (t.enabled ? 'on' : 'off') + '</span>' +
        '</div>';
      });
      if (data.customHooks && data.customHooks.length) {
        html += '<div class="split-group-label">Custom Hooks</div>';
        data.customHooks.forEach(function(ch) {
          html += '<div class="split-item" style="cursor:default;flex-direction:column;align-items:flex-start">' +
            '<div class="hook-custom-event">' + esc(ch.event) + '</div>' +
            '<div class="hook-custom-cmd">' + esc(ch.command) + '</div>' +
          '</div>';
        });
      }
      list.innerHTML = html;
    });
  }

  window.selectHook = function(filePath, el, toolName, exists) {
    if (_editingHook && !confirm('Discard unsaved changes?')) return;
    _editingHook = false;
    _currentHookPath = filePath;
    document.querySelectorAll('#hooks-list .hook-item').forEach(function(i) { i.classList.remove('selected'); });
    if (el) el.classList.add('selected');
    var reader = document.getElementById('hooks-reader');
    if (!exists) {
      reader.innerHTML =
        '<div class="reader-toolbar"><span class="reader-title">' + esc(toolName) + '</span><span class="reader-path">' + esc(filePath) + '</span></div>' +
        '<div class="reader-empty">Config file not found. This tool may not be installed or configured.</div>';
      return;
    }
    reader.innerHTML =
      '<div class="reader-toolbar">' +
        '<span class="reader-title">' + esc(toolName) + '</span>' +
        '<span class="reader-path">' + esc(filePath) + '</span>' +
        '<span id="hook-status"></span>' +
        '<button class="btn btn-sm" onclick="editHook()">Edit</button>' +
        '<button class="btn btn-sm btn-primary" onclick="toggleHookTool(' + JSON.stringify(toolName).replace(/"/g,"'") + ')">Toggle</button>' +
      '</div>' +
      '<div class="reader-content"><div class="reader-empty">Loading...</div></div>';
    fetch('/api/skill-content?path=' + encodeURIComponent(filePath))
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var content = reader.querySelector('.reader-content');
        if (!content) return;
        if (!data.ok) { content.innerHTML = '<div class="reader-empty">' + esc(data.error || 'Error loading file') + '</div>'; return; }
        content.innerHTML = '<pre id="hook-pre">' + esc(data.content) + '</pre>';
      });
  };

  window.editHook = function() {
    var pre = document.getElementById('hook-pre');
    if (!pre) return;
    _editingHook = true;
    var toolbar = document.querySelector('#hooks-reader .reader-toolbar');
    var btns = toolbar.querySelectorAll('.btn');
    btns.forEach(function(b) { b.remove(); });
    var saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-sm btn-primary';
    saveBtn.textContent = 'Save';
    saveBtn.onclick = window.saveHook;
    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-sm';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = window.cancelHookEdit;
    toolbar.appendChild(saveBtn);
    toolbar.appendChild(cancelBtn);
    var ta = document.createElement('textarea');
    ta.id = 'hook-textarea';
    ta.value = pre.textContent;
    pre.replaceWith(ta);
    ta.focus();
  };

  window.cancelHookEdit = function() {
    _editingHook = false;
    _hooksLoaded = false;
    loadHooks();
    document.getElementById('hooks-reader').innerHTML = '<div class="reader-empty">Select a hook config to view its contents.</div>';
  };

  window.saveHook = function() {
    var ta = document.getElementById('hook-textarea');
    if (!ta || !_currentHookPath) return;
    fetch('/api/skill-save', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'path=' + encodeURIComponent(_currentHookPath) + '&content=' + encodeURIComponent(ta.value)
    }).then(function(r) { return r.json(); }).then(function(data) {
      if (data.ok) {
        _editingHook = false;
        setStatus('hook-status', 'Saved', 'ok');
        window.cancelHookEdit();
      } else {
        setStatus('hook-status', data.error || 'Save failed', 'err');
      }
    });
  };

  window.toggleHookTool = function(toolName) {
    fetch('/api/hook-toggle', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'tool=' + encodeURIComponent(toolName)
    }).then(function(r) { return r.json(); }).then(function(data) {
      if (data.ok) { _hooksLoaded = false; loadHooks(); }
    });
  };

  // ── Graph (Force-directed) ───────────────────────────────────
  var _graphData = null;
  var _graphNodes = [];
  var _graphZoom = 1;
  var _graphPanX = 0, _graphPanY = 0;
  var _graphDrag = null;
  var _graphRunning = false;
  var _graphAlpha = 1;
  var _graphFilter = 'all';
  var _graphListenersAttached = false;

  var COLORS = { project: '#7c3aed', decision: '#3b82f6', pitfall: '#ef4444', pattern: '#10b981', tradeoff: '#f59e0b', architecture: '#8b5cf6', bug: '#dc2626' };
  var RADII = { project: 18, decision: 8, pitfall: 8, pattern: 8, tradeoff: 8, architecture: 8, bug: 8 };

  function loadGraph() {
    var url = '/api/graph' + (_authToken ? '?_auth=' + encodeURIComponent(_authToken) : '');
    fetch(url).then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function(data) {
      _graphLoaded = true;
      _graphData = data;
      initGraph(data);
    }).catch(function(err) {
      _graphLoaded = false;
      var canvas = document.getElementById('graph-canvas');
      if (canvas) {
        var ctx = canvas.getContext('2d');
        var w = canvas.clientWidth, h = canvas.clientHeight;
        ctx.fillStyle = '#ef4444';
        ctx.font = '14px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText('Graph failed to load: ' + err.message, w/2, h/2);
      }
    });
  }

  function initGraph(data) {
    var canvas = document.getElementById('graph-canvas');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    var rect = canvas.parentElement.getBoundingClientRect();
    var W = rect.width || 900;
    var H = Math.max(window.innerHeight - 160, 800);
    canvas.width = W * 2;
    canvas.height = H * 2;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.scale(2, 2);

    // Build filter buttons
    var filterEl = document.getElementById('graph-filter');
    var types = ['all', 'project', 'decision', 'pitfall', 'pattern', 'tradeoff', 'architecture', 'bug'];
    filterEl.innerHTML = types.map(function(t) {
      return '<button class="graph-filter-btn' + (t === 'all' ? ' active' : '') + '" onclick="graphFilterBy(\\''+t+'\\')">'+t+'</button>';
    }).join('');

    // Init node positions
    var nodeMap = {};
    _graphNodes = data.nodes.map(function(n, i) {
      var angle = (2 * Math.PI * i) / Math.max(data.nodes.length, 1);
      var r = n.group === 'project' ? Math.min(W, H) * 0.25 : Math.min(W, H) * 0.35;
      var node = {
        id: n.id, label: n.label, group: n.group, refCount: n.refCount,
        x: W/2 + r * Math.cos(angle) + (Math.random()-0.5) * 40,
        y: H/2 + r * Math.sin(angle) + (Math.random()-0.5) * 40,
        vx: 0, vy: 0
      };
      nodeMap[n.id] = node;
      return node;
    });

    var links = data.links.map(function(l) {
      return { source: nodeMap[l.source], target: nodeMap[l.target] };
    }).filter(function(l) { return l.source && l.target; });

    _graphAlpha = 1;
    _graphRunning = true;
    _graphZoom = 1;
    _graphPanX = 0;
    _graphPanY = 0;

    function tick() {
      if (_graphAlpha < 0.001) { _graphRunning = false; return; }
      _graphAlpha *= 0.995;

      // Repulsion
      for (var i = 0; i < _graphNodes.length; i++) {
        for (var j = i + 1; j < _graphNodes.length; j++) {
          var a = _graphNodes[i], b = _graphNodes[j];
          var dx = b.x - a.x, dy = b.y - a.y;
          var d = Math.sqrt(dx*dx + dy*dy) || 1;
          var repulse = a.group === 'project' && b.group === 'project' ? 3000 : 600;
          var f = repulse / (d * d) * _graphAlpha;
          a.vx -= f * dx/d; a.vy -= f * dy/d;
          b.vx += f * dx/d; b.vy += f * dy/d;
        }
      }

      // Attraction
      for (var k = 0; k < links.length; k++) {
        var s = links[k].source, t = links[k].target;
        var dx2 = t.x - s.x, dy2 = t.y - s.y;
        var d2 = Math.sqrt(dx2*dx2 + dy2*dy2) || 1;
        var ideal = s.group === 'project' ? 80 : 50;
        var f2 = (d2 - ideal) * 0.005 * _graphAlpha;
        s.vx += f2 * dx2/d2; s.vy += f2 * dy2/d2;
        t.vx -= f2 * dx2/d2; t.vy -= f2 * dy2/d2;
      }

      // Center gravity + damping + bounds
      for (var m = 0; m < _graphNodes.length; m++) {
        var n = _graphNodes[m];
        if (_graphDrag && _graphDrag.node === n) continue;
        n.vx += (W/2 - n.x) * 0.0005 * _graphAlpha;
        n.vy += (H/2 - n.y) * 0.0005 * _graphAlpha;
        n.vx *= 0.85; n.vy *= 0.85;
        n.x += n.vx; n.y += n.vy;
        // Soft bounds: allow nodes to go off-canvas (panning brings them back)
        n.x = Math.max(-W, Math.min(W*2, n.x));
        n.y = Math.max(-H, Math.min(H*2, n.y));
      }

      renderGraph();
      requestAnimationFrame(tick);
    }

    function renderGraph() {
      ctx.clearRect(0, 0, W, H);
      ctx.save();
      ctx.translate(_graphPanX, _graphPanY);
      ctx.scale(_graphZoom, _graphZoom);

      // Links
      ctx.strokeStyle = 'rgba(148,163,184,0.15)';
      ctx.lineWidth = 1;
      for (var k = 0; k < links.length; k++) {
        var s = links[k].source, t = links[k].target;
        if (_graphFilter !== 'all' && s.group !== _graphFilter && t.group !== _graphFilter) continue;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(t.x, t.y);
        ctx.stroke();
      }

      // Nodes
      for (var i = 0; i < _graphNodes.length; i++) {
        var n = _graphNodes[i];
        if (_graphFilter !== 'all' && n.group !== _graphFilter && n.group !== 'project') continue;
        var r = RADII[n.group] || 8;
        var col = COLORS[n.group] || '#888';

        // Glow for projects
        if (n.group === 'project') {
          ctx.beginPath();
          ctx.arc(n.x, n.y, r + 6, 0, Math.PI * 2);
          ctx.fillStyle = col + '22';
          ctx.fill();
        }

        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fillStyle = col;
        ctx.fill();
        ctx.strokeStyle = '#0f172a';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Labels
        ctx.fillStyle = '#94a3b8';
        ctx.font = n.group === 'project' ? 'bold 13px system-ui' : '10px system-ui';
        ctx.textBaseline = 'middle';
        var labelX = n.x + r + 6;
        var maxLabelW = n.group === 'project' ? 200 : 150;
        var label = n.label;
        if (ctx.measureText(label).width > maxLabelW) {
          while (ctx.measureText(label + '...').width > maxLabelW && label.length > 5) label = label.slice(0, -1);
          label += '...';
        }
        if (n.group === 'project') ctx.fillStyle = '#e2e8f0';
        ctx.fillText(label, labelX, n.y);
      }

      ctx.restore();
    }

    // Mouse interaction
    var mouseDown = false, lastMouse = {x:0, y:0};

    function getNodeAt(mx, my) {
      var sx = (mx - _graphPanX) / _graphZoom;
      var sy = (my - _graphPanY) / _graphZoom;
      for (var i = _graphNodes.length - 1; i >= 0; i--) {
        var n = _graphNodes[i];
        var r = RADII[n.group] || 8;
        var dx = sx - n.x, dy = sy - n.y;
        if (dx*dx + dy*dy < (r+4)*(r+4)) return n;
      }
      return null;
    }

    // Register canvas listeners only once to avoid duplicates on re-init (Q55)
    if (!_graphListenersAttached) {
      _graphListenersAttached = true;

    canvas.addEventListener('mousedown', function(e) {
      var rect = canvas.getBoundingClientRect();
      var mx = e.clientX - rect.left, my = e.clientY - rect.top;
      var node = getNodeAt(mx, my);
      if (node) {
        _graphDrag = { node: node, startX: node.x, startY: node.y };
        _graphAlpha = Math.max(_graphAlpha, 0.3);
        if (!_graphRunning) { _graphRunning = true; requestAnimationFrame(tick); }
      }
      mouseDown = true;
      lastMouse = {x: e.clientX, y: e.clientY};
    });

    canvas.addEventListener('mousemove', function(e) {
      var rect = canvas.getBoundingClientRect();
      var mx = e.clientX - rect.left, my = e.clientY - rect.top;

      if (_graphDrag) {
        var dx = (e.clientX - lastMouse.x) / _graphZoom;
        var dy = (e.clientY - lastMouse.y) / _graphZoom;
        _graphDrag.node.x += dx;
        _graphDrag.node.y += dy;
        _graphDrag.node.vx = 0;
        _graphDrag.node.vy = 0;
        lastMouse = {x: e.clientX, y: e.clientY};
        if (!_graphRunning) renderGraph();
        return;
      }

      if (mouseDown) {
        _graphPanX += e.clientX - lastMouse.x;
        _graphPanY += e.clientY - lastMouse.y;
        lastMouse = {x: e.clientX, y: e.clientY};
        if (!_graphRunning) renderGraph();
        return;
      }

      // Tooltip
      var node = getNodeAt(mx, my);
      var tooltip = document.getElementById('graph-tooltip');
      if (node) {
        tooltip.textContent = node.fullLabel || node.label;
        tooltip.style.left = (mx + 16) + 'px';
        tooltip.style.top = (my - 8) + 'px';
        tooltip.classList.add('visible');
        canvas.style.cursor = 'pointer';
      } else {
        tooltip.classList.remove('visible');
        canvas.style.cursor = 'grab';
      }
    });

    canvas.addEventListener('mouseup', function() {
      mouseDown = false;
      _graphDrag = null;
    });

    canvas.addEventListener('mouseleave', function() {
      mouseDown = false;
      _graphDrag = null;
      document.getElementById('graph-tooltip').classList.remove('visible');
    });

    canvas.addEventListener('wheel', function(e) {
      e.preventDefault();
      var factor = e.deltaY > 0 ? 0.9 : 1.1;
      var rect = canvas.getBoundingClientRect();
      var mx = e.clientX - rect.left, my = e.clientY - rect.top;
      _graphPanX = mx - (mx - _graphPanX) * factor;
      _graphPanY = my - (my - _graphPanY) * factor;
      _graphZoom *= factor;
      if (!_graphRunning) renderGraph();
    }, { passive: false });

    } // end if (!_graphListenersAttached)

    requestAnimationFrame(tick);
  }

  window.graphZoom = function(factor) {
    var canvas = document.getElementById('graph-canvas');
    if (!canvas) return;
    var W = canvas.clientWidth / 2, H = canvas.clientHeight / 2;
    _graphPanX = W - (W - _graphPanX) * factor;
    _graphPanY = H - (H - _graphPanY) * factor;
    _graphZoom *= factor;
    if (!_graphRunning) {
      var ctx = canvas.getContext('2d');
      // re-render will happen through renderGraph stored as closure, just bump alpha
    }
    _graphAlpha = 0.01;
    if (!_graphRunning) { _graphRunning = true; }
  };

  window.graphReset = function() {
    _graphZoom = 1;
    _graphPanX = 0;
    _graphPanY = 0;
    _graphAlpha = 1;
    if (!_graphRunning) {
      _graphRunning = true;
      loadGraph();
    }
  };

  window.graphFilterBy = function(type) {
    _graphFilter = type;
    document.querySelectorAll('.graph-filter-btn').forEach(function(b) {
      b.classList.toggle('active', b.textContent === type);
    });
    // Force re-render
    _graphAlpha = Math.max(_graphAlpha, 0.01);
    if (!_graphRunning) { _graphRunning = true; loadGraph(); }
  };

  // ── Utils ────────────────────────────────────────────────────
  function setStatus(id, msg, type) {
    var el = document.getElementById(id);
    if (!el) return;
    el.className = 'status-msg' + (type ? ' ' + type : '');
    el.textContent = msg;
    if (msg) setTimeout(function() { el.textContent = ''; el.className = ''; }, 3000);
  }

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
})();
</script>
</body>
</html>`;
}

// ── Server ───────────────────────────────────────────────────────────────────

export function createReviewUiServer(cortexPath: string, opts?: ReviewUiOptions): http.Server {
  const authToken = opts?.authToken;
  const csrfTokens = opts?.csrfTokens;

  return http.createServer((req, res) => {
    setCommonHeaders(res);
    const url = req.url || "/";

    if (req.method === "GET" && url === "/") {
      pruneExpiredCsrfTokens(csrfTokens);
      let csrfToken: string | undefined;
      if (csrfTokens) {
        csrfToken = crypto.randomUUID();
        csrfTokens.set(csrfToken, Date.now());
      }
      const html = renderPage(cortexPath, csrfToken, authToken);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    // ── Auth guard for all /api/* routes (Q7) ───────────────────
    if (url.startsWith("/api/")) {
      if (authToken) {
        const submitted = getSubmittedAuthToken(req, url);
        if (!authTokensMatch(submitted, authToken)) {
          res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
          res.end("Unauthorized");
          return;
        }
      }
    }

    // ── Project APIs ────────────────────────────────────────────
    if (req.method === "GET" && url === "/api/projects") {
      const projects = collectProjectsForUI(cortexPath);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(projects));
      return;
    }

    if (req.method === "GET" && url.startsWith("/api/project-content")) {
      const qs = url.includes("?") ? querystring.parse(url.slice(url.indexOf("?") + 1)) : {};
      const project = String(qs.project || "");
      const file = String(qs.file || "");
      if (!project || !isValidProjectName(project) || !file) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid project or file" }));
        return;
      }
      // Only allow specific files
      const allowedFiles = ["FINDINGS.md", "backlog.md", "CLAUDE.md", "summary.md"];
      if (!allowedFiles.includes(file)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "File not allowed: " + file }));
        return;
      }
      const filePath = path.join(cortexPath, project, file);
      if (!fs.existsSync(filePath)) {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "File not found: " + file }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, content: fs.readFileSync(filePath, "utf8") }));
      return;
    }

    // ── Skills API ──────────────────────────────────────────────
    if (req.method === "GET" && url === "/api/skills") {
      const skills = collectSkillsForUI(cortexPath);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(skills));
      return;
    }

    if (req.method === "GET" && url.startsWith("/api/skill-content")) {
      const qs = url.includes("?") ? querystring.parse(url.slice(url.indexOf("?") + 1)) : {};
      const filePath = String(qs.path || "");
      if (!filePath || !isAllowedFilePath(filePath, cortexPath)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid path" }));
        return;
      }
      if (!fs.existsSync(filePath)) {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "File not found" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, content: fs.readFileSync(filePath, "utf8") }));
      return;
    }

    // ── Hooks API ───────────────────────────────────────────────
    if (req.method === "GET" && url === "/api/hooks") {
      const data = getHooksData(cortexPath);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(data));
      return;
    }

    // ── Write APIs ──────────────────────────────────────────────
    if (req.method === "POST" && url === "/api/skill-save") {
      const contentLength = parseInt(req.headers["content-length"] || "0", 10);
      if (contentLength > 1_048_576) {
        res.writeHead(413, { "content-type": "text/plain" });
        res.end("Request body too large");
        return;
      }
      let body = "";
      let received = 0;
      req.on("data", (chunk) => {
        received += chunk.length;
        if (received > 1_048_576) {
          req.destroy();
          return;
        }
        body += String(chunk);
      });
      req.on("end", () => {
        const parsed = querystring.parse(body);
        const filePath = String(parsed.path || "");
        const content = String(parsed.content || "");
        if (!filePath || !isAllowedFilePath(filePath, cortexPath)) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Invalid path" }));
          return;
        }
        try {
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.writeFileSync(filePath, content);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (err: unknown) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: errorMessage(err) }));
        }
      });
      return;
    }

    if (req.method === "POST" && url === "/api/hook-toggle") {
      const contentLength = parseInt(req.headers["content-length"] || "0", 10);
      if (contentLength > 1_048_576) {
        res.writeHead(413, { "content-type": "text/plain" });
        res.end("Request body too large");
        return;
      }
      let body = "";
      let received = 0;
      req.on("data", (chunk) => {
        received += chunk.length;
        if (received > 1_048_576) {
          req.destroy();
          return;
        }
        body += String(chunk);
      });
      req.on("end", () => {
        const parsed = querystring.parse(body);
        const tool = String(parsed.tool || "").toLowerCase();
        const validTools = ["claude", "copilot", "cursor", "codex"];
        if (!validTools.includes(tool)) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Invalid tool" }));
          return;
        }
        const prefs = readInstallPreferences(cortexPath);
        const toolPrefs = (prefs.hookTools && typeof prefs.hookTools === "object") ? prefs.hookTools : {};
        const current = toolPrefs[tool] !== false && prefs.hooksEnabled !== false;
        writeInstallPreferences(cortexPath, {
          hookTools: { ...toolPrefs, [tool]: !current },
        } satisfies Partial<InstallPreferences>);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, enabled: !current }));
      });
      return;
    }

    // ── Graph API ───────────────────────────────────────────────
    if (req.method === "GET" && url.startsWith("/api/graph")) {
      const graph = buildGraph(cortexPath);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(graph));
      return;
    }

    // ── Review actions ──────────────────────────────────────────
    if (req.method === "POST" && ["/approve", "/reject", "/edit"].includes(url)) {
      const contentLength = parseInt(req.headers["content-length"] || "0", 10);
      if (contentLength > 1_048_576) {
        res.writeHead(413, { "content-type": "text/plain" });
        res.end("Request body too large");
        return;
      }

      let body = "";
      let received = 0;
      req.on("data", (chunk) => {
        received += chunk.length;
        if (received > 1_048_576) {
          req.destroy();
          return;
        }
        body += String(chunk);
      });
      req.on("end", () => {
        const parsed = querystring.parse(body);

        if (authToken) {
          const submitted = getSubmittedAuthToken(req, url, parsed);
          if (!authTokensMatch(submitted, authToken)) {
            res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
            res.end("Unauthorized");
            return;
          }
        }

        if (csrfTokens) {
          pruneExpiredCsrfTokens(csrfTokens);
          const submitted = String(parsed._csrf || "");
          if (!submitted || !csrfTokens.delete(submitted)) {
            res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
            res.end("Invalid or missing CSRF token");
            return;
          }
        }

        const project = String(parsed.project || "");
        const line = String(parsed.line || "");
        const newText = String(parsed.new_text || "");
        if (!project || !line) {
          res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
          res.end("Missing project/line");
          return;
        }
        if (!isValidProjectName(project)) {
          res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
          res.end("Invalid project name");
          return;
        }

        let result: import("./shared.js").CortexResult<string> = { ok: false, error: "unknown action" };
        if (url === "/approve") {
          result = approveQueueItem(cortexPath, project, line);
        } else if (url === "/reject") {
          result = rejectQueueItem(cortexPath, project, line);
        } else if (url === "/edit") {
          result = editQueueItem(cortexPath, project, line, newText);
        }

        if (!result.ok) {
          const code = result.code;
          if (code === CortexError.PERMISSION_DENIED || result.error.includes("requires maintainer/admin role")) {
            res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
            res.end(result.error);
            return;
          }
          if (code === CortexError.NOT_FOUND) {
            res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
            res.end(result.error);
            return;
          }
          if (code === CortexError.INVALID_PROJECT_NAME || code === CortexError.EMPTY_INPUT) {
            res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
            res.end(result.error);
            return;
          }
          res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          res.end(result.error);
          return;
        }

        res.writeHead(302, { location: "/" });
        res.end();
      });
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  });
}

export async function startReviewUi(cortexPath: string, port: number): Promise<void> {
  const authToken = crypto.randomUUID();
  const csrfTokens = new Map<string, number>();
  const server = createReviewUiServer(cortexPath, { authToken, csrfTokens });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  process.stdout.write(`cortex review-ui running at http://127.0.0.1:${port}\n`);
  process.stderr.write(`auth token: ${authToken}\n`);

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      server.close(() => resolve());
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  });
}
