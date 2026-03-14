import * as vscode from "vscode";
import { PhrenClient } from "./phrenClient";
import { showPreview } from "./previewPanel";

interface TaskData {
  projectName: string;
  id: string;
  line: string;
  section: string;
  checked: boolean;
}

export function showTaskDetail(client: PhrenClient, task: TaskData, onRefresh: () => void): void {
  showPreview({
    key: `task:${task.projectName}:${task.id}`,
    title: `Task: ${task.id}`,
    html: renderTaskHtml(task),
    onMessage: async (msg: Record<string, unknown>) => {
      if (msg.type === "complete") {
        try {
          await client.completeTask(task.projectName, task.line);
          vscode.window.showInformationMessage(`Task "${task.id}" marked complete.`);
          onRefresh();
        } catch (e) {
          vscode.window.showErrorMessage(`Failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (msg.type === "delete") {
        try {
          const confirmed = await vscode.window.showWarningMessage(
            `Delete task "${task.id}"?`,
            { modal: true, detail: task.line },
            "Delete",
          );
          if (confirmed !== "Delete") return;
          await client.removeTask(task.projectName, task.line);
          vscode.window.showInformationMessage(`Task "${task.id}" deleted.`);
          onRefresh();
        } catch (e) {
          vscode.window.showErrorMessage(`Failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (msg.type === "save" && typeof msg.text === "string") {
        try {
          await client.updateTask(task.projectName, task.line, { item: msg.text as string });
          task.line = msg.text as string;
          vscode.window.showInformationMessage(`Task "${task.id}" updated.`);
          onRefresh();
        } catch (e) {
          vscode.window.showErrorMessage(`Failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    },
  });
}

function renderTaskHtml(task: TaskData): string {
  const sectionColor: Record<string, string> = { Active: "#388a34", Queue: "#7B68AE", Done: "#666" };
  const color = sectionColor[task.section] ?? "#888";

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: var(--vscode-font-family, sans-serif); padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; color: #fff; margin-right: 8px; }
    .badge-project { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
    h1 { font-size: 18px; margin-bottom: 8px; }
    .status { margin-top: 8px; font-size: 13px; margin-bottom: 12px; }
    .toolbar { display: flex; gap: 8px; margin-bottom: 12px; }
    button { padding: 4px 12px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px; cursor: pointer; font-size: 13px; }
    .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
    .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .content-view { line-height: 1.6; white-space: pre-wrap; font-size: 14px; border: 1px solid var(--vscode-editorWidget-border, #333); border-radius: 6px; padding: 12px; }
    textarea { width: 100%; min-height: 120px; font-family: var(--vscode-editor-font-family, monospace); font-size: 14px; line-height: 1.6; border: 1px solid var(--vscode-focusBorder, #007acc); border-radius: 6px; padding: 12px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); resize: vertical; box-sizing: border-box; }
    .hidden { display: none; }
  </style>
</head>
<body>
  <h1>Task ${esc(task.id)}</h1>
  <span class="badge" style="background:${color}">${esc(task.section)}</span>
  <span class="badge badge-project">${esc(task.projectName)}</span>
  <div class="status">${task.checked ? "&#9745; Complete" : "&#9744; Incomplete"}</div>
  <div class="toolbar">
    <button id="btnEdit" class="btn-primary" onclick="startEdit()">Edit</button>
    <button id="btnSave" class="btn-primary hidden" onclick="save()">Save</button>
    <button id="btnCancel" class="btn-secondary hidden" onclick="cancelEdit()">Cancel</button>
    ${task.section !== "Done" ? '<button class="btn-secondary" onclick="complete()">Mark Done</button>' : ""}
    <button class="btn-secondary" onclick="removeTask()">Delete</button>
  </div>
  <div id="viewMode" class="content-view">${esc(task.line)}</div>
  <textarea id="editMode" class="hidden">${esc(task.line)}</textarea>
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
      vscode.postMessage({ type: "save", text: text });
      document.getElementById("viewMode").textContent = text;
      cancelEdit();
    }
    function complete() {
      vscode.postMessage({ type: "complete" });
    }
    function removeTask() {
      vscode.postMessage({ type: "delete" });
    }
  </script>
</body>
</html>`;
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
