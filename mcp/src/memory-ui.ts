import * as http from "http";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
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
import { isValidProjectName } from "./utils.js";

export interface ReviewUiOptions {
  authToken?: string;
  csrfTokens?: Set<string>;
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

interface GraphNode {
  id: string;
  label: string;
  group: "project" | "decision" | "pitfall" | "pattern";
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
  const typeMap: Record<string, "decision" | "pitfall" | "pattern"> = {
    decision: "decision",
    pitfall: "pitfall",
    pattern: "pattern",
  };

  for (const project of projects) {
    const findingsPath = path.join(cortexPath, project, "FINDINGS.md");
    if (!fs.existsSync(findingsPath)) continue;

    nodes.push({ id: project, label: project, group: "project", refCount: 1 });

    const content = fs.readFileSync(findingsPath, "utf8");
    const lines = content.split("\n");
    const counts: Record<string, number> = {};

    for (const line of lines) {
      const match = line.match(/^-\s+\[(decision|pitfall|pattern)\]\s+(.+?)(?:\s*<!--.*-->)?$/);
      if (!match) continue;
      const tag = match[1] as "decision" | "pitfall" | "pattern";
      const text = match[2].trim();
      const label = text.length > 60 ? text.slice(0, 57) + "..." : text;
      const nodeId = `${project}:${tag}:${nodes.length}`;

      counts[tag] = (counts[tag] || 0) + 1;
      nodes.push({ id: nodeId, label, group: typeMap[tag], refCount: counts[tag] });
      links.push({ source: project, target: nodeId });
    }
  }

  return { nodes, links };
}

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
        <tr>
          <td>${h(project)}</td>
          <td>${h(item.section)}</td>
          <td>${h(item.date)}</td>
          <td>${h(item.text)}</td>
          <td class="actions">
            <form method="POST" action="/approve">
              ${hiddenFields}
              <input type="hidden" name="project" value="${h(project)}" />
              <input type="hidden" name="line" value="${h(item.line)}" />
              <button type="submit">Approve</button>
            </form>
            <form method="POST" action="/reject">
              ${hiddenFields}
              <input type="hidden" name="project" value="${h(project)}" />
              <input type="hidden" name="line" value="${h(item.line)}" />
              <button type="submit">Reject</button>
            </form>
            <form method="POST" action="/edit">
              ${hiddenFields}
              <input type="hidden" name="project" value="${h(project)}" />
              <input type="hidden" name="line" value="${h(item.line)}" />
              <input type="text" name="new_text" value="${h(item.text)}" />
              <button type="submit">Edit</button>
            </form>
          </td>
        </tr>
      `);
    }
  }

  const acceptedItems = accepted.map((l) => `<li>${h(l)}</li>`).join("\n");
  const usageItems = usage.map((l) => `<li>${h(l)}</li>`).join("\n");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Cortex Memory UI</title>
  <script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
  <style>
    :root {
      --bg: #f4efe6;
      --ink: #1f2937;
      --muted: #6b7280;
      --accent: #0f766e;
      --line: #d6d3d1;
    }
    body { font-family: "IBM Plex Sans", "Segoe UI", sans-serif; background: linear-gradient(135deg,#f4efe6,#eaf5f2); color: var(--ink); margin: 0; padding: 24px; }
    h1 { margin: 0 0 12px 0; font-size: 30px; }
    .subtitle { color: var(--muted); margin-bottom: 16px; }
    table { width: 100%; border-collapse: collapse; background: white; border: 1px solid var(--line); }
    th, td { border-bottom: 1px solid var(--line); padding: 10px; vertical-align: top; text-align: left; }
    th { background: #fafaf9; font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
    .actions { display: grid; gap: 6px; min-width: 280px; }
    .actions form { display: flex; gap: 6px; margin: 0; }
    .actions input[type="text"] { flex: 1; }
    button { border: 1px solid var(--accent); background: var(--accent); color: white; padding: 5px 10px; cursor: pointer; }
    button:hover { filter: brightness(0.95); }
    .panes { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 20px; }
    .card { background: white; border: 1px solid var(--line); padding: 12px; }
    .card h2 { margin: 0 0 8px 0; font-size: 16px; }
    .card ul { margin: 0; padding-left: 18px; max-height: 240px; overflow: auto; }
    .tab-bar { display: flex; gap: 0; margin-bottom: 16px; border-bottom: 2px solid var(--line); }
    .tab-bar button { background: none; border: none; padding: 8px 16px; font-size: 14px; cursor: pointer; color: var(--muted); border-bottom: 2px solid transparent; margin-bottom: -2px; font-family: inherit; }
    .tab-bar button.active { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }
    .tab-bar button:hover { color: var(--ink); }
    .tab-content { display: none; }
    .tab-content.active { display: block; }
    #graph-panel { background: #1e1e2e; border-radius: 8px; border: 1px solid var(--line); overflow: hidden; }
    #graph-svg { width: 100%; height: 600px; display: block; }
    .graph-legend { display: flex; gap: 16px; padding: 10px 16px; background: #1e1e2e; border-top: 1px solid #333; }
    .graph-legend span { display: flex; align-items: center; gap: 6px; color: #cdd6f4; font-size: 13px; }
    .graph-legend span::before { content: ''; width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
    .legend-project::before { background: #7C3AED; }
    .legend-decision::before { background: #2563EB; }
    .legend-pitfall::before { background: #DC2626; }
    .legend-pattern::before { background: #16A34A; }
    @media (max-width: 900px) { .panes { grid-template-columns: 1fr; } .actions { min-width: 0; } }
  </style>
</head>
<body>
  <h1>Cortex Memory Review</h1>
  <div class="subtitle">Markdown is source-of-truth. Approve/reject/edit updates queue + findings directly.</div>

  <div class="tab-bar">
    <button class="active" onclick="switchTab('review')">Review</button>
    <button onclick="switchTab('graph')">Graph</button>
  </div>

  <div id="tab-review" class="tab-content active">
  <table>
    <thead>
      <tr><th>Project</th><th>Status</th><th>Date</th><th>Memory</th><th>Actions</th></tr>
    </thead>
    <tbody>
      ${rows.join("\n") || `<tr><td colspan="5">No queued items.</td></tr>`}
    </tbody>
  </table>

  <div class="panes">
    <div class="card">
      <h2>Accepted</h2>
      <ul>${acceptedItems || "<li>None yet.</li>"}</ul>
    </div>
    <div class="card">
      <h2>Recently Used</h2>
      <ul>${usageItems || "<li>No usage events yet.</li>"}</ul>
    </div>
  </div>
  </div>

  <div id="tab-graph" class="tab-content">
    <div id="graph-panel">
      <svg id="graph-svg"></svg>
      <div class="graph-legend">
        <span class="legend-project">Project</span>
        <span class="legend-decision">Decision</span>
        <span class="legend-pitfall">Pitfall</span>
        <span class="legend-pattern">Pattern</span>
      </div>
    </div>
  </div>

  <script>
    function switchTab(tab) {
      document.querySelectorAll('.tab-content').forEach(function(el) { el.classList.remove('active'); });
      document.querySelectorAll('.tab-bar button').forEach(function(el) { el.classList.remove('active'); });
      document.getElementById('tab-' + tab).classList.add('active');
      document.querySelector('.tab-bar button[onclick*="' + tab + '"]').classList.add('active');
      if (tab === 'graph' && !window._graphLoaded) {
        window._graphLoaded = true;
        loadGraph();
      }
    }

    function loadGraph() {
      fetch('/api/graph').then(function(r) { return r.json(); }).then(function(data) {
        var svg = d3.select('#graph-svg');
        var container = document.getElementById('graph-panel');
        var width = container.clientWidth || 900;
        var height = 600;
        svg.attr('viewBox', '0 0 ' + width + ' ' + height);

        var colorMap = { project: '#7C3AED', decision: '#2563EB', pitfall: '#DC2626', pattern: '#16A34A' };

        var g = svg.append('g');

        var zoom = d3.zoom().scaleExtent([0.3, 4]).on('zoom', function(event) {
          g.attr('transform', event.transform);
        });
        svg.call(zoom);

        var simulation = d3.forceSimulation(data.nodes)
          .force('link', d3.forceLink(data.links).id(function(d) { return d.id; }).distance(80))
          .force('charge', d3.forceManyBody().strength(-200))
          .force('center', d3.forceCenter(width / 2, height / 2))
          .force('collision', d3.forceCollide().radius(30));

        var link = g.append('g')
          .selectAll('line')
          .data(data.links)
          .join('line')
          .attr('stroke', '#555')
          .attr('stroke-opacity', 0.4)
          .attr('stroke-width', 1);

        var node = g.append('g')
          .selectAll('circle')
          .data(data.nodes)
          .join('circle')
          .attr('r', function(d) { return Math.max(5, Math.sqrt(d.refCount) * 6); })
          .attr('fill', function(d) { return colorMap[d.group] || '#888'; })
          .attr('stroke', '#1e1e2e')
          .attr('stroke-width', 1.5)
          .call(d3.drag()
            .on('start', function(event, d) {
              if (!event.active) simulation.alphaTarget(0.3).restart();
              d.fx = d.x; d.fy = d.y;
            })
            .on('drag', function(event, d) {
              d.fx = event.x; d.fy = event.y;
            })
            .on('end', function(event, d) {
              if (!event.active) simulation.alphaTarget(0);
              d.fx = null; d.fy = null;
            })
          );

        var label = g.append('g')
          .selectAll('text')
          .data(data.nodes)
          .join('text')
          .text(function(d) { return d.label; })
          .attr('font-size', function(d) { return d.group === 'project' ? 13 : 10; })
          .attr('font-weight', function(d) { return d.group === 'project' ? 'bold' : 'normal'; })
          .attr('fill', '#cdd6f4')
          .attr('dx', function(d) { return Math.max(5, Math.sqrt(d.refCount) * 6) + 4; })
          .attr('dy', 4);

        simulation.on('tick', function() {
          link
            .attr('x1', function(d) { return d.source.x; })
            .attr('y1', function(d) { return d.source.y; })
            .attr('x2', function(d) { return d.target.x; })
            .attr('y2', function(d) { return d.target.y; });
          node
            .attr('cx', function(d) { return d.x; })
            .attr('cy', function(d) { return d.y; });
          label
            .attr('x', function(d) { return d.x; })
            .attr('y', function(d) { return d.y; });
        });
      });
    }
  </script>
</body>
</html>`;
}

export function createReviewUiServer(cortexPath: string, opts?: ReviewUiOptions): http.Server {
  const authToken = opts?.authToken;
  const csrfTokens = opts?.csrfTokens;

  return http.createServer((req, res) => {
    const url = req.url || "/";
    if (req.method === "GET" && url === "/") {
      let csrfToken: string | undefined;
      if (csrfTokens) {
        csrfToken = crypto.randomUUID();
        csrfTokens.add(csrfToken);
      }
      const html = renderPage(cortexPath, csrfToken, authToken);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (req.method === "GET" && url === "/api/graph") {
      const graph = buildGraph(cortexPath);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(graph));
      return;
    }

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
          const submitted = String(parsed._auth || "");
          if (submitted !== authToken) {
            res.writeHead(401, { "content-type": "text/plain" });
            res.end("Unauthorized");
            return;
          }
        }

        if (csrfTokens) {
          const submitted = String(parsed._csrf || "");
          if (!submitted || !csrfTokens.delete(submitted)) {
            res.writeHead(403, { "content-type": "text/plain" });
            res.end("Invalid or missing CSRF token");
            return;
          }
        }

        const project = String(parsed.project || "");
        const line = String(parsed.line || "");
        const newText = String(parsed.new_text || "");
        if (!project || !line) {
          res.writeHead(400, { "content-type": "text/plain" });
          res.end("Missing project/line");
          return;
        }
        if (!isValidProjectName(project)) {
          res.writeHead(400, { "content-type": "text/plain" });
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
  const csrfTokens = new Set<string>();
  const server = createReviewUiServer(cortexPath, { authToken, csrfTokens });

  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve());
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
