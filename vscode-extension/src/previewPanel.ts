import * as vscode from "vscode";

let panel: vscode.WebviewPanel | undefined;
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
    panel.title = opts.title;
    panel.webview.html = opts.html;
    if (opts.onMessage) {
      messageDisposable = panel.webview.onDidReceiveMessage(opts.onMessage);
    }
    panel.reveal(vscode.ViewColumn.One, true);
    return;
  }

  panel = vscode.window.createWebviewPanel(
    "phren.preview",
    opts.title,
    { viewColumn: vscode.ViewColumn.One, preserveFocus: true },
    { enableScripts: true },
  );

  panel.onDidDispose(() => {
    panel = undefined;
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

export function closePreview(): void {
  if (panel) {
    panel.dispose();
  }
}
