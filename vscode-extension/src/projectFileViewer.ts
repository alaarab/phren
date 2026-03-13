import * as vscode from "vscode";
import { CortexClient } from "./cortexClient";

export async function showProjectFile(client: CortexClient, projectName: string, fileName: string): Promise<void> {
  const panel = vscode.window.createWebviewPanel(
    "cortex.projectFile",
    `${projectName}/${fileName}`,
    vscode.ViewColumn.One,
    {}
  );

  try {
    const raw = await client.getMemoryDetail(`mem:${projectName}/${fileName}`);
    const data = asRecord(raw);
    const content = asString(asRecord(data?.data)?.content) ?? asString(data?.content) ?? "(no content)";
    panel.webview.html = renderFileHtml(projectName, fileName, content);
  } catch (error) {
    panel.webview.html = renderFileHtml(projectName, fileName, `Error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function renderFileHtml(project: string, file: string, content: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: var(--vscode-editor-font-family, monospace); padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    .header { margin-bottom: 16px; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
    .content { white-space: pre-wrap; line-height: 1.5; font-size: 13px; }
    h1 { font-size: 16px; }
  </style>
</head>
<body>
  <div class="header">
    <h1>${escapeHtml(file)}</h1>
    <span class="badge">${escapeHtml(project)}</span>
  </div>
  <div class="content">${escapeHtml(content)}</div>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
