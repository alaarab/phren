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
    const projectNodeIds = new Set();
    // Build project nodes (skip empty orphans)
    for (const { projectName, summary, findings, tasks } of perProjectResults) {
        if (findings.length === 0 && tasks.length === 0)
            continue;
        const projectNodeId = `project:${projectName}`;
        projectNodeIds.add(projectNodeId);
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
            const colorMap = { decision: "#3b82f6", pitfall: "#ef4444", pattern: "#10b981", other: "#f4a261" };
            nodes.push({
                id: findingId,
                kind: "finding",
                projectName,
                label: finding.text.slice(0, 40) + (finding.text.length > 40 ? "..." : ""),
                subtype: finding.findingType,
                text: finding.text,
                radius: 8,
                color: colorMap[finding.findingType] || "#f4a261",
                date: finding.date,
                stableId: finding.stableId,
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
                    if (doc.startsWith(pName + "/")) {
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
        parsed.push({
            id,
            date: asString(record?.date) ?? "",
            text,
            stableId: asString(record?.stableId),
            findingType: classifyFinding(text),
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
function classifyFinding(text) {
    const lower = text.toLowerCase();
    if (lower.includes("decision") || lower.includes("chose") || lower.includes("decided"))
        return "decision";
    if (lower.includes("pitfall") || lower.includes("gotcha") || lower.includes("warning") || lower.includes("never ") || lower.includes("don't ") || lower.includes("avoid"))
        return "pitfall";
    if (lower.includes("pattern") || lower.includes("always ") || lower.includes("convention") || lower.includes("standard"))
        return "pattern";
    return "other";
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
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cortex Entity Graph</title>
  <style>
    :root { color-scheme:light dark; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; --border:color-mix(in srgb,var(--vscode-foreground) 20%,transparent); }
    * { box-sizing:border-box; }
    body { margin:0; height:100vh; overflow:hidden; color:var(--vscode-foreground); background:var(--vscode-editor-background); }
    .filter-bar { display:flex; gap:10px; padding:8px 12px; background:var(--vscode-editorWidget-background); border-bottom:1px solid var(--border); align-items:center; flex-wrap:wrap; }
    .filter-bar label { font-size:12px; opacity:0.8; }
    .filter-bar select, .filter-bar input[type=text] { font-size:12px; background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--border); border-radius:4px; padding:3px 6px; }
    .filter-bar input[type=range] { font-size:12px; }
    .filter-bar .limit-val { font-size:11px; min-width:36px; text-align:center; }
    #searchBox { width:160px; }
    .type-toggles { display:flex; gap:4px; align-items:center; }
    .type-toggle { display:flex; align-items:center; gap:2px; font-size:11px; cursor:pointer; padding:2px 7px; border-radius:999px; border:1px solid var(--border); user-select:none; opacity:0.5; transition:opacity 0.15s; }
    .type-toggle.active { opacity:1; }
    .type-toggle .dot { width:8px; height:8px; border-radius:50%; display:inline-block; }
    .layout { display:grid; grid-template-columns:3fr 1fr; height:calc(100vh - 40px); }
    .canvas-wrap { position:relative; overflow:hidden; background:color-mix(in srgb,var(--vscode-editor-background) 95%,#000); }
    canvas { display:block; width:100%; height:100%; }
    .controls { position:absolute; top:10px; right:10px; display:flex; flex-direction:column; gap:4px; z-index:2; }
    .controls button { width:30px; height:30px; border:1px solid var(--border); border-radius:6px; background:color-mix(in srgb,var(--vscode-editorWidget-background) 85%,transparent); color:var(--vscode-foreground); font-size:16px; cursor:pointer; display:grid; place-items:center; backdrop-filter:blur(4px); }
    .controls button:hover { background:var(--vscode-button-hoverBackground); color:var(--vscode-button-foreground); }
    .side { padding:16px; overflow:auto; border-left:1px solid var(--border); }
    .side h2 { margin:0 0 4px; font-size:11px; text-transform:uppercase; letter-spacing:0.05em; opacity:0.6; }
    .side .node-name { font-size:1.2rem; margin:0 0 8px; }
    .type-badge { display:inline-block; font-size:11px; padding:2px 8px; border-radius:999px; color:#fff; margin-bottom:6px; margin-right:4px; }
    .type-badge.project { background:#7c3aed; }
    .type-badge.decision { background:#3b82f6; }
    .type-badge.pitfall { background:#ef4444; }
    .type-badge.pattern { background:#10b981; }
    .type-badge.other { background:#f4a261; }
    .type-badge.active { background:#10b981; }
    .type-badge.queue { background:#eab308; }
    .type-badge.done { background:#6b7280; }
    .type-badge.entity { background:#06b6d4; }
    .type-badge.reference { background:#14b8a6; }
    .file-badges { display:flex; gap:6px; flex-wrap:wrap; margin:8px 0; }
    .file-badge { font-size:11px; padding:3px 8px; border-radius:999px; border:1px solid var(--border); background:color-mix(in srgb,var(--vscode-editorWidget-background) 80%,transparent); }
    .detail-text { white-space:pre-wrap; overflow-wrap:anywhere; line-height:1.5; font-size:13px; border:1px solid var(--border); border-radius:8px; padding:10px 12px; background:color-mix(in srgb,var(--vscode-editorWidget-background) 60%,transparent); margin-top:8px; }
    .detail-label { font-size:11px; opacity:0.6; margin-top:10px; }
    .quality-bar { margin-top:8px; padding:8px; border:1px solid var(--border); border-radius:6px; font-size:12px; }
    .quality-bar .q-row { display:flex; justify-content:space-between; margin:2px 0; }
    .quality-bar .q-val { font-weight:600; }
    .hint { font-size:12px; opacity:0.5; margin-top:14px; }
    @media (max-width:700px) {
      .layout { grid-template-columns:1fr; grid-template-rows:55vh 1fr; }
      .side { border-left:none; border-top:1px solid var(--border); }
    }
  </style>
</head>
<body>
  <a href="#detail" class="sr-only" style="position:absolute;left:-9999px;top:auto;width:1px;height:1px;overflow:hidden;z-index:100;" onfocus="this.style.position='static';this.style.width='auto';this.style.height='auto';" onblur="this.style.position='absolute';this.style.left='-9999px';this.style.width='1px';this.style.height='1px';">Skip to details panel</a>
  <div class="filter-bar">
    <input type="text" id="searchBox" placeholder="Search nodes...">
    <div class="type-toggles">
      <span class="type-toggle active" data-kind="project"><span class="dot" style="background:#7c3aed"></span>Projects</span>
      <span class="type-toggle active" data-kind="finding"><span class="dot" style="background:#f4a261"></span>Findings</span>
      <span class="type-toggle active" data-kind="task"><span class="dot" style="background:#10b981"></span>Tasks</span>
      <span class="type-toggle active" data-kind="entity"><span class="dot" style="background:#06b6d4"></span>Entities</span>
      <span class="type-toggle active" data-kind="reference"><span class="dot" style="background:#14b8a6"></span>Refs</span>
    </div>
    <label>Project</label>
    <select id="filterProject"><option value="all">All</option></select>
    <label>Health</label>
    <select id="filterHealth">
      <option value="all">All</option>
      <option value="healthy">Healthy</option>
      <option value="stale">Stale</option>
      <option value="decaying">Decaying</option>
    </select>
    <label>Age</label>
    <select id="filterAge">
      <option value="all">All</option>
      <option value="7d">Last 7 days</option>
      <option value="30d">Last 30 days</option>
      <option value="90d">Last 90 days</option>
    </select>
    <label>Limit</label>
    <input type="range" id="nodeLimit" min="10" max="10000" value="500" step="10">
    <span class="limit-val" id="limitVal">500</span>
  </div>
  <main class="layout">
    <section class="canvas-wrap">
      <canvas id="graph" aria-label="Cortex entity graph" tabindex="0" role="application"></canvas>
      <div id="graph-tooltip" style="display:none;position:absolute;pointer-events:none;padding:4px 8px;border-radius:4px;font-size:12px;max-width:300px;word-break:break-all;background:var(--vscode-editorWidget-background);color:var(--vscode-foreground);border:1px solid var(--border);z-index:10;box-shadow:0 2px 6px rgba(0,0,0,0.3)"></div>
      <div class="controls">
        <button id="zoomIn" title="Zoom in">+</button>
        <button id="zoomOut" title="Zoom out">&minus;</button>
        <button id="zoomReset" title="Reset view">R</button>
      </div>
    </section>
    <aside class="side" id="detail">
      <h2>Details</h2>
      <div class="node-name">No node selected</div>
      <div class="detail-text">Click a node in the graph to inspect it.</div>
    </aside>
  </main>
  <script nonce="${nonce}">
(function() {
  var payload = ${safePayload};
  var canvas = document.getElementById("graph");
  var ctx = canvas.getContext("2d");
  var detail = document.getElementById("detail");
  var typeToggles = document.querySelectorAll(".type-toggle");

  // Debug: show node counts in initial detail panel
  var _counts = {};
  for (var _i = 0; _i < payload.nodes.length; _i++) {
    var _k = payload.nodes[_i].kind;
    _counts[_k] = (_counts[_k] || 0) + 1;
  }
  detail.innerHTML = "<h2>Graph loaded</h2><div class='node-name'>Node counts</div>"
    + "<div class='detail-text'>" + JSON.stringify(_counts) + "\\nEdges: " + payload.edges.length + "</div>";
  var filterProject = document.getElementById("filterProject");
  var filterHealth = document.getElementById("filterHealth");
  var filterAge = document.getElementById("filterAge");
  var searchBox = document.getElementById("searchBox");
  var nodeLimit = document.getElementById("nodeLimit");
  var limitVal = document.getElementById("limitVal");

  var dpr = window.devicePixelRatio || 1;
  var canvasW = 400, canvasH = 300;

  /* ── quality multiplier (mirrors governance-scores.ts) ── */
  var NOW = Date.now();

  // Precompute score lookup: Map from stable node ID/project prefix to best score entry
  var _scoreByNodeId = {};
  var _scoreByProject = {};
  (function buildScoreLookup() {
    var entries = payload.scores && payload.scores.entries ? payload.scores.entries : {};
    var keys = Object.keys(entries);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      var entry = entries[key];
      // Index by exact key
      _scoreByNodeId[key] = entry;
      // Also index by project prefix (first path segment)
      var slashIdx = key.indexOf("/");
      if (slashIdx !== -1) {
        var proj = key.substring(0, slashIdx);
        var existing = _scoreByProject[proj];
        if (!existing || (entry.impressions || 0) > (existing.impressions || 0)) {
          _scoreByProject[proj] = entry;
        }
      }
    }
  })();

  function lookupScore(node) {
    // 1. Exact match on stableId if available
    if (node.stableId && _scoreByNodeId[node.stableId]) return _scoreByNodeId[node.stableId];
    // 2. Exact match on node.id
    if (_scoreByNodeId[node.id]) return _scoreByNodeId[node.id];
    // 3. Project-level fallback
    if (node.projectName && _scoreByProject[node.projectName]) return _scoreByProject[node.projectName];
    return null;
  }

  function computeQuality(node) {
    var entry = lookupScore(node);
    if (!entry) return { multiplier: 1.0, daysSinceUse: -1, helpful: 0 };

    var daysSinceUse = entry.lastUsedAt ? (NOW - new Date(entry.lastUsedAt).getTime()) / 86400000 : 999;
    var recencyBoost = daysSinceUse <= 7 ? 0.15 : (daysSinceUse <= 30 ? 0 : Math.max(-0.3, -0.1 * Math.floor((daysSinceUse - 30) / 30)));
    var frequencyBoost = Math.min(0.2, Math.log2((entry.impressions || 0) + 1) * 0.05);
    var feedbackScore = (entry.helpful || 0) * 0.15 - ((entry.repromptPenalty || 0) + (entry.regressionPenalty || 0) * 2) * 0.2;
    var multiplier = Math.max(0.2, Math.min(1.5, 1 + feedbackScore + recencyBoost + frequencyBoost));
    return { multiplier: multiplier, daysSinceUse: daysSinceUse, helpful: entry.helpful || 0 };
  }

  function nodeOpacity(multiplier) {
    // 0.2 -> 0.3, >=1.0 -> 1.0
    return 0.3 + (Math.min(multiplier, 1.0) - 0.2) * (0.7 / 0.8);
  }

  function healthCategory(daysSinceUse) {
    if (daysSinceUse < 0) return "unknown";
    if (daysSinceUse <= 7) return "recent";
    if (daysSinceUse <= 30) return "normal";
    if (daysSinceUse <= 90) return "stale";
    return "decaying";
  }

  /* ── accessibility: health indicators + ARIA ── */
  function healthStatusLabel(cat) {
    if (cat === "recent" || cat === "normal") return "H";
    if (cat === "stale") return "S";
    if (cat === "decaying") return "D";
    return null;
  }

  function healthDashPattern(cat, sc) {
    if (cat === "recent" || cat === "normal") return [];
    if (cat === "stale") return [6 / sc, 3 / sc];
    if (cat === "decaying") return [2 / sc, 3 / sc];
    return [];
  }

  var liveRegion = null;
  var focusedNodeIndex = -1;

  function announce(text) {
    if (!liveRegion) return;
    liveRegion.textContent = "";
    setTimeout(function() { liveRegion.textContent = text; }, 50);
  }

  function announceNode(node) {
    if (!node) { announce("No node selected"); return; }
    var cat = healthCategory(node.daysSinceUse);
    var parts = [node.label, node.kind];
    if (cat !== "unknown") parts.push(cat + " health");
    announce("Selected: " + parts.join(", "));
  }

  function announceFilterChange() {
    announce("Showing " + activeNodes.length + " of " + payload.nodes.length + " nodes");
  }

  function panToNode(nd) {
    panX = canvasW / 2 - nd.x * scale;
    panY = canvasH / 2 - nd.y * scale;
  }

  /* ── project filter ── */
  var projectNames = [];
  for (var i = 0; i < payload.nodes.length; i++) {
    if (payload.nodes[i].kind === "project" && projectNames.indexOf(payload.nodes[i].projectName) === -1) {
      projectNames.push(payload.nodes[i].projectName);
    }
  }
  projectNames.forEach(function(name) {
    var opt = document.createElement("option");
    opt.value = name; opt.textContent = name;
    filterProject.appendChild(opt);
  });

  /* ── state ── */
  var scale = 1, panX = 0, panY = 0;
  var selectedId = null;
  var activeNodes = [], activeLinks = [];
  var searchMatches = new Set();
  var pulsePhase = 0;

  function esc(v) {
    return String(v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  /* ── filtering ── */
  function getActiveKinds() {
    var kinds = {};
    typeToggles.forEach(function(el) {
      if (el.classList.contains("active")) kinds[el.getAttribute("data-kind")] = true;
    });
    return kinds;
  }
  function getFilteredData() {
    var activeKinds = getActiveKinds();
    var projVal = filterProject.value;
    var healthVal = filterHealth.value;
    var ageVal = filterAge.value;
    var limit = parseInt(nodeLimit.value, 10);

    // Age filter: compute cutoff date
    var ageCutoff = 0;
    if (ageVal === "7d") ageCutoff = NOW - 7 * 86400000;
    else if (ageVal === "30d") ageCutoff = NOW - 30 * 86400000;
    else if (ageVal === "90d") ageCutoff = NOW - 90 * 86400000;

    var filtered = [];
    for (var i = 0; i < payload.nodes.length; i++) {
      var n = payload.nodes[i];
      if (!activeKinds[n.kind]) continue;
      if (projVal !== "all" && n.projectName !== projVal) continue;
      if (healthVal !== "all") {
        var q = computeQuality(n);
        var cat = healthCategory(q.daysSinceUse);
        if (healthVal === "healthy" && cat !== "recent" && cat !== "normal" && cat !== "unknown") continue;
        if (healthVal === "stale" && cat !== "stale") continue;
        if (healthVal === "decaying" && cat !== "decaying") continue;
      }
      // Age filter: skip nodes older than cutoff (projects always pass)
      if (ageCutoff > 0 && n.kind !== "project") {
        var nodeDate = n.date ? new Date(n.date).getTime() : 0;
        if (nodeDate > 0 && nodeDate < ageCutoff) continue;
      }
      filtered.push(n);
    }

    // Priority order: projects first, entities by refCount desc, findings, tasks, references
    var projects = [], entities = [], findings = [], tasks = [], refs = [];
    for (var j = 0; j < filtered.length; j++) {
      var nd = filtered[j];
      if (nd.kind === "project") projects.push(nd);
      else if (nd.kind === "entity") entities.push(nd);
      else if (nd.kind === "finding") findings.push(nd);
      else if (nd.kind === "task") tasks.push(nd);
      else refs.push(nd);
    }
    entities.sort(function(a, b) { return (b.refCount || 0) - (a.refCount || 0); });
    var sorted = projects.concat(entities, findings, tasks, refs);

    // Ensure parent projects of visible children are included
    var result = sorted.slice(0, limit);
    var idSet = {};
    for (var r = 0; r < result.length; r++) idSet[result[r].id] = true;
    for (var r2 = 0; r2 < result.length; r2++) {
      if (result[r2].kind !== "project") {
        var pid = "project:" + result[r2].projectName;
        if (!idSet[pid]) {
          var pnode = null;
          for (var p = 0; p < payload.nodes.length; p++) {
            if (payload.nodes[p].id === pid) { pnode = payload.nodes[p]; break; }
          }
          if (pnode) { result.push(pnode); idSet[pid] = true; }
        }
      }
    }

    var edgeResult = [];
    for (var e = 0; e < payload.edges.length; e++) {
      if (idSet[payload.edges[e].source] && idSet[payload.edges[e].target]) {
        edgeResult.push(payload.edges[e]);
      }
    }
    return { nodes: result, edges: edgeResult };
  }

  /* ── resize ── */
  function resizeCanvas() {
    var rect = canvas.parentElement.getBoundingClientRect();
    var oldW = canvasW, oldH = canvasH;
    canvasW = Math.max(rect.width, 100);
    canvasH = Math.max(rect.height, 100);
    canvas.width = canvasW * dpr;
    canvas.height = canvasH * dpr;
    canvas.style.width = canvasW + "px";
    canvas.style.height = canvasH + "px";
    /* preserve viewport center on resize */
    if (oldW > 0 && oldH > 0) {
      var oldCX = (oldW / 2 - panX) / scale;
      var oldCY = (oldH / 2 - panY) / scale;
      panX = canvasW / 2 - oldCX * scale;
      panY = canvasH / 2 - oldCY * scale;
    }
    render();
  }
  window.addEventListener("resize", resizeCanvas);

  /* ── PURE STATIC ring layout — NO force simulation ── */
  var PI2 = Math.PI * 2;
  var PER_RING = 8;         // nodes per ring
  var RING_START = 38;      // first ring distance from parent
  var RING_GAP = 22;        // distance between rings

  function computeChildPositions(parentX, parentY, children) {
    for (var i = 0; i < children.length; i++) {
      var ring = Math.floor(i / PER_RING);
      var pos = i % PER_RING;
      var countInRing = Math.min(children.length - ring * PER_RING, PER_RING);
      var r = RING_START + ring * RING_GAP;
      var offset = (ring % 2 === 1) ? PI2 / (countInRing * 2) : 0;
      var a = (PI2 * pos / countInRing) + offset;
      children[i]._rx = parentX + Math.cos(a) * r;
      children[i]._ry = parentY + Math.sin(a) * r;
    }
  }

  /* ── rebuild (pure static — no simulation) ── */
  function rebuild() {
    var data = getFilteredData();

    var rawProjects = [], allChildren = [];
    for (var ni = 0; ni < data.nodes.length; ni++) {
      var nd = data.nodes[ni];
      if (nd.kind === "project") rawProjects.push(nd);
      else allChildren.push(nd);
    }

    // Group children by project
    var groups = {};
    for (var ci = 0; ci < allChildren.length; ci++) {
      var pname = allChildren[ci].projectName || "";
      if (!groups[pname]) groups[pname] = [];
      groups[pname].push(allChildren[ci]);
    }

    // Compute max cluster outer radius
    var maxClusterR = 30;
    for (var mc = 0; mc < rawProjects.length; mc++) {
      var grp = groups[rawProjects[mc].projectName] || [];
      var lastRing = grp.length > 0 ? Math.floor((grp.length - 1) / PER_RING) : 0;
      var outerR = RING_START + lastRing * RING_GAP + 14;
      if (outerR > maxClusterR) maxClusterR = outerR;
    }

    // Place projects on a ring large enough that clusters never overlap
    var cx = canvasW / 2, cy = canvasH / 2;
    var n = rawProjects.length;
    // Allow clusters to be closer (70% of no-overlap distance) — tighter feel
    var minProjR = n <= 1 ? 0 : n <= 2 ? maxClusterR * 1.6 : (maxClusterR * 0.7) / Math.sin(Math.PI / n);
    var projR = Math.max(minProjR, 120);
    var projMap = {};

    var liveProjects = [];
    for (var pi = 0; pi < rawProjects.length; pi++) {
      var rp = rawProjects[pi];
      var angle = PI2 * pi / Math.max(n, 1) - Math.PI / 2;
      var q = computeQuality(rp);
      var lp = {
        id: rp.id, kind: rp.kind, projectName: rp.projectName, label: rp.label,
        subtype: rp.subtype, text: rp.text, radius: rp.radius, color: rp.color,
        qualityMultiplier: q.multiplier, daysSinceUse: q.daysSinceUse, helpful: q.helpful,
        x: cx + Math.cos(angle) * projR,
        y: cy + Math.sin(angle) * projR
      };
      liveProjects.push(lp);
      projMap[rp.projectName] = lp;
    }

    // Place children in rings around their parent
    var liveChildren = [];
    for (var pn in groups) {
      var par = projMap[pn];
      var px = par ? par.x : cx, py = par ? par.y : cy;
      computeChildPositions(px, py, groups[pn]);
      for (var gi = 0; gi < groups[pn].length; gi++) {
        var rc = groups[pn][gi];
        var q2 = computeQuality(rc);
        liveChildren.push({
          id: rc.id, kind: rc.kind, projectName: rc.projectName, label: rc.label,
          subtype: rc.subtype, text: rc.text, radius: rc.radius, color: rc.color,
          refCount: rc.refCount, date: rc.date, section: rc.section, priority: rc.priority,
          entityType: rc.entityType, connectedProjects: rc.connectedProjects,
          qualityMultiplier: q2.multiplier, daysSinceUse: q2.daysSinceUse, helpful: q2.helpful,
          x: rc._rx, y: rc._ry,
          _parentName: rc.projectName
        });
      }
    }

    activeNodes = liveProjects.concat(liveChildren);

    var byId = {};
    for (var i = 0; i < activeNodes.length; i++) byId[activeNodes[i].id] = activeNodes[i];

    activeLinks = [];
    for (var j = 0; j < data.edges.length; j++) {
      var s = byId[data.edges[j].source], t = byId[data.edges[j].target];
      if (s && t) activeLinks.push({ source: s, target: t });
    }

    autoFit();
  }

  // Recompute child ring positions after a project is dragged
  function recomputeChildren(projectNode) {
    var pname = projectNode.projectName;
    var kids = [];
    for (var i = 0; i < activeNodes.length; i++) {
      if (activeNodes[i]._parentName === pname) kids.push(activeNodes[i]);
    }
    computeChildPositions(projectNode.x, projectNode.y, kids);
    for (var j = 0; j < kids.length; j++) {
      kids[j].x = kids[j]._rx;
      kids[j].y = kids[j]._ry;
    }
  }

  /* ── render (Canvas2D) ── */
  function render() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvasW, canvasH);
    ctx.save();
    ctx.translate(panX, panY);
    ctx.scale(scale, scale);

    // Cross-project edges — bright and visible
    ctx.lineWidth = Math.max(0.5, Math.min(2.5 / scale, 3));
    var _hasSearch = searchMatches.size > 0;
    if (_hasSearch) {
      for (var e = 0; e < activeLinks.length; e++) {
        var link = activeLinks[e];
        if (link.source.kind === "project" && link.target.kind === "project") {
          var sMatch = searchMatches.has(link.source.id);
          var tMatch = searchMatches.has(link.target.id);
          ctx.beginPath();
          ctx.strokeStyle = (sMatch || tMatch) ? "rgba(160,170,255,0.6)" : "rgba(160,170,255,0.06)";
          ctx.moveTo(link.source.x, link.source.y);
          ctx.lineTo(link.target.x, link.target.y);
          ctx.stroke();
        }
      }
    } else {
      ctx.strokeStyle = "rgba(160,170,255,0.6)";
      ctx.beginPath();
      for (var e = 0; e < activeLinks.length; e++) {
        var link = activeLinks[e];
        if (link.source.kind === "project" && link.target.kind === "project") {
          ctx.moveTo(link.source.x, link.source.y);
          ctx.lineTo(link.target.x, link.target.y);
        }
      }
      ctx.stroke();
    }

    // Draw nodes
    for (var i = 0; i < activeNodes.length; i++) {
      var nd = activeNodes[i];
      var opacity = nodeOpacity(nd.qualityMultiplier || 1);
      /* dim non-matching nodes when search is active */
      if (searchMatches.size > 0 && !searchMatches.has(nd.id)) opacity = 0.1;
      ctx.globalAlpha = opacity;
      ctx.fillStyle = nd.color;
      ctx.beginPath();
      ctx.arc(nd.x, nd.y, nd.radius, 0, PI2);
      ctx.fill();

      // Health ring with dash pattern + text label (WCAG 1.4.1)
      var health = healthCategory(nd.daysSinceUse);
      var ringColor = null;
      if (health === "recent") ringColor = "#22c55e";
      else if (health === "stale") ringColor = "#f97316";
      else if (health === "decaying") ringColor = "#ef4444";
      if (ringColor) {
        var dashPat = healthDashPattern(health, scale);
        ctx.strokeStyle = ringColor;
        ctx.lineWidth = Math.max(0.5, Math.min(2 / scale, 3));
        if (dashPat.length) ctx.setLineDash(dashPat);
        ctx.beginPath();
        ctx.arc(nd.x, nd.y, nd.radius + 2, 0, PI2);
        ctx.stroke();
        ctx.setLineDash([]);
        var hlbl = healthStatusLabel(health);
        if (hlbl && scale >= 0.5) {
          var hfs = Math.max(7, Math.round(8 / scale));
          ctx.font = "600 " + hfs + "px sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillStyle = "#ffffff";
          ctx.globalAlpha = 0.9;
          ctx.fillText(hlbl, nd.x, nd.y);
          ctx.globalAlpha = 1.0;
        }
      }

      // Pulse for high-helpful nodes
      if (nd.helpful >= 3) {
        var pulseR = nd.radius + 4 + Math.sin(pulsePhase * 3) * 2;
        ctx.globalAlpha = 0.2 + Math.sin(pulsePhase * 3) * 0.1;
        ctx.strokeStyle = "#22c55e";
        ctx.lineWidth = Math.max(0.5, Math.min(1.5 / scale, 3));
        ctx.beginPath();
        ctx.arc(nd.x, nd.y, pulseR, 0, PI2);
        ctx.stroke();
      }

      // Selection ring
      if (nd.id === selectedId) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = Math.max(0.5, Math.min(2.5 / scale, 3));
        ctx.beginPath();
        ctx.arc(nd.x, nd.y, nd.radius + 1.5, 0, PI2);
        ctx.stroke();
      }

      // Keyboard focus ring (distinct from selection)
      if (i === focusedNodeIndex && nd.id !== selectedId) {
        ctx.globalAlpha = 1;
        ctx.setLineDash([4 / scale, 3 / scale]);
        ctx.strokeStyle = "#60a5fa";
        ctx.lineWidth = 2 / scale;
        ctx.beginPath();
        ctx.arc(nd.x, nd.y, nd.radius + 3, 0, PI2);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Search highlight
      if (searchMatches.has(nd.id)) {
        ctx.globalAlpha = 0.8;
        ctx.strokeStyle = "#facc15";
        ctx.lineWidth = Math.max(0.5, Math.min(2.5 / scale, 3));
        ctx.beginPath();
        ctx.arc(nd.x, nd.y, nd.radius + 3, 0, PI2);
        ctx.stroke();
      }
    }

    // Labels — always visible, constant screen-space size
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    var fg = getComputedStyle(document.body).color || "#ccc";
    var bg = getComputedStyle(document.body).backgroundColor || "#1e1e1e";

    for (var li = 0; li < activeNodes.length; li++) {
      var ln = activeNodes[li];

      var screenPx = ln.kind === "project" ? 14 : 9;
      var worldPx = screenPx / scale;
      ctx.font = (ln.kind === "project" ? "700 " : "400 ") + worldPx + "px -apple-system,BlinkMacSystemFont,sans-serif";

      var labelText = ln.label;
      if (ln.kind !== "project" && labelText.length > 14) labelText = labelText.slice(0, 12) + "..";
      var lx = ln.x, ly = ln.y + ln.radius + 2;
      var tw = ctx.measureText(labelText).width;

      // Background pill only for projects (reduces clutter for children)
      if (ln.kind === "project") {
        ctx.globalAlpha = 0.8;
        ctx.fillStyle = bg;
        ctx.fillRect(lx - tw / 2 - 3, ly - 1, tw + 6, worldPx + 3);
      }

      ctx.globalAlpha = ln.kind === "project" ? 1.0 : 0.7;
      /* dim labels for non-matching nodes during search */
      if (searchMatches.size > 0 && !searchMatches.has(ln.id)) ctx.globalAlpha = 0.1;
      ctx.fillStyle = fg;
      ctx.fillText(labelText, lx, ly);
    }

    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function autoFit() {
    if (activeNodes.length === 0) return;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < activeNodes.length; i++) {
      var n = activeNodes[i];
      if (n.x < minX) minX = n.x; if (n.y < minY) minY = n.y;
      if (n.x > maxX) maxX = n.x; if (n.y > maxY) maxY = n.y;
    }
    var pad = 40;
    var graphW = (maxX - minX) + pad * 2;
    var graphH = (maxY - minY) + pad * 2;
    var fitScale = Math.min(canvasW / graphW, canvasH / graphH, 2.0);
    scale = fitScale;
    panX = canvasW / 2 - ((minX + maxX) / 2) * scale;
    panY = canvasH / 2 - ((minY + maxY) / 2) * scale;
  }

  /* ── hit testing ── */
  function hitTest(clientX, clientY) {
    var rect = canvas.getBoundingClientRect();
    var mx = (clientX - rect.left - panX) / scale;
    var my = (clientY - rect.top - panY) / scale;
    var best = null, bestDist = Infinity;
    for (var i = 0; i < activeNodes.length; i++) {
      var n = activeNodes[i];
      var dx = n.x - mx, dy = n.y - my;
      var d = Math.sqrt(dx * dx + dy * dy);
      var hitR = Math.max(n.radius + 4, 14);
      if (d < hitR && d < bestDist) { best = n; bestDist = d; }
    }
    return best;
  }

  /* ── interaction: node drag ── */
  var dragNode = null;
  var isDragging = false;
  var isPanning = false;
  var lastMX = 0, lastMY = 0, panStartX = 0, panStartY = 0, dragStartMX = 0, dragStartMY = 0;

  canvas.addEventListener("pointerdown", function(e) {
    var hit = hitTest(e.clientX, e.clientY);
    lastMX = e.clientX; lastMY = e.clientY;
    if (hit) {
      dragNode = hit;
      isDragging = true;
      canvas.setPointerCapture(e.pointerId);
    } else {
      isPanning = true;
      panStartX = panX; panStartY = panY;
      dragStartMX = e.clientX; dragStartMY = e.clientY;
      canvas.style.cursor = "grabbing";
    }
  });

  canvas.addEventListener("pointermove", function(e) {
    if (isDragging && dragNode) {
      var dx = (e.clientX - lastMX) / scale;
      var dy = (e.clientY - lastMY) / scale;
      dragNode.x += dx; dragNode.y += dy;
      if (dragNode.kind === "project") recomputeChildren(dragNode);
      lastMX = e.clientX; lastMY = e.clientY;
      render();
    } else if (isPanning) {
      panX = panStartX + (e.clientX - dragStartMX);
      panY = panStartY + (e.clientY - dragStartMY);
      render();
    }
  });

  canvas.addEventListener("pointerup", function(e) {
    if (isDragging && dragNode) {
      selectNode(dragNode);
      canvas.releasePointerCapture(e.pointerId);
      dragNode = null;
      isDragging = false;
    }
    if (isPanning) {
      isPanning = false;
      canvas.style.cursor = "default";
    }
  });

  canvas.addEventListener("pointercancel", function() {
    dragNode = null; isDragging = false; isPanning = false;
    canvas.style.cursor = "default";
  });

  /* ── tooltip on hover (200ms delay, full label) ── */
  var _tooltip = document.getElementById("graph-tooltip");
  var _ttNode = null, _ttTimer = null;
  canvas.addEventListener("mousemove", function(e) {
    if (isDragging || isPanning) {
      if (_tooltip) _tooltip.style.display = "none";
      _ttNode = null;
      clearTimeout(_ttTimer);
      return;
    }
    var hit = hitTest(e.clientX, e.clientY);
    var rect = canvas.getBoundingClientRect();
    if (hit && _tooltip) {
      if (hit !== _ttNode) {
        _ttNode = hit;
        clearTimeout(_ttTimer);
        _tooltip.style.display = "none";
        _ttTimer = setTimeout(function() {
          if (_ttNode === hit) {
            _tooltip.style.display = "block";
            _tooltip.textContent = hit.text || hit.label || hit.id;
          }
        }, 200);
      }
      _tooltip.style.left = (e.clientX - rect.left + 12) + "px";
      _tooltip.style.top = (e.clientY - rect.top - 8) + "px";
    } else if (_tooltip) {
      _ttNode = null;
      clearTimeout(_ttTimer);
      _tooltip.style.display = "none";
    }
  });
  canvas.addEventListener("mouseleave", function() {
    _ttNode = null;
    clearTimeout(_ttTimer);
    if (_tooltip) _tooltip.style.display = "none";
  });

  /* ── zoom ── */
  canvas.addEventListener("wheel", function(e) {
    e.preventDefault();
    var rect = canvas.getBoundingClientRect();
    var mx = e.clientX - rect.left;
    var my = e.clientY - rect.top;
    var factor = e.deltaY < 0 ? 1.1 : 0.9;
    var newScale = scale * factor;
    panX = mx - (mx - panX) * (newScale / scale);
    panY = my - (my - panY) * (newScale / scale);
    scale = newScale;
    render();
  }, { passive: false });

  document.getElementById("zoomIn").addEventListener("click", function() { scale *= 1.2; render(); });
  document.getElementById("zoomOut").addEventListener("click", function() { scale *= 0.8; render(); });
  document.getElementById("zoomReset").addEventListener("click", function() { scale = 1; panX = 0; panY = 0; autoFit(); render(); });

  /* ── keyboard navigation (a11y) ── */
  canvas.setAttribute("tabindex", "0");
  canvas.setAttribute("role", "application");
  canvas.setAttribute("aria-label", "Knowledge graph. Use Tab to cycle nodes, Enter to select, Arrow keys to pan, +/- to zoom, Home to reset, Escape to deselect.");

  canvas.addEventListener("keydown", function(e) {
    var PAN_STEP = 40;
    var handled = true;
    switch (e.key) {
      case "Tab":
        e.preventDefault();
        if (activeNodes.length === 0) break;
        if (e.shiftKey) {
          focusedNodeIndex = focusedNodeIndex <= 0 ? activeNodes.length - 1 : focusedNodeIndex - 1;
        } else {
          focusedNodeIndex = (focusedNodeIndex + 1) % activeNodes.length;
        }
        panToNode(activeNodes[focusedNodeIndex]);
        announceNode(activeNodes[focusedNodeIndex]);
        render();
        break;
      case "Enter":
        if (focusedNodeIndex >= 0 && focusedNodeIndex < activeNodes.length) {
          selectNode(activeNodes[focusedNodeIndex]);
          announceNode(activeNodes[focusedNodeIndex]);
          detail.focus();
        }
        break;
      case "Escape":
        if (selectedId) {
          selectedId = null;
          detail.innerHTML = "<h2>Details</h2><div class='node-name'>No node selected</div><div class='detail-text'>Click a node in the graph to inspect it.</div>";
          announce("Deselected");
          canvas.focus();
        } else {
          focusedNodeIndex = -1;
        }
        render();
        break;
      case "ArrowLeft":
        e.preventDefault(); panX += PAN_STEP; render(); break;
      case "ArrowRight":
        e.preventDefault(); panX -= PAN_STEP; render(); break;
      case "ArrowUp":
        e.preventDefault(); panY += PAN_STEP; render(); break;
      case "ArrowDown":
        e.preventDefault(); panY -= PAN_STEP; render(); break;
      case "+": case "=":
        scale *= 1.15; render(); break;
      case "-": case "_":
        scale *= 0.85; render(); break;
      case "Home":
        scale = 1; panX = 0; panY = 0; autoFit(); focusedNodeIndex = -1;
        render(); announce("View reset"); break;
      default:
        handled = false;
    }
    if (handled) e.stopPropagation();
  });

  /* ── select node ── */
  function selectNode(node) {
    selectedId = node.id;
    render();

    var q = { multiplier: node.qualityMultiplier || 1, daysSinceUse: node.daysSinceUse, helpful: node.helpful || 0 };
    var healthStr = healthCategory(q.daysSinceUse);
    var healthLabel = healthStr === "recent" ? "Recent (< 7d)" : healthStr === "normal" ? "Normal" : healthStr === "stale" ? "Stale (30-90d)" : healthStr === "decaying" ? "Decaying (90d+)" : "Unknown";

    var qualityHtml = "<div class='quality-bar'>"
      + "<div class='q-row'><span>Quality multiplier</span><span class='q-val'>" + q.multiplier.toFixed(2) + "</span></div>"
      + "<div class='q-row'><span>Health</span><span class='q-val'>" + healthLabel + "</span></div>"
      + "<div class='q-row'><span>Helpful count</span><span class='q-val'>" + q.helpful + "</span></div>"
      + "</div>";

    if (node.kind === "project") {
      var proj = payload.summaries[node.projectName];
      var fileBadges = proj ? proj.files.slice(0, 12).map(function(f) {
        return "<span class='file-badge'>" + esc(f.type) + ": " + esc(f.filename) + "</span>";
      }).join("") : "";
      var counts = proj ? "<div class='detail-label'>Findings: " + (proj.findingCount || 0) + " | Tasks: " + (proj.taskCount || 0) + "</div>" : "";
      detail.innerHTML = "<h2>Project</h2>"
        + "<div class='node-name'>" + esc(node.projectName) + "</div>"
        + "<span class='type-badge project'>project</span>"
        + counts
        + (fileBadges ? "<div class='file-badges'>" + fileBadges + "</div>" : "")
        + "<div class='detail-text'>" + esc(proj ? proj.summary : "No summary.") + "</div>"
        + qualityHtml;
    } else if (node.kind === "finding") {
      detail.innerHTML = "<h2>Finding</h2>"
        + "<div class='node-name'>" + esc(node.label) + "</div>"
        + "<span class='type-badge " + esc(node.subtype) + "'>" + esc(node.subtype) + "</span>"
        + (node.date ? "<div class='detail-label'>Date: " + esc(node.date) + "</div>" : "")
        + "<div class='detail-label'>Project</div>"
        + "<span class='type-badge project'>" + esc(node.projectName) + "</span>"
        + "<div class='detail-text'>" + esc(node.text) + "</div>"
        + qualityHtml;
    } else if (node.kind === "task") {
      detail.innerHTML = "<h2>Task</h2>"
        + "<div class='node-name'>" + esc(node.label) + "</div>"
        + "<span class='type-badge " + esc(node.subtype) + "'>" + esc(node.section || node.subtype) + "</span>"
        + (node.priority ? " <span class='type-badge other'>" + esc(node.priority) + "</span>" : "")
        + "<div class='detail-label'>Project</div>"
        + "<span class='type-badge project'>" + esc(node.projectName) + "</span>"
        + "<div class='detail-text'>" + esc(node.text) + "</div>"
        + qualityHtml;
    } else if (node.kind === "entity") {
      var connHtml = "";
      if (node.connectedProjects && node.connectedProjects.length > 0) {
        connHtml = "<div class='detail-label'>Connected projects</div><div class='file-badges'>"
          + node.connectedProjects.map(function(p) { return "<span class='file-badge'>" + esc(p) + "</span>"; }).join("")
          + "</div>";
      }
      detail.innerHTML = "<h2>Entity</h2>"
        + "<div class='node-name'>" + esc(node.label) + "</div>"
        + "<span class='type-badge entity'>" + esc(node.entityType || node.subtype) + "</span>"
        + "<div class='detail-label'>References: " + (node.refCount || 0) + "</div>"
        + connHtml
        + "<div class='detail-text'>" + esc(node.text) + "</div>"
        + qualityHtml;
    } else if (node.kind === "reference") {
      detail.innerHTML = "<h2>Reference</h2>"
        + "<div class='node-name'>" + esc(node.label) + "</div>"
        + "<span class='type-badge reference'>reference</span>"
        + (node.projectName ? "<div class='detail-label'>Project</div><span class='type-badge project'>" + esc(node.projectName) + "</span>" : "")
        + "<div class='detail-text'>" + esc(node.text) + "</div>"
        + qualityHtml;
    }
  }

  /* ── search ── */
  searchBox.addEventListener("input", function() {
    var query = searchBox.value.trim().toLowerCase();
    searchMatches = new Set();
    if (!query) { render(); return; }

    var matches = [];
    for (var i = 0; i < activeNodes.length; i++) {
      var n = activeNodes[i];
      if (n.label.toLowerCase().indexOf(query) !== -1 || n.text.toLowerCase().indexOf(query) !== -1) {
        searchMatches.add(n.id);
        matches.push(n);
      }
    }

    if (matches.length === 1) {
      // Pan/zoom to center on single match
      scale = 1.5;
      panX = canvasW / 2 - matches[0].x * scale;
      panY = canvasH / 2 - matches[0].y * scale;
      selectNode(matches[0]);
    } else if (matches.length > 1) {
      // Fit view to bounding box of matches
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (var j = 0; j < matches.length; j++) {
        if (matches[j].x < minX) minX = matches[j].x;
        if (matches[j].y < minY) minY = matches[j].y;
        if (matches[j].x > maxX) maxX = matches[j].x;
        if (matches[j].y > maxY) maxY = matches[j].y;
      }
      var gp = 60;
      var gw = (maxX - minX) + gp * 2;
      var gh = (maxY - minY) + gp * 2;
      scale = Math.min(canvasW / gw, canvasH / gh, 2.0);
      var cx = (minX + maxX) / 2;
      var cy = (minY + maxY) / 2;
      panX = canvasW / 2 - cx * scale;
      panY = canvasH / 2 - cy * scale;
    }
    render();
  });

  /* ── filter handlers ── */
  function rebuildAll() { rebuild(); render(); announceFilterChange(); }
  typeToggles.forEach(function(el) {
    el.addEventListener("click", function() {
      el.classList.toggle("active");
      rebuildAll();
    });
  });
  filterProject.addEventListener("change", rebuildAll);
  filterHealth.addEventListener("change", rebuildAll);
  filterAge.addEventListener("change", rebuildAll);
  nodeLimit.addEventListener("input", function() { limitVal.textContent = nodeLimit.value; rebuildAll(); });

  /* ── init ── */
  /* create ARIA live region for screen reader announcements */
  liveRegion = document.createElement("div");
  liveRegion.setAttribute("role", "status");
  liveRegion.setAttribute("aria-live", "polite");
  liveRegion.setAttribute("aria-atomic", "true");
  liveRegion.style.cssText = "position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0";
  document.body.appendChild(liveRegion);

  /* make detail panel focusable for keyboard flow */
  detail.setAttribute("tabindex", "-1");
  detail.setAttribute("role", "region");
  detail.setAttribute("aria-label", "Node details");

  resizeCanvas();
  rebuild();
  render();
  if (activeNodes.length > 0) selectNode(activeNodes[0]);

  /* announce graph summary */
  var _initCounts = {};
  for (var _ci = 0; _ci < payload.nodes.length; _ci++) {
    var _ck = payload.nodes[_ci].kind;
    _initCounts[_ck] = (_initCounts[_ck] || 0) + 1;
  }
  var _sumParts = [];
  if (_initCounts.project) _sumParts.push(_initCounts.project + " projects");
  if (_initCounts.finding) _sumParts.push(_initCounts.finding + " findings");
  if (_initCounts.entity) _sumParts.push(_initCounts.entity + " entities");
  if (_initCounts.task) _sumParts.push(_initCounts.task + " tasks");
  announce("Graph loaded with " + _sumParts.join(", "));

  // Animate pulse continuously for high-helpful nodes (capped at 60fps)
  var _lastPulseTime = 0;
  var _PULSE_INTERVAL = 1000 / 60;
  (function animatePulse(timestamp) {
    if (timestamp - _lastPulseTime >= _PULSE_INTERVAL) {
      _lastPulseTime = timestamp;
      var hasPulse = false;
      for (var i = 0; i < activeNodes.length; i++) {
        if ((activeNodes[i].helpful || 0) >= 3) { hasPulse = true; break; }
      }
      if (hasPulse) {
        pulsePhase += 0.016;
        render();
      }
    }
    requestAnimationFrame(animatePulse);
  })(0);
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