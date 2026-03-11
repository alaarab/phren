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
            radius: 18,
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
        const entityId = `entity:${entity.name}`;
        const connectedProjects = [];
        for (const doc of entity.docs) {
            for (const pName of projectNameSet) {
                if (doc.includes(pName)) {
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
                    if (doc.includes(pName)) {
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
        if (name) {
            parsed.push({ name, brief: asString(record?.brief) });
        }
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
    .detail-text { white-space:pre-wrap; line-height:1.5; font-size:13px; border:1px solid var(--border); border-radius:8px; padding:10px 12px; background:color-mix(in srgb,var(--vscode-editorWidget-background) 60%,transparent); margin-top:8px; }
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
    <label>Limit</label>
    <input type="range" id="nodeLimit" min="10" max="10000" value="500" step="10">
    <span class="limit-val" id="limitVal">500</span>
  </div>
  <main class="layout">
    <section class="canvas-wrap">
      <canvas id="graph" aria-label="Cortex entity graph"></canvas>
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
  var filterProject = document.getElementById("filterProject");
  var filterHealth = document.getElementById("filterHealth");
  var searchBox = document.getElementById("searchBox");
  var nodeLimit = document.getElementById("nodeLimit");
  var limitVal = document.getElementById("limitVal");

  var dpr = window.devicePixelRatio || 1;
  var canvasW = 400, canvasH = 300;

  /* ── quality multiplier (mirrors governance-scores.ts) ── */
  var NOW = Date.now();
  function computeQuality(node) {
    var entries = payload.scores && payload.scores.entries ? payload.scores.entries : {};
    var entry = null;
    // Try to find a matching score entry by stableId or id
    var keys = Object.keys(entries);
    for (var k = 0; k < keys.length; k++) {
      if (node.id.indexOf(keys[k]) !== -1 || keys[k].indexOf(node.label) !== -1) {
        entry = entries[keys[k]];
        break;
      }
    }
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
  var animFrame = null;
  var alpha = 1.0;
  var alphaDecay = 0.06;
  var alphaMin = 0.005;
  var autoFitOnSettle = true;
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
    var limit = parseInt(nodeLimit.value, 10);

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

  /* ── Barnes-Hut Quadtree ── */
  var THETA = 0.7;
  function Quadtree(x, y, w, h) {
    this.x = x; this.y = y; this.w = w; this.h = h;
    this.body = null; this.mass = 0; this.cx = 0; this.cy = 0;
    this.nw = null; this.ne = null; this.sw = null; this.se = null;
    this.divided = false;
  }
  Quadtree.prototype.subdivide = function() {
    var hw = this.w / 2, hh = this.h / 2;
    this.nw = new Quadtree(this.x, this.y, hw, hh);
    this.ne = new Quadtree(this.x + hw, this.y, hw, hh);
    this.sw = new Quadtree(this.x, this.y + hh, hw, hh);
    this.se = new Quadtree(this.x + hw, this.y + hh, hw, hh);
    this.divided = true;
  };
  Quadtree.prototype.insert = function(node) {
    if (node.x < this.x || node.x > this.x + this.w || node.y < this.y || node.y > this.y + this.h) return;
    if (!this.body && !this.divided) { this.body = node; this.mass = 1; this.cx = node.x; this.cy = node.y; return; }
    if (!this.divided) {
      this.subdivide();
      if (this.body) {
        var old = this.body; this.body = null;
        this.nw.insert(old); this.ne.insert(old); this.sw.insert(old); this.se.insert(old);
      }
    }
    this.nw.insert(node); this.ne.insert(node); this.sw.insert(node); this.se.insert(node);
    this.mass++;
    this.cx = (this.cx * (this.mass - 1) + node.x) / this.mass;
    this.cy = (this.cy * (this.mass - 1) + node.y) / this.mass;
  };
  Quadtree.prototype.computeMass = function() {
    if (this.body) { this.mass = 1; this.cx = this.body.x; this.cy = this.body.y; return; }
    if (!this.divided) { this.mass = 0; return; }
    this.nw.computeMass(); this.ne.computeMass(); this.sw.computeMass(); this.se.computeMass();
    this.mass = this.nw.mass + this.ne.mass + this.sw.mass + this.se.mass;
    if (this.mass > 0) {
      this.cx = (this.nw.cx * this.nw.mass + this.ne.cx * this.ne.mass + this.sw.cx * this.sw.mass + this.se.cx * this.se.mass) / this.mass;
      this.cy = (this.nw.cy * this.nw.mass + this.ne.cy * this.ne.mass + this.sw.cy * this.sw.mass + this.se.cy * this.se.mass) / this.mass;
    }
  };
  Quadtree.prototype.forceOn = function(node, strength) {
    if (this.mass === 0) return;
    var dx = this.cx - node.x, dy = this.cy - node.y;
    var distSq = dx * dx + dy * dy;
    if (distSq < 1) distSq = 1;
    // If leaf with single body, or cell is far enough
    if (!this.divided || (this.w / Math.sqrt(distSq)) < THETA) {
      if (this.body === node) return;
      var dist = Math.sqrt(distSq);
      var f = -strength * this.mass / distSq;
      node.fx += (dx / dist) * f;
      node.fy += (dy / dist) * f;
      return;
    }
    this.nw.forceOn(node, strength); this.ne.forceOn(node, strength);
    this.sw.forceOn(node, strength); this.se.forceOn(node, strength);
  };

  /* ── resize ── */
  function resizeCanvas() {
    var rect = canvas.parentElement.getBoundingClientRect();
    canvasW = Math.max(rect.width, 100);
    canvasH = Math.max(rect.height, 100);
    canvas.width = canvasW * dpr;
    canvas.height = canvasH * dpr;
    canvas.style.width = canvasW + "px";
    canvas.style.height = canvasH + "px";
    render();
  }
  window.addEventListener("resize", resizeCanvas);

  /* ── rebuild ── */
  function rebuild() {
    var data = getFilteredData();
    activeNodes = data.nodes.map(function(n) {
      var q = computeQuality(n);
      return {
        id: n.id, kind: n.kind, projectName: n.projectName, label: n.label,
        subtype: n.subtype, text: n.text, radius: n.radius, color: n.color,
        refCount: n.refCount, date: n.date, section: n.section, priority: n.priority,
        entityType: n.entityType, connectedProjects: n.connectedProjects,
        qualityMultiplier: q.multiplier, daysSinceUse: q.daysSinceUse, helpful: q.helpful,
        x: canvasW / 2 + (Math.random() - 0.5) * canvasW * 0.5,
        y: canvasH / 2 + (Math.random() - 0.5) * canvasH * 0.5,
        vx: 0, vy: 0, fx: 0, fy: 0
      };
    });

    var byId = {};
    for (var i = 0; i < activeNodes.length; i++) byId[activeNodes[i].id] = activeNodes[i];

    activeLinks = [];
    for (var j = 0; j < data.edges.length; j++) {
      var s = byId[data.edges[j].source], t = byId[data.edges[j].target];
      if (s && t) activeLinks.push({ source: s, target: t });
    }
  }

  /* ── render (Canvas2D) ── */
  function render() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvasW, canvasH);
    ctx.save();
    ctx.translate(panX, panY);
    ctx.scale(scale, scale);

    // Edges: batch by single color
    ctx.strokeStyle = "rgba(128,128,128,0.12)";
    ctx.lineWidth = 0.5 / scale;
    ctx.beginPath();
    for (var e = 0; e < activeLinks.length; e++) {
      var link = activeLinks[e];
      ctx.moveTo(link.source.x, link.source.y);
      ctx.lineTo(link.target.x, link.target.y);
    }
    ctx.stroke();

    // Group nodes by color for batched fills
    var colorGroups = {};
    for (var i = 0; i < activeNodes.length; i++) {
      var n = activeNodes[i];
      var c = n.color;
      if (!colorGroups[c]) colorGroups[c] = [];
      colorGroups[c].push(n);
    }

    var PI2 = Math.PI * 2;
    var colors = Object.keys(colorGroups);

    for (var ci = 0; ci < colors.length; ci++) {
      var group = colorGroups[colors[ci]];
      // Draw fills
      for (var gi = 0; gi < group.length; gi++) {
        var nd = group[gi];
        var opacity = nodeOpacity(nd.qualityMultiplier || 1);
        ctx.globalAlpha = opacity;
        ctx.fillStyle = nd.color;
        ctx.beginPath();
        ctx.arc(nd.x, nd.y, nd.radius, 0, PI2);
        ctx.fill();

        // Health ring
        var health = healthCategory(nd.daysSinceUse);
        var ringColor = null;
        if (health === "recent") ringColor = "#22c55e";
        else if (health === "stale") ringColor = "#f97316";
        else if (health === "decaying") ringColor = "#ef4444";

        if (ringColor) {
          ctx.strokeStyle = ringColor;
          ctx.lineWidth = 2 / scale;
          ctx.beginPath();
          ctx.arc(nd.x, nd.y, nd.radius + 2, 0, PI2);
          ctx.stroke();
        }

        // Pulse animation for high-helpful nodes
        if (nd.helpful >= 3) {
          var pulseR = nd.radius + 4 + Math.sin(pulsePhase * 3) * 2;
          ctx.globalAlpha = 0.2 + Math.sin(pulsePhase * 3) * 0.1;
          ctx.strokeStyle = "#22c55e";
          ctx.lineWidth = 1.5 / scale;
          ctx.beginPath();
          ctx.arc(nd.x, nd.y, pulseR, 0, PI2);
          ctx.stroke();
        }

        // Selection ring
        if (nd.id === selectedId) {
          ctx.globalAlpha = 1;
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 3 / scale;
          ctx.beginPath();
          ctx.arc(nd.x, nd.y, nd.radius + 1, 0, PI2);
          ctx.stroke();
        }

        // Search highlight
        if (searchMatches.has(nd.id)) {
          ctx.globalAlpha = 0.8;
          ctx.strokeStyle = "#facc15";
          ctx.lineWidth = 3 / scale;
          ctx.beginPath();
          ctx.arc(nd.x, nd.y, nd.radius + 3, 0, PI2);
          ctx.stroke();
        }
      }
    }

    // Labels (semantic zoom with text backgrounds for readability)
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    var fontSize = Math.max(9, 11 / scale);
    ctx.font = "500 " + fontSize + "px -apple-system,BlinkMacSystemFont,sans-serif";

    if (scale >= 0.25) {
      var fg = getComputedStyle(document.body).color || "#ccc";
      var bg = getComputedStyle(document.body).backgroundColor || "#1e1e1e";

      for (var li = 0; li < activeNodes.length; li++) {
        var ln = activeNodes[li];
        var showLabel = false;
        if (ln.kind === "project") showLabel = true;
        else if (scale >= 0.6) showLabel = (ln.kind === "entity" && (ln.refCount || 0) > 2);
        if (scale >= 0.9) showLabel = true;

        if (showLabel) {
          var labelText = ln.label;
          if (ln.kind === "finding") labelText = labelText.length > 24 ? labelText.slice(0, 22) + ".." : labelText;
          else if (ln.kind === "task") labelText = labelText.length > 30 ? labelText.slice(0, 28) + ".." : labelText;
          var lx = ln.x, ly = ln.y + ln.radius + 3;
          // Draw text background pill for readability
          var tw = ctx.measureText(labelText).width;
          ctx.globalAlpha = 0.75;
          ctx.fillStyle = bg;
          ctx.fillRect(lx - tw / 2 - 2, ly - 1, tw + 4, fontSize + 2);
          ctx.globalAlpha = 0.9;
          ctx.fillStyle = fg;
          ctx.fillText(labelText, lx, ly);
        }
      }
    }

    ctx.globalAlpha = 1;
    ctx.restore();
  }

  /* ── simulation tick ── */
  function scheduleTick() {
    if (animFrame !== null) return;
    animFrame = requestAnimationFrame(tick);
  }

  function reheat(v) { alpha = Math.max(alpha, v === undefined ? 1.0 : v); }

  function tick() {
    animFrame = null;
    if (activeNodes.length === 0 || alpha < alphaMin) {
      if (alpha < alphaMin && autoFitOnSettle) { autoFit(); autoFitOnSettle = false; }
      render();
      return;
    }
    alpha *= (1 - alphaDecay);
    pulsePhase += 0.016;

    // Reset forces
    for (var i = 0; i < activeNodes.length; i++) { activeNodes[i].fx = 0; activeNodes[i].fy = 0; }

    // Barnes-Hut repulsion
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var b = 0; b < activeNodes.length; b++) {
      if (activeNodes[b].x < minX) minX = activeNodes[b].x;
      if (activeNodes[b].y < minY) minY = activeNodes[b].y;
      if (activeNodes[b].x > maxX) maxX = activeNodes[b].x;
      if (activeNodes[b].y > maxY) maxY = activeNodes[b].y;
    }
    var pad = 100;
    var treeW = Math.max(maxX - minX + pad * 2, 200);
    var treeH = Math.max(maxY - minY + pad * 2, 200);
    var tree = new Quadtree(minX - pad, minY - pad, treeW, treeH);
    for (var ti = 0; ti < activeNodes.length; ti++) tree.insert(activeNodes[ti]);
    tree.computeMass();

    var repStr = alpha * 3000;
    for (var ri = 0; ri < activeNodes.length; ri++) tree.forceOn(activeNodes[ri], repStr);

    // Link springs (shorter rest length keeps clusters tight)
    var springStr = alpha * 0.03;
    var restLen = 55;
    for (var si = 0; si < activeLinks.length; si++) {
      var link = activeLinks[si];
      var dx = link.target.x - link.source.x;
      var dy = link.target.y - link.source.y;
      var dist = Math.max(Math.sqrt(dx * dx + dy * dy), 0.1);
      var spring = springStr * (dist - restLen);
      var ux = dx / dist, uy = dy / dist;
      link.source.fx += ux * spring; link.source.fy += uy * spring;
      link.target.fx -= ux * spring; link.target.fy -= uy * spring;
    }

    // Center gravity (strong enough to keep everything clustered) + velocity integration
    var centerX = canvasW / 2, centerY = canvasH / 2;
    var gravBase = alpha * 0.012;
    for (var vi = 0; vi < activeNodes.length; vi++) {
      var node = activeNodes[vi];
      // Stronger gravity for project hub nodes to anchor clusters
      var grav = node.kind === "project" ? gravBase * 2.5 : gravBase;
      node.fx += (centerX - node.x) * grav;
      node.fy += (centerY - node.y) * grav;
      node.vx = (node.vx + node.fx) * 0.4;
      node.vy = (node.vy + node.fy) * 0.4;
      node.x += node.vx;
      node.y += node.vy;
    }

    render();
    if (alpha >= alphaMin) scheduleTick();
    else if (autoFitOnSettle) { autoFit(); autoFitOnSettle = false; render(); }
  }

  function autoFit() {
    if (activeNodes.length === 0) return;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < activeNodes.length; i++) {
      var n = activeNodes[i];
      if (n.x < minX) minX = n.x; if (n.y < minY) minY = n.y;
      if (n.x > maxX) maxX = n.x; if (n.y > maxY) maxY = n.y;
    }
    var graphPad = 60;
    var graphW = (maxX - minX) + graphPad * 2;
    var graphH = (maxY - minY) + graphPad * 2;
    var fitScale = Math.min(canvasW / graphW, canvasH / graphH, 1.5);
    var cx = (minX + maxX) / 2;
    var cy = (minY + maxY) / 2;
    scale = fitScale;
    panX = canvasW / 2 - cx * scale;
    panY = canvasH / 2 - cy * scale;
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
      if (d < n.radius + 4 && d < bestDist) { best = n; bestDist = d; }
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
      autoFitOnSettle = false;
      reheat(0.38);
      scheduleTick();
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
      dragNode.vx = dx * 0.18; dragNode.vy = dy * 0.18;
      lastMX = e.clientX; lastMY = e.clientY;
      reheat(0.24);
      scheduleTick();
      render();
    } else if (isPanning) {
      panX = panStartX + (e.clientX - dragStartMX);
      panY = panStartY + (e.clientY - dragStartMY);
      render();
    }
  });

  canvas.addEventListener("pointerup", function(e) {
    if (isDragging && dragNode) {
      // If barely moved, treat as click
      var movedDist = Math.abs(e.clientX - lastMX) + Math.abs(e.clientY - lastMY);
      selectNode(dragNode);
      canvas.releasePointerCapture(e.pointerId);
      dragNode = null;
      isDragging = false;
      reheat(0.18);
      scheduleTick();
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
  function rebuildAndReheat() {
    autoFitOnSettle = true;
    rebuild();
    reheat();
    scheduleTick();
  }
  typeToggles.forEach(function(el) {
    el.addEventListener("click", function() {
      el.classList.toggle("active");
      rebuildAndReheat();
    });
  });
  filterProject.addEventListener("change", rebuildAndReheat);
  filterHealth.addEventListener("change", rebuildAndReheat);
  nodeLimit.addEventListener("input", function() { limitVal.textContent = nodeLimit.value; rebuildAndReheat(); });

  /* ── init ── */
  resizeCanvas();
  rebuild();
  reheat();
  if (activeNodes.length > 0) selectNode(activeNodes[0]);
  scheduleTick();

  // Animate pulse continuously
  (function animatePulse() {
    var hasPulse = false;
    for (var i = 0; i < activeNodes.length; i++) {
      if ((activeNodes[i].helpful || 0) >= 3) { hasPulse = true; break; }
    }
    if (hasPulse && alpha < alphaMin) {
      pulsePhase += 0.016;
      render();
    }
    requestAnimationFrame(animatePulse);
  })();
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