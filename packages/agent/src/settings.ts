/** Shared settings persistence for agent TUI and REPL. */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { normalizeProviderId, normalizeReasoningEffort, type ReasoningEffort } from "./models.js";
import type { InputMode } from "./repl.js";
import type { PermissionMode } from "./permissions/types.js";

export const SETTINGS_FILE = path.join(os.homedir(), ".phren-agent", "settings.json");

function settingsFile(): string {
  return path.join(os.homedir(), ".phren-agent", "settings.json");
}

function readSettings(): Record<string, unknown> {
  try {
    const data = JSON.parse(fs.readFileSync(settingsFile(), "utf-8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function writeSettings(data: Record<string, unknown>): void {
  try {
    const file = settingsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch { /* best effort */ }
}

function update(key: string, value: unknown): void {
  const data = readSettings();
  data[key] = value;
  writeSettings(data);
}

export function loadInputMode(): InputMode {
  return readSettings().inputMode === "queue" ? "queue" : "steering";
}

export function saveInputMode(mode: InputMode): void {
  update("inputMode", mode);
}

export function savePermissionMode(mode: PermissionMode): void {
  update("permissionMode", mode);
}

export function loadPermissionMode(): PermissionMode | undefined {
  const mode = readSettings().permissionMode;
  if (mode === "suggest" || mode === "auto-confirm" || mode === "plan" || mode === "full-auto") {
    return mode;
  }
  return undefined;
}

/** Projects whose own MCP config (`.mcp.json`) the user chose to load. */
export function isMcpProjectTrusted(projectRoot: string): boolean {
  const list = readSettings().trustedMcpProjects;
  return Array.isArray(list) && list.includes(path.resolve(projectRoot));
}

export function trustMcpProject(projectRoot: string): void {
  const data = readSettings();
  const list = Array.isArray(data.trustedMcpProjects) ? data.trustedMcpProjects.filter((p): p is string => typeof p === "string") : [];
  const root = path.resolve(projectRoot);
  if (!list.includes(root)) list.push(root);
  data.trustedMcpProjects = list;
  writeSettings(data);
}

export function loadTheme(): string | undefined {
  const name = readSettings().theme;
  return typeof name === "string" && name ? name : undefined;
}

export function saveTheme(name: string): void {
  update("theme", name);
}

export function loadInputHistory(): string[] {
  const history = readSettings().inputHistory;
  return Array.isArray(history)
    ? history.filter((line): line is string => typeof line === "string").slice(-500)
    : [];
}

export function saveInputHistory(lines: string[]): void {
  update("inputHistory", lines.slice(-500));
}

export interface ModelSelection {
  provider: string;
  model?: string;
  reasoning?: string;
}

/** The last explicit picker/CLI selection for each project working tree. */
export function loadModelSelection(projectRoot = process.cwd()): ModelSelection | undefined {
  const selections = readSettings().modelSelections;
  if (!selections || typeof selections !== "object" || Array.isArray(selections)) return undefined;
  const value = (selections as Record<string, unknown>)[modelProjectRoot(projectRoot)];
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.provider !== "string" || !row.provider) return undefined;
  return {
    provider: row.provider,
    ...(typeof row.model === "string" && row.model ? { model: row.model } : {}),
    ...(typeof row.reasoning === "string" && row.reasoning ? { reasoning: row.reasoning } : {}),
  };
}

export function saveModelSelection(selection: ModelSelection, projectRoot = process.cwd()): void {
  const data = readSettings();
  const existing = data.modelSelections && typeof data.modelSelections === "object" && !Array.isArray(data.modelSelections)
    ? data.modelSelections as Record<string, unknown>
    : {};
  existing[modelProjectRoot(projectRoot)] = {
    provider: selection.provider,
    ...(selection.model ? { model: selection.model } : {}),
    ...(selection.reasoning ? { reasoning: selection.reasoning } : {}),
  };
  data.modelSelections = existing;
  writeSettings(data);
}

/** Subdirectories share the checkout's choice; linked worktrees stay independent. */
function modelProjectRoot(cwd: string): string {
  const start = path.resolve(cwd);
  let current = start;
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

export function restoreModelSelection(
  explicit: { provider?: string; model?: string; reasoning?: ReasoningEffort },
  saved: ModelSelection | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { provider?: string; model?: string; reasoning?: ReasoningEffort } {
  let provider = explicit.provider ?? env.PHREN_AGENT_PROVIDER;
  let model = explicit.model ?? env.PHREN_AGENT_MODEL;
  // Only the two historic qualified prefixes are unambiguous; Router IDs
  // contain slashes too, so they stay under the explicitly selected provider.
  const qualified = /^(openai-codex|openai)\/(.+)$/.exec(model ?? "");
  if (!provider && qualified) { provider = qualified[1]; model = qualified[2]; }
  const sameProvider = !provider || normalizeProviderId(provider) === normalizeProviderId(saved?.provider);
  const sameModel = !model || model === saved?.model;
  return {
    provider: provider ?? (model ? undefined : saved?.provider),
    model: model ?? (sameProvider ? saved?.model : undefined),
    reasoning: explicit.reasoning ?? normalizeReasoningEffort(env.PHREN_AGENT_REASONING)
      ?? (sameProvider && sameModel ? normalizeReasoningEffort(saved?.reasoning) : undefined),
  };
}
