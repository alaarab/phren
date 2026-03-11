"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.showGraphWebview = showGraphWebview;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
/**
 * Load the review-ui graph script from the MCP dist.
 * This gives us the Barnes-Hut force simulation, relevance gravity, a11y, etc.
 *
 * Resolution order:
 * 1. Same directory as compiled extension JS (works in .vsix packaging)
 * 2. Repo-relative path (works in source checkout)
 * Falls back to empty string if neither is available.
 */
function loadGraphScript() {
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
        }
        catch {
            // Try next candidate
        }
    }
    return "";
}
/* ── Main entry ──────────────────────────────────────────── */
async function showGraphWebview(client, context) {
    const panel = vscode.window.createWebviewPanel("cortex.entityGraph", "Cortex Entity Graph", vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [context.extensionUri] });
    panel.iconPath = vscode.Uri.file(path.join(context.extensionPath, "media", "cortex.svg"));
    panel.webview.html = renderLoadingHtml(panel.webview);
    try {
        const graphData = await loadGraphData(client);
        panel.webview.html = renderGraphHtml(panel.webview, graphData);
    }
    catch (error) {
        panel.webview.html = renderErrorHtml(panel.webview, toErrorMessage(error));
    }
}
/* ── Data loading ────────────────────────────────────────── */
async function loadGraphData(client) {
    const projects = await fetchProjects(client);
    // Parallel per-project fetches
    const perProjectResults = await Promise.all(projects.map(async (p) => {
        const [summary, findings, tasks] = await Promise.all([
            fetchProjectSummary(client, p.name),
            fetchFindings(client, p.name),
            fetchTasks(client, p.name),
        ]);
        return { projectName: p.name, summary, findings, tasks };
    }));
    // Entity graph
    const entities = await fetchEntities(client);
    // Memory scores
    const scores = loadMemoryScores();
    const nodes = [];
    const edges = [];
    const summaryMap = {};
    // Build project nodes (skip empty orphans)
    for (const { projectName, summary, findings, tasks } of perProjectResults) {
        if (findings.length === 0 && tasks.length === 0)
            continue;
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
            color: "#7c3aed",
        });
        // Finding nodes
        for (const finding of findings) {
            const findingId = `finding:${projectName}:${finding.id}`;
            nodes.push({
                id: findingId,
                kind: "finding",
                projectName,
                label: finding.text.slice(0, 40) + (finding.text.length > 40 ? "..." : ""),
                subtype: finding.topicSlug,
                text: finding.text,
                radius: 8,
                color: "#f4a261", // placeholder; actual color determined by graph engine from topic slug
                date: finding.date,
                stableId: finding.stableId,
                topicSlug: finding.topicSlug,
                topicLabel: finding.topicLabel,
            });
            edges.push({ source: projectNodeId, target: findingId });
        }
        // Task nodes (active + queue only)
        for (const task of tasks) {
            if (task.section === "Done")
                continue;
            const taskId = `task:${projectName}:${task.id}`;
            const sectionLower = task.section.toLowerCase();
            const taskColorMap = { active: "#10b981", queue: "#eab308", done: "#6b7280" };
            nodes.push({
                id: taskId,
                kind: "task",
                projectName,
                label: task.line.slice(0, 40) + (task.line.length > 40 ? "..." : ""),
                subtype: sectionLower,
                text: task.line,
                radius: 7,
                color: taskColorMap[sectionLower] || "#eab308",
                section: task.section,
                priority: task.priority,
            });
            edges.push({ source: projectNodeId, target: taskId });
        }
    }
    // Entity nodes and edges
    const projectNameSet = new Set(projects.map((p) => p.name));
    for (const entity of entities) {
        const entityId = entity.id || `entity:${entity.name}`;
        const connectedProjects = [];
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
            color: "#06b6d4",
            refCount: entity.refCount,
            entityType: entity.type,
            connectedProjects: uniqueConnected,
            docs: entity.docs,
        });
        // Entity → project edges
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
    const edgeSet = new Set();
    const uniqueEdges = [];
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
async function fetchProjects(client) {
    const raw = await client.listProjects();
    const data = responseData(raw);
    const parsed = [];
    for (const entry of asArray(data?.projects)) {
        const record = asRecord(entry);
        const name = asString(record?.name);
        // Skip bogus entries: paths, reserved names, stale FTS entries
        if (!name)
            continue;
        if (name.includes(":") || name.includes("/") || name.includes("\\"))
            continue;
        if (name === "global" || name === "scripts" || name === "templates" || name === "profiles")
            continue;
        // Filter known stale/non-profile projects (should be fixed at MCP level long-term)
        if (name === "dendron" || name === "cortex-framework" || name === "max4liveplugins" || name === "pcn-reports")
            continue;
        parsed.push({ name, brief: asString(record?.brief) });
    }
    return parsed;
}
async function fetchProjectSummary(client, project) {
    const raw = await client.getProjectSummary(project);
    const data = responseData(raw);
    const files = [];
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
async function fetchFindings(client, project) {
    const raw = await client.getFindings(project);
    const data = responseData(raw);
    const parsed = [];
    for (const entry of asArray(data?.findings)) {
        const record = asRecord(entry);
        const id = asString(record?.id) ?? asString(record?.stableId) ?? String(parsed.length);
        const text = asString(record?.text) ?? "";
        if (!text)
            continue;
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
async function fetchTasks(client, project) {
    const raw = await client.getTasks(project);
    const data = responseData(raw);
    const items = asRecord(data?.items);
    const parsed = [];
    for (const section of ["Active", "Queue"]) {
        for (const entry of asArray(items?.[section])) {
            const record = asRecord(entry);
            if (!record)
                continue;
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
        if (!record)
            continue;
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
async function fetchEntities(client) {
    try {
        const raw = await client.readGraph();
        const data = responseData(raw);
        const parsed = [];
        for (const entry of asArray(data?.entities)) {
            const record = asRecord(entry);
            if (!record)
                continue;
            parsed.push({
                name: asString(record.name) ?? "",
                type: asString(record.type) ?? "unknown",
                refCount: typeof record.refCount === "number" ? record.refCount : 0,
                docs: asArray(record.docs).filter((d) => typeof d === "string"),
            });
        }
        return parsed.slice(0, 500);
    }
    catch {
        return [];
    }
}
function loadMemoryScores() {
    try {
        const scoresPath = path.join(os.homedir(), ".cortex", ".runtime", "memory-scores.json");
        const raw = fs.readFileSync(scoresPath, "utf8");
        const parsed = JSON.parse(raw);
        return { schemaVersion: parsed.schemaVersion ?? 1, entries: parsed.entries ?? {} };
    }
    catch {
        return { schemaVersion: 1, entries: {} };
    }
}
/* Builtin topic keywords mirroring project-topics.ts BUILTIN_TOPICS */
const BUILTIN_TOPIC_KEYWORDS = [
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
function classifyFindingTopic(text) {
    const lower = text.toLowerCase();
    let bestSlug = "general";
    let bestLabel = "General";
    let bestScore = 0;
    for (const topic of BUILTIN_TOPIC_KEYWORDS) {
        let score = 0;
        for (const kw of topic.keywords) {
            if (lower.includes(kw))
                score++;
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
function renderLoadingHtml(webview) {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cortex Entity Graph</title>
  <style>
    body { margin:0; display:grid; place-items:center; min-height:100vh; color:var(--vscode-foreground); font-family:sans-serif; }
  </style>
</head>
<body><div>Loading Cortex Entity Graph...</div></body>
</html>`;
}
function renderErrorHtml(webview, errorMessage) {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cortex Entity Graph</title>
  <style>
    body { margin:0; display:grid; place-items:center; min-height:100vh; padding:24px; color:var(--vscode-errorForeground); font-family:sans-serif; }
    .panel { max-width:720px; border:1px solid; border-radius:10px; padding:16px; }
  </style>
</head>
<body><div class="panel">Failed to render entity graph: ${escapeHtml(errorMessage)}</div></body>
</html>`;
}
function renderGraphHtml(webview, payload) {
    const nonce = getNonce();
    const safePayload = JSON.stringify(payload).replace(/</g, "\\u003c");
    // Load the review-ui graph script (Barnes-Hut force sim, relevance gravity, a11y, etc.)
    const graphScript = loadGraphScript();
    return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cortex Entity Graph</title>
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
    </section>
    <aside class="graph-detail-panel" id="graph-detail-panel">
      <h2>Details</h2>
      <div id="graph-detail-meta">Click a bubble to inspect it.</div>
      <div id="graph-detail-body"><p class="text-muted" style="margin:0">Use the graph filters, then click a project or finding bubble to pin its details here.</p></div>
    </aside>
  </main>
  <script nonce="${nonce}">
// ── Review-UI graph engine (Barnes-Hut + relevance gravity) ──
${graphScript}

// ── Data adapter: transform extension payload to review-ui format ──
(function() {
  var payload = ${safePayload};

  var graphNodes = [];
  for (var i = 0; i < payload.nodes.length; i++) {
    var n = payload.nodes[i];
    var group = 'other';
    if (n.kind === 'project') group = 'project';
    else if (n.kind === 'finding') group = n.subtype || 'other';
    else if (n.kind === 'task') group = 'task-' + (n.subtype || 'queue');
    else if (n.kind === 'entity') group = 'entity';
    else if (n.kind === 'reference') group = 'reference';

    graphNodes.push({
      id: n.id,
      group: group,
      project: n.projectName || '',
      label: n.label,
      fullLabel: n.text || n.label,
      refCount: n.refCount || 0,
      entityType: n.entityType || n.subtype || '',
      section: n.section || '',
      priority: n.priority || '',
      refDocs: n.docs || [],
      connectedProjects: n.connectedProjects || []
    });
  }

  var graphLinks = [];
  for (var j = 0; j < payload.edges.length; j++) {
    graphLinks.push({
      source: payload.edges[j].source,
      target: payload.edges[j].target
    });
  }

  // Build scores in review-ui format (flat entries map)
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

  // Mount the review-ui graph
  if (window.cortexGraph && window.cortexGraph.mount) {
    window.cortexGraph.mount({
      nodes: graphNodes,
      links: graphLinks,
      scores: scores
    });
  } else {
    var fallback = document.getElementById('graph-canvas');
    if (fallback && fallback.parentElement) {
      fallback.parentElement.innerHTML = '<p style="padding:24px;color:var(--vscode-errorForeground,#f44)">Graph engine not available. Ensure the cortex MCP server is built (npm run build in cortex root).</p>';
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
})();
  </script>
</body>
</html>`;
}
/* ── Helpers ──────────────────────────────────────────────── */
function getNonce() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let nonce = "";
    for (let i = 0; i < 32; i++) {
        nonce += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return nonce;
}
function asRecord(value) {
    return typeof value === "object" && value !== null ? value : undefined;
}
function asArray(value) {
    return Array.isArray(value) ? value : [];
}
function asString(value) {
    return typeof value === "string" ? value : undefined;
}
function responseData(value) {
    return asRecord(asRecord(value)?.data);
}
function escapeHtml(value) {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function toErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=graphWebview.js.map