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
exports.showFindingDetail = showFindingDetail;
const vscode = __importStar(require("vscode"));
const previewPanel_1 = require("./previewPanel");
function showFindingDetail(client, finding, onRefresh) {
    (0, previewPanel_1.showPreview)({
        key: `finding:${finding.projectName}:${finding.id}`,
        title: `Finding: ${finding.id}`,
        html: renderFindingHtml(finding),
        onMessage: async (msg) => {
            if (msg.type === "save" && typeof msg.newText === "string") {
                try {
                    const nextText = msg.newText.trim();
                    if (!nextText || nextText === finding.text.trim())
                        return;
                    await client.editFinding(finding.projectName, finding.text, nextText);
                    finding.text = nextText;
                    vscode.window.showInformationMessage(`Finding "${finding.id}" updated.`);
                    onRefresh();
                }
                catch (e) {
                    vscode.window.showErrorMessage(`Failed: ${e instanceof Error ? e.message : String(e)}`);
                }
            }
            if (msg.type === "delete") {
                try {
                    await client.removeFinding(finding.projectName, finding.text);
                    vscode.window.showInformationMessage(`Finding "${finding.id}" removed.`);
                    onRefresh();
                }
                catch (e) {
                    vscode.window.showErrorMessage(`Failed: ${e instanceof Error ? e.message : String(e)}`);
                }
            }
            if (msg.type === "supersede") {
                const replacementText = await vscode.window.showInputBox({
                    prompt: "Enter the replacement finding text",
                    placeHolder: "New finding that supersedes this one",
                });
                if (!replacementText?.trim())
                    return;
                try {
                    await client.supersedeFinding(finding.projectName, finding.text, replacementText.trim());
                    vscode.window.showInformationMessage(`Finding "${finding.id}" superseded.`);
                    onRefresh();
                }
                catch (e) {
                    vscode.window.showErrorMessage(`Failed: ${e instanceof Error ? e.message : String(e)}`);
                }
            }
            if (msg.type === "retract") {
                const reason = await vscode.window.showInputBox({
                    prompt: "Enter reason for retracting this finding",
                    placeHolder: "e.g. no longer accurate, superseded by new approach",
                });
                if (!reason?.trim())
                    return;
                try {
                    await client.retractFinding(finding.projectName, finding.text, reason.trim());
                    vscode.window.showInformationMessage(`Finding "${finding.id}" retracted.`);
                    onRefresh();
                }
                catch (e) {
                    vscode.window.showErrorMessage(`Failed: ${e instanceof Error ? e.message : String(e)}`);
                }
            }
            if (msg.type === "resolveContradiction") {
                const otherText = await vscode.window.showInputBox({
                    prompt: "Enter the contradicting finding text",
                    placeHolder: "The other finding this one contradicts",
                });
                if (!otherText?.trim())
                    return;
                const resolution = await vscode.window.showInputBox({
                    prompt: "Enter resolution",
                    placeHolder: "How to resolve this contradiction",
                });
                if (!resolution?.trim())
                    return;
                try {
                    await client.resolveContradiction(finding.projectName, finding.text, otherText.trim(), resolution.trim());
                    vscode.window.showInformationMessage(`Contradiction resolved.`);
                    onRefresh();
                }
                catch (e) {
                    vscode.window.showErrorMessage(`Failed: ${e instanceof Error ? e.message : String(e)}`);
                }
            }
        },
    });
}
function renderFindingHtml(finding) {
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
  ${finding.type ? `<span class="badge" style="background:#2a7acc">${esc(finding.type)}</span>` : ""}
  ${finding.confidence !== undefined ? `<span class="badge" style="background:${finding.confidence >= 70 ? '#388a34' : '#7B68AE'}">${Math.round(finding.confidence)}% confidence</span>` : ""}
  <span class="date">${esc(finding.date)}</span>
  <div class="toolbar">
    <button id="btnEdit" class="btn-primary" onclick="startEdit()">Edit</button>
    <button id="btnSave" class="btn-primary hidden" onclick="save()">Save</button>
    <button id="btnCancel" class="btn-secondary hidden" onclick="cancelEdit()">Cancel</button>
    <button class="btn-secondary" onclick="supersede()">Supersede</button>
    <button class="btn-secondary" onclick="retract()">Retract</button>
    ${finding.contradicted ? '<button class="btn-secondary" onclick="resolveContradiction()">Resolve Contradiction</button>' : ""}
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
    function supersede() {
      vscode.postMessage({ type: "supersede" });
    }
    function retract() {
      vscode.postMessage({ type: "retract" });
    }
    function resolveContradiction() {
      vscode.postMessage({ type: "resolveContradiction" });
    }
  </script>
</body>
</html>`;
}
function esc(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
//# sourceMappingURL=findingViewer.js.map