import * as vscode from "vscode";
import { CortexClient } from "./cortexClient";
import { showPreview } from "./previewPanel";

interface FindingData {
  projectName: string;
  id: string;
  date: string;
  text: string;
}

export function showFindingDetail(client: CortexClient, finding: FindingData, onRefresh: () => void): void {
  showPreview({
    key: `finding:${finding.projectName}:${finding.id}`,
    title: `Finding: ${finding.id}`,
    html: renderFindingHtml(finding),
    onMessage: async (msg: Record<string, unknown>) => {
      if (msg.type === "save" && typeof msg.newText === "string") {
        try {
          // Remove old, add new
          await client.removeFinding(finding.projectName, finding.text);
          await client.addFinding(finding.projectName, msg.newText as string);
          finding.text = msg.newText as string;
          vscode.window.showInformationMessage(`Finding "${finding.id}" updated.`);
          onRefresh();
        } catch (e) {
          vscode.window.showErrorMessage(`Failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (msg.type === "delete") {
        try {
          await client.removeFinding(finding.projectName, finding.text);
          vscode.window.showInformationMessage(`Finding "${finding.id}" removed.`);
          onRefresh();
        } catch (e) {
          vscode.window.showErrorMessage(`Failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    },
  });
}

function renderFindingHtml(finding: FindingData): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: var(--vscode-font-family, sans-serif); padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); margin-right: 8px; }
    .date { color: var(--vscode-descriptionForeground); font-size: 13px; }
    h1 { font-size: 18px; margin-bottom: 8px; }
    .toolbar { display: flex; gap: 8px; margin: 12px 0; }
    button { padding: 4px 12px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px; cursor: pointer; font-size: 13px; }
    .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
    .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .btn-danger { background: #c33; color: #fff; }
    .content-view { line-height: 1.6; white-space: pre-wrap; font-size: 14px; border: 1px solid var(--vscode-editorWidget-border, #333); border-radius: 6px; padding: 12px; }
    textarea { width: 100%; min-height: 120px; font-family: var(--vscode-editor-font-family, monospace); font-size: 14px; line-height: 1.6; border: 1px solid var(--vscode-focusBorder, #007acc); border-radius: 6px; padding: 12px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); resize: vertical; box-sizing: border-box; }
    .hidden { display: none; }
  </style>
</head>
<body>
  <h1>Finding ${esc(finding.id)}</h1>
  <span class="badge">${esc(finding.projectName)}</span>
  <span class="date">${esc(finding.date)}</span>
  <div class="toolbar">
    <button id="btnEdit" class="btn-primary" onclick="startEdit()">Edit</button>
    <button id="btnSave" class="btn-primary hidden" onclick="save()">Save</button>
    <button id="btnCancel" class="btn-secondary hidden" onclick="cancelEdit()">Cancel</button>
    <button class="btn-danger" onclick="del()">Delete</button>
  </div>
  <div id="viewMode" class="content-view">${esc(finding.text)}</div>
  <textarea id="editMode" class="hidden">${esc(finding.text)}</textarea>
  <script>
    const vscode = acquireVsCodeApi();
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
    function del() {
      if (confirm("Delete this finding?")) {
        vscode.postMessage({ type: "delete" });
      }
    }
  </script>
</body>
</html>`;
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
