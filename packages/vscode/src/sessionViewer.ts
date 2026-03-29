import { PhrenClient } from "./phrenClient";
import { showPreview } from "./previewPanel";

interface SessionData {
  projectName: string;
  sessionId: string;
  startedAt: string;
  durationMins?: number;
  summary?: string;
  findingsAdded: number;
  status: "active" | "ended";
}

interface SessionFindingView {
  id: string;
  date: string;
  text: string;
}

interface SessionTaskView {
  id: string;
  line: string;
  section: string;
  checked: boolean;
}

export async function showSessionOverview(client: PhrenClient, session: SessionData): Promise<void> {
  try {
    const raw = await client.sessionHistory({ sessionId: session.sessionId, project: session.projectName });
    const response = asRecord(raw);
    const data = asRecord(response?.data);
    const findings = asArray(data?.findings)
      .map((entry) => {
        const record = asRecord(entry);
        const id = asString(record?.id);
        const text = asString(record?.text);
        if (!id || !text) return undefined;
        return {
          id,
          date: asString(record?.date) ?? "unknown",
          text,
        } satisfies SessionFindingView;
      })
      .filter((entry): entry is SessionFindingView => Boolean(entry));
    const tasks = asArray(data?.tasks)
      .map((entry) => {
        const record = asRecord(entry);
        const id = asString(record?.id);
        const line = asString(record?.text);
        const section = asString(record?.section);
        if (!id || !line || !section) return undefined;
        return {
          id,
          line,
          section,
          checked: asBoolean(record?.checked) ?? section === "Done",
        } satisfies SessionTaskView;
      })
      .filter((entry): entry is SessionTaskView => Boolean(entry));

    showPreview({
      key: `session:${session.projectName}:${session.sessionId}`,
      title: `Session: ${session.sessionId.slice(0, 8)}`,
      html: renderSessionHtml(session, findings, tasks),
    });
  } catch (error) {
    showPreview({
      key: `session:${session.projectName}:${session.sessionId}`,
      title: `Session: ${session.sessionId.slice(0, 8)}`,
      html: renderErrorHtml(session, error),
    });
  }
}

function renderSessionHtml(session: SessionData, findings: SessionFindingView[], tasks: SessionTaskView[]): string {
  const startedLabel = formatTimestamp(session.startedAt);
  const findingsLabel = findings.length === 1 ? "1 finding" : `${findings.length} findings`;
  const tasksLabel = tasks.length === 1 ? "1 task" : `${tasks.length} tasks`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: var(--vscode-font-family, sans-serif); padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    h1 { font-size: 18px; margin: 0 0 10px; }
    h2 { font-size: 15px; margin: 24px 0 10px; }
    .meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin: 18px 0; }
    .card { border: 1px solid var(--vscode-editorWidget-border, #333); border-radius: 8px; padding: 12px; background: var(--vscode-sideBar-background, transparent); }
    .meta-label { font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.04em; }
    .meta-value { font-size: 14px; line-height: 1.4; }
    .badge-row { display: flex; gap: 8px; flex-wrap: wrap; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
    .badge-status-active { background: var(--vscode-testing-iconPassed, #2ea043); color: #fff; }
    .summary { line-height: 1.6; white-space: pre-wrap; margin: 16px 0 0; padding: 12px; border-left: 3px solid var(--vscode-focusBorder, #007acc); background: color-mix(in srgb, var(--vscode-editor-background) 85%, var(--vscode-focusBorder, #007acc) 15%); }
    .list { margin: 0; padding: 0; list-style: none; }
    .list-item { padding: 10px 0; border-bottom: 1px solid var(--vscode-editorWidget-border, #333); }
    .list-item:last-child { border-bottom: 0; }
    .item-meta { font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
    .empty { color: var(--vscode-descriptionForeground); }
    code { font-family: var(--vscode-editor-font-family, monospace); }
  </style>
</head>
<body>
  <h1>Session ${esc(session.sessionId.slice(0, 8))}</h1>
  <div class="badge-row">
    <span class="badge">${esc(session.projectName)}</span>
    <span class="badge ${session.status === "active" ? "badge-status-active" : ""}">${esc(session.status)}</span>
    <span class="badge">${esc(findingsLabel)}</span>
    <span class="badge">${esc(tasksLabel)}</span>
  </div>

  <div class="meta">
    <div class="card">
      <div class="meta-label">Started</div>
      <div class="meta-value">${esc(startedLabel)}</div>
    </div>
    <div class="card">
      <div class="meta-label">Duration</div>
      <div class="meta-value">${esc(`${session.durationMins ?? 0} min`)}</div>
    </div>
    <div class="card">
      <div class="meta-label">Findings Added</div>
      <div class="meta-value">${esc(String(session.findingsAdded))}</div>
    </div>
    <div class="card">
      <div class="meta-label">Session ID</div>
      <div class="meta-value"><code>${esc(session.sessionId)}</code></div>
    </div>
  </div>

  ${session.summary ? `<div class="summary">${esc(session.summary)}</div>` : ""}

  <h2>Findings</h2>
  ${findings.length === 0 ? '<div class="empty">No findings captured for this session.</div>' : `
    <ul class="list">
      ${findings.map((finding) => `
        <li class="list-item">
          <div class="item-meta">${esc(finding.id)} · ${esc(finding.date)}</div>
          <div>${esc(finding.text)}</div>
        </li>
      `).join("")}
    </ul>
  `}

  <h2>Tasks</h2>
  ${tasks.length === 0 ? '<div class="empty">No tasks captured for this session.</div>' : `
    <ul class="list">
      ${tasks.map((task) => `
        <li class="list-item">
          <div class="item-meta">${esc(task.id)} · ${esc(task.section)}${task.checked ? " · done" : ""}</div>
          <div>${esc(task.line)}</div>
        </li>
      `).join("")}
    </ul>
  `}
</body>
</html>`;
}

function renderErrorHtml(session: SessionData, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: var(--vscode-font-family, sans-serif); padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    .error { white-space: pre-wrap; line-height: 1.6; border: 1px solid var(--vscode-inputValidation-errorBorder, #c33); border-radius: 8px; padding: 12px; color: var(--vscode-errorForeground, #f48771); }
  </style>
</head>
<body>
  <h1>Session ${esc(session.sessionId.slice(0, 8))}</h1>
  <div class="error">${esc(message)}</div>
</body>
</html>`;
}

function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  if (isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
