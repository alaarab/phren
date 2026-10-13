// The summon hotkey: a system-wide shortcut that brings Phren to the front with
// ⌘K open, from any app. The Electron shell registers it (globalShortcut); this
// module keeps the choice in localStorage, turns a keydown into an Electron
// accelerator and opens the palette when the shell says the key was pressed.
import { isPaletteOpen, openPalette } from "./palette.js";

const KEY = "phren.desktop.summon";
export const DEFAULT_SUMMON = "CommandOrControl+Shift+Space";

const NAMED = { Space: "Space", Enter: "Enter", Tab: "Tab", Backspace: "Backspace", Delete: "Delete", Home: "Home", End: "End",
  PageUp: "PageUp", PageDown: "PageDown", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Semicolon: ";",
  Quote: "'", Comma: ",", Period: ".", Slash: "/" };

/** The key part of an accelerator from a KeyboardEvent's `code`, layout-independent; null for modifiers and unknown keys. */
function keyPart(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return NAMED[code] ?? null;
}

/** An Electron accelerator for a keydown, or null when it is not a usable
 * global shortcut: it needs ⌘/Ctrl or ⌥/Alt plus one key (Shift alone would
 * steal ordinary typing everywhere). */
export function acceleratorFromEvent(ev, platform) {
  const key = keyPart(ev.code ?? "");
  if (!key) return null;
  const mac = platform === "darwin";
  const parts = [];
  if (mac ? ev.metaKey : ev.ctrlKey) parts.push("CommandOrControl");
  if (mac && ev.ctrlKey) parts.push("Control");
  if (!mac && ev.metaKey) parts.push("Super");
  if (ev.altKey) parts.push("Alt");
  if (!parts.length) return null;
  if (ev.shiftKey) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

/** How an accelerator reads in the UI: ⌘⇧Space on a Mac, Ctrl+Shift+Space elsewhere. */
export function formatAccelerator(accel, platform) {
  if (!accel) return "Off";
  const mac = platform === "darwin";
  const names = mac
    ? { CommandOrControl: "⌘", Control: "⌃", Alt: "⌥", Shift: "⇧", Super: "⌘" }
    : { CommandOrControl: "Ctrl", Control: "Ctrl", Alt: "Alt", Shift: "Shift", Super: "Super" };
  const parts = accel.split("+").map((p) => names[p] ?? p);
  return mac ? parts.join("") : parts.join("+");
}

/** The saved accelerator: the default until changed, "" when turned off. */
export function summonKey() {
  try { const value = localStorage.getItem(KEY); return value === null ? DEFAULT_SUMMON : value; }
  catch { return DEFAULT_SUMMON; }
}

let shell = null;

/** Save and register a new accelerator ("" turns it off). Resolves false when
 * the system refused it, usually because another app holds that key. */
export async function setSummonKey(accel) {
  try { localStorage.setItem(KEY, accel); } catch { /* private window: this session only */ }
  if (!shell?.setSummonKey) return false;
  return (await shell.setSummonKey(accel)) === true;
}

/** Register the saved key with the shell and open ⌘K whenever it fires. */
export function startSummon(desktop) {
  if (!desktop?.setSummonKey || !desktop.onSummon) return;
  shell = desktop;
  desktop.onSummon(() => { if (!isPaletteOpen()) openPalette(); });
  const accel = summonKey();
  if (accel) void desktop.setSummonKey(accel);
}

/** Whether this window can register a system-wide key (the Electron shell, not a browser). */
export function summonAvailable() { return !!shell; }
