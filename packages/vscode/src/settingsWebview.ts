/**
 * Phren settings webview — a full configuration dashboard for the VS Code
 * extension.
 *
 * It renders every config domain from the shared schema that `get_config`
 * returns (so labels, options, help, and defaults never drift from the CLI or
 * Web UI), shows each field's resolved value with a 3-level source chip
 * (default / global / project), and writes changes back through `set_config`.
 */

import * as vscode from "vscode";
import * as crypto from "crypto";
import { PhrenClient } from "./phrenClient";

// ── Shapes mirrored from the MCP get_config response ──────────────────────────

interface SchemaOption {
  value: string;
  label: string;
  blurb: string;
  recommended?: boolean;
}

interface SchemaField {
  key: string;
  domain: string;
  label: string;
  summary: string;
  help: string;
  control: "enum" | "number" | "boolean" | "string-list" | "object";
  options?: SchemaOption[];
  range?: { min: number; max: number; step: number };
  default: unknown;
  scope: "global+project" | "global-only" | "project-only";
  impact: string;
  risk: "safe" | "caution";
}

interface SchemaDomain {
  id: string;
  label: string;
  icon: string;
  summary: string;
  scope: string;
  fields: SchemaField[];
}

interface ResolvedField {
  key: string;
  value: unknown;
  source: "default" | "global" | "project";
  inheritedValue: unknown;
  sourcePath?: string;
}

interface ConfigSnapshot {
  schema: SchemaDomain[];
  fields: Record<string, ResolvedField>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null) return "unset";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "none";
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
}

/** Map a dotted field key + new value to a `set_config` domain + settings payload. */
function toSetConfig(key: string, value: unknown): { domain: string; settings: Record<string, unknown> } | null {
  if (key === "proactivity.base") return { domain: "proactivity", settings: { level: value, scope: "base" } };
  if (key === "proactivity.findings") return { domain: "proactivity", settings: { level: value, scope: "findings" } };
  if (key === "proactivity.tasks") return { domain: "proactivity", settings: { level: value, scope: "tasks" } };
  if (key === "taskMode") return { domain: "taskMode", settings: { mode: value } };
  if (key === "findingSensitivity") return { domain: "findingSensitivity", settings: { level: value } };
  if (key.startsWith("retention.decay.")) {
    return { domain: "retention", settings: { decay: { [key.slice("retention.decay.".length)]: value } } };
  }
  if (key.startsWith("retention.")) {
    return { domain: "retention", settings: { [key.slice("retention.".length)]: value } };
  }
  if (key === "workflow.lowConfidenceThreshold") return { domain: "workflow", settings: { lowConfidenceThreshold: value } };
  if (key === "workflow.riskySections") return { domain: "workflow", settings: { riskySections: value } };
  if (key.startsWith("index.")) return { domain: "index", settings: { [key.slice("index.".length)]: value } };
  return null; // access / topic — not writable through set_config
}

/** Whether a field can be edited at the current scope. */
function isEditable(field: SchemaField, isProject: boolean): boolean {
  if (field.domain === "access" || field.domain === "topic") return false;
  if (field.scope === "global-only") return !isProject;
  if (field.scope === "project-only") return isProject;
  return true;
}

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadSnapshot(client: PhrenClient, project?: string): Promise<ConfigSnapshot> {
  const raw = await client.getConfig("all", project);
  const data = asRecord(asRecord(raw)?.data);
  const schema = asArray(data?.schema) as SchemaDomain[];
  const fields = (asRecord(data?.fields) as Record<string, ResolvedField>) ?? {};
  return { schema, fields };
}

async function loadProjectNames(client: PhrenClient): Promise<string[]> {
  try {
    const raw = await client.listProjects();
    const data = asRecord(asRecord(raw)?.data);
    const names: string[] = [];
    for (const entry of asArray(data?.projects)) {
      const name = asRecord(entry)?.name;
      if (typeof name === "string") names.push(name);
    }
    return names.sort();
  } catch {
    return [];
  }
}

// ── HTML rendering ────────────────────────────────────────────────────────────

function sourceChip(field: SchemaField, resolved: ResolvedField | undefined): string {
  const source = resolved?.source ?? "default";
  const titleParts: string[] = [];
  if (source === "default") titleParts.push("Using the built-in default.");
  else if (source === "global") titleParts.push("Set in global config (~/.phren/.config).");
  else titleParts.push("Overridden for this project (phren.project.yaml).");
  if (source !== "default" && resolved) {
    titleParts.push(`Without this: ${formatValue(resolved.inheritedValue)}.`);
  }
  if (resolved?.sourcePath) titleParts.push(resolved.sourcePath);
  return `<span class="chip chip-${esc(source)}" title="${esc(titleParts.join(" "))}">${esc(source)}</span>`;
}

function renderControl(field: SchemaField, resolved: ResolvedField | undefined, editable: boolean): string {
  const value = resolved ? resolved.value : field.default;
  if (!editable) {
    return `<div class="value readonly">${esc(formatValue(value))}</div>`;
  }
  const dataKey = `data-key="${esc(field.key)}"`;

  if (field.control === "enum" && field.options) {
    const buttons = field.options.map((opt) => {
      const active = String(value) === opt.value ? " active" : "";
      const star = opt.recommended ? " ★" : "";
      return `<button class="opt${active}" ${dataKey} data-value="${esc(opt.value)}" `
        + `title="${esc(opt.blurb)}">${esc(opt.label)}${star}</button>`;
    }).join("");
    return `<div class="opts">${buttons}</div>`;
  }

  if (field.control === "boolean") {
    const on = value === true;
    return `<button class="toggle${on ? " active" : ""}" ${dataKey} data-value="${on ? "false" : "true"}">`
      + `${on ? "On" : "Off"}</button>`;
  }

  if (field.control === "number") {
    const r = field.range;
    const attrs = r ? `min="${r.min}" max="${r.max}" step="${r.step}"` : "";
    return `<div class="numrow">`
      + `<input type="number" id="in-${esc(field.key)}" value="${esc(String(value ?? ""))}" ${attrs} />`
      + `<button class="set" ${dataKey} data-kind="number">Set</button></div>`;
  }

  // string-list — comma separated
  const listValue = Array.isArray(value) ? value.join(", ") : "";
  return `<div class="numrow">`
    + `<input type="text" id="in-${esc(field.key)}" value="${esc(listValue)}" placeholder="comma,separated" />`
    + `<button class="set" ${dataKey} data-kind="list">Set</button></div>`;
}

function renderField(field: SchemaField, resolved: ResolvedField | undefined, isProject: boolean): string {
  const editable = isEditable(field, isProject);
  const cautionBadge = field.risk === "caution" ? `<span class="caution" title="Changing this has notable side effects.">caution</span>` : "";
  const scopeNote = !editable && field.domain !== "access" && field.domain !== "topic"
    ? `<div class="note">${field.scope === "global-only"
      ? "Global-only — switch to Global scope to edit."
      : "Project-only — select a project to edit."}</div>`
    : "";
  const accessNote = field.domain === "access"
    ? `<div class="note">Edit access roles with <code>phren config access</code>.</div>`
    : "";
  return `<div class="field">
    <div class="field-head">
      <span class="field-label">${esc(field.label)}</span>
      ${cautionBadge}
      ${sourceChip(field, resolved)}
    </div>
    <div class="field-summary">${esc(field.summary)}</div>
    ${renderControl(field, resolved, editable)}
    ${scopeNote}${accessNote}
    <details class="help"><summary>What this does</summary>
      <div class="help-body">${esc(field.help)}</div>
      <div class="help-impact"><strong>Impact:</strong> ${esc(field.impact)}</div>
    </details>
  </div>`;
}

function renderDomain(domain: SchemaDomain, fields: Record<string, ResolvedField>, isProject: boolean): string {
  const rows = domain.fields.map((f) => renderField(f, fields[f.key], isProject)).join("");
  return `<section class="domain">
    <div class="domain-head">
      <span class="domain-label">${esc(domain.label)}</span>
      <span class="domain-summary">${esc(domain.summary)}</span>
    </div>
    ${rows}
  </section>`;
}

function renderHtml(
  snapshot: ConfigSnapshot,
  scope: string | undefined,
  projects: string[],
  nonce: string,
): string {
  const isProject = Boolean(scope);
  const scopeOptions = [
    `<option value=""${scope ? "" : " selected"}>Global (all projects)</option>`,
    ...projects.map((p) => `<option value="${esc(p)}"${p === scope ? " selected" : ""}>${esc(p)}</option>`),
  ].join("");

  const domainsHtml = snapshot.schema.length
    ? snapshot.schema.map((d) => renderDomain(d, snapshot.fields, isProject)).join("")
    : `<p class="empty">Could not load the config schema. Is the Phren MCP server running?</p>`;

  const scopeLine = isProject
    ? `Editing <strong>${esc(scope)}</strong> — changes write to <code>phren.project.yaml</code>.`
    : `Editing <strong>global</strong> config — applies to every project unless overridden.`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
    background: var(--vscode-editor-background); padding: 0 20px 40px; }
  h1 { font-size: 1.3em; margin: 18px 0 4px; }
  .scope-bar { display: flex; align-items: center; gap: 10px; margin: 14px 0 6px;
    flex-wrap: wrap; }
  .scope-bar select { background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border);
    padding: 4px 8px; border-radius: 4px; }
  .scope-note { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
  .domain { border: 1px solid var(--vscode-panel-border); border-radius: 6px;
    margin: 16px 0; overflow: hidden; }
  .domain-head { padding: 10px 14px; background: var(--vscode-sideBar-background);
    border-bottom: 1px solid var(--vscode-panel-border); }
  .domain-label { font-weight: 600; }
  .domain-summary { color: var(--vscode-descriptionForeground); margin-left: 8px; font-size: 0.9em; }
  .field { padding: 12px 14px; border-bottom: 1px solid var(--vscode-panel-border); }
  .field:last-child { border-bottom: none; }
  .field-head { display: flex; align-items: center; gap: 8px; }
  .field-label { font-weight: 600; }
  .field-summary { color: var(--vscode-descriptionForeground); font-size: 0.9em;
    margin: 2px 0 8px; }
  .chip { font-size: 0.72em; padding: 1px 7px; border-radius: 9px; text-transform: uppercase;
    letter-spacing: 0.04em; }
  .chip-default { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .chip-global { background: var(--vscode-statusBarItem-prominentBackground, #3a3d8a);
    color: var(--vscode-statusBar-foreground, #fff); }
  .chip-project { background: var(--vscode-statusBarItem-warningBackground, #8a5a1a);
    color: var(--vscode-statusBar-foreground, #fff); }
  .caution { font-size: 0.72em; padding: 1px 7px; border-radius: 9px;
    background: var(--vscode-inputValidation-warningBackground, #6b4a00);
    color: var(--vscode-foreground); }
  .opts { display: flex; flex-wrap: wrap; gap: 6px; }
  .opt, .toggle, .set { background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground); border: 1px solid var(--vscode-panel-border);
    padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 0.9em; }
  .opt.active, .toggle.active { background: var(--vscode-button-background);
    color: var(--vscode-button-foreground); border-color: var(--vscode-button-background); }
  .opt:hover, .toggle:hover, .set:hover { filter: brightness(1.15); }
  .numrow { display: flex; gap: 6px; align-items: center; }
  .numrow input { background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    padding: 4px 8px; border-radius: 4px; min-width: 120px; }
  .value.readonly { color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); }
  .note { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-top: 6px; font-style: italic; }
  .help { margin-top: 8px; }
  .help summary { cursor: pointer; color: var(--vscode-textLink-foreground); font-size: 0.85em; }
  .help-body, .help-impact { color: var(--vscode-descriptionForeground); font-size: 0.85em;
    margin-top: 6px; }
  code { background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; }
  .empty { color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
  <h1>Phren Settings</h1>
  <div class="scope-bar">
    <label for="scope">Scope:</label>
    <select id="scope">${scopeOptions}</select>
    <button class="set" id="refresh">Refresh</button>
  </div>
  <div class="scope-note">${scopeLine}</div>
  ${domainsHtml}
  <script nonce="${nonce}">
    const vscodeApi = acquireVsCodeApi();
    document.getElementById('scope').addEventListener('change', function (e) {
      vscodeApi.postMessage({ command: 'changeScope', scope: e.target.value });
    });
    document.getElementById('refresh').addEventListener('click', function () {
      vscodeApi.postMessage({ command: 'refresh' });
    });
    document.body.addEventListener('click', function (e) {
      const el = e.target.closest('[data-key]');
      if (!el) return;
      const key = el.getAttribute('data-key');
      if (el.classList.contains('opt') || el.classList.contains('toggle')) {
        let value = el.getAttribute('data-value');
        if (value === 'true') value = true;
        else if (value === 'false') value = false;
        vscodeApi.postMessage({ command: 'setField', key: key, value: value });
        return;
      }
      if (el.classList.contains('set')) {
        const input = document.getElementById('in-' + key);
        if (!input) return;
        const kind = el.getAttribute('data-kind');
        let value;
        if (kind === 'number') {
          value = Number(input.value);
          if (!isFinite(value)) return;
        } else if (kind === 'list') {
          value = input.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        } else {
          value = input.value;
        }
        vscodeApi.postMessage({ command: 'setField', key: key, value: value });
      }
    });
  </script>
</body>
</html>`;
}

// ── Entry point ───────────────────────────────────────────────────────────────

/**
 * Open the Phren settings dashboard. `initialProject`, when given, opens the
 * panel scoped to that project.
 */
export async function showSettingsWebview(
  client: PhrenClient,
  context: vscode.ExtensionContext,
  initialProject?: string,
): Promise<void> {
  const panel = vscode.window.createWebviewPanel(
    "phren.settings",
    "Phren Settings",
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );

  let scope: string | undefined = initialProject;

  async function render(): Promise<void> {
    const nonce = crypto.randomBytes(16).toString("base64");
    try {
      const [snapshot, projects] = await Promise.all([
        loadSnapshot(client, scope),
        loadProjectNames(client),
      ]);
      if (scope && !projects.includes(scope)) scope = undefined;
      panel.webview.html = renderHtml(snapshot, scope, projects, nonce);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      panel.webview.html = `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:20px">`
        + `<h2>Phren Settings</h2><p>Failed to load configuration:</p>`
        + `<pre>${esc(message)}</pre></body></html>`;
    }
  }

  await render();

  panel.webview.onDidReceiveMessage(async (raw: unknown) => {
    const msg = asRecord(raw);
    if (!msg) return;
    const command = msg.command;

    if (command === "changeScope") {
      scope = typeof msg.scope === "string" && msg.scope ? msg.scope : undefined;
      await render();
      return;
    }

    if (command === "refresh") {
      await render();
      return;
    }

    if (command === "setField" && typeof msg.key === "string") {
      const mapped = toSetConfig(msg.key, msg.value);
      if (!mapped) {
        await vscode.window.showWarningMessage(`Phren: "${msg.key}" cannot be edited here.`);
        return;
      }
      try {
        const result = await client.setConfig(mapped.domain, mapped.settings, scope);
        const data = asRecord(asRecord(result)?.data);
        const warning = typeof data?.warning === "string" ? data.warning : undefined;
        if (warning) void vscode.window.showWarningMessage(`Phren: ${warning}`);
        await render();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await vscode.window.showErrorMessage(`Phren: failed to update ${msg.key}: ${message}`);
      }
    }
  }, undefined, context.subscriptions);
}
