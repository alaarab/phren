import * as vscode from "vscode";

let panel: vscode.WebviewPanel | undefined;
let currentKey: string | undefined;
let messageDisposable: vscode.Disposable | undefined;

export interface PreviewOptions {
  key: string;
  title: string;
  html: string;
  onMessage?: (msg: Record<string, unknown>) => void;
}

export function showPreview(opts: PreviewOptions): void {
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
  panel = vscode.window.createWebviewPanel(
    "cortex.preview",
    opts.title,
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    { enableScripts: true },
  );

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
