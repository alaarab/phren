import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as crypto from "crypto";
import { PhrenClient } from "./phrenClient";

/**
 * Load the web-ui graph script from the MCP dist.
 * This gives us the Barnes-Hut force simulation, relevance gravity, a11y, etc.
 *
 * Resolution order:
 * 1. Same directory as compiled extension JS (works in .vsix packaging)
 * 2. Repo-relative path (works in source checkout)
 * Falls back to empty string if neither is available.
 */
function loadGraphScript(): string {
  const candidates = [
    // 1. Packaged: copied alongside extension output
    path.resolve(__dirname, "memory-ui-graph.js"),
    // 2. Source checkout: repo root -> mcp/dist/
    path.resolve(__dirname, "..", "..", "mcp", "dist", "memory-ui-graph.js"),
  ];
  for (const candidate of candidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require(candidate);
      if (typeof mod.renderGraphScript === "function") {
        return mod.renderGraphScript();
      }
    } catch {
      // Try next candidate
    }
  }
  return "";
}

/* ── Phren inline SVG for webview embedding ─────────────── */

const PHREN_INLINE_SVG_SMALL = `<svg width="64" height="64" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="pb" cx="48%" cy="42%" r="50%">
      <stop offset="0%" stop-color="#9B8DC8"/>
      <stop offset="40%" stop-color="#7B68AE"/>
      <stop offset="85%" stop-color="#5B4B8A"/>
      <stop offset="100%" stop-color="#2D2255"/>
    </radialGradient>
  </defs>
  <path d="M 28 60 C 26 44, 32 28, 46 22 C 52 18, 60 16, 68 18 C 78 20, 86 28, 90 38 C 96 50, 94 66, 88 76 C 82 86, 74 94, 62 96 C 48 98, 36 92, 30 80 C 24 72, 24 66, 28 60 Z" fill="url(#pb)"/>
  <path d="M 36 38 C 46 34, 60 36, 72 32 C 78 30, 84 34, 88 38" stroke="#5B4B8A" stroke-width="2.5" stroke-linecap="round" fill="none" opacity="0.5"/>
  <path d="M 30 52 C 42 48, 56 50, 68 46 C 78 44, 84 48, 90 52" stroke="#5B4B8A" stroke-width="2" stroke-linecap="round" fill="none" opacity="0.4"/>
  <path d="M 42 68 L 46 63 L 50 68 L 46 73 Z" fill="#1a1a2e"/>
  <path d="M 56 68 L 61 62 L 66 68 L 61 74 Z" fill="#1a1a2e"/>
  <rect x="43" y="64" width="2.5" height="2.5" rx="0.5" fill="#FFF" opacity="0.8"/>
  <rect x="57.5" y="63" width="2.5" height="2.5" rx="0.5" fill="#FFF" opacity="0.8"/>
  <path d="M 48 78 L 51 81 L 54 78" stroke="#2D2255" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  <rect x="38" y="96" width="11" height="14" rx="2" fill="#3D3270"/>
  <rect x="57" y="96" width="11" height="14" rx="2" fill="#3D3270"/>
  <g transform="translate(96, 14)">
    <polygon points="0,-8 2,0 0,8 -2,0" fill="#00E5FF"/>
    <polygon points="-8,0 0,-2 8,0 0,2" fill="#00E5FF"/>
    <circle cx="0" cy="0" r="1.5" fill="#FFF" opacity="0.9"/>
  </g>
</svg>`;

/* ── Interfaces ──────────────────────────────────────────── */

interface ProjectSummaryFile {
  filename: string;
  type: string;
}

interface ProjectSummaryData {
  name: string;
  summary: string;
  files: ProjectSummaryFile[];
  findingCount: number;
  taskCount: number;
}

interface FindingData {
  id: string;
  date: string;
  text: string;
  stableId?: string;
  topicSlug: string;
  topicLabel: string;
}

interface TaskData {
  id: string;
  line: string;
  section: string;
  checked: boolean;
  priority?: string;
}

interface EntityData {
  id?: string;
  name: string;
  type: string;
  refCount: number;
  docs: string[];
}

interface GraphNode {
  id: string;
  kind: "project" | "finding" | "task" | "entity" | "reference";
  projectName: string;
  label: string;
  subtype: string;
  text: string;
  radius: number;
  color: string;
  refCount?: number;
  date?: string;
  section?: string;
  priority?: string;
  entityType?: string;
  connectedProjects?: string[];
  qualityMultiplier?: number;
  lastUsedAt?: string;
  helpful?: number;
  stableId?: string;
  docs?: string[];
  topicSlug?: string;
  topicLabel?: string;
  scoreKey?: string;
}

interface GraphEdge {
  source: string;
  target: string;
}

interface MemoryScoreEntry {
  impressions: number;
  helpful: number;
  repromptPenalty: number;
  regressionPenalty: number;
  lastUsedAt: string;
}

interface MemoryScores {
  schemaVersion?: number;
  entries: Record<string, MemoryScoreEntry>;
}

interface GraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
  summaries: Record<string, ProjectSummaryData>;
  scores: MemoryScores;
}

/* ── Main entry ──────────────────────────────────────────── */

export async function showGraphWebview(client: PhrenClient, context: vscode.ExtensionContext): Promise<void> {
  const panel = vscode.window.createWebviewPanel(
    "phren.fragmentGraph",
    "Phren Fragment Graph",
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [context.extensionUri] },
  );

  panel.iconPath = vscode.Uri.file(path.join(context.extensionPath, "media", "icon.svg"));
  panel.webview.html = renderLoadingHtml(panel.webview);

  let graphData: GraphPayload | undefined;

  try {
    graphData = await loadGraphData(client);
    panel.webview.html = renderGraphHtml(panel.webview, graphData);
  } catch (error) {
    panel.webview.html = renderErrorHtml(panel.webview, toErrorMessage(error));
    return;
  }

  // Handle messages from the webview
  panel.webview.onDidReceiveMessage(async (msg: unknown) => {
    const message = asRecord(msg);
    if (!message) return;
    const command = asString(message.command);

    if (command === "nodeClick") {
      // Webview clicked a node — send back detail for findings
      const nodeId = asString(message.nodeId);
      const kind = asString(message.kind);
      if (!nodeId || kind !== "finding" || !graphData) return;

      // Find the node in the loaded payload
      const node = graphData.nodes.find((n) => n.id === nodeId);
      if (!node) return;

      panel.webview.postMessage({
        command: "nodeDetail",
        nodeId,
        kind: "finding",
        projectName: node.projectName,
        text: node.text,
        date: node.date ?? "",
        topicLabel: node.topicLabel ?? "",
        stableId: node.stableId ?? "",
      });
    }

    if (command === "editFinding") {
      const projectName = asString(message.projectName);
      const originalText = asString(message.text);
      if (!projectName || !originalText) return;

      const edited = await vscode.window.showInputBox({
        title: "Edit Finding",
        value: originalText,
        prompt: "Edit the finding text. Save to replace the existing entry.",
        validateInput: (v) => (v.trim().length === 0 ? "Finding text cannot be empty." : undefined),
      });

      if (!edited || edited.trim() === originalText.trim()) return;

      try {
        await client.removeFinding(projectName, originalText);
        await client.addFinding(projectName, edited.trim());
        vscode.window.showInformationMessage("Finding updated.");

        // Reload graph data so the panel reflects the change
        graphData = await loadGraphData(client);
        panel.webview.html = renderGraphHtml(panel.webview, graphData);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to update finding: ${toErrorMessage(err)}`);
      }
    }

    if (command === "deleteFinding") {
      const projectName = asString(message.projectName);
      const text = asString(message.text);
      if (!projectName || !text) return;

      const confirm = await vscode.window.showWarningMessage(
        `Delete this finding from "${projectName}"?`,
        { modal: true },
        "Delete",
      );
      if (confirm !== "Delete") return;

      try {
        await client.removeFinding(projectName, text);
        vscode.window.showInformationMessage("Finding deleted.");

        graphData = await loadGraphData(client);
        panel.webview.html = renderGraphHtml(panel.webview, graphData);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to delete finding: ${toErrorMessage(err)}`);
      }
    }
  });
}

/* ── Data loading ────────────────────────────────────────── */

async function loadGraphData(client: PhrenClient): Promise<GraphPayload> {
  const projects = await fetchProjects(client);

  // Parallel per-project fetches
  const perProjectResults = await Promise.all(
    projects.map(async (p) => {
      const [summary, findings, tasks] = await Promise.all([
        fetchProjectSummary(client, p.name),
        fetchFindings(client, p.name),
        fetchTasks(client, p.name),
      ]);
      return { projectName: p.name, summary, findings, tasks };
    }),
  );

  // Fragment graph
  const entities = await fetchEntities(client);

  // Memory scores
  const scores = loadMemoryScores();
  const scoreLookup = buildScoreLookup(scores);

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const summaryMap: Record<string, ProjectSummaryData> = {};
  // Build project nodes (skip empty orphans)
  for (const { projectName, summary, findings, tasks } of perProjectResults) {
    if (findings.length === 0 && tasks.length === 0) continue;

    const projectNodeId = `project:${projectName}`;
    summaryMap[projectName] = { ...summary, findingCount: findings.length, taskCount: tasks.length };

    nodes.push({
      id: projectNodeId,
      kind: "project",
      projectName,
      label: projectName,
      subtype: "project",
      text: summary.summary,
      radius: Math.min(14 + Math.sqrt(findings.length + tasks.length) * 1.5, 30),
      color: "#7B68AE",
    });

    // Finding nodes
    for (const finding of findings) {
      const findingId = `finding:${projectName}:${finding.id}`;
      const findingScoreKey = buildScoreKey(projectName, "FINDINGS.md", finding.text);
      const findingScore = scoreLookup.get(findingScoreKey);
      nodes.push({
        id: findingId,
        kind: "finding",
        projectName,
        label: finding.text.slice(0, 40) + (finding.text.length > 40 ? "..." : ""),
        subtype: finding.topicSlug,
        text: finding.text,
        radius: 8,
        color: "#5B4B8A", // placeholder; actual color determined by graph engine from topic slug
        date: finding.date,
        stableId: finding.stableId,
        topicSlug: finding.topicSlug,
        topicLabel: finding.topicLabel,
        scoreKey: findingScoreKey,
        qualityMultiplier: qualityMultiplierFromEntry(findingScore),
        lastUsedAt: findingScore?.lastUsedAt,
        helpful: findingScore?.helpful,
      });
      edges.push({ source: projectNodeId, target: findingId });
    }

    // Task nodes
    for (const task of tasks) {
      const taskId = `task:${projectName}:${task.id}`;
      const taskScoreKey = buildScoreKey(projectName, "tasks.md", task.line);
      const taskScore = scoreLookup.get(taskScoreKey);
      const sectionLower = task.section.toLowerCase();
      const taskColorMap: Record<string, string> = { active: "#10b981", queue: "#00E5FF", done: "#6b7280" };
      nodes.push({
        id: taskId,
        kind: "task",
        projectName,
        label: task.line.slice(0, 40) + (task.line.length > 40 ? "..." : ""),
        subtype: sectionLower,
        text: task.line,
        radius: 7,
        color: taskColorMap[sectionLower] || "#00E5FF",
        section: task.section,
        priority: task.priority,
        scoreKey: taskScoreKey,
        qualityMultiplier: qualityMultiplierFromEntry(taskScore),
        lastUsedAt: taskScore?.lastUsedAt,
        helpful: taskScore?.helpful,
      });
      edges.push({ source: projectNodeId, target: taskId });
    }
  }

  // Fragment nodes and edges
  const projectNameSet = new Set(projects.map((p) => p.name));
  for (const entity of entities) {
    const entityId = entity.id || `entity:${entity.name}`;
    const connectedProjects: string[] = [];
    for (const doc of entity.docs) {
      for (const pName of projectNameSet) {
        // Path-separator-aware matching: doc must start with "projectName/"
        if (doc === pName || doc.startsWith(pName + "/") || doc.startsWith(pName + "\\")) {
          connectedProjects.push(pName);
        }
      }
    }
    const uniqueConnected = [...new Set(connectedProjects)];

    nodes.push({
      id: entityId,
      kind: "entity",
      projectName: uniqueConnected[0] || "",
      label: entity.name,
      subtype: entity.type,
      text: `${entity.name} (${entity.type}) - ${entity.refCount} refs`,
      radius: Math.min(6 + entity.refCount, 16),
      color: "#00E5FF",
      refCount: entity.refCount,
      entityType: entity.type,
      connectedProjects: uniqueConnected,
      docs: entity.docs,
    });

    // Fragment → project edges
    for (const pName of uniqueConnected) {
      edges.push({ source: entityId, target: `project:${pName}` });
    }

    // Cross-project edges
    if (uniqueConnected.length > 1) {
      for (let i = 0; i < uniqueConnected.length; i++) {
        for (let j = i + 1; j < uniqueConnected.length; j++) {
          edges.push({ source: `project:${uniqueConnected[i]}`, target: `project:${uniqueConnected[j]}` });
        }
      }
    }

    // Reference doc nodes
    for (const doc of entity.docs) {
      const refId = `ref:${doc}`;
      if (!nodes.find((n) => n.id === refId)) {
        let refProject = "";
        for (const pName of projectNameSet) {
          if (doc.startsWith(pName + "/") || doc.startsWith(pName + "\\")) {
            refProject = pName;
            break;
          }
        }
        nodes.push({
          id: refId,
          kind: "reference",
          projectName: refProject,
          label: doc.split("/").pop() || doc,
          subtype: "reference",
          text: doc,
          radius: 6,
          color: "#14b8a6",
        });
      }
      edges.push({ source: entityId, target: `ref:${doc}` });
    }
  }

  // Deduplicate edges
  const edgeSet = new Set<string>();
  const uniqueEdges: GraphEdge[] = [];
  for (const e of edges) {
    const key = `${e.source}|${e.target}`;
    const reverseKey = `${e.target}|${e.source}`;
    if (!edgeSet.has(key) && !edgeSet.has(reverseKey)) {
      edgeSet.add(key);
      uniqueEdges.push(e);
    }
  }

  return { nodes, edges: uniqueEdges, summaries: summaryMap, scores };
}

/* ── Fetch helpers ───────────────────────────────────────── */

async function fetchProjects(client: PhrenClient): Promise<{ name: string; brief?: string }[]> {
  const raw = await client.listProjects();
  const data = responseData(raw);
  const parsed: { name: string; brief?: string }[] = [];
  for (const entry of asArray(data?.projects)) {
    const record = asRecord(entry);
    const name = asString(record?.name);
    // Skip bogus entries: paths, reserved names, stale FTS entries
    if (!name) continue;
    if (name.includes(":") || name.includes("/") || name.includes("\\")) continue;
    if (name === "global" || name === "scripts" || name === "templates" || name === "profiles") continue;
    // Filter known stale/non-profile projects (should be fixed at MCP level long-term)
    if (name === "dendron" || name === "phren-framework" || name === "max4liveplugins" || name === "pcn-reports") continue;
    parsed.push({ name, brief: asString(record?.brief) });
  }
  return parsed;
}

async function fetchProjectSummary(client: PhrenClient, project: string): Promise<ProjectSummaryData> {
  const raw = await client.getProjectSummary(project);
  const data = responseData(raw);
  const files: ProjectSummaryFile[] = [];
  for (const file of asArray(data?.files)) {
    const record = asRecord(file);
    const filename = asString(record?.filename) ?? asString(record?.name);
    const type = asString(record?.type);
    if (filename && type) {
      files.push({ filename, type });
    }
  }
  return {
    name: asString(data?.name) ?? project,
    summary: asString(data?.summary) ?? "No summary.md found.",
    files,
    findingCount: 0,
    taskCount: 0,
  };
}

async function fetchFindings(client: PhrenClient, project: string): Promise<FindingData[]> {
  const raw = await client.getFindings(project);
  const data = responseData(raw);
  const parsed: FindingData[] = [];
  for (const entry of asArray(data?.findings)) {
    const record = asRecord(entry);
    const id = asString(record?.id) ?? asString(record?.stableId) ?? String(parsed.length);
    const text = asString(record?.text) ?? "";
    if (!text) continue;
    const topic = classifyFindingTopic(text);
    parsed.push({
      id,
      date: asString(record?.date) ?? "",
      text,
      stableId: asString(record?.stableId),
      topicSlug: topic.slug,
      topicLabel: topic.label,
    });
  }
  return parsed;
}

async function fetchTasks(client: PhrenClient, project: string): Promise<TaskData[]> {
  const raw = await client.getTasks(project, { status: "all", done_limit: 10 });
  const data = responseData(raw);
  const items = asRecord(data?.items);
  const parsed: TaskData[] = [];

  for (const section of ["Active", "Queue"]) {
    for (const entry of asArray(items?.[section])) {
      const record = asRecord(entry);
      if (!record) continue;
      parsed.push({
        id: asString(record.id) ?? String(parsed.length),
        line: asString(record.line) ?? asString(record.item) ?? "",
        section,
        checked: record.checked === true,
        priority: asString(record.priority),
      });
    }
  }

  // Include up to 10 done items
  const doneItems = asArray(items?.Done).slice(0, 10);
  for (const entry of doneItems) {
    const record = asRecord(entry);
    if (!record) continue;
    parsed.push({
      id: asString(record.id) ?? String(parsed.length),
      line: asString(record.line) ?? asString(record.item) ?? "",
      section: "Done",
      checked: true,
      priority: asString(record.priority),
    });
  }

  return parsed;
}

async function fetchEntities(client: PhrenClient): Promise<EntityData[]> {
  try {
    const raw = await client.readGraph();
    const data = responseData(raw);
    const parsed: EntityData[] = [];
    for (const entry of asArray(data?.entities)) {
      const record = asRecord(entry);
      if (!record) continue;
      parsed.push({
        name: asString(record.name) ?? "",
        type: asString(record.type) ?? "unknown",
        refCount: typeof record.refCount === "number" ? record.refCount : 0,
        docs: asArray(record.docs).filter((d): d is string => typeof d === "string"),
      });
    }
    return parsed.slice(0, 500);
  } catch {
    return [];
  }
}

function loadMemoryScores(): MemoryScores {
  try {
    const scoresPath = path.join(os.homedir(), ".phren", ".runtime", "memory-scores.json");
    const raw = fs.readFileSync(scoresPath, "utf8");
    const parsed = JSON.parse(raw) as MemoryScores;
    return { schemaVersion: parsed.schemaVersion ?? 1, entries: parsed.entries ?? {} };
  } catch {
    return { schemaVersion: 1, entries: {} };
  }
}

function buildScoreLookup(scores: MemoryScores): Map<string, MemoryScoreEntry> {
  return new Map(Object.entries(scores.entries ?? {}));
}

function buildScoreKey(project: string, filename: string, snippet: string): string {
  const short = (snippet || "").slice(0, 160);
  const digest = crypto.createHash("sha1").update(`${project}:${filename}:${short}`).digest("hex").slice(0, 12);
  return `${project}/${filename}:${digest}`;
}

function qualityMultiplierFromEntry(entry?: MemoryScoreEntry): number | undefined {
  if (!entry) return undefined;
  const now = Date.now();
  const lastUsed = entry.lastUsedAt ? new Date(entry.lastUsedAt).getTime() : 0;
  const daysSince = lastUsed ? (now - lastUsed) / 86400000 : 999;

  let recencyBoost = 0;
  if (daysSince <= 7) recencyBoost = 0.15;
  else if (daysSince <= 30) recencyBoost = 0;
  else recencyBoost = Math.max(-0.3, -0.1 * Math.floor((daysSince - 30) / 30));

  const impressions = entry.impressions || 0;
  const frequencyBoost = Math.min(0.2, Math.log(impressions + 1) / Math.LN2 * 0.05);
  const helpful = entry.helpful || 0;
  const reprompt = entry.repromptPenalty || 0;
  const regression = entry.regressionPenalty || 0;
  const feedbackScore = helpful * 0.15 - (reprompt + regression * 2) * 0.2;

  return Math.max(0.2, Math.min(1.5, 1 + feedbackScore + recencyBoost + frequencyBoost));
}

/* Builtin topic keywords mirroring project-topics.ts BUILTIN_TOPICS */
const BUILTIN_TOPIC_KEYWORDS: Array<{ slug: string; label: string; keywords: string[] }> = [
  { slug: "api", label: "API", keywords: ["api", "endpoint", "route", "rest", "graphql", "grpc", "request", "response", "http", "url", "webhook", "cors"] },
  { slug: "database", label: "Database", keywords: ["database", "db", "sql", "query", "index", "migration", "schema", "table", "column", "postgres", "mysql", "sqlite", "mongo", "redis", "orm"] },
  { slug: "performance", label: "Performance", keywords: ["performance", "speed", "latency", "cache", "optimize", "memory", "cpu", "bottleneck", "profiling", "benchmark", "throughput", "lazy"] },
  { slug: "security", label: "Security", keywords: ["security", "vulnerability", "xss", "csrf", "injection", "sanitize", "escape", "encrypt", "decrypt", "hash", "salt", "tls", "ssl"] },
  { slug: "frontend", label: "Frontend", keywords: ["frontend", "ui", "ux", "css", "html", "dom", "render", "component", "layout", "responsive", "animation", "browser", "react", "vue", "angular"] },
  { slug: "testing", label: "Testing", keywords: ["test", "spec", "assert", "mock", "stub", "fixture", "coverage", "jest", "vitest", "playwright", "e2e", "unit", "integration"] },
  { slug: "devops", label: "DevOps", keywords: ["deploy", "ci", "cd", "pipeline", "docker", "kubernetes", "container", "infra", "terraform", "aws", "cloud", "monitoring", "logging"] },
  { slug: "architecture", label: "Architecture", keywords: ["architecture", "design", "pattern", "layer", "module", "system", "structure", "microservice", "monolith", "event-driven", "plugin"] },
  { slug: "debugging", label: "Debugging", keywords: ["debug", "bug", "error", "crash", "fix", "issue", "stack", "trace", "breakpoint", "log", "workaround", "pitfall", "caveat"] },
  { slug: "tooling", label: "Tooling", keywords: ["tool", "cli", "script", "build", "webpack", "vite", "eslint", "prettier", "npm", "package", "config", "plugin", "hook", "git"] },
  { slug: "auth", label: "Auth", keywords: ["auth", "login", "logout", "session", "token", "jwt", "oauth", "sso", "permission", "role", "access", "credential"] },
  { slug: "data", label: "Data", keywords: ["data", "model", "schema", "serialize", "deserialize", "json", "csv", "transform", "validate", "parse", "format", "encode"] },
  { slug: "mobile", label: "Mobile", keywords: ["mobile", "ios", "android", "react-native", "flutter", "native", "touch", "gesture", "push-notification", "app-store"] },
  { slug: "ai_ml", label: "AI / ML", keywords: ["ai", "ml", "model", "embedding", "vector", "llm", "prompt", "token", "inference", "training", "neural", "gpt", "claude"] },
];

function classifyFindingTopic(text: string): { slug: string; label: string } {
  const lower = text.toLowerCase();
  let bestSlug = "general";
  let bestLabel = "General";
  let bestScore = 0;
  for (const topic of BUILTIN_TOPIC_KEYWORDS) {
    let score = 0;
    for (const kw of topic.keywords) {
      if (lower.includes(kw)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestSlug = topic.slug;
      bestLabel = topic.label;
    }
  }
  return { slug: bestSlug, label: bestLabel };
}

/* ── HTML renderers ──────────────────────────────────────── */

function renderLoadingHtml(webview: vscode.Webview): string {
  const nonce = getNonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Phren Fragment Graph</title>
  <style>
    body { margin:0; display:grid; place-items:center; min-height:100vh; color:var(--vscode-foreground); font-family:sans-serif; }
    .loading-container { text-align:center; }
    .loading-container svg { margin-bottom:16px; }
    .loading-text { font-size:14px; opacity:0.7; }
    @keyframes phren-bob { 0%,100% { transform:translateY(0); } 50% { transform:translateY(-4px); } }
    .phren-loading { animation:phren-bob 1.2s ease-in-out infinite; }
  </style>
</head>
<body>
  <div class="loading-container">
    <div class="phren-loading">${PHREN_INLINE_SVG_SMALL}</div>
    <div class="loading-text">Loading fragment graph...</div>
  </div>
</body>
</html>`;
}

function renderErrorHtml(webview: vscode.Webview, errorMessage: string): string {
  const nonce = getNonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Phren Fragment Graph</title>
  <style>
    body { margin:0; display:grid; place-items:center; min-height:100vh; padding:24px; color:var(--vscode-errorForeground); font-family:sans-serif; }
    .panel { max-width:720px; border:1px solid; border-radius:10px; padding:16px; }
  </style>
</head>
<body><div class="panel"><div style="text-align:center;margin-bottom:12px">${PHREN_INLINE_SVG_SMALL}</div>Failed to render fragment graph: ${escapeHtml(errorMessage)}</div></body>
</html>`;
}

function renderGraphHtml(webview: vscode.Webview, payload: GraphPayload): string {
  const nonce = getNonce();
  const safePayload = JSON.stringify(payload).replace(/</g, "\\u003c");

  // Load the web-ui graph script (Barnes-Hut force sim, relevance gravity, a11y, etc.)
  const graphScript = loadGraphScript();

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Phren Fragment Graph</title>
  <style>
    :root {
      color-scheme:light dark;
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      --border:color-mix(in srgb,var(--vscode-foreground) 20%,transparent);
      --surface:var(--vscode-editorWidget-background);
      --ink:var(--vscode-foreground);
      --muted:color-mix(in srgb,var(--vscode-foreground) 50%,transparent);
    }
    * { box-sizing:border-box; }
    body { margin:0; height:100vh; overflow:hidden; color:var(--vscode-foreground); background:var(--vscode-editor-background); }
    .graph-layout { display:grid; grid-template-columns:3fr 1fr; height:100vh; }
    .graph-container { position:relative; overflow:hidden; }
    #graph-canvas { display:block; width:100%; height:100%; }
    #graph-tooltip { display:none; position:absolute; pointer-events:none; padding:4px 8px; border-radius:4px; font-size:12px; max-width:300px; word-break:break-all; background:var(--vscode-editorWidget-background); color:var(--vscode-foreground); border:1px solid var(--border); z-index:10; box-shadow:0 2px 6px rgba(0,0,0,0.3); }
    .graph-controls { position:absolute; top:10px; right:10px; display:flex; flex-direction:column; gap:4px; z-index:2; }
    .graph-controls button { width:36px; height:36px; border:1px solid var(--border); border-radius:6px; background:color-mix(in srgb,var(--vscode-editorWidget-background) 85%,transparent); color:var(--vscode-foreground); font-size:16px; cursor:pointer; display:grid; place-items:center; backdrop-filter:blur(4px); }
    .graph-controls button:hover { background:var(--vscode-button-hoverBackground); color:var(--vscode-button-foreground); }
    #graph-filter, #graph-project-filter, #graph-limit-row { display:flex; gap:8px; padding:6px 12px; align-items:center; flex-wrap:wrap; background:var(--vscode-editorWidget-background); border-bottom:1px solid var(--border); }
    .graph-legend { display:flex; gap:10px; padding:6px 12px; flex-wrap:wrap; background:var(--vscode-editorWidget-background); border-bottom:1px solid var(--border); }
    .graph-legend-item { display:flex; align-items:center; gap:4px; font-size:11px; opacity:0.7; }
    .graph-legend-dot { display:inline-block; width:8px; height:8px; border-radius:50%; }
    .graph-detail-panel { padding:16px; overflow:auto; border-left:1px solid var(--border); }
    .graph-detail-panel h2 { margin:0 0 4px; font-size:11px; text-transform:uppercase; letter-spacing:0.05em; opacity:0.6; }
    #graph-detail-meta { font-size:13px; margin-bottom:8px; }
    #graph-detail-body { font-size:13px; line-height:1.6; }
    .btn { padding:4px 10px; border:1px solid var(--border); border-radius:4px; background:var(--surface); color:var(--ink); font-size:12px; cursor:pointer; }
    .btn.active, .btn:hover { background:var(--vscode-button-background); color:var(--vscode-button-foreground); }
    .btn-sm { font-size:11px; padding:3px 8px; }
    .text-muted { color:var(--muted); }
    #node-overlay { display:none; position:absolute; z-index:20; min-width:220px; max-width:320px; background:var(--vscode-editorWidget-background); border:1px solid var(--border); border-radius:8px; padding:12px; box-shadow:0 4px 16px rgba(0,0,0,0.4); font-size:13px; }
    #node-overlay h3 { margin:0 0 6px; font-size:11px; text-transform:uppercase; letter-spacing:0.05em; opacity:0.6; }
    #node-overlay-text { margin:0 0 10px; line-height:1.5; word-break:break-word; }
    #node-overlay-meta { font-size:11px; opacity:0.65; margin-bottom:10px; }
    #node-overlay-actions { display:flex; gap:6px; }
    #node-overlay-close { position:absolute; top:6px; right:8px; background:none; border:none; color:var(--ink); font-size:16px; cursor:pointer; opacity:0.5; line-height:1; padding:0; }
    #node-overlay-close:hover { opacity:1; }
    @media (max-width:700px) {
      .graph-layout { grid-template-columns:1fr; grid-template-rows:55vh 1fr; }
      .graph-detail-panel { border-left:none; border-top:1px solid var(--border); }
    }
  </style>
</head>
<body>
  <a href="#graph-detail-panel" id="skip-link" class="sr-only" style="position:absolute;left:-9999px;top:auto;width:1px;height:1px;overflow:hidden;z-index:100;">Skip to details panel</a>
  <div id="graph-filter"></div>
  <div id="graph-project-filter"></div>
  <div id="graph-limit-row"></div>
  <div class="graph-legend"></div>
  <main class="graph-layout">
    <section class="graph-container">
      <canvas id="graph-canvas"></canvas>
      <div id="graph-tooltip"></div>
      <div class="graph-controls">
        <button id="btn-zoom-in" title="Zoom in">+</button>
        <button id="btn-zoom-out" title="Zoom out">&minus;</button>
        <button id="btn-zoom-reset" title="Reset view">R</button>
      </div>
      <div id="node-overlay" role="dialog" aria-label="Finding detail">
        <button id="node-overlay-close" title="Close" aria-label="Close">&times;</button>
        <h3>Finding</h3>
        <div id="node-overlay-text"></div>
        <div id="node-overlay-meta"></div>
        <div id="node-overlay-actions">
          <button class="btn btn-sm" id="node-overlay-edit">Edit</button>
          <button class="btn btn-sm" id="node-overlay-delete" style="border-color:var(--vscode-errorForeground,#f44);color:var(--vscode-errorForeground,#f44)">Delete</button>
        </div>
      </div>
    </section>
    <aside class="graph-detail-panel" id="graph-detail-panel">
      <div style="text-align:center;margin-bottom:12px;opacity:0.6">${PHREN_INLINE_SVG_SMALL}</div>
      <h2>Details</h2>
      <div id="graph-detail-meta">Click a bubble to inspect it.</div>
      <div id="graph-detail-body"><p class="text-muted" style="margin:0">Use the graph filters, then click a project or finding bubble to pin its details here.</p></div>
    </aside>
  </main>
  <script nonce="${nonce}">
// ── Web UI graph engine (Barnes-Hut + relevance gravity) ──
${graphScript}

// ── Data adapter: transform extension payload to web-ui format ──
(function() {
  var payload = ${safePayload};

  var graphNodes = [];
  var topicMap = {};
  for (var i = 0; i < payload.nodes.length; i++) {
    var n = payload.nodes[i];
    var group = 'other';
    if (n.kind === 'project') group = 'project';
    else if (n.kind === 'finding') {
      group = n.topicSlug ? 'topic:' + n.topicSlug : 'topic:general';
      if (n.topicSlug && !topicMap[n.topicSlug]) {
        topicMap[n.topicSlug] = n.topicLabel || n.topicSlug;
      }
    }
    else if (n.kind === 'task') group = 'task-' + (n.subtype || 'queue');
    else if (n.kind === 'entity') group = 'entity';
    else if (n.kind === 'reference') group = 'reference';

    graphNodes.push({
      id: n.id,
      group: group,
      project: n.projectName || '',
      label: n.label,
      fullLabel: n.text || n.label,
      scoreKey: n.scoreKey || '',
      refCount: n.refCount || 0,
      entityType: n.entityType || n.subtype || '',
      section: n.section || '',
      priority: n.priority || '',
      refDocs: n.docs || [],
      connectedProjects: n.connectedProjects || [],
      topicSlug: n.topicSlug || '',
      topicLabel: n.topicLabel || '',
      tagged: n.kind === 'finding'
    });
  }
  var topics = [];
  var tSlugs = Object.keys(topicMap);
  for (var ti = 0; ti < tSlugs.length; ti++) {
    topics.push({ slug: tSlugs[ti], label: topicMap[tSlugs[ti]] });
  }

  var graphLinks = [];
  for (var j = 0; j < payload.edges.length; j++) {
    graphLinks.push({
      source: payload.edges[j].source,
      target: payload.edges[j].target
    });
  }

  // Build scores in web-ui format (flat entries map)
  var scores = {};
  if (payload.scores && payload.scores.entries) {
    scores = payload.scores.entries;
  }

  // Detect VS Code theme
  var bodyBg = getComputedStyle(document.body).backgroundColor || '';
  var isDark = true;
  if (bodyBg) {
    var m = bodyBg.match(/\\d+/g);
    if (m && m.length >= 3) {
      var lum = (parseInt(m[0]) * 299 + parseInt(m[1]) * 587 + parseInt(m[2]) * 114) / 1000;
      isDark = lum < 128;
    }
  }
  document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');

  // Mount the web-ui graph
  if (window.phrenGraph && window.phrenGraph.mount) {
    window.phrenGraph.mount({
      nodes: graphNodes,
      links: graphLinks,
      scores: scores,
      topics: topics
    });
  } else {
    var fallback = document.getElementById('graph-canvas');
    if (fallback && fallback.parentElement) {
      fallback.parentElement.innerHTML = '<p style="padding:24px;color:var(--vscode-errorForeground,#f44)">Graph engine not available. Ensure the phren MCP server is built (npm run build in project root).</p>';
    }
  }

  // Wire up zoom buttons and skip-link via addEventListener (CSP safe)
  var zoomInBtn = document.getElementById('btn-zoom-in');
  var zoomOutBtn = document.getElementById('btn-zoom-out');
  var zoomResetBtn = document.getElementById('btn-zoom-reset');
  if (zoomInBtn) zoomInBtn.addEventListener('click', function() { window.graphZoom(1.2); });
  if (zoomOutBtn) zoomOutBtn.addEventListener('click', function() { window.graphZoom(0.8); });
  if (zoomResetBtn) zoomResetBtn.addEventListener('click', function() { window.graphReset(); });

  var skipLink = document.getElementById('skip-link');
  if (skipLink) {
    skipLink.addEventListener('focus', function() { skipLink.style.position = 'static'; skipLink.style.width = 'auto'; skipLink.style.height = 'auto'; });
    skipLink.addEventListener('blur', function() { skipLink.style.position = 'absolute'; skipLink.style.left = '-9999px'; skipLink.style.width = '1px'; skipLink.style.height = '1px'; });
  }

  // ── Node click → detail overlay ──
  var vscode = acquireVsCodeApi();
  var overlay = document.getElementById('node-overlay');
  var overlayText = document.getElementById('node-overlay-text');
  var overlayMeta = document.getElementById('node-overlay-meta');
  var overlayEdit = document.getElementById('node-overlay-edit');
  var overlayDelete = document.getElementById('node-overlay-delete');
  var overlayClose = document.getElementById('node-overlay-close');

  // Track current finding for action buttons
  var currentDetail = null;

  function hideOverlay() {
    if (overlay) overlay.style.display = 'none';
    currentDetail = null;
  }

  if (overlayClose) overlayClose.addEventListener('click', hideOverlay);

  if (overlayEdit) overlayEdit.addEventListener('click', function() {
    if (!currentDetail) return;
    vscode.postMessage({ command: 'editFinding', projectName: currentDetail.projectName, text: currentDetail.text });
  });

  if (overlayDelete) overlayDelete.addEventListener('click', function() {
    if (!currentDetail) return;
    vscode.postMessage({ command: 'deleteFinding', projectName: currentDetail.projectName, text: currentDetail.text });
    hideOverlay();
  });

  // Hook into the graph engine's node-select event (fired when the user clicks a bubble)
  // phrenGraph exposes window.phrenGraph.onNodeSelect(callback)
  if (window.phrenGraph && window.phrenGraph.onNodeSelect) {
    window.phrenGraph.onNodeSelect(function(node, canvasX, canvasY) {
      if (!node || node.group === 'project' || node.group === 'entity' || node.group === 'reference') {
        hideOverlay();
        return;
      }
      // Notify extension — it will send back full detail via postMessage
      vscode.postMessage({ command: 'nodeClick', nodeId: node.id, kind: node.id.startsWith('finding:') ? 'finding' : node.id.startsWith('task:') ? 'task' : 'other' });

      // Position overlay near the click point
      if (overlay) {
        var container = document.querySelector('.graph-container');
        var rect = container ? container.getBoundingClientRect() : { left: 0, top: 0, width: 800, height: 600 };
        var ox = Math.min(canvasX + 16, rect.width - 340);
        var oy = Math.min(canvasY + 16, rect.height - 200);
        overlay.style.left = Math.max(8, ox) + 'px';
        overlay.style.top = Math.max(8, oy) + 'px';
        overlay.style.display = 'none'; // hidden until extension responds
      }
    });
  } else {
    // Fallback: listen for canvas clicks directly and derive node from payload
    var canvas = document.getElementById('graph-canvas');
    if (canvas) {
      canvas.addEventListener('click', function(evt) {
        // If the graph engine doesn't have onNodeSelect, fall back to a manual hit test
        // against a simple node-position map if window.phrenGraph.getNodeAt is available
        if (window.phrenGraph && window.phrenGraph.getNodeAt) {
          var node = window.phrenGraph.getNodeAt(evt.offsetX, evt.offsetY);
          if (node && node.id.startsWith('finding:')) {
            vscode.postMessage({ command: 'nodeClick', nodeId: node.id, kind: 'finding' });
          }
        }
      });
    }
  }

  // Listen for messages back from the extension
  window.addEventListener('message', function(event) {
    var msg = event.data;
    if (!msg || msg.command !== 'nodeDetail') return;
    if (msg.kind !== 'finding') return;

    currentDetail = { projectName: msg.projectName, text: msg.text, nodeId: msg.nodeId };

    if (overlayText) overlayText.textContent = msg.text || '';
    if (overlayMeta) {
      var meta = '';
      if (msg.date) meta += msg.date;
      if (msg.topicLabel) meta += (meta ? ' · ' : '') + msg.topicLabel;
      overlayMeta.textContent = meta;
    }
    if (overlay) overlay.style.display = 'block';
  });
})();
  </script>
</body>
</html>`;
}

/* ── Helpers ──────────────────────────────────────────────── */

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function responseData(value: unknown): Record<string, unknown> | undefined {
  return asRecord(asRecord(value)?.data);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
