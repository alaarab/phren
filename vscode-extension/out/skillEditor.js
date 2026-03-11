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
exports.showSkillEditor = showSkillEditor;
const vscode = __importStar(require("vscode"));
const previewPanel_1 = require("./previewPanel");
async function showSkillEditor(client, skillName, skillSource) {
    let skillContent = "";
    let skillEnabled = true;
    try {
        const raw = await client.readSkill(skillName, skillSource === "global" ? undefined : skillSource);
        const data = asRecord(raw);
        const inner = asRecord(data?.data) ?? data;
        skillContent = asString(inner?.content) ?? asString(inner?.body) ?? "";
        skillEnabled = asBoolean(inner?.enabled) ?? true;
    }
    catch (error) {
        skillContent = `(Error loading skill: ${error instanceof Error ? error.message : String(error)})`;
    }
    (0, previewPanel_1.showPreview)({
        key: `skill:${skillSource}:${skillName}`,
        title: `Skill: ${skillName}`,
        html: renderSkillEditorHtml(skillName, skillSource, skillContent, skillEnabled),
        onMessage: async (msg) => {
            if (msg.type === "save" && typeof msg.content === "string") {
                try {
                    await client.writeSkill(skillName, msg.content, skillSource);
                    vscode.window.showInformationMessage(`Skill "${skillName}" saved.`);
                }
                catch (error) {
                    vscode.window.showErrorMessage(`Failed to save skill: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
            if (msg.type === "toggle") {
                try {
                    const project = skillSource === "global" ? undefined : skillSource;
                    if (skillEnabled) {
                        await client.disableSkill(skillName, project);
                        skillEnabled = false;
                    }
                    else {
                        await client.enableSkill(skillName, project);
                        skillEnabled = true;
                    }
                    vscode.window.showInformationMessage(`Skill "${skillName}" ${skillEnabled ? "enabled" : "disabled"}.`);
                }
                catch (error) {
                    vscode.window.showErrorMessage(`Failed to toggle skill: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
        },
    });
}
function renderSkillEditorHtml(name, source, content, enabled) {
    const statusBadge = enabled
        ? `<span class="badge badge-enabled">enabled</span>`
        : `<span class="badge badge-disabled">disabled</span>`;
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: var(--vscode-font-family, sans-serif); padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    h1 { font-size: 18px; margin-bottom: 8px; }
    .meta { margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; }
    .badge-enabled { background: #388a34; color: #fff; }
    .badge-disabled { background: #c33; color: #fff; }
    .badge-source { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
    .content-view { white-space: pre-wrap; font-family: var(--vscode-editor-font-family, monospace); font-size: 13px; line-height: 1.5; border: 1px solid var(--vscode-editorWidget-border, #444); padding: 12px; border-radius: 4px; }
    textarea { width: 100%; min-height: 400px; font-family: var(--vscode-editor-font-family, monospace); font-size: 13px; line-height: 1.5; border: 1px solid var(--vscode-focusBorder, #007acc); padding: 12px; border-radius: 4px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); resize: vertical; box-sizing: border-box; }
    .toolbar { margin-bottom: 12px; display: flex; gap: 8px; }
    button { padding: 4px 12px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px; cursor: pointer; font-size: 13px; }
    .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
    .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .hidden { display: none; }
  </style>
</head>
<body>
  <h1>${escapeHtml(name)}</h1>
  <div class="meta">
    <span class="badge badge-source">${escapeHtml(source)}</span>
    ${statusBadge}
    <button class="btn-secondary" onclick="toggle()">Toggle ${enabled ? "Off" : "On"}</button>
  </div>
  <div class="toolbar">
    <button id="btnEdit" class="btn-primary" onclick="startEdit()">Edit</button>
    <button id="btnSave" class="btn-primary hidden" onclick="save()">Save</button>
    <button id="btnCancel" class="btn-secondary hidden" onclick="cancelEdit()">Cancel</button>
  </div>
  <div id="viewMode" class="content-view">${escapeHtml(content)}</div>
  <textarea id="editMode" class="hidden">${escapeHtml(content)}</textarea>
  <script>
    const vscode = acquireVsCodeApi();
    function startEdit() {
      document.getElementById("viewMode").classList.add("hidden");
      document.getElementById("editMode").classList.remove("hidden");
      document.getElementById("btnEdit").classList.add("hidden");
      document.getElementById("btnSave").classList.remove("hidden");
      document.getElementById("btnCancel").classList.remove("hidden");
    }
    function cancelEdit() {
      document.getElementById("viewMode").classList.remove("hidden");
      document.getElementById("editMode").classList.add("hidden");
      document.getElementById("btnEdit").classList.remove("hidden");
      document.getElementById("btnSave").classList.add("hidden");
      document.getElementById("btnCancel").classList.add("hidden");
    }
    function save() {
      const content = document.getElementById("editMode").value;
      vscode.postMessage({ type: "save", content: content });
      document.getElementById("viewMode").textContent = content;
      cancelEdit();
    }
    function toggle() {
      vscode.postMessage({ type: "toggle" });
    }
  </script>
</body>
</html>`;
}
function escapeHtml(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function asRecord(value) {
    return typeof value === "object" && value !== null ? value : undefined;
}
function asString(value) {
    return typeof value === "string" ? value : undefined;
}
function asBoolean(value) {
    return typeof value === "boolean" ? value : undefined;
}
//# sourceMappingURL=skillEditor.js.map