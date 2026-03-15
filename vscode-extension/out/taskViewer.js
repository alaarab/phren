"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.showTaskDetail = showTaskDetail;
const vscode = __importStar(require("vscode"));
const previewPanel_1 = require("./previewPanel");
function showTaskDetail(client, task, onRefresh) {
    (0, previewPanel_1.showPreview)({
        key: `task:${task.projectName}:${task.id}`,
        title: `Task: ${task.id}`,
        html: renderTaskHtml(task),
        onMessage: async (msg) => {
            if (msg.type === "complete") {
                try {
                    await client.completeTask(task.projectName, task.line);
                    vscode.window.showInformationMessage(`Task "${task.id}" marked complete.`);
                    onRefresh();
                }
                catch (e) {
                    vscode.window.showErrorMessage(`Failed: ${e instanceof Error ? e.message : String(e)}`);
                }
            }
            if (msg.type === "delete") {
                try {
                    const confirmed = await vscode.window.showWarningMessage(`Delete task "${task.id}"?`, { modal: true, detail: task.line }, "Delete");
                    if (confirmed !== "Delete")
                        return;
                    await client.removeTask(task.projectName, task.line);
                    vscode.window.showInformationMessage(`Task "${task.id}" deleted.`);
                    onRefresh();
                }
                catch (e) {
                    vscode.window.showErrorMessage(`Failed: ${e instanceof Error ? e.message : String(e)}`);
                }
            }
            if (msg.type === "save" && typeof msg.text === "string") {
                try {
                    const nextText = msg.text.trim();
                    if (!nextText)
                        return;
                    await client.updateTask(task.projectName, task.line, { text: nextText });
                    task.line = nextText;
                    vscode.window.showInformationMessage(`Task "${task.id}" updated.`);
                    onRefresh();
                }
                catch (e) {
                    vscode.window.showErrorMessage(`Failed: ${e instanceof Error ? e.message : String(e)}`);
                }
            }
            if (msg.type === "linkIssue") {
                const input = await vscode.window.showInputBox({
                    prompt: "Enter GitHub issue number or URL",
                    placeHolder: "123 or https://github.com/owner/repo/issues/123",
                });
                if (!input?.trim())
                    return;
                const trimmed = input.trim();
                const numMatch = trimmed.match(/^(\d+)$/);
                try {
                    if (numMatch) {
                        await client.linkTaskIssue(task.projectName, task.line, parseInt(numMatch[1], 10));
                    }
                    else {
                        await client.linkTaskIssue(task.projectName, task.line, undefined, trimmed);
                    }
                    vscode.window.showInformationMessage(`Issue linked to task "${task.id}".`);
                    onRefresh();
                }
                catch (e) {
                    vscode.window.showErrorMessage(`Failed: ${e instanceof Error ? e.message : String(e)}`);
                }
            }
            if (msg.type === "createIssue") {
                try {
                    const raw = await client.promoteTaskToIssue(task.projectName, task.line);
                    const data = raw?.data;
                    const issueUrl = typeof data?.issue_url === "string" ? data.issue_url : undefined;
                    vscode.window.showInformationMessage(`GitHub issue created for task "${task.id}".`);
                    if (issueUrl) {
                        await vscode.env.openExternal(vscode.Uri.parse(issueUrl));
                    }
                    onRefresh();
                }
                catch (e) {
                    vscode.window.showErrorMessage(`Failed: ${e instanceof Error ? e.message : String(e)}`);
                }
            }
        },
    });
}
function renderTaskHtml(task) {
    const sectionColor = { Active: "#388a34", Queue: "#7B68AE", Done: "#666" };
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
  ${task.priority ? `<span class="badge" style="background:${task.priority === "high" ? "#c33" : task.priority === "medium" ? "#b8860b" : "#666"}">${esc(task.priority)}</span>` : ""}
  ${task.pinned ? '<span class="badge" style="background:#7B68AE">&#x1F4CC; pinned</span>' : ""}
  ${task.issueUrl ? `<a href="${esc(task.issueUrl)}" style="font-size:12px;color:var(--vscode-textLink-foreground)">#${task.issueNumber ?? "issue"}</a>` : ""}
  <div class="status">${task.checked ? "&#9745; Complete" : "&#9744; Incomplete"}</div>
  <div class="toolbar">
    <button id="btnEdit" class="btn-primary" onclick="startEdit()">Edit</button>
    <button id="btnSave" class="btn-primary hidden" onclick="save()">Save</button>
    <button id="btnCancel" class="btn-secondary hidden" onclick="cancelEdit()">Cancel</button>
    ${task.section !== "Done" ? '<button class="btn-secondary" onclick="complete()">Mark Done</button>' : ""}
    <button class="btn-secondary" onclick="linkIssue()">${task.issueUrl ? "Update Issue Link" : "Link Issue"}</button>
    <button class="btn-secondary" onclick="createIssue()">Create Issue</button>
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
    function linkIssue() {
      vscode.postMessage({ type: "linkIssue" });
    }
    function createIssue() {
      vscode.postMessage({ type: "createIssue" });
    }
  </script>
</body>
</html>`;
}
function esc(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
//# sourceMappingURL=taskViewer.js.map