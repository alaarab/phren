import * as vscode from "vscode";
import * as path from "path";
import { CortexClient } from "./cortexClient";

interface ProjectSummaryFile {
  filename: string;
  type: string;
}

interface ProjectSummaryData {
  name: string;
  summary: string;
  files: ProjectSummaryFile[];
}

interface FindingData {
  id: string;
  date: string;
  text: string;
  stableId?: string;
  findingType: string;
}

interface GraphNode {
  id: string;
  kind: "project" | "finding";
  projectName: string;
  label: string;
  findingType: string;
  text: string;
  radius: number;
}

interface GraphEdge {
  source: string;
  target: string;
}

interface GraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
  summaries: Record<string, ProjectSummaryData>;
}

export async function showGraphWebview(client: CortexClient, context: vscode.ExtensionContext): Promise<void> {
  const panel = vscode.window.createWebviewPanel(
    "cortex.entityGraph",
    "Cortex Entity Graph",
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [context.extensionUri] },
  );

  panel.iconPath = vscode.Uri.file(path.join(context.extensionPath, "media", "cortex.svg"));
  panel.webview.html = renderLoadingHtml(panel.webview);

  try {
    const graphData = await loadGraphData(client);
    panel.webview.html = renderGraphHtml(panel.webview, graphData);
  } catch (error) {
    panel.webview.html = renderErrorHtml(panel.webview, toErrorMessage(error));
  }
}

async function loadGraphData(client: CortexClient): Promise<GraphPayload> {
  const projects = await fetchProjects(client);
  const results = await Promise.all(
    projects.map(async (p) => {
      const summary = await fetchProjectSummary(client, p.name);
      const findings = await fetchFindings(client, p.name);
      return { summary, findings };
    }),
  );

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const summaryMap: Record<string, ProjectSummaryData> = {};

  for (const { summary, findings } of results) {
    summaryMap[summary.name] = summary;
    const projectNodeId = `project:${summary.name}`;
    nodes.push({
      id: projectNodeId,
      kind: "project",
      projectName: summary.name,
      label: summary.name,
      findingType: "project",
      text: summary.summary,
      radius: 20,
    });

    for (const finding of findings) {
      const findingId = `finding:${summary.name}:${finding.id}`;
      nodes.push({
        id: findingId,
        kind: "finding",
        projectName: summary.name,
        label: finding.text.slice(0, 40) + (finding.text.length > 40 ? "..." : ""),
        findingType: finding.findingType,
        text: finding.text,
        radius: 12,
      });
      edges.push({ source: projectNodeId, target: findingId });
    }
  }

  return { nodes, edges, summaries: summaryMap };
}

async function fetchProjects(client: CortexClient): Promise<{ name: string }[]> {
  const raw = await client.listProjects();
  const data = responseData(raw);
  const parsed: { name: string }[] = [];
  for (const entry of asArray(data?.projects)) {
    const record = asRecord(entry);
    const name = asString(record?.name);
    if (name) {
      parsed.push({ name });
    }
  }
  return parsed;
}

async function fetchProjectSummary(client: CortexClient, project: string): Promise<ProjectSummaryData> {
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
  };
}

async function fetchFindings(client: CortexClient, project: string): Promise<FindingData[]> {
  const raw = await client.getFindings(project);
  const data = responseData(raw);
  const parsed: FindingData[] = [];
  for (const entry of asArray(data?.findings)) {
    const record = asRecord(entry);
    const id = asString(record?.id) ?? asString(record?.stableId) ?? String(parsed.length);
    const text = asString(record?.text) ?? "";
    if (!text) {
      continue;
    }
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

function classifyFinding(text: string): string {
  const lower = text.toLowerCase();
  if (lower.includes("decision") || lower.includes("chose") || lower.includes("decided")) {
    return "decision";
  }
  if (lower.includes("pitfall") || lower.includes("gotcha") || lower.includes("warning") || lower.includes("never ") || lower.includes("don't ") || lower.includes("avoid")) {
    return "pitfall";
  }
  if (lower.includes("pattern") || lower.includes("always ") || lower.includes("convention") || lower.includes("standard")) {
    return "pattern";
  }
  return "other";
}

function renderLoadingHtml(webview: vscode.Webview): string {
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

function renderErrorHtml(webview: vscode.Webview, errorMessage: string): string {
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

function renderGraphHtml(webview: vscode.Webview, payload: GraphPayload): string {
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
    .filter-bar select, .filter-bar input[type=range] { font-size:12px; background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--border); border-radius:4px; padding:3px 6px; }
    .filter-bar .limit-val { font-size:11px; min-width:28px; text-align:center; }
    .layout { display:grid; grid-template-columns:3fr 1fr; height:calc(100vh - 40px); }
    .canvas { position:relative; overflow:hidden; background:color-mix(in srgb,var(--vscode-editor-background) 95%,#000); }
    svg { width:100%; height:100%; display:block; }
    .controls { position:absolute; top:10px; right:10px; display:flex; flex-direction:column; gap:4px; z-index:2; }
    .controls button { width:30px; height:30px; border:1px solid var(--border); border-radius:6px; background:color-mix(in srgb,var(--vscode-editorWidget-background) 85%,transparent); color:var(--vscode-foreground); font-size:16px; cursor:pointer; display:grid; place-items:center; backdrop-filter:blur(4px); }
    .controls button:hover { background:var(--vscode-button-hoverBackground); color:var(--vscode-button-foreground); }
    .side { padding:16px; overflow:auto; border-left:1px solid var(--border); }
    .side h2 { margin:0 0 4px; font-size:11px; text-transform:uppercase; letter-spacing:0.05em; opacity:0.6; }
    .side .node-name { font-size:1.2rem; margin:0 0 8px; }
    .type-badge { display:inline-block; font-size:11px; padding:2px 8px; border-radius:999px; color:#fff; margin-bottom:10px; }
    .type-badge.project { background:#7c3aed; }
    .type-badge.decision { background:#3b82f6; }
    .type-badge.pitfall { background:#ef4444; }
    .type-badge.pattern { background:#10b981; }
    .type-badge.other { background:#f4a261; }
    .file-badges { display:flex; gap:6px; flex-wrap:wrap; margin:8px 0; }
    .file-badge { font-size:11px; padding:3px 8px; border-radius:999px; border:1px solid var(--border); background:color-mix(in srgb,var(--vscode-editorWidget-background) 80%,transparent); }
    .detail-text { white-space:pre-wrap; line-height:1.5; font-size:13px; border:1px solid var(--border); border-radius:8px; padding:10px 12px; background:color-mix(in srgb,var(--vscode-editorWidget-background) 60%,transparent); margin-top:8px; }
    .detail-label { font-size:11px; opacity:0.6; margin-top:10px; }
    .hint { font-size:12px; opacity:0.5; margin-top:14px; }
    .edge { stroke:color-mix(in srgb,var(--vscode-foreground) 10%,transparent); stroke-width:0.5; }
    .node-circle { cursor:pointer; stroke-width:2; transition:stroke-width 0.15s; }
    .node-circle.selected { stroke-width:4; stroke:#fff; }
    .node-label { font-size:10px; text-anchor:middle; pointer-events:none; fill:var(--vscode-foreground); opacity:0.85; user-select:none; }
    @media (max-width:700px) {
      .layout { grid-template-columns:1fr; grid-template-rows:55vh 1fr; }
      .side { border-left:none; border-top:1px solid var(--border); }
    }
  </style>
</head>
<body>
  <div class="filter-bar">
    <label>Type</label>
    <select id="filterType">
      <option value="all">All</option>
      <option value="project">Projects</option>
      <option value="decision">Decisions</option>
      <option value="pitfall">Pitfalls</option>
      <option value="pattern">Patterns</option>
    </select>
    <label>Project</label>
    <select id="filterProject"><option value="all">All</option></select>
    <label>Limit</label>
    <input type="range" id="nodeLimit" min="10" max="200" value="100">
    <span class="limit-val" id="limitVal">100</span>
  </div>
  <main class="layout">
    <section class="canvas">
      <svg id="graph" aria-label="Cortex entity graph"></svg>
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
  const payload = ${safePayload};
  const svg = document.getElementById("graph");
  const detail = document.getElementById("detail");
  const filterType = document.getElementById("filterType");
  const filterProject = document.getElementById("filterProject");
  const nodeLimit = document.getElementById("nodeLimit");
  const limitVal = document.getElementById("limitVal");

  const nodeColor = { project:"#7c3aed", decision:"#3b82f6", pitfall:"#ef4444", pattern:"#10b981", other:"#f4a261" };

  // Populate project filter
  const projectNames = [...new Set(payload.nodes.filter(n => n.kind === "project").map(n => n.projectName))];
  projectNames.forEach(name => {
    const opt = document.createElement("option");
    opt.value = name; opt.textContent = name;
    filterProject.appendChild(opt);
  });

  // State
  let scale = 1, panX = 0, panY = 0;
  let selectedId = null;
  let activeNodes = [], activeLinks = [], activeEdgeEls = [], activeNodeEls = [], activeLabelEls = [];
  let edgeLayer, nodeLayer, labelLayer, transformGroup;

  function esc(v) {
    return String(v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  function getFilteredData() {
    const typeVal = filterType.value;
    const projVal = filterProject.value;
    const limit = parseInt(nodeLimit.value, 10);

    let filtered = payload.nodes.filter(n => {
      if (typeVal !== "all") {
        if (typeVal === "project" && n.kind !== "project") return false;
        if (typeVal !== "project" && (n.kind !== "finding" || n.findingType !== typeVal)) return false;
      }
      if (projVal !== "all" && n.projectName !== projVal) return false;
      return true;
    });

    // Always include parent projects for visible findings
    const visibleProjects = new Set(filtered.filter(n => n.kind === "project").map(n => n.id));
    const neededProjects = new Set();
    filtered.filter(n => n.kind === "finding").forEach(n => {
      const pid = "project:" + n.projectName;
      if (!visibleProjects.has(pid)) neededProjects.add(pid);
    });
    if (neededProjects.size > 0) {
      const extras = payload.nodes.filter(n => neededProjects.has(n.id));
      filtered = extras.concat(filtered);
    }

    filtered = filtered.slice(0, limit);

    const idSet = new Set(filtered.map(n => n.id));
    const edges = payload.edges.filter(e => idSet.has(e.source) && idSet.has(e.target));
    return { nodes: filtered, edges };
  }

  function rebuild() {
    // Clear SVG
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    transformGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
    svg.appendChild(transformGroup);
    edgeLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
    nodeLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
    labelLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
    transformGroup.append(edgeLayer, nodeLayer, labelLayer);

    const data = getFilteredData();

    const bounds = svg.getBoundingClientRect();
    const w = Math.max(bounds.width, 400);
    const h = Math.max(bounds.height, 300);

    // Spread nodes across a large area — use 2x viewport so they have room
    activeNodes = data.nodes.map((n, i) => ({
      ...n,
      x: w/2 + (Math.random() - 0.5) * w * 1.6,
      y: h/2 + (Math.random() - 0.5) * h * 1.6,
      vx: 0, vy: 0
    }));

    const byId = new Map(activeNodes.map(n => [n.id, n]));
    activeLinks = data.edges.map(e => ({ source: byId.get(e.source), target: byId.get(e.target) })).filter(e => e.source && e.target);

    activeEdgeEls = activeLinks.map(() => {
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("class", "edge");
      edgeLayer.appendChild(line);
      return line;
    });

    activeNodeEls = activeNodes.map(n => {
      const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      const colorKey = n.kind === "project" ? "project" : n.findingType;
      c.setAttribute("class", "node-circle" + (n.id === selectedId ? " selected" : ""));
      c.setAttribute("r", String(n.radius));
      c.style.fill = nodeColor[colorKey] || nodeColor.other;
      c.style.stroke = nodeColor[colorKey] || nodeColor.other;
      c.addEventListener("click", (e) => { e.stopPropagation(); selectNode(n); });
      // Node dragging
      let nodeDrag = false, ndx = 0, ndy = 0;
      c.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        nodeDrag = true;
        ndx = e.clientX; ndy = e.clientY;
        c.style.cursor = "grabbing";
      });
      const onMove = (e) => {
        if (!nodeDrag) return;
        const dx = (e.clientX - ndx) / scale;
        const dy = (e.clientY - ndy) / scale;
        n.x += dx; n.y += dy;
        n.vx = 0; n.vy = 0;
        ndx = e.clientX; ndy = e.clientY;
        c.setAttribute("cx", n.x);
        c.setAttribute("cy", n.y);
        // Update connected edges
        for (let ei = 0; ei < activeLinks.length; ei++) {
          const l = activeLinks[ei];
          if (l.source === n || l.target === n) {
            activeEdgeEls[ei].setAttribute("x1", l.source.x);
            activeEdgeEls[ei].setAttribute("y1", l.source.y);
            activeEdgeEls[ei].setAttribute("x2", l.target.x);
            activeEdgeEls[ei].setAttribute("y2", l.target.y);
          }
        }
        const ni = activeNodes.indexOf(n);
        if (ni >= 0) {
          activeLabelEls[ni].setAttribute("x", n.x);
          activeLabelEls[ni].setAttribute("y", n.y + n.radius + 13);
        }
      };
      const onUp = () => { nodeDrag = false; c.style.cursor = "pointer"; };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      nodeLayer.appendChild(c);
      return c;
    });

    activeLabelEls = activeNodes.map(n => {
      const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
      t.setAttribute("class", "node-label");
      t.textContent = n.kind === "project" ? n.label : (n.label.length > 24 ? n.label.slice(0,22) + ".." : n.label);
      labelLayer.appendChild(t);
      return t;
    });

    applyTransform();
  }

  function selectNode(node) {
    selectedId = node.id;
    activeNodeEls.forEach((el, i) => {
      el.setAttribute("class", "node-circle" + (activeNodes[i].id === selectedId ? " selected" : ""));
    });

    if (node.kind === "project") {
      const proj = payload.summaries[node.projectName];
      const fileBadges = proj ? proj.files.slice(0, 12).map(f =>
        "<span class='file-badge'>" + esc(f.type) + ": " + esc(f.filename) + "</span>"
      ).join("") : "";

      detail.innerHTML = [
        "<h2>Project</h2>",
        "<div class='node-name'>" + esc(node.projectName) + "</div>",
        "<span class='type-badge project'>project</span>",
        fileBadges ? "<div class='file-badges'>" + fileBadges + "</div>" : "",
        "<div class='detail-text'>" + esc(proj ? proj.summary : "No summary.") + "</div>"
      ].join("");
    } else {
      detail.innerHTML = [
        "<h2>Finding</h2>",
        "<div class='node-name'>" + esc(node.label) + "</div>",
        "<span class='type-badge " + esc(node.findingType) + "'>" + esc(node.findingType) + "</span>",
        "<div class='detail-label'>Project</div>",
        "<div>" + esc(node.projectName) + "</div>",
        "<div class='detail-text'>" + esc(node.text) + "</div>"
      ].join("");
    }
  }

  function applyTransform() {
    if (transformGroup) {
      transformGroup.setAttribute("transform", "translate(" + panX + "," + panY + ") scale(" + scale + ")");
    }
  }

  // Zoom controls
  document.getElementById("zoomIn").addEventListener("click", () => { scale *= 1.2; applyTransform(); });
  document.getElementById("zoomOut").addEventListener("click", () => { scale *= 0.8; applyTransform(); });
  document.getElementById("zoomReset").addEventListener("click", () => { scale = 1; panX = 0; panY = 0; applyTransform(); });

  // Scroll zoom
  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = svg.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const newScale = scale * factor;
    panX = mx - (mx - panX) * (newScale / scale);
    panY = my - (my - panY) * (newScale / scale);
    scale = newScale;
    applyTransform();
  }, { passive: false });

  // Drag to pan
  let dragging = false, dragStartX = 0, dragStartY = 0, panStartX = 0, panStartY = 0;
  svg.addEventListener("mousedown", (e) => {
    if (e.target === svg || e.target === transformGroup || e.target.tagName === "line") {
      dragging = true;
      dragStartX = e.clientX; dragStartY = e.clientY;
      panStartX = panX; panStartY = panY;
      svg.style.cursor = "grabbing";
    }
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    panX = panStartX + (e.clientX - dragStartX);
    panY = panStartY + (e.clientY - dragStartY);
    applyTransform();
  });
  window.addEventListener("mouseup", () => { dragging = false; svg.style.cursor = "default"; });

  // Filters — rebuild and reheat simulation
  function rebuildAndReheat() { rebuild(); reheat(); requestAnimationFrame(tick); }
  filterType.addEventListener("change", rebuildAndReheat);
  filterProject.addEventListener("change", rebuildAndReheat);
  nodeLimit.addEventListener("input", () => { limitVal.textContent = nodeLimit.value; rebuildAndReheat(); });

  // Force simulation — settles in ~40 frames (<1 second), then freezes
  let alpha = 1.0;
  const alphaDecay = 0.06;
  const alphaMin = 0.005;
  let simW = 400, simH = 300;

  function reheat() { alpha = 1.0; }

  function tick() {
    if (activeNodes.length === 0 || alpha < alphaMin) {
      return;
    }

    alpha *= (1 - alphaDecay);

    const bounds = svg.getBoundingClientRect();
    simW = Math.max(bounds.width, 400);
    simH = Math.max(bounds.height, 300);

    for (const n of activeNodes) { n.fx = 0; n.fy = 0; }

    // Strong repulsion — nodes push apart aggressively
    const repStrength = alpha * 8000;
    for (let i = 0; i < activeNodes.length; i++) {
      for (let j = i + 1; j < activeNodes.length; j++) {
        const a = activeNodes[i], b = activeNodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        if (dx === 0 && dy === 0) { dx = (Math.random() - 0.5) * 2; dy = (Math.random() - 0.5) * 2; }
        const distSq = Math.max(dx * dx + dy * dy, 100);
        const dist = Math.sqrt(distSq);
        const force = repStrength / distSq;
        const ux = dx / dist, uy = dy / dist;
        a.fx += ux * force; a.fy += uy * force;
        b.fx -= ux * force; b.fy -= uy * force;
      }
    }

    // Light springs — cosmetic link, very gentle pull so clusters form loosely
    const springStrength = alpha * 0.008;
    for (const link of activeLinks) {
      const dx = link.target.x - link.source.x;
      const dy = link.target.y - link.source.y;
      const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 0.1);
      const spring = springStrength * (dist - 120);
      const ux = dx / dist, uy = dy / dist;
      link.source.fx += ux * spring; link.source.fy += uy * spring;
      link.target.fx -= ux * spring; link.target.fy -= uy * spring;
    }

    // Apply velocity with heavy damping
    for (const n of activeNodes) {
      n.vx = (n.vx + n.fx) * 0.35;
      n.vy = (n.vy + n.fy) * 0.35;
      n.x += n.vx;
      n.y += n.vy;
    }

    // Update DOM
    for (let i = 0; i < activeLinks.length; i++) {
      const l = activeLinks[i];
      activeEdgeEls[i].setAttribute("x1", l.source.x);
      activeEdgeEls[i].setAttribute("y1", l.source.y);
      activeEdgeEls[i].setAttribute("x2", l.target.x);
      activeEdgeEls[i].setAttribute("y2", l.target.y);
    }
    for (let i = 0; i < activeNodes.length; i++) {
      const n = activeNodes[i];
      activeNodeEls[i].setAttribute("cx", n.x);
      activeNodeEls[i].setAttribute("cy", n.y);
      activeLabelEls[i].setAttribute("x", n.x);
      activeLabelEls[i].setAttribute("y", n.y + n.radius + 13);
    }

    if (alpha >= alphaMin) {
      requestAnimationFrame(tick);
    } else {
      // Auto-fit: zoom to show all nodes
      autoFit();
    }
  }

  function autoFit() {
    if (activeNodes.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of activeNodes) {
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x > maxX) maxX = n.x;
      if (n.y > maxY) maxY = n.y;
    }
    const pad = 60;
    const graphW = (maxX - minX) + pad * 2;
    const graphH = (maxY - minY) + pad * 2;
    const fitScale = Math.min(simW / graphW, simH / graphH, 1.5);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    scale = fitScale;
    panX = simW / 2 - cx * scale;
    panY = simH / 2 - cy * scale;
    applyTransform();
  }

  // Init
  rebuild();
  reheat();
  if (activeNodes.length > 0) {
    selectNode(activeNodes[0]);
  }
  requestAnimationFrame(tick);
})();
  </script>
</body>
</html>`;
}

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
