// ── ANSI helpers ─────────────────────────────────────────────────────────────
export const ESC = "\x1b[";
export const s = {
    reset: `${ESC}0m`,
    bold: (t) => `${ESC}1m${t}${ESC}0m`,
    dim: (t) => `${ESC}2m${t}${ESC}0m`,
    italic: (t) => `${ESC}3m${t}${ESC}0m`,
    cyan: (t) => `${ESC}36m${t}${ESC}0m`,
    green: (t) => `${ESC}32m${t}${ESC}0m`,
    yellow: (t) => `${ESC}33m${t}${ESC}0m`,
    red: (t) => `${ESC}31m${t}${ESC}0m`,
    blue: (t) => `${ESC}34m${t}${ESC}0m`,
    magenta: (t) => `${ESC}35m${t}${ESC}0m`,
    gray: (t) => `${ESC}90m${t}${ESC}0m`,
    invert: (t) => `${ESC}7m${t}${ESC}0m`,
    // Gradient-style brand text
    brand: (t) => `${ESC}1;35m${t}${ESC}0m`,
};
export function cols() {
    return process.stdout.columns || 80;
}
export function stripAnsi(t) {
    return t.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}
// ── Permission mode helpers ─────────────────────────────────────────────────
// Cycle: ask → auto edits → plan → autopilot (matches Claude Code pattern)
export const PERMISSION_MODES = ["suggest", "auto-confirm", "plan", "full-auto"];
/** Cycle to next permission mode. Skips full-auto unless yolo is true. */
export function nextPermissionMode(current, yolo = false) {
    const modes = yolo ? PERMISSION_MODES : PERMISSION_MODES.filter(m => m !== "full-auto");
    const idx = modes.indexOf(current);
    // If current mode is full-auto but yolo is false, jump to suggest
    if (idx === -1)
        return modes[0];
    return modes[(idx + 1) % modes.length];
}
export const PERMISSION_LABELS = {
    "suggest": "",
    "auto-confirm": "auto edits",
    "plan": "plan",
    "full-auto": "autopilot",
};
export const PERMISSION_ICONS = {
    "suggest": "",
    "auto-confirm": "\u25d0", // ◐
    "plan": "\u25d1", // ◑
    "full-auto": "\u25cf", // ●
};
export const PERMISSION_COLORS = {
    "suggest": (t) => t, // invisible / no color
    "auto-confirm": s.blue, // blue
    "plan": s.magenta, // purple
    "full-auto": s.green, // green (requires --yolo to enable)
};
export function permTag(mode) {
    return PERMISSION_COLORS[mode](`${PERMISSION_ICONS[mode]} ${PERMISSION_LABELS[mode]}`);
}
