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
exports.showProjectFile = showProjectFile;
const vscode = __importStar(require("vscode"));
async function showProjectFile(client, projectName, fileName) {
    const panel = vscode.window.createWebviewPanel("cortex.projectFile", `${projectName}/${fileName}`, vscode.ViewColumn.Beside, {});
    try {
        const raw = await client.getMemoryDetail(`mem:${projectName}/${fileName}`);
        const data = asRecord(raw);
        const content = asString(asRecord(data?.data)?.content) ?? asString(data?.content) ?? "(no content)";
        panel.webview.html = renderFileHtml(projectName, fileName, content);
    }
    catch (error) {
        panel.webview.html = renderFileHtml(projectName, fileName, `Error: ${error instanceof Error ? error.message : String(error)}`);
    }
}
function renderFileHtml(project, file, content) {
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
function escapeHtml(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function asRecord(value) {
    return typeof value === "object" && value !== null ? value : undefined;
}
function asString(value) {
    return typeof value === "string" ? value : undefined;
}
//# sourceMappingURL=projectFileViewer.js.map