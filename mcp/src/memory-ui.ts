import * as http from "http";
import * as crypto from "crypto";
import { timingSafeEqual } from "crypto";
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

function layoutGraph(graph: { nodes: GraphNode[]; links: GraphLink[] }, width: number, height: number): { nodes: Array<GraphNode & { x: number; y: number }>; links: Array<{ x1: number; y1: number; x2: number; y2: number }> } {
  if (graph.nodes.length === 0) return { nodes: [], links: [] };

  const nodeMap = new Map<string, GraphNode & { x: number; y: number }>();
  const cx = width / 2;
  const cy = height / 2;

  // Place project nodes in a circle, then child nodes around their parent
  const projectNodes = graph.nodes.filter((n) => n.group === "project");
  const childNodes = graph.nodes.filter((n) => n.group !== "project");

  projectNodes.forEach((n, i) => {
    const angle = (2 * Math.PI * i) / Math.max(projectNodes.length, 1);
    const radius = Math.min(width, height) * 0.3;
    nodeMap.set(n.id, { ...n, x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) });
  });

  // Group children by parent project
  const parentMap = new Map<string, string[]>();
  for (const link of graph.links) {
    if (!parentMap.has(link.source)) parentMap.set(link.source, []);
    parentMap.get(link.source)!.push(link.target);
  }

  for (const [parentId, childIds] of parentMap) {
    const parent = nodeMap.get(parentId);
    if (!parent) continue;
    childIds.forEach((childId, i) => {
      const child = graph.nodes.find((n) => n.id === childId);
      if (!child || nodeMap.has(childId)) return;
      const angle = (2 * Math.PI * i) / childIds.length;
      const r = 60 + childIds.length * 5;
      nodeMap.set(childId, { ...child, x: parent.x + r * Math.cos(angle), y: parent.y + r * Math.sin(angle) });
    });
  }

  // Any remaining nodes not yet placed
  for (const n of graph.nodes) {
    if (!nodeMap.has(n.id)) {
      nodeMap.set(n.id, { ...n, x: cx + (Math.random() - 0.5) * width * 0.5, y: cy + (Math.random() - 0.5) * height * 0.5 });
    }
  }

  const laidOutNodes = [...nodeMap.values()];
  const laidOutLinks = graph.links.map((link) => {
    const s = nodeMap.get(link.source);
    const t = nodeMap.get(link.target);
    return { x1: s?.x ?? 0, y1: s?.y ?? 0, x2: t?.x ?? 0, y2: t?.y ?? 0 };
  });

  return { nodes: laidOutNodes, links: laidOutLinks };
}

function renderGraphSvg(cortexPath: string, width: number, height: number): string {
  const graph = buildGraph(cortexPath);
  const layout = layoutGraph(graph, width, height);
  const colorMap: Record<string, string> = { project: "#7C3AED", decision: "#2563EB", pitfall: "#DC2626", pattern: "#16A34A" };

  const lines = layout.links.map((l) =>
    `<line x1="${l.x1}" y1="${l.y1}" x2="${l.x2}" y2="${l.y2}" stroke="#555" stroke-opacity="0.4" stroke-width="1" />`
  );

  const circles = layout.nodes.map((n) => {
    const r = Math.max(5, Math.sqrt(n.refCount) * 6);
    const fill = colorMap[n.group] || "#888";
    const fontSize = n.group === "project" ? 13 : 10;
    const fontWeight = n.group === "project" ? "bold" : "normal";
    return `<circle cx="${n.x}" cy="${n.y}" r="${r}" fill="${fill}" stroke="#1e1e2e" stroke-width="1.5" />` +
      `<text x="${n.x + r + 4}" y="${n.y + 4}" font-size="${fontSize}" font-weight="${fontWeight}" fill="#cdd6f4">${h(n.label)}</text>`;
  });

  return `<svg id="graph-svg" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">` +
    `<g>${lines.join("")}${circles.join("")}</g></svg>`;
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

  const graphSvg = renderGraphSvg(cortexPath, 900, 600);

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Cortex Memory UI</title>
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
      ${graphSvg}
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
    }
  </script>
</body>
</html>`;
}

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

    if (req.method === "GET" && url.startsWith("/api/graph")) {
      if (authToken) {
        const submitted = getSubmittedAuthToken(req, url);
        if (!authTokensMatch(submitted, authToken)) {
          res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
          res.end("Unauthorized");
          return;
        }
      }
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
