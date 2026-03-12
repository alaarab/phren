import * as vscode from "vscode";
import { CortexClient } from "./cortexClient";
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

export function showQueueItemDetail(client: CortexClient, item: QueueItemData, onRefresh: () => void): void {
  showPreview({
    key: `queue:${item.projectName}:${item.id}`,
    title: `Queue: ${item.id}`,
    html: renderQueueItemHtml(item),
    onMessage: async (msg: Record<string, unknown>) => {
      if (msg.type === "approve") {
        try {
          await client.approveQueueItem(item.projectName, item.text);
          vscode.window.showInformationMessage(`Queue item "${item.id}" approved and moved to FINDINGS.md.`);
          onRefresh();
        } catch (e) {
          vscode.window.showErrorMessage(`Failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (msg.type === "reject") {
        try {
          await client.rejectQueueItem(item.projectName, item.text);
          vscode.window.showInformationMessage(`Queue item "${item.id}" rejected.`);
          onRefresh();
        } catch (e) {
          vscode.window.showErrorMessage(`Failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (msg.type === "save" && typeof msg.newText === "string") {
        try {
          await client.editQueueItem(item.projectName, item.text, msg.newText as string);
          item.text = msg.newText as string;
          vscode.window.showInformationMessage(`Queue item "${item.id}" updated.`);
          onRefresh();
        } catch (e) {
          vscode.window.showErrorMessage(`Failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    },
  });
}

function renderQueueItemHtml(item: QueueItemData): string {
  const sectionColor: Record<string, string> = {
    Review: "#2a7acc",
    Stale: "#c89b2a",
    Conflicts: "#c33",
  };
  const color = sectionColor[item.section] ?? "#888";
  const confidenceHtml = item.confidence !== undefined
    ? `<span class="badge" style="background:${item.confidence < 0.7 ? '#c89b2a' : '#388a34'}">${Math.round(item.confidence * 100)}% confidence</span>`
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
    .toolbar { display: flex; gap: 8px; margin: 12px 0; }
    button { padding: 4px 12px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px; cursor: pointer; font-size: 13px; }
    .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
    .btn-approve { background: #388a34; color: #fff; }
    .btn-approve:hover { background: #2d7229; }
    .btn-reject { background: #c33; color: #fff; }
    .btn-reject:hover { background: #a22; }
    .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .content-view { line-height: 1.6; white-space: pre-wrap; font-size: 14px; border: 1px solid var(--vscode-editorWidget-border, #333); border-radius: 6px; padding: 12px; }
    textarea { width: 100%; min-height: 120px; font-family: var(--vscode-editor-font-family, monospace); font-size: 14px; line-height: 1.6; border: 1px solid var(--vscode-focusBorder, #007acc); border-radius: 6px; padding: 12px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); resize: vertical; box-sizing: border-box; }
    .hidden { display: none; }
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
  <div class="toolbar">
    <button class="btn-approve" onclick="approve()">Approve</button>
    <button class="btn-reject" onclick="reject()">Reject</button>
    <button id="btnEdit" class="btn-secondary" onclick="startEdit()">Edit</button>
    <button id="btnSave" class="btn-primary hidden" onclick="save()">Save</button>
    <button id="btnCancel" class="btn-secondary hidden" onclick="cancelEdit()">Cancel</button>
  </div>
  <div id="viewMode" class="content-view">${esc(item.text)}</div>
  <textarea id="editMode" class="hidden">${esc(item.text)}</textarea>
  <script>
    const vscode = acquireVsCodeApi();
    function approve() {
      if (confirm("Approve this memory? It will be moved to FINDINGS.md.")) {
        vscode.postMessage({ type: "approve" });
      }
    }
    function reject() {
      if (confirm("Reject this memory? It will be removed from the queue.")) {
        vscode.postMessage({ type: "reject" });
      }
    }
    function startEdit() {
      document.getElementById("viewMode").classList.add("hidden");
      document.getElementById("editMode").classList.remove("hidden");
      document.getElementById("btnEdit").classList.add("hidden");
      document.getElementById("btnSave").classList.remove("hidden");
      document.getElementById("btnCancel").classList.remove("hidden");
      document.getElementById("editMode").focus();
    }
    function cancelEdit() {
      document.getElementById("viewMode").classList.remove("hidden");
      document.getElementById("editMode").classList.add("hidden");
      document.getElementById("btnEdit").classList.remove("hidden");
      document.getElementById("btnSave").classList.add("hidden");
      document.getElementById("btnCancel").classList.add("hidden");
    }
    function save() {
      const text = document.getElementById("editMode").value;
      vscode.postMessage({ type: "save", newText: text });
      document.getElementById("viewMode").textContent = text;
      cancelEdit();
    }
  </script>
</body>
</html>`;
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
