/**
 * Text effects for the phren wordmark on the shell splash.
 *
 * Inspired by TerminalTextEffects: the block-letter logo is revealed with a
 * "decrypt" scramble that settles cell by cell into the real glyphs, and the
 * finished wordmark carries a slow light-beam shimmer while the splash holds.
 *
 * Two rules keep the letters intact:
 *  - scramble glyphs come only from the same box-drawing / block family the
 *    logo already uses, so every cell stays one column wide;
 *  - every frame is a pure function of (progress, cell) with hash-based
 *    jitter, so the reveal is deterministic and the final frame equals the
 *    plain gradient logo exactly.
 *
 * This module is imported by render.ts and must not import from it.
 */

const RESET = "\x1b[0m";

// Block-letter logo for the splash.
export const PHREN_LOGO = [
  "██████╗ ██╗  ██╗██████╗ ███████╗███╗   ██╗",
  "██╔══██╗██║  ██║██╔══██╗██╔════╝████╗  ██║",
  "██████╔╝███████║██████╔╝█████╗  ██╔██╗ ██║",
  "██╔═══╝ ██╔══██║██╔══██╗██╔══╝  ██║╚██╗██║",
  "██║     ██║  ██║██║  ██║███████╗██║ ╚████║",
  "╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═══╝",
];

// Neural gradient palette: purple → blue → cyan (256-color ANSI)
export const PHREN_GRADIENT = [
  "\x1b[38;5;93m",   // vivid purple
  "\x1b[38;5;99m",   // purple-blue
  "\x1b[38;5;105m",  // blue-purple
  "\x1b[38;5;111m",  // sky blue
  "\x1b[38;5;75m",   // dodger blue
  "\x1b[38;5;81m",   // cyan-blue
  "\x1b[38;5;87m",   // bright cyan
];

/** Glyphs the scramble may show: the logo's own alphabet plus shade blocks. All one cell wide. */
const SCRAMBLE_POOL = [..."░▒▓█▀▄╗╔╝╚║═╬╪╫┼"];

/** Dim greys the unsettled cells cycle through. */
const SCRAMBLE_COLORS = ["\x1b[38;5;238m", "\x1b[38;5;240m", "\x1b[38;5;243m", "\x1b[38;5;245m"];
const FLASH = "\x1b[38;5;231m";
const SHIMMER = ["\x1b[38;5;123m", "\x1b[38;5;159m", "\x1b[38;5;195m", "\x1b[38;5;159m", "\x1b[38;5;123m"];

/** Frames in the reveal and the delay between them. ~1s total. */
export const LOGO_REVEAL_FRAMES = 22;
export const LOGO_REVEAL_FRAME_MS = 45;
export const LOGO_SHIMMER_FRAME_MS = 110;

function hash(a: number, b: number, c: number): number {
  let h = 2166136261;
  for (const v of [a, b, c]) {
    h ^= v + 0x9e3779b9;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

interface Cell {
  ch: string;
  /** Index into PHREN_GRADIENT, or -1 for whitespace. */
  colorIdx: number;
  /** Position among the line's non-space cells, 0..1. */
  along: number;
}

/**
 * Split a logo line into cells with the same colour assignment `gradient()`
 * in render.ts uses (bucket by position among non-space characters).
 */
function cells(line: string): Cell[] {
  const chars = [...line];
  const nonSpace = chars.filter((ch) => !/\s/.test(ch)).length;
  let vi = 0;
  return chars.map((ch) => {
    if (/\s/.test(ch)) return { ch, colorIdx: -1, along: 0 };
    const colorIdx = Math.min(Math.floor((vi * PHREN_GRADIENT.length) / nonSpace), PHREN_GRADIENT.length - 1);
    const along = nonSpace > 1 ? vi / (nonSpace - 1) : 0;
    vi++;
    return { ch, colorIdx, along };
  });
}

const LOGO_CELLS = PHREN_LOGO.map(cells);

function paint(row: Cell[], color: (cell: Cell, col: number) => { ch: string; sgr: string }): string {
  let out = "";
  let current = "";
  row.forEach((cell, col) => {
    if (cell.colorIdx < 0) { out += cell.ch; return; }
    const { ch, sgr } = color(cell, col);
    if (sgr !== current) { out += sgr; current = sgr; }
    out += ch;
  });
  return out + RESET;
}

/** The finished wordmark: identical colours to `gradient(line)` in render.ts. */
export function logoPlain(): string[] {
  return LOGO_CELLS.map((row) => paint(row, (cell) => ({ ch: cell.ch, sgr: PHREN_GRADIENT[cell.colorIdx] })));
}

/**
 * Decrypt reveal at `progress` in [0, 1]. Cells settle left to right with
 * per-cell jitter; a settling cell flashes white for a moment; unsettled
 * cells churn through scramble glyphs. At progress >= 1 this is `logoPlain()`.
 */
export function logoRevealFrame(progress: number): string[] {
  const p = Math.max(0, Math.min(1, progress));
  const tick = Math.floor(p * 40);
  return LOGO_CELLS.map((row, r) => paint(row, (cell, c) => {
    const settleAt = cell.along * 0.72 + hash(r, c, 1) * 0.24;
    if (p >= 1 || p >= settleAt + 0.07) return { ch: cell.ch, sgr: PHREN_GRADIENT[cell.colorIdx] };
    if (p >= settleAt) return { ch: cell.ch, sgr: FLASH };
    const glyph = SCRAMBLE_POOL[Math.floor(hash(r, c, tick) * SCRAMBLE_POOL.length)];
    const shade = SCRAMBLE_COLORS[Math.floor(hash(c, r, tick + 7) * SCRAMBLE_COLORS.length)];
    return { ch: glyph, sgr: shade };
  }));
}

/**
 * A soft beam of light sweeping across the finished wordmark. `tick` is any
 * increasing integer; the sweep loops with a pause between passes.
 */
export function logoShimmerFrame(tick: number): string[] {
  const width = Math.max(...PHREN_LOGO.map((line) => [...line].length));
  const period = width + 26;
  const x = ((tick * 2) % period) - 8;
  return LOGO_CELLS.map((row, r) => paint(row, (cell, c) => {
    // The beam leans like a slash: each row is offset one column.
    const d = c + r - x;
    if (d >= -2 && d <= 2) return { ch: cell.ch, sgr: SHIMMER[d + 2] };
    return { ch: cell.ch, sgr: PHREN_GRADIENT[cell.colorIdx] };
  }));
}
