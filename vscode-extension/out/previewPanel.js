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
exports.showPreview = showPreview;
const vscode = __importStar(require("vscode"));
let panel;
let currentKey;
let messageDisposable;
function showPreview(opts) {
    // Dispose previous message handler
    if (messageDisposable) {
        messageDisposable.dispose();
        messageDisposable = undefined;
    }
    if (panel) {
        currentKey = opts.key;
        panel.title = opts.title;
        panel.webview.html = opts.html;
        if (opts.onMessage) {
            messageDisposable = panel.webview.onDidReceiveMessage(opts.onMessage);
        }
        panel.reveal(vscode.ViewColumn.Beside, true);
        return;
    }
    currentKey = opts.key;
    panel = vscode.window.createWebviewPanel("cortex.preview", opts.title, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true });
    panel.onDidDispose(() => {
        panel = undefined;
        currentKey = undefined;
        if (messageDisposable) {
            messageDisposable.dispose();
            messageDisposable = undefined;
        }
    });
    panel.webview.html = opts.html;
    if (opts.onMessage) {
        messageDisposable = panel.webview.onDidReceiveMessage(opts.onMessage);
    }
}
//# sourceMappingURL=previewPanel.js.map