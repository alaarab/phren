import * as vscode from "vscode";
import * as os from "os";
import { PhrenClient } from "./phrenClient";

/* ── Main entry ──────────────────────────────────────────── */

export function showSetupWizard(
  client: PhrenClient,
  context: vscode.ExtensionContext,
  initialData: { hostname: string },
): void {
  const panel = vscode.window.createWebviewPanel(
    "phren.setupWizard",
    "Phren Setup",
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: false },
  );

  panel.webview.html = renderWizardHtml(panel.webview, initialData);

  panel.webview.onDidReceiveMessage(async (msg: unknown) => {
    const message = asRecord(msg);
    if (!message) return;
    const command = asString(message.command);

    if (command === "apply") {
      const sensitivity = asString(message.sensitivity);
      const taskMode = asString(message.taskMode);
      const proactivity = asString(message.proactivity);

      try {
        if (sensitivity) await client.setFindingSensitivity(sensitivity);
        if (taskMode) await client.setTaskMode(taskMode);
        if (proactivity) await client.setProactivity(proactivity);

        vscode.window.showInformationMessage("Phren settings applied successfully.");
        panel.dispose();
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to apply settings: ${toErrorMessage(err)}`);
      }
    }
  });
}

/* ── HTML renderer ───────────────────────────────────────── */

function renderWizardHtml(webview: vscode.Webview, data: { hostname: string }): string {
  const nonce = getNonce();
  const hostname = escapeHtml(data.hostname || os.hostname());

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Phren Setup</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      margin: 0;
      padding: 24px;
      line-height: 1.5;
    }
    h1 {
      font-size: 20px;
      font-weight: 600;
      margin: 0 0 24px;
    }
    h2 {
      font-size: 14px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--vscode-descriptionForeground);
      margin: 24px 0 12px;
      padding-bottom: 6px;
      border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-input-border));
    }
    .form-group {
      margin-bottom: 16px;
    }
    label {
      display: block;
      font-size: 13px;
      font-weight: 500;
      margin-bottom: 6px;
    }
    input[type="text"] {
      width: 100%;
      max-width: 400px;
      padding: 6px 10px;
      font-size: 13px;
      font-family: var(--vscode-font-family);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      outline: none;
    }
    input[type="text"]:focus {
      border-color: var(--vscode-focusBorder);
    }
    input[type="text"]::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }
    .radio-group {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-top: 4px;
    }
    .radio-group label {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-weight: 400;
      cursor: pointer;
      margin-bottom: 0;
    }
    input[type="radio"] {
      accent-color: var(--vscode-button-background);
    }
    .description {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 6px;
    }
    .actions {
      margin-top: 32px;
    }
    button {
      padding: 8px 20px;
      font-size: 13px;
      font-family: var(--vscode-font-family);
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
    }
    button:hover {
      background: var(--vscode-button-hoverBackground);
    }
  </style>
</head>
<body>
  <h1>Phren Setup</h1>

  <h2>Identity</h2>
  <div class="form-group">
    <label for="machine-name">Machine name</label>
    <input type="text" id="machine-name" value="${hostname}">
  </div>
  <div class="form-group">
    <label for="profile-name">Profile name</label>
    <input type="text" id="profile-name" value="personal">
  </div>

  <h2>Capture Behavior</h2>
  <div class="form-group">
    <label>Finding sensitivity</label>
    <p class="description">Controls how aggressively phren captures findings from conversations.</p>
    <div class="radio-group">
      <label><input type="radio" name="sensitivity" value="minimal"> Minimal</label>
      <label><input type="radio" name="sensitivity" value="conservative"> Conservative</label>
      <label><input type="radio" name="sensitivity" value="balanced" checked> Balanced</label>
      <label><input type="radio" name="sensitivity" value="aggressive"> Aggressive</label>
    </div>
  </div>
  <div class="form-group">
    <label>Task mode</label>
    <p class="description">Controls how phren manages tasks.</p>
    <div class="radio-group">
      <label><input type="radio" name="taskMode" value="off"> Off</label>
      <label><input type="radio" name="taskMode" value="manual"> Manual</label>
      <label><input type="radio" name="taskMode" value="suggest"> Suggest</label>
      <label><input type="radio" name="taskMode" value="auto" checked> Auto</label>
    </div>
  </div>
  <div class="form-group">
    <label>Proactivity</label>
    <p class="description">Controls how proactive the agent is in surfacing information.</p>
    <div class="radio-group">
      <label><input type="radio" name="proactivity" value="high" checked> High</label>
      <label><input type="radio" name="proactivity" value="medium"> Medium</label>
      <label><input type="radio" name="proactivity" value="low"> Low</label>
    </div>
  </div>

  <h2>Sync</h2>
  <div class="form-group">
    <label for="clone-url">Clone URL</label>
    <p class="description">Optional. A git remote to sync your phren store across machines.</p>
    <input type="text" id="clone-url" placeholder="https://github.com/user/phren-store.git">
  </div>

  <div class="actions">
    <button id="btn-apply">Apply</button>
  </div>

  <script nonce="${nonce}">
    (function() {
      var vscode = acquireVsCodeApi();

      function getRadioValue(name) {
        var checked = document.querySelector('input[name="' + name + '"]:checked');
        return checked ? checked.value : '';
      }

      document.getElementById('btn-apply').addEventListener('click', function() {
        vscode.postMessage({
          command: 'apply',
          machineName: document.getElementById('machine-name').value.trim(),
          profileName: document.getElementById('profile-name').value.trim(),
          sensitivity: getRadioValue('sensitivity'),
          taskMode: getRadioValue('taskMode'),
          proactivity: getRadioValue('proactivity'),
          cloneUrl: document.getElementById('clone-url').value.trim()
        });
      });
    })();
  </script>
</body>
</html>`;
}

/* ── Helpers ──────────────────────────────────────────────── */

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
