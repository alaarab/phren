// Keyboard shortcuts for Phren desktop, configured the way Herdr is.
//
// Layers, later wins:
//   1. Built-in defaults: Herdr's own defaults for the actions that have a
//      desktop meaning, plus a few desktop-only actions.
//   2. ~/.config/herdr/config.toml [keys]: the owner's Herdr bindings, so the
//      same muscle memory works in the desktop's sidebar.
//   3. ~/.config/phren/desktop.toml [keys]: desktop overrides, same syntax.
// A value is one binding string or an array of them; "" unbinds the action.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parse } from "smol-toml";

export interface KeyAction { action: string; group: string; label: string; herdr: boolean; app?: boolean }

/** Every action the desktop understands, in the order the shortcut sheet shows them. */
export const ACTIONS: KeyAction[] = [
  { action: "help", group: "General", label: "Show these shortcuts", herdr: true },
  { action: "reload_config", group: "General", label: "Reload key settings", herdr: true },
  { action: "goto", group: "Sessions", label: "Go to a session", herdr: true },
  { action: "workspace_picker", group: "Sessions", label: "Walk the sidebar (↑ ↓ j k, Enter opens, Esc leaves)", herdr: true },
  { action: "next_tab", group: "Sessions", label: "Next session", herdr: true },
  { action: "previous_tab", group: "Sessions", label: "Previous session", herdr: true },
  { action: "switch_tab", group: "Sessions", label: "Open session 1 to 9", herdr: true },
  { action: "next_agent", group: "Sessions", label: "Next session that needs you", herdr: true },
  { action: "rename_tab", group: "Sessions", label: "Rename this session", herdr: true },
  { action: "toggle_sidebar", group: "Layout", label: "Show or hide the sidebar", herdr: true },
  { action: "focus_pane_left", group: "Layout", label: "Focus the column to the left", herdr: true },
  { action: "focus_pane_right", group: "Layout", label: "Focus the column to the right", herdr: true },
  { action: "cycle_pane_next", group: "Layout", label: "Focus the next column", herdr: true },
  { action: "zoom", group: "Layout", label: "Let the panel cover the chat", herdr: true },
  { action: "close_pane", group: "Layout", label: "Close the panel", herdr: true },
  { action: "new_tab", group: "Panel", label: "Open the session's terminal", herdr: true },
  { action: "show_changes", group: "Panel", label: "Open Changes", herdr: false },
  { action: "show_files", group: "Panel", label: "Open Files", herdr: false },
  { action: "show_search", group: "Panel", label: "Open Search", herdr: false },
  { action: "palette", group: "Direct", label: "Open the command palette", herdr: false, app: true },
  { action: "open_file", group: "Direct", label: "Quick open a file", herdr: false, app: true },
  { action: "terminal", group: "Direct", label: "Show the terminal pane", herdr: false, app: true },
  { action: "sidebar", group: "Direct", label: "Show or hide the sidebar", herdr: false, app: true },
  { action: "next_needs_you", group: "Direct", label: "Go to the next session that needs you", herdr: false, app: true },
  { action: "close_tab", group: "Direct", label: "Close the current panel", herdr: false, app: true },
];
for (let n = 1; n <= 9; n++) {
  ACTIONS.push({ action: `session_${n}`, group: "Direct", label: `Open session ${n}`, herdr: false, app: true });
}

/** Herdr's own defaults (herdr --default-config, 0.9.x) for the shared actions,
 * and Phren's for the desktop-only ones. */
export const DEFAULTS: Record<string, string[]> = {
  prefix: ["ctrl+b"],
  help: ["prefix+?"], reload_config: ["prefix+shift+r"],
  goto: ["prefix+g"], workspace_picker: ["prefix+w"],
  next_tab: ["prefix+n"], previous_tab: ["prefix+p"], switch_tab: ["prefix+1..9"],
  next_agent: ["prefix+a"], rename_tab: ["prefix+shift+t"],
  toggle_sidebar: ["prefix+b"], focus_pane_left: ["prefix+h"], focus_pane_right: ["prefix+l"],
  cycle_pane_next: ["prefix+tab"], zoom: ["prefix+z"], close_pane: ["prefix+x"],
  new_tab: ["prefix+c"], show_changes: ["prefix+d"], show_files: ["prefix+f"], show_search: ["prefix+/"],
};

/** Direct (prefix-free) bindings under [keys.app]. "cmd" is Command on macOS and
 * Control elsewhere; the UI resolves that when it matches presses. */
export const DEFAULTS_APP: Record<string, string[]> = {
  palette: ["cmd+k"], open_file: ["cmd+p"],
  terminal: ["cmd+j"], sidebar: ["cmd+b"],
  next_needs_you: ["cmd+shift+a"], close_tab: ["cmd+w"],
};
for (let n = 1; n <= 9; n++) DEFAULTS_APP[`session_${n}`] = [`cmd+${n}`];

export interface KeyConfig {
  bindings: Record<string, string[]>;
  /** Direct (no prefix) bindings from [keys.app]. */
  appBindings: Record<string, string[]>;
  /** Which file set each action, for the shortcut sheet ("default" otherwise). */
  sources: Record<string, string>;
  appSources: Record<string, string>;
  files: { herdr: string; desktop: string };
  errors: string[];
}

export const herdrConfigPath = (): string =>
  process.env.HERDR_CONFIG ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"), "herdr", "config.toml");
export const desktopConfigPath = (): string =>
  process.env.PHREN_DESKTOP_CONFIG ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"), "phren", "desktop.toml");

const KEY = /^[a-z0-9+?/.,;:'"`\-=\[\]\\_&*()!@#$%^~<>|{}]+$/i;

const KNOWN_KEYS = new Set(["prefix", ...ACTIONS.filter(a => !a.app).map(a => a.action)]);
const KNOWN_APP = new Set(ACTIONS.filter(a => a.app).map(a => a.action));

/** Normalise one table ("[keys]" or "[keys.app]") into action → bindings, skipping unknown actions. */
function normaliseKeys(keys: Record<string, unknown>, known: Set<string>, label: string, file: string, errors: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [action, value] of Object.entries(keys)) {
    if (!known.has(action)) continue; // Herdr-only actions (split_vertical, …) and custom commands
    const list = typeof value === "string" ? [value] : Array.isArray(value) ? value : undefined;
    if (!list || !list.every(v => typeof v === "string")) { errors.push(`${file}: ${label}.${action} must be a string or a list of strings.`); continue; }
    const bindings = (list as string[]).map(v => v.trim().toLowerCase()).filter(Boolean);
    const bad = bindings.find(b => !KEY.test(b));
    if (bad) { errors.push(`${file}: ${label}.${action} has an unreadable key "${bad}".`); continue; }
    out[action] = bindings; // [] (from "") unbinds
  }
  return out;
}

/** Both key tables of one config file: [keys] and the direct [keys.app]. */
export function tablesFromToml(text: string, file: string, errors: string[]): { bindings: Record<string, string[]>; appBindings: Record<string, string[]> } {
  let doc: Record<string, unknown>;
  try { doc = parse(text) as Record<string, unknown>; }
  catch (error) { errors.push(`${file}: ${(error as Error).message.split("\n")[0]}`); return { bindings: {}, appBindings: {} }; }
  const keys = doc.keys;
  if (!keys || typeof keys !== "object") return { bindings: {}, appBindings: {} };
  const { app, ...rest } = keys as Record<string, unknown>;
  const bindings = normaliseKeys(rest, KNOWN_KEYS, "keys", file, errors);
  const appBindings = app && typeof app === "object"
    ? normaliseKeys(app as Record<string, unknown>, KNOWN_APP, "keys.app", file, errors)
    : {};
  return { bindings, appBindings };
}

/** Normalise one file's [keys] table into action → bindings. */
export function keysFromToml(text: string, file: string, errors: string[]): Record<string, string[]> {
  return tablesFromToml(text, file, errors).bindings;
}

async function readText(file: string): Promise<string | undefined> {
  try { return await readFile(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/** Defaults, then Herdr's config, then the desktop's own. */
export async function loadKeyConfig(): Promise<KeyConfig> {
  const files = { herdr: herdrConfigPath(), desktop: desktopConfigPath() };
  const errors: string[] = [];
  const bindings: Record<string, string[]> = structuredClone(DEFAULTS);
  const appBindings: Record<string, string[]> = structuredClone(DEFAULTS_APP);
  const sources: Record<string, string> = Object.fromEntries(Object.keys(DEFAULTS).map(k => [k, "default"]));
  const appSources: Record<string, string> = Object.fromEntries(Object.keys(DEFAULTS_APP).map(k => [k, "default"]));
  for (const [source, file] of [["herdr", files.herdr], ["desktop", files.desktop]] as const) {
    const text = await readText(file).catch(error => { errors.push(`${file}: ${(error as Error).message}`); return undefined; });
    if (text === undefined) continue;
    const tables = tablesFromToml(text, file, errors);
    for (const [action, list] of Object.entries(tables.bindings)) {
      bindings[action] = list;
      sources[action] = source;
    }
    for (const [action, list] of Object.entries(tables.appBindings)) {
      appBindings[action] = list;
      appSources[action] = source;
    }
  }
  if (!bindings.prefix?.length) bindings.prefix = DEFAULTS.prefix;
  return { bindings, appBindings, sources, appSources, files, errors };
}
