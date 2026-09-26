/** Shared settings persistence for agent TUI and REPL. */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { InputMode } from "./repl.js";
import type { PermissionMode } from "./permissions/types.js";

export const SETTINGS_FILE = path.join(os.homedir(), ".phren-agent", "settings.json");

function readSettings(): Record<string, unknown> {
  try {
    const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function writeSettings(data: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2) + "\n");
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
