// ── ANSI utilities ──────────────────────────────────────────────────────────

export const ESC = "\x1b[";
export const RESET = `${ESC}0m`;

export const style = {
  bold:        (s: string) => `${ESC}1m${s}${RESET}`,
  dim:         (s: string) => `${ESC}2m${s}${RESET}`,
  italic:      (s: string) => `${ESC}3m${s}${RESET}`,
  cyan:        (s: string) => `${ESC}36m${s}${RESET}`,
  green:       (s: string) => `${ESC}32m${s}${RESET}`,
  yellow:      (s: string) => `${ESC}33m${s}${RESET}`,
  red:         (s: string) => `${ESC}31m${s}${RESET}`,
  magenta:     (s: string) => `${ESC}35m${s}${RESET}`,
  blue:        (s: string) => `${ESC}34m${s}${RESET}`,
  white:       (s: string) => `${ESC}37m${s}${RESET}`,
  gray:        (s: string) => `${ESC}90m${s}${RESET}`,
  boldCyan:    (s: string) => `${ESC}1;36m${s}${RESET}`,
  boldGreen:   (s: string) => `${ESC}1;32m${s}${RESET}`,
  boldYellow:  (s: string) => `${ESC}1;33m${s}${RESET}`,
  boldRed:     (s: string) => `${ESC}1;31m${s}${RESET}`,
  boldMagenta: (s: string) => `${ESC}1;35m${s}${RESET}`,
  boldBlue:    (s: string) => `${ESC}1;34m${s}${RESET}`,
  dimItalic:   (s: string) => `${ESC}2;3m${s}${RESET}`,
  invert:      (s: string) => `${ESC}7m${s}${RESET}`,
};

export function badge(label: string, colorFn: (s: string) => string): string {
  return colorFn(`[${label}]`);
}

export function separator(width = 50): string {
  return style.dim("─".repeat(width));
}

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

export function padToWidth(s: string, width: number): string {
  const visible = stripAnsi(s);
  if (visible.length > width) return visible.slice(0, width - 1) + "…";
  return s + " ".repeat(width - visible.length);
}

// ANSI handling: `s` may contain ANSI escape codes (styled text from the style.*
// helpers). We measure visible width via stripAnsi, then if truncation is needed we
// slice the *plain* text (discarding ANSI codes) to avoid cutting mid-escape. A
// trailing reset is appended to guard against any residual SGR state from earlier
// output on the same terminal line.
export function truncateLine(s: string, cols: number): string {
  const visible = stripAnsi(s);
  if (visible.length <= cols) return s;
  return visible.slice(0, cols - 1) + "…" + "\x1b[0m";
}

// ── Line-based viewport: edge-triggered scroll (stable, no jumpiness) ─────────

export function lineViewport(
  allLines: string[],
  cursorFirstLine: number,
  cursorLastLine: number,
  height: number,
  prevStart: number,
): { lines: string[]; scrollStart: number } {
  if (allLines.length === 0 || height <= 0) return { lines: [], scrollStart: 0 };
  if (allLines.length <= height) return { lines: allLines.slice(), scrollStart: 0 };

  const first = Math.max(0, Math.min(cursorFirstLine, allLines.length - 1));
  const last  = Math.max(first, Math.min(cursorLastLine, allLines.length - 1));
  let start   = Math.max(0, prevStart);

  // Scroll up if cursor is above viewport
  if (first < start) start = first;
  // Scroll down if cursor is below viewport
  if (last >= start + height) start = last - height + 1;
  // Clamp
  start = Math.min(start, Math.max(0, allLines.length - height));

  return { lines: allLines.slice(start, start + height), scrollStart: start };
}

// ── Help text ────────────────────────────────────────────────────────────────

export function shellHelpText(): string {
  const hdr = (s: string) => style.bold(s);
  const k   = (s: string) => style.boldCyan(s);
  const d   = (s: string) => style.dim(s);
  const cmd = (s: string) => style.cyan(s);

  return [
    "",
    hdr("Navigation"),
    `  ${k("← →")} ${d("switch tabs")}    ${k("↑ ↓")} ${d("move cursor")}    ${k("↵")} ${d("activate")}    ${k("q")} ${d("quit")}`,
    `  ${k("/")} ${d("filter")}    ${k(":")} ${d("command palette")}    ${k("Esc")} ${d("cancel / clear filter")}    ${k("?")} ${d("toggle this help")}`,
    "",
    hdr("View-specific keys"),
    `  ${style.bold("Projects")}     ${k("↵")} ${d("open project as context")}`,
    `  ${style.bold("Backlog")}      ${k("a")} ${d("add task")}  ${k("d")} ${d("toggle active/queue")}  ${k("↵")} ${d("mark complete")}`,
    `  ${style.bold("Findings")}    ${k("a")} ${d("add finding")}  ${k("d")} ${d("delete selected")}`,
    `  ${style.bold("Review Queue")} ${k("a")} ${d("approve")}  ${k("r")} ${d("reject")}  ${k("e")} ${d("edit")}`,
    "",
    hdr("Palette commands  (:cmd)"),
    `  ${cmd(":open <project>")}                             ${d("set active project context")}`,
    `  ${cmd(":add <task>")}                                 ${d("add backlog item")}`,
    `  ${cmd(":complete <id|match>")}                        ${d("mark done")}`,
    `  ${cmd(":move <id|match> <active|queue|done>")}        ${d("move item")}`,
    `  ${cmd(":reprioritize <id|match> <high|medium|low>")}`,
    `  ${cmd(":context <id|match> <text>")}`,
    `  ${cmd(":pin <id>")}  ${cmd(":unpin <id>")}  ${cmd(":work next")}  ${cmd(":tidy [keep]")}`,
    `  ${cmd(":find add <text>")}  ${cmd(":find remove <id|match>")}`,
    `  ${cmd(":mq approve|reject|edit <id>")}`,
    `  ${cmd(":govern")}  ${cmd(":consolidate")}  ${cmd(":search <query>")}`,
    `  ${cmd(":undo")}  ${cmd(":diff")}  ${cmd(":conflicts")}  ${cmd(":reset")}`,
    `  ${cmd(":run fix")}  ${cmd(":relink")}  ${cmd(":rerun hooks")}  ${cmd(":update")}`,
    `  ${cmd(":machines")}`,
  ].join("\n");
}

// ── Terminal control ──────────────────────────────────────────────────────────

export function clearScreen(): void {
  if (process.stdout.isTTY) {
    // Move cursor to home and overwrite in place (no full clear = no flicker)
    process.stdout.write("\x1b[H");
  }
}

// Clear any leftover lines below the rendered content
export function clearToEnd(): void {
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[J");
  }
}
