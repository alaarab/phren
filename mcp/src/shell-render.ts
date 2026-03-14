// ── ANSI utilities ──────────────────────────────────────────────────────────

const ESC = "\x1b[";
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
  return style.dim("━".repeat(Math.max(1, width)));
}

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

export function visibleWidth(s: string): number {
  return stripAnsi(s).length;
}

export function padToWidth(s: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return truncateLine(s, width);
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
  if (cols <= 0) return "";
  if (cols === 1) return "…" + "\x1b[0m";
  const visible = stripAnsi(s);
  if (visible.length <= cols) return s;
  return visible.slice(0, cols - 1) + "…" + "\x1b[0m";
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

// Compact phren character for startup (imported inline to avoid circular deps)
const PHREN_STARTUP = [
  "\x1b[96m        ✦\x1b[0m",
  "\x1b[38;5;57m   ▄\x1b[35m██████\x1b[38;5;57m▄\x1b[0m",
  "\x1b[35m  ██\x1b[95m▓▓\x1b[35m██\x1b[95m▓▓\x1b[35m██\x1b[0m",
  "\x1b[35m  █\x1b[38;5;57m◆\x1b[35m██\x1b[38;5;57m◆\x1b[35m███\x1b[0m",
  "\x1b[35m  ██\x1b[2m\x1b[35m▽\x1b[0m\x1b[35m████\x1b[95m█\x1b[0m",
  "\x1b[38;5;57m   ▀\x1b[35m██████\x1b[38;5;57m▀\x1b[0m",
  "\x1b[38;5;57m    ██  ██\x1b[0m",
];

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
    `  ${style.bold("Fragments")}   ${k("a")} ${d("tell phren")}  ${k("d")} ${d("delete selected")}`,
    `  ${style.bold("Review Queue")} ${k("a")} ${d("approve")}  ${k("r")} ${d("reject")}  ${k("e")} ${d("edit")}`,
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

export function shellStartupFrames(version: string): string[] {
  const cols = process.stdout.columns || 80;
  const tagline = style.dim("local memory for working agents");
  const versionBadge = badge(`v${version}`, style.boldBlue);

  if (cols >= 56) {
    const logo = PHREN_LOGO.map(line => "  " + gradient(line));
    const phren = PHREN_STARTUP.map(line => "  " + line);
    const sep = gradient("━".repeat(Math.min(52, cols)));

    return [
      // Frame 1: Phren appears
      ["", ...phren, "", `  ${versionBadge}  ${tagline}`, ""].join("\n"),
      // Frame 2: Full logo materializes with phren
      ["", ...phren, "", ...logo, "", `  ${versionBadge}  ${tagline}`, ""].join("\n"),
      // Frame 3: Complete with brand separator
      ["", ...phren, "", ...logo, `  ${sep}`, `  ${gradient("◆")} ${style.bold("phren")}  ${versionBadge}  ${tagline}`, ""].join("\n"),
    ];
  }

  // Narrow terminal: progressive text reveal with gradient
  const stages = ["c", "cor", "phren"];
  const spinners = ["◜", "◠", "◝"];
  return stages.map((stage, i) => [
    "",
    `  ${gradient(stage)} ${style.dim(spinners[i])}`,
    "",
    `  ${versionBadge}  ${tagline}`,
    "",
  ].join("\n"));
}
