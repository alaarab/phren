import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as querystring from "querystring";
import {
  checkMemoryPermission,
  getProjectDirs,
  getMemoryWorkflowPolicy,
  addLearningToFile,
  appendAuditLog,
} from "./shared.js";

interface QueueItem {
  section: "Review" | "Stale" | "Conflicts";
  line: string;
  text: string;
  date: string;
}

function queuePath(cortexPath: string, project: string): string {
  return path.join(cortexPath, project, "MEMORY_QUEUE.md");
}

function parseQueueItems(cortexPath: string, project: string): QueueItem[] {
  const file = queuePath(cortexPath, project);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split("\n");
  let section: QueueItem["section"] = "Review";
  const items: QueueItem[] = [];

  for (const line of lines) {
    if (line.trim() === "## Review") section = "Review";
    if (line.trim() === "## Stale") section = "Stale";
    if (line.trim() === "## Conflicts") section = "Conflicts";
    if (!line.startsWith("- ")) continue;
    const m = line.match(/^- \[(\d{4}-\d{2}-\d{2})\]\s*(.+)$/);
    if (!m) continue;
    items.push({
      section,
      line,
      date: m[1],
      text: m[2],
    });
  }

  return items;
}

function findQueueItem(cortexPath: string, project: string, line: string): QueueItem | null {
  return parseQueueItems(cortexPath, project).find((i) => i.line === line) || null;
}

function isRiskyQueueItem(cortexPath: string, item: QueueItem | null): boolean {
  if (!item) return false;
  const workflow = getMemoryWorkflowPolicy(cortexPath);
  const riskyBySection = workflow.riskySections.includes(item.section);
  const confidence = item.text.match(/\[confidence\s+([01](?:\.\d+)?)\]/i);
  const riskyByConfidence = confidence ? Number.parseFloat(confidence[1]) < workflow.lowConfidenceThreshold : false;
  return riskyBySection || riskyByConfidence;
}

function rewriteQueue(cortexPath: string, project: string, items: QueueItem[]) {
  const bySection: Record<QueueItem["section"], QueueItem[]> = {
    Review: [],
    Stale: [],
    Conflicts: [],
  };
  for (const item of items) bySection[item.section].push(item);

  const out: string[] = [`# ${project} Memory Queue`, "", "## Review", ""];
  for (const item of bySection.Review) out.push(item.line);
  out.push("", "## Stale", "");
  for (const item of bySection.Stale) out.push(item.line);
  out.push("", "## Conflicts", "");
  for (const item of bySection.Conflicts) out.push(item.line);
  out.push("");

  fs.writeFileSync(queuePath(cortexPath, project), out.join("\n").replace(/\n{3,}/g, "\n\n"));
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

function renderPage(cortexPath: string): string {
  const projects = getProjectDirs(cortexPath).map((p) => path.basename(p)).filter((p) => p !== "global");
  const usage = recentUsage(cortexPath);
  const accepted = recentAccepted(cortexPath);
  const rows: string[] = [];

  for (const project of projects) {
    const items = parseQueueItems(cortexPath, project);
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
              <input type="hidden" name="project" value="${h(project)}" />
              <input type="hidden" name="line" value="${h(item.line)}" />
              <button type="submit">Approve</button>
            </form>
            <form method="POST" action="/reject">
              <input type="hidden" name="project" value="${h(project)}" />
              <input type="hidden" name="line" value="${h(item.line)}" />
              <button type="submit">Reject</button>
            </form>
            <form method="POST" action="/edit">
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

function removeLine(cortexPath: string, project: string, line: string): boolean {
  const items = parseQueueItems(cortexPath, project);
  const idx = items.findIndex((i) => i.line === line);
  if (idx === -1) return false;
  items.splice(idx, 1);
  rewriteQueue(cortexPath, project, items);
  return true;
}

function editLine(cortexPath: string, project: string, line: string, newText: string): boolean {
  const items = parseQueueItems(cortexPath, project);
  const idx = items.findIndex((i) => i.line === line);
  if (idx === -1) return false;
  const date = items[idx].date;
  items[idx].text = newText.trim();
  items[idx].line = `- [${date}] ${items[idx].text}`;
  rewriteQueue(cortexPath, project, items);
  return true;
}

export async function startMemoryUi(cortexPath: string, port: number): Promise<void> {
  const server = http.createServer(async (req, res) => {
    const url = req.url || "/";
    if (req.method === "GET" && url === "/") {
      const html = renderPage(cortexPath);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (req.method === "POST" && ["/approve", "/reject", "/edit"].includes(url)) {
      let body = "";
      req.on("data", (chunk) => { body += String(chunk); });
      req.on("end", () => {
        const parsed = querystring.parse(body);
        const project = String(parsed.project || "");
        const line = String(parsed.line || "");
        const newText = String(parsed.new_text || "");
        if (!project || !line) {
          res.writeHead(400, { "content-type": "text/plain" });
          res.end("Missing project/line");
          return;
        }

        if (url === "/approve") {
          const item = findQueueItem(cortexPath, project, line);
          const workflow = getMemoryWorkflowPolicy(cortexPath);
          if (workflow.requireMaintainerApproval && isRiskyQueueItem(cortexPath, item)) {
            const denial = checkMemoryPermission(cortexPath, "pin");
            if (denial) {
              appendAuditLog(cortexPath, "approve_memory_denied", `project=${project} reason=${JSON.stringify(denial)}`);
              res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
              res.end("Approval requires maintainer/admin role for risky memory entries.");
              return;
            }
          }

          const m = line.match(/^- \[\d{4}-\d{2}-\d{2}\]\s*(.+)$/);
          const text = m ? m[1] : line.replace(/^- /, "");
          addLearningToFile(cortexPath, project, text);
          removeLine(cortexPath, project, line);
          appendAuditLog(cortexPath, "approve_memory", `project=${project} memory=${JSON.stringify(text)}`);
        } else if (url === "/reject") {
          removeLine(cortexPath, project, line);
          appendAuditLog(cortexPath, "reject_memory", `project=${project} memory=${JSON.stringify(line)}`);
        } else if (url === "/edit") {
          editLine(cortexPath, project, line, newText);
          appendAuditLog(cortexPath, "edit_memory", `project=${project} old=${JSON.stringify(line)} new=${JSON.stringify(newText)}`);
        }

        res.writeHead(302, { location: "/" });
        res.end();
      });
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  });

  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve());
  });
  process.stdout.write(`cortex memory-ui running at http://127.0.0.1:${port}\n`);
  await new Promise<void>(() => { /* keep alive */ });
}
