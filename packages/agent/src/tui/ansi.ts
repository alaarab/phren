/**
 * ANSI escape helpers, permission mode utilities, and terminal helpers.
 */
import type { PermissionMode } from "../permissions/types.js";

// ── ANSI helpers ─────────────────────────────────────────────────────────────
export const ESC = "\x1b[";
export const s = {
  reset: `${ESC}0m`,
  bold: (t: string) => `${ESC}1m${t}${ESC}0m`,
  dim: (t: string) => `${ESC}2m${t}${ESC}0m`,
  italic: (t: string) => `${ESC}3m${t}${ESC}0m`,
  cyan: (t: string) => `${ESC}36m${t}${ESC}0m`,
  green: (t: string) => `${ESC}32m${t}${ESC}0m`,
  yellow: (t: string) => `${ESC}33m${t}${ESC}0m`,
  red: (t: string) => `${ESC}31m${t}${ESC}0m`,
  blue: (t: string) => `${ESC}34m${t}${ESC}0m`,
  magenta: (t: string) => `${ESC}35m${t}${ESC}0m`,
  gray: (t: string) => `${ESC}90m${t}${ESC}0m`,
  invert: (t: string) => `${ESC}7m${t}${ESC}0m`,
  // Gradient-style brand text
  brand: (t: string) => `${ESC}1;35m${t}${ESC}0m`,
};

export function cols(): number {
  return process.stdout.columns || 80;
}

export function stripAnsi(t: string): string {
  return t.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

// ── Permission mode helpers ─────────────────────────────────────────────────
export const PERMISSION_MODES: PermissionMode[] = ["suggest", "auto-confirm", "full-auto"];

export function nextPermissionMode(current: PermissionMode): PermissionMode {
  const idx = PERMISSION_MODES.indexOf(current);
  return PERMISSION_MODES[(idx + 1) % PERMISSION_MODES.length];
}

export const PERMISSION_LABELS: Record<PermissionMode, string> = {
  "suggest": "suggest",
  "auto-confirm": "auto",
  "full-auto": "full-auto",
};

export const PERMISSION_ICONS: Record<PermissionMode, string> = {
  "suggest": "○",
  "auto-confirm": "◐",
  "full-auto": "●",
};

export const PERMISSION_COLORS: Record<PermissionMode, (t: string) => string> = {
  "suggest": s.cyan,
  "auto-confirm": s.green,
  "full-auto": s.yellow,
};

export function permTag(mode: PermissionMode): string {
  return PERMISSION_COLORS[mode](`${PERMISSION_ICONS[mode]} ${mode}`);
}
