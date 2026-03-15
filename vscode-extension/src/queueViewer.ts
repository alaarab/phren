import type { PhrenClient } from "./phrenClient";
import { showPreview } from "./previewPanel";

export interface QueueItemData {
  projectName: string;
  id: string;
  section: string;
  date: string;
  text: string;
  line: string;
  confidence?: number;
  risky: boolean;
  machine?: string;
  model?: string;
}

export function showQueueItemDetail(_client: PhrenClient, item: QueueItemData, _onRefresh: () => void): void {
  showPreview({
    key: `queue:${item.projectName}:${item.id}`,
    title: `Queue: ${item.projectName} · ${item.id}`,
    html: renderQueueItemHtml(item),
  });
}

function renderQueueItemHtml(item: QueueItemData): string {
  const sectionColor: Record<string, string> = {
    Review: "#2a7acc",
    Stale: "#7B68AE",
    Conflicts: "#c33",
  };
  const color = sectionColor[item.section] ?? "#888";
  const confidenceHtml = item.confidence !== undefined
    ? `<span class="badge" style="background:${item.confidence < 0.7 ? '#7B68AE' : '#388a34'}">${Math.round(item.confidence * 100)}% confidence</span>`
    : "";
  const riskyHtml = item.risky ? '<span class="badge" style="background:#c33">risky</span>' : "";
  const metaHtml = [
    item.machine ? `Machine: ${esc(item.machine)}` : "",
    item.model ? `Model: ${esc(item.model)}` : "",
  ].filter(Boolean).join(" &middot; ");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: var(--vscode-font-family, sans-serif); padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; color: #fff; margin-right: 8px; }
    .badge-project { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
    .date { color: var(--vscode-descriptionForeground); font-size: 13px; }
    .meta { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 4px; }
    h1 { font-size: 18px; margin-bottom: 8px; }
    .notice { margin: 12px 0; padding: 10px 12px; border-radius: 6px; background: var(--vscode-textCodeBlock-background); color: var(--vscode-descriptionForeground); font-size: 13px; }
    .content-view { line-height: 1.6; white-space: pre-wrap; font-size: 14px; border: 1px solid var(--vscode-editorWidget-border, #333); border-radius: 6px; padding: 12px; }
  </style>
</head>
<body>
  <h1>Queue Item ${esc(item.id)}</h1>
  <span class="badge" style="background:${color}">${esc(item.section)}</span>
  <span class="badge badge-project">${esc(item.projectName)}</span>
  ${confidenceHtml}
  ${riskyHtml}
  <br>
  <span class="date">${esc(item.date)}</span>
  ${metaHtml ? `<div class="meta">${metaHtml}</div>` : ""}
  <div class="notice">Review queue items are read-only in VS Code. Use the CLI or MCP tools to approve or reject.</div>
  <div id="viewMode" class="content-view">${esc(item.text)}</div>
</body>
</html>`;
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
