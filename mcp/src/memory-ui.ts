import * as http from "http";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as querystring from "querystring";
import {
  getProjectDirs,
} from "./shared.js";
import {
  approveMemoryQueueItem,
  editMemoryQueueItem,
  readMemoryQueue,
  rejectMemoryQueueItem,
} from "./data-access.js";
import { isValidProjectName } from "./utils.js";

export interface MemoryUiOptions {
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
  const audit = path.join(cortexPath, ".cortex-audit.log");
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

function renderPage(cortexPath: string, csrfToken?: string, authToken?: string): string {
  const projects = getProjectDirs(cortexPath).map((p) => path.basename(p)).filter((p) => p !== "global");
  const usage = recentUsage(cortexPath);
  const accepted = recentAccepted(cortexPath);
  const rows: string[] = [];

  const csrfField = csrfToken ? `<input type="hidden" name="_csrf" value="${h(csrfToken)}" />` : "";
  const authField = authToken ? `<input type="hidden" name="_auth" value="${h(authToken)}" />` : "";
  const hiddenFields = csrfField + authField;

  for (const project of projects) {
    const result = readMemoryQueue(cortexPath, project);
    // TODO (#85): readMemoryQueue returns QueueItem[] | string; migrate to CortexResult<T>
    const items = Array.isArray(result) ? result : [];
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
    @media (max-width: 900px) { .panes { grid-template-columns: 1fr; } .actions { min-width: 0; } }
  </style>
</head>
<body>
  <h1>Cortex Memory Review</h1>
  <div class="subtitle">Markdown is source-of-truth. Approve/reject/edit updates queue + learnings directly.</div>
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
</body>
</html>`;
}

export function createMemoryUiServer(cortexPath: string, opts?: MemoryUiOptions): http.Server {
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

        let outcome = "";
        if (url === "/approve") {
          outcome = approveMemoryQueueItem(cortexPath, project, line);
        } else if (url === "/reject") {
          outcome = rejectMemoryQueueItem(cortexPath, project, line);
        } else if (url === "/edit") {
          outcome = editMemoryQueueItem(cortexPath, project, line, newText);
        }

        if (outcome.includes("requires maintainer/admin role") || outcome.startsWith("Permission denied")) {
          res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
          res.end(outcome);
          return;
        }
        if (outcome.startsWith("No memory queue item")) {
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          res.end(outcome);
          return;
        }
        if (outcome.startsWith("Invalid") || outcome.startsWith("Usage:") || outcome.includes("cannot be empty")) {
          res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
          res.end(outcome);
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

export async function startMemoryUi(cortexPath: string, port: number): Promise<void> {
  const authToken = crypto.randomUUID();
  const csrfTokens = new Set<string>();
  const server = createMemoryUiServer(cortexPath, { authToken, csrfTokens });

  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve());
  });

  process.stdout.write(`cortex memory-ui running at http://127.0.0.1:${port}\n`);
  process.stderr.write(`auth token: ${authToken}\n`);

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      server.close(() => resolve());
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  });
}
