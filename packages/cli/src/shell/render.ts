// ── ANSI utilities ──────────────────────────────────────────────────────────

const ESC = "\x1b[";
export const RESET  = `${ESC}0m`;
export const BOLD   = `${ESC}1m`;
export const DIM    = `${ESC}2m`;
export const GREEN  = `${ESC}32m`;
export const YELLOW = `${ESC}33m`;
export const RED    = `${ESC}31m`;
export const CYAN   = `${ESC}36m`;

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
  return style.dim("━".repeat(Math.max(1, width)));
}

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

// ── Display width ────────────────────────────────────────────────────────────

// String length counts UTF-16 code units, which is not what a terminal draws:
// combining marks occupy no cell, and East Asian Wide / emoji-presentation
// characters occupy two. Measuring with .length under-counts those, so a line
// built to "fit" overflows, the terminal autowraps it, and every row below
// shifts — which corrupts the whole in-place redraw. Ambiguous-width characters
// are counted as one cell, matching the default in Windows Terminal and most
// Unix terminals.

const ZERO_WIDTH = /^\p{M}$/u;

// East Asian Wide/Fullwidth blocks plus the BMP characters with
// Emoji_Presentation=Yes (which terminals draw double-wide).
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x23e9, 0x23ec], [0x23f0, 0x23f0],
  [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653],
  [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab],
  [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4],
  [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa],
  [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728],
  [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757],
  [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0x303e], [0x3041, 0x33ff],
  [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f],
  [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f],
  [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff], [0x1f7e0, 0x1f7eb], [0x1f900, 0x1f9ff],
  [0x1fa70, 0x1faff], [0x20000, 0x3fffd],
];

function isWideCodePoint(cp: number): boolean {
  let lo = 0, hi = WIDE_RANGES.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const range = WIDE_RANGES[mid]!;
    if (cp < range[0]) hi = mid - 1;
    else if (cp > range[1]) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Terminal cells occupied by `s`, ignoring any ANSI escape codes it contains. */
export function displayWidth(s: string): number {
  const plain = stripAnsi(s);
  let width = 0;
  for (let i = 0; i < plain.length; ) {
    const cp = plain.codePointAt(i)!;
    const size = cp > 0xffff ? 2 : 1;
    i += size;
    // Zero-width joiner, bidi/format controls and byte-order mark draw nothing.
    if (cp === 0x200d || (cp >= 0x200b && cp <= 0x200f) || cp === 0xfeff) continue;
    // Variation selectors: VS16 promotes the previous character to emoji width.
    if (cp >= 0xfe00 && cp <= 0xfe0f) { if (cp === 0xfe0f) width += 1; continue; }
    if (cp >= 0xe0100 && cp <= 0xe01ef) continue;
    if (ZERO_WIDTH.test(String.fromCodePoint(cp))) continue;
    width += isWideCodePoint(cp) ? 2 : 1;
  }
  return width;
}

function visibleWidth(s: string): number {
  return displayWidth(s);
}

/** Longest prefix of `plain` (unstyled) that fits in `cols` cells. */
function sliceToWidth(plain: string, cols: number): string {
  let width = 0;
  for (let i = 0; i < plain.length; ) {
    const cp = plain.codePointAt(i)!;
    const size = cp > 0xffff ? 2 : 1;
    const next = displayWidth(String.fromCodePoint(cp));
    if (width + next > cols) return plain.slice(0, i);
    width += next;
    i += size;
  }
  return plain;
}

export function padToWidth(s: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return truncateLine(s, width);
  const visible = displayWidth(s);
  if (visible > width) return sliceToWidth(stripAnsi(s), width - 1) + "…";
  return s + " ".repeat(width - visible);
}

// ANSI handling: `s` may contain ANSI escape codes (styled text from the style.*
// helpers). We measure visible width via displayWidth, then if truncation is needed
// we slice the *plain* text (discarding ANSI codes) to avoid cutting mid-escape. A
// trailing reset is appended to guard against any residual SGR state from earlier
// output on the same terminal line.
export function truncateLine(s: string, cols: number): string {
  if (cols <= 0) return "";
  if (cols === 1) return "…" + "\x1b[0m";
  if (displayWidth(s) <= cols) return s;
  return sliceToWidth(stripAnsi(s), cols - 1) + "…" + "\x1b[0m";
}

// Reserve one column to avoid terminal autowrap when a line exactly fills the width.
// Many terminals wrap on the last visible column, which corrupts full-screen redraws.
export function renderWidth(columns = process.stdout.columns || 80): number {
  return Math.max(1, columns - 1);
}

interface WrapSegmentsOptions {
  indent?: string;
  maxLines?: number;
  separator?: string;
}

export function wrapSegments(
  segments: string[],
  cols: number,
  opts: WrapSegmentsOptions = {},
): string {
  const indent = opts.indent ?? "  ";
  const maxLines = Math.max(1, opts.maxLines ?? Number.POSITIVE_INFINITY);
  const separator = opts.separator ?? " ";
  const indentWidth = visibleWidth(indent);
  const available = Math.max(1, cols - indentWidth);

  const lines: string[] = [];
  let current = indent;
  let currentWidth = indentWidth;

  const pushEllipsis = () => {
    const extraSep = currentWidth > indentWidth ? separator : "";
    lines.push(truncateLine(current + extraSep + "…", cols));
  };

  for (const raw of segments) {
    if (!raw) continue;
    const segment = truncateLine(raw, available);
    const segmentWidth = visibleWidth(segment);
    const separatorWidth = currentWidth > indentWidth ? visibleWidth(separator) : 0;

    if (currentWidth > indentWidth && currentWidth + separatorWidth + segmentWidth > cols) {
      if (lines.length + 1 >= maxLines) {
        pushEllipsis();
        return lines.join("\n");
      }
      lines.push(current);
      current = indent + segment;
      currentWidth = indentWidth + segmentWidth;
      continue;
    }

    if (currentWidth > indentWidth) {
      current += separator;
      currentWidth += separatorWidth;
    }
    current += segment;
    currentWidth += segmentWidth;
  }

  lines.push(current);
  return lines.slice(0, maxLines).join("\n");
}

// ── Phren theme ────────────────────────────────────────────────────────────

// Neural gradient palette: purple → blue → cyan (256-color ANSI)
const PHREN_GRADIENT = [
  "\x1b[38;5;93m",   // vivid purple
  "\x1b[38;5;99m",   // purple-blue
  "\x1b[38;5;105m",  // blue-purple
  "\x1b[38;5;111m",  // sky blue
  "\x1b[38;5;75m",   // dodger blue
  "\x1b[38;5;81m",   // cyan-blue
  "\x1b[38;5;87m",   // bright cyan
];

// Apply gradient coloring across non-whitespace characters
export function gradient(text: string, colors: string[] = PHREN_GRADIENT): string {
  const plain = stripAnsi(text);
  const chars = [...plain];
  const nonSpaceCount = chars.filter(ch => !/\s/.test(ch)).length;
  if (!nonSpaceCount || !colors.length) return text;
  let result = "";
  let vi = 0;
  for (const ch of chars) {
    if (/\s/.test(ch)) {
      result += ch;
    } else {
      const ci = Math.min(Math.floor(vi * colors.length / nonSpaceCount), colors.length - 1);
      result += colors[ci] + ch;
      vi++;
    }
  }
  return result + RESET;
}

// Block-letter logo for startup animation
const PHREN_LOGO = [
  "██████╗ ██╗  ██╗██████╗ ███████╗███╗   ██╗",
  "██╔══██╗██║  ██║██╔══██╗██╔════╝████╗  ██║",
  "██████╔╝███████║██████╔╝█████╗  ██╔██╗ ██║",
  "██╔═══╝ ██╔══██║██╔══██╗██╔══╝  ██║╚██╗██║",
  "██║     ██║  ██║██║  ██║███████╗██║ ╚████║",
  "╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═══╝",
];

import { PHREN_ART as PHREN_STARTUP_ART } from "../phren-art.js";

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
    `  ${style.bold("Projects")}     ${k("↵")} ${d("open project tasks")}  ${k("i")} ${d("cycle intro mode")}`,
    `  ${style.bold("Tasks")}        ${k("a")} ${d("add task")}  ${k("d")} ${d("toggle active/queue")}  ${k("↵")} ${d("mark complete")}`,
    `  ${style.bold("Findings")}    ${k("a")} ${d("tell phren")}  ${k("d")} ${d("delete selected")}`,
    `  ${style.bold("Review Queue")} ${k("↵")} ${d("inspect selected item")}  ${d("(read-only)")}`,
    `  ${style.bold("Skills")}       ${k("t")} ${d("toggle enabled")}  ${k("d")} ${d("remove")}`,
    "",
    hdr("Palette commands  (:cmd)"),
    `  ${cmd(":open <project>")}                             ${d("set active project context")}`,
    `  ${cmd(":add <task>")}                                 ${d("add task")}`,
    `  ${cmd(":complete <id|match>")}                        ${d("mark done")}`,
    `  ${cmd(":move <id|match> <active|queue|done>")}        ${d("move item")}`,
    `  ${cmd(":reprioritize <id|match> <high|medium|low>")}`,
    `  ${cmd(":context <id|match> <text>")}`,
    `  ${cmd(":pin <id>")}  ${cmd(":unpin <id>")}  ${cmd(":work next")}  ${cmd(":tidy [keep]")}`,
    `  ${cmd(":find add <text>")}  ${cmd(":find remove <id|match>")}`,
    `  ${cmd(":intro always|once-per-version|off")}`,
    `  ${cmd(":review queue")}                              ${d("inspect review queue (read-only)")}`,
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

// Begin/End Synchronized Update (DEC private mode 2026). Terminals that support
// it buffer everything between the two and present the frame in one go, so a
// multi-kilobyte repaint never shows half-drawn. Terminals that don't support it
// ignore unknown private modes, so this is safe to send unconditionally.
const SYNC_BEGIN = "\x1b[?2026h";
const SYNC_END   = "\x1b[?2026l";

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

// Autowrap off. The views already truncate to renderWidth(), but a single
// mismeasured line would otherwise wrap, push every row below it down, and
// scroll the frame out from under the cursor-home redraw — corrupting every
// subsequent frame. With autowrap off an over-long line is merely clipped.
const WRAP_OFF = "\x1b[?7l";
const WRAP_ON  = "\x1b[?7h";

const ALT_SCREEN_ON  = "\x1b[?1049h";
const ALT_SCREEN_OFF = "\x1b[?1049l";

/** Switch to the alternate screen buffer and put the terminal in TUI mode. */
export function enterFullscreen(): void {
  if (!process.stdout.isTTY) return;
  process.stdout.write(ALT_SCREEN_ON);
  process.stdout.write(HIDE_CURSOR);
  process.stdout.write(WRAP_OFF);
}

/** Undo enterFullscreen(). Safe to call more than once. */
export function exitFullscreen(): void {
  if (!process.stdout.isTTY) return;
  process.stdout.write(WRAP_ON);
  process.stdout.write(SHOW_CURSOR);
  process.stdout.write(ALT_SCREEN_OFF);
}

/**
 * Write one frame as a single synchronized write.
 *
 * The old path issued three separate writes (home, body, erase-to-end) with the
 * cursor visible, which let a concurrent repaint interleave between them and
 * dragged the caret across the screen on every keystroke.
 */
export function paintFrame(frame: string): void {
  // A frame with more lines than the terminal has rows scrolls the alternate
  // buffer, and once it scrolls every later cursor-home repaint lands on
  // shifted rows and the frames stack on top of each other. Clip the overflow
  // (including a trailing newline on the last row) rather than scroll.
  const rows = Math.max(1, process.stdout.rows || 24);
  const lines = frame.split("\n");
  const body = lines.length > rows ? lines.slice(0, rows).join("\n") : frame;
  process.stdout.write(SYNC_BEGIN + "\x1b[H" + body + "\x1b[J" + SYNC_END);
}

// The character art is a fixed-size pixel grid; the gap keeps the logo off it.
const ART_WIDTH = 24;
const ART_GAP = 2;
const LOGO_WIDTH = Math.max(...PHREN_LOGO.map(displayWidth));

/**
 * The wordmark line, split onto two rows when the terminal is too narrow to
 * carry the tagline alongside the version badge.
 */
function startupInfoLines(version: string, available: number): string[] {
  const tagline = style.dim("local memory for working agents");
  const head = `${gradient("◆")} ${style.bold("phren")}  ${badge(`v${version}`, style.boldBlue)}`;
  const single = `${head}  ${tagline}`;
  return displayWidth(single) <= available ? [single] : [head, tagline];
}

/**
 * Lay out one splash frame from the character art the caller supplies (a live
 * animation frame, or the static art).
 *
 * Every branch is chosen so the result fits the terminal it is about to be
 * painted into: the wide layout needs room for art + gap + logo, the stacked
 * one drops the logo rather than clipping it, and a terminal too short for the
 * character drops the character rather than pushing the tagline off the bottom.
 * A frame taller than the screen would scroll the alternate buffer, and once it
 * scrolls every later cursor-home repaint lands on shifted rows, stacking the
 * frames on top of each other.
 */
export function composeStartupFrame(artLines: string[], version: string, hint?: string): string[] {
  const cols = renderWidth();
  const rows = process.stdout.rows || 24;
  const logoLines = PHREN_LOGO.map(line => gradient(line));
  const hintLines = hint ? ["", `  ${hint}`] : [];
  // One blank line above, one below, plus the hint block.
  const budget = rows - 2 - hintLines.length;

  const stackedInfo = startupInfoLines(version, cols - 2).map(line => `  ${line}`);

  const sideBySide = (): string[] => {
    // Logo is 6 lines; the leading blanks centre it against the character.
    const rightSide = ["", "", ...logoLines, "", ...startupInfoLines(version, cols - ART_WIDTH - ART_GAP)];
    const lines: string[] = [];
    for (let i = 0; i < Math.max(artLines.length, rightSide.length); i++) {
      // padToWidth measures display cells; String.padEnd counts the art's ANSI
      // bytes as width and pads nothing at all.
      const left = padToWidth(i < artLines.length ? artLines[i] : "", ART_WIDTH + ART_GAP);
      lines.push(left + (i < rightSide.length ? rightSide[i] : ""));
    }
    return lines;
  };

  // Widest layout the terminal can carry, then progressively less of it: art
  // beside the logo, art alone, logo alone, and finally just the wordmark.
  const candidates: string[][] = [];
  if (cols >= ART_WIDTH + ART_GAP + LOGO_WIDTH) candidates.push(sideBySide());
  candidates.push([...artLines, "", ...stackedInfo]);
  if (cols >= LOGO_WIDTH + 2) candidates.push([...logoLines.map(line => `  ${line}`), "", ...stackedInfo]);
  candidates.push(stackedInfo);

  const body = candidates.find(lines => lines.length <= budget) ?? stackedInfo;
  return ["", ...body, ...hintLines, ""];
}

/**
 * Clamp a frame to the terminal before painting: truncate each line to the
 * render width, erase whatever the previous frame left to the right of it, and
 * drop rows past the bottom so the frame can never scroll the screen.
 */
export function fitFrame(lines: string[]): string {
  const cols = renderWidth();
  const rows = Math.max(1, process.stdout.rows || 24);
  return lines
    .slice(0, rows)
    .map(line => truncateLine(line, cols) + "\x1b[K")
    .join("\n");
}

export function shellStartupFrames(version: string): string[] {
  const cols = process.stdout.columns || 80;

  if (cols >= 44) {
    return [fitFrame(composeStartupFrame(PHREN_STARTUP_ART, version))];
  }

  // Narrow terminal: progressive text reveal with gradient
  const stages = ["p", "phr", "phren"];
  const spinners = ["◜", "◠", "◝"];
  const infoLines = startupInfoLines(version, renderWidth() - 2).map(line => `  ${line}`);
  return stages.map((stage, i) => fitFrame([
    "",
    `  ${gradient(stage)} ${style.dim(spinners[i])}`,
    "",
    ...infoLines,
    "",
  ]));
}
