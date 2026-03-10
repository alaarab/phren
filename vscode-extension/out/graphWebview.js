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
async function showGraphWebview(client, context) {
    const panel = vscode.window.createWebviewPanel("cortex.entityGraph", "Cortex Entity Graph", vscode.ViewColumn.One, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [context.extensionUri],
    });
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
async function loadGraphData(client) {
    const projects = await fetchProjects(client);
    const summaries = await Promise.all(projects.map(async (project) => fetchProjectSummary(client, project.name)));
    const nodes = [];
    const edges = [];
    const summaryMap = {};
    for (const summary of summaries) {
        summaryMap[summary.name] = summary;
        const projectNodeId = `project:${summary.name}`;
        nodes.push({
            id: projectNodeId,
            kind: "project",
            projectName: summary.name,
            label: summary.name,
            type: summary.projectType,
            radius: 18,
        });
        const findingFiles = summary.files.filter((file) => file.type === "findings");
        if (findingFiles.length === 0) {
            continue;
        }
        for (const file of findingFiles) {
            const findingId = `finding:${summary.name}:${file.filename}`;
            nodes.push({
                id: findingId,
                kind: "finding",
                projectName: summary.name,
                label: file.filename,
                type: "finding",
                radius: 10,
            });
            edges.push({ source: projectNodeId, target: findingId });
        }
    }
    return { nodes, edges, summaries: summaryMap };
}
async function fetchProjects(client) {
    const raw = await client.listProjects();
    const data = responseData(raw);
    const projects = asArray(data?.projects);
    const parsed = [];
    for (const entry of projects) {
        const record = asRecord(entry);
        const name = asString(record?.name);
        if (!name) {
            continue;
        }
        parsed.push({ name });
    }
    return parsed;
}
async function fetchProjectSummary(client, project) {
    const raw = await client.getProjectSummary(project);
    const data = responseData(raw);
    const name = asString(data?.name) ?? project;
    const summary = asString(data?.summary) ?? "No summary.md found.";
    const files = [];
    for (const file of asArray(data?.files)) {
        const record = asRecord(file);
        const filename = asString(record?.filename);
        const type = asString(record?.type);
        if (!filename || !type) {
            continue;
        }
        files.push({ filename, type });
    }
    return {
        name,
        summary,
        files,
        projectType: resolveProjectType(files),
    };
}
function resolveProjectType(files) {
    const typeSet = new Set(files.map((file) => file.type));
    if (typeSet.has("backlog")) {
        return "planner";
    }
    if (typeSet.has("findings")) {
        return "insights";
    }
    if (typeSet.has("summary")) {
        return "summary";
    }
    if (typeSet.has("claude")) {
        return "instructions";
    }
    return "project";
}
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
    :root {
      color-scheme: light dark;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    body {
      margin: 0;
      display: grid;
      place-items: center;
      min-height: 100vh;
      color: var(--vscode-foreground);
    }
  </style>
</head>
<body>
  <div>Loading Cortex Entity Graph...</div>
</body>
</html>`;
}
function renderErrorHtml(webview, errorMessage) {
    const nonce = getNonce();
    const safeMessage = escapeHtml(errorMessage);
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cortex Entity Graph</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      color: var(--vscode-errorForeground);
    }
    .panel {
      max-width: 720px;
      border: 1px solid color-mix(in srgb, var(--vscode-errorForeground) 35%, transparent);
      border-radius: 10px;
      padding: 16px;
      background: color-mix(in srgb, var(--vscode-editorError-foreground) 8%, transparent);
    }
  </style>
</head>
<body>
  <div class="panel">Failed to render entity graph: ${safeMessage}</div>
</body>
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
    :root {
      color-scheme: light dark;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --border: color-mix(in srgb, var(--vscode-foreground) 25%, transparent);
    }
    body {
      margin: 0;
      height: 100vh;
      overflow: hidden;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    .layout {
      display: grid;
      grid-template-columns: minmax(420px, 2fr) minmax(280px, 1fr);
      height: 100%;
      width: 100%;
    }
    .canvas {
      position: relative;
      border-right: 1px solid var(--border);
      background:
        radial-gradient(circle at 18% 14%, color-mix(in srgb, var(--vscode-button-background) 16%, transparent), transparent 28%),
        radial-gradient(circle at 76% 78%, color-mix(in srgb, var(--vscode-focusBorder) 18%, transparent), transparent 34%),
        var(--vscode-editor-background);
    }
    svg {
      width: 100%;
      height: 100%;
      display: block;
    }
    .side {
      padding: 18px;
      overflow: auto;
    }
    .side h2 {
      margin: 0;
      font-size: 1rem;
      letter-spacing: 0.03em;
      text-transform: uppercase;
      opacity: 0.8;
    }
    .project-name {
      margin: 8px 0 10px;
      font-size: 1.3rem;
    }
    .badge-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin: 0 0 14px;
    }
    .badge {
      font-size: 0.75rem;
      padding: 4px 10px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: color-mix(in srgb, var(--vscode-editorWidget-background) 85%, transparent);
    }
    .summary {
      white-space: pre-wrap;
      line-height: 1.5;
      border-radius: 10px;
      border: 1px solid var(--border);
      padding: 10px 12px;
      background: color-mix(in srgb, var(--vscode-editorWidget-background) 70%, transparent);
    }
    .hint {
      font-size: 0.86rem;
      opacity: 0.75;
      margin-top: 12px;
    }
    .edge {
      stroke: color-mix(in srgb, var(--vscode-foreground) 28%, transparent);
      stroke-width: 1.2;
    }
    .node {
      cursor: pointer;
      stroke-width: 1.8;
    }
    .node.project {
      stroke: color-mix(in srgb, var(--vscode-foreground) 35%, transparent);
    }
    .node.finding {
      stroke: color-mix(in srgb, var(--vscode-editorWarning-foreground) 35%, transparent);
    }
    .label {
      font-size: 11px;
      text-anchor: middle;
      pointer-events: none;
      fill: var(--vscode-foreground);
      opacity: 0.9;
      user-select: none;
    }
    @media (max-width: 900px) {
      .layout {
        grid-template-columns: 1fr;
        grid-template-rows: minmax(300px, 55vh) minmax(220px, 1fr);
      }
      .canvas {
        border-right: none;
        border-bottom: 1px solid var(--border);
      }
    }
  </style>
</head>
<body>
  <main class="layout">
    <section class="canvas">
      <svg id="graph" aria-label="Cortex entity graph"></svg>
    </section>
    <aside class="side" id="detail">
      <h2>Project</h2>
      <div class="project-name">No project selected</div>
      <div class="summary">Click a project node to inspect summary details.</div>
      <div class="hint">Drag is not required; the graph auto-settles using a lightweight force simulation.</div>
    </aside>
  </main>
  <script nonce="${nonce}">
    const payload = ${safePayload};
    const svg = document.getElementById("graph");
    const detail = document.getElementById("detail");

    const colorByType = {
      planner: "#2a9d8f",
      insights: "#e76f51",
      summary: "#457b9d",
      instructions: "#8d99ae",
      project: "#6c757d",
      finding: "#f4a261"
    };

    const rect = () => svg.getBoundingClientRect();
    const nodes = payload.nodes.map((node, index) => ({
      ...node,
      x: 120 + (index % 8) * 68,
      y: 80 + Math.floor(index / 8) * 68,
      vx: 0,
      vy: 0
    }));

    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const links = payload.edges
      .map((edge) => ({
        source: nodeById.get(edge.source),
        target: nodeById.get(edge.target)
      }))
      .filter((edge) => edge.source && edge.target);

    const edgeLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
    const nodeLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
    const labelLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
    svg.append(edgeLayer, nodeLayer, labelLayer);

    const edgeEls = links.map(() => {
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("class", "edge");
      edgeLayer.appendChild(line);
      return line;
    });

    const nodeEls = nodes.map((node) => {
      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("class", "node " + node.kind);
      circle.setAttribute("r", String(node.radius));
      circle.style.fill = colorByType[node.type] || colorByType.project;
      circle.addEventListener("click", () => {
        const projectName = node.kind === "project" ? node.projectName : node.projectName;
        selectProject(projectName);
      });
      nodeLayer.appendChild(circle);
      return circle;
    });

    const labelEls = nodes.map((node) => {
      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("class", "label");
      label.textContent = node.kind === "project" ? node.label : "finding";
      labelLayer.appendChild(label);
      return label;
    });

    function selectProject(projectName) {
      const project = payload.summaries[projectName];
      if (!project) {
        detail.innerHTML = [
          "<h2>Project</h2>",
          "<div class='project-name'>Unknown project</div>",
          "<div class='summary'>No summary data found.</div>"
        ].join("");
        return;
      }

      const fileBadges = project.files.slice(0, 10).map((file) => {
        const safeType = escapeHtml(file.type);
        const safeFile = escapeHtml(file.filename);
        return "<span class='badge'>" + safeType + ": " + safeFile + "</span>";
      }).join("");

      detail.innerHTML = [
        "<h2>Project</h2>",
        "<div class='project-name'>" + escapeHtml(project.name) + "</div>",
        "<div class='badge-row'>" + fileBadges + "</div>",
        "<div class='summary'>" + escapeHtml(project.summary || "No summary.md found.") + "</div>",
        "<div class='hint'>Click additional nodes to compare project summaries.</div>"
      ].join("");
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function tick() {
      const bounds = rect();
      const width = Math.max(bounds.width, 320);
      const height = Math.max(bounds.height, 220);
      const cx = width / 2;
      const cy = height / 2;

      for (const node of nodes) {
        node.fx = 0;
        node.fy = 0;
      }

      for (let i = 0; i < nodes.length; i += 1) {
        for (let j = i + 1; j < nodes.length; j += 1) {
          const a = nodes[i];
          const b = nodes[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const distSq = Math.max(dx * dx + dy * dy, 0.01);
          const dist = Math.sqrt(distSq);
          const repulse = 1300 / distSq;
          const ux = dx / dist;
          const uy = dy / dist;

          a.fx += ux * repulse;
          a.fy += uy * repulse;
          b.fx -= ux * repulse;
          b.fy -= uy * repulse;
        }
      }

      for (const link of links) {
        const dx = link.target.x - link.source.x;
        const dy = link.target.y - link.source.y;
        const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 0.01);
        const desired = 80;
        const stretch = dist - desired;
        const spring = 0.03 * stretch;
        const ux = dx / dist;
        const uy = dy / dist;

        link.source.fx += ux * spring;
        link.source.fy += uy * spring;
        link.target.fx -= ux * spring;
        link.target.fy -= uy * spring;
      }

      for (const node of nodes) {
        node.fx += (cx - node.x) * 0.0016;
        node.fy += (cy - node.y) * 0.0016;
        node.vx = (node.vx + node.fx) * 0.9;
        node.vy = (node.vy + node.fy) * 0.9;
        node.x += node.vx;
        node.y += node.vy;

        const margin = node.radius + 8;
        node.x = Math.min(width - margin, Math.max(margin, node.x));
        node.y = Math.min(height - margin, Math.max(margin, node.y));
      }

      for (let i = 0; i < links.length; i += 1) {
        const edge = links[i];
        edgeEls[i].setAttribute("x1", String(edge.source.x));
        edgeEls[i].setAttribute("y1", String(edge.source.y));
        edgeEls[i].setAttribute("x2", String(edge.target.x));
        edgeEls[i].setAttribute("y2", String(edge.target.y));
      }

      for (let i = 0; i < nodes.length; i += 1) {
        const node = nodes[i];
        nodeEls[i].setAttribute("cx", String(node.x));
        nodeEls[i].setAttribute("cy", String(node.y));
        labelEls[i].setAttribute("x", String(node.x));
        labelEls[i].setAttribute("y", String(node.y + node.radius + 14));
      }

      requestAnimationFrame(tick);
    }

    if (nodes.length > 0) {
      selectProject(nodes[0].projectName);
      requestAnimationFrame(tick);
    } else {
      detail.innerHTML = [
        "<h2>Project</h2>",
        "<div class='project-name'>No projects</div>",
        "<div class='summary'>No indexed Cortex projects were returned by list_projects.</div>"
      ].join("");
    }
  </script>
</body>
</html>`;
}
function getNonce() {
    const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let nonce = "";
    for (let index = 0; index < 32; index += 1) {
        nonce += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return nonce;
}
function asRecord(value) {
    if (typeof value !== "object" || value === null) {
        return undefined;
    }
    return value;
}
function asArray(value) {
    return Array.isArray(value) ? value : [];
}
function asString(value) {
    return typeof value === "string" ? value : undefined;
}
function responseData(value) {
    const response = asRecord(value);
    return asRecord(response?.data);
}
function escapeHtml(value) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
function toErrorMessage(error) {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}
//# sourceMappingURL=graphWebview.js.map