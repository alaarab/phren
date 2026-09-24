/**
 * A braille dot canvas with a text overlay, rendered to ANSI lines.
 *
 * Each terminal cell is a 2×4 grid of braille dots (U+2800–U+28FF), which
 * gives the graph 8× the resolution of plain block characters and — because
 * a cell is roughly twice as tall as it is wide — dots that are close to
 * square, so no aspect correction is needed. Edges and node blobs are drawn
 * in dot space; glyphs, labels and the legend are written into a cell-level
 * overlay that takes precedence when rendering.
 *
 * Every rendered line is exactly `cols` cells wide and built only from
 * width-1 characters, so the shell's `truncateLine`/`displayWidth` pipeline
 * measures it correctly.
 */

import { displayWidth } from "../render.js";

const RESET = "\x1b[0m";

// Braille bit for dot (x, y) inside a cell — x ∈ {0,1}, y ∈ {0..3}.
const DOT_BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];

export type ColorMode = "truecolor" | "256";

let colorModeOverride: ColorMode | null = null;

/** Tests pin the mode; real terminals are sniffed from COLORTERM/TERM. */
export function setColorMode(mode: ColorMode | null): void {
  colorModeOverride = mode;
}

export function colorMode(): ColorMode {
  if (colorModeOverride) return colorModeOverride;
  const colorterm = (process.env.COLORTERM || "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") return "truecolor";
  const term = (process.env.TERM || "").toLowerCase();
  if (term.includes("direct") || term.includes("truecolor")) return "truecolor";
  return "256";
}

export function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean.padEnd(6, "0");
  const value = Number.parseInt(full.slice(0, 6), 16);
  if (!Number.isFinite(value)) return [127, 127, 127];
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const clampByte = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${[clampByte(r), clampByte(g), clampByte(b)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** Linear blend from `from` toward `to` by `t` in [0, 1]. */
export function blendHex(from: string, to: string, t: number): string {
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  const k = Math.max(0, Math.min(1, t));
  return rgbToHex(a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k);
}

/** Nearest xterm-256 index: 6×6×6 colour cube, or the grey ramp for greys. */
export function hexToAnsi256(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  if (Math.abs(r - g) < 10 && Math.abs(g - b) < 10) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return 232 + Math.round(((r - 8) / 247) * 23);
  }
  const level = (v: number) => Math.round((v / 255) * 5);
  return 16 + 36 * level(r) + 6 * level(g) + level(b);
}

const sgrCache = new Map<string, string>();

/** Foreground SGR for a hex colour in the active colour mode. */
export function hexToSgr(hex: string): string {
  const key = `${colorMode()}:${hex}`;
  const cached = sgrCache.get(key);
  if (cached) return cached;
  const [r, g, b] = hexToRgb(hex);
  const sgr = colorMode() === "truecolor" ? `\x1b[38;2;${r};${g};${b}m` : `\x1b[38;5;${hexToAnsi256(hex)}m`;
  sgrCache.set(key, sgr);
  return sgr;
}

interface OverlayCell {
  ch: string;
  sgr: string;
}

export interface DotOptions {
  /** Higher z wins when two draws hit the same cell (node dots beat edges). */
  z?: number;
  /** Light every other dot along a line. */
  dotted?: boolean;
}

export class BrailleCanvas {
  private readonly masks: Uint8Array;
  private readonly zs: Int16Array;
  private readonly colors: (string | undefined)[];
  private readonly overlay: (OverlayCell | undefined)[];

  constructor(readonly cols: number, readonly rows: number) {
    const cells = Math.max(0, cols * rows);
    this.masks = new Uint8Array(cells);
    this.zs = new Int16Array(cells).fill(-32768);
    this.colors = new Array(cells);
    this.overlay = new Array(cells);
  }

  get dotWidth(): number { return this.cols * 2; }
  get dotHeight(): number { return this.rows * 4; }

  private cell(col: number, row: number): number {
    return row * this.cols + col;
  }

  setDot(x: number, y: number, color: string, z = 0): void {
    const dx = Math.round(x);
    const dy = Math.round(y);
    if (dx < 0 || dy < 0 || dx >= this.dotWidth || dy >= this.dotHeight) return;
    const col = dx >> 1;
    const row = dy >> 2;
    const idx = this.cell(col, row);
    this.masks[idx] |= DOT_BITS[dy & 3][dx & 1];
    if (z >= this.zs[idx]) {
      this.zs[idx] = z;
      this.colors[idx] = color;
    }
  }

  /** Bresenham in dot space. */
  line(x0: number, y0: number, x1: number, y1: number, color: string, opts: DotOptions = {}): void {
    let ax = Math.round(x0);
    let ay = Math.round(y0);
    const bx = Math.round(x1);
    const by = Math.round(y1);
    const ddx = Math.abs(bx - ax);
    const ddy = -Math.abs(by - ay);
    const sx = ax < bx ? 1 : -1;
    const sy = ay < by ? 1 : -1;
    let err = ddx + ddy;
    let n = 0;
    for (;;) {
      if (!opts.dotted || n % 2 === 0) this.setDot(ax, ay, color, opts.z ?? 0);
      if (ax === bx && ay === by) break;
      const e2 = 2 * err;
      if (e2 >= ddy) { err += ddy; ax += sx; }
      if (e2 <= ddx) { err += ddx; ay += sy; }
      n++;
      if (n > 100000) break;
    }
  }

  /** Filled disc in dot space; radius 0 lights a single dot. */
  disc(cx: number, cy: number, radius: number, color: string, z = 1): void {
    const r = Math.max(0, radius);
    const r2 = r * r + 0.25;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const ddx = x - cx;
        const ddy = y - cy;
        if (ddx * ddx + ddy * ddy <= r2) this.setDot(x, y, color, z);
      }
    }
  }

  /**
   * True when the cells [col, col+width) on `row` hold no overlay text —
   * and, with `avoidDots`, no braille dots either, so a label does not
   * paint over somebody else's node or edge.
   */
  isFree(col: number, row: number, width: number, avoidDots = false): boolean {
    if (row < 0 || row >= this.rows || col < 0 || col + width > this.cols) return false;
    for (let c = col; c < col + width; c++) {
      const idx = this.cell(c, row);
      if (this.overlay[idx]) return false;
      if (avoidDots && this.masks[idx]) return false;
    }
    return true;
  }

  /**
   * Write styled text into the overlay. Characters wider than one cell are
   * replaced with `·` so the row stays exactly `cols` wide. Returns the number
   * of cells written (0 when the text starts off-canvas).
   */
  putText(col: number, row: number, text: string, sgr = ""): number {
    if (row < 0 || row >= this.rows) return 0;
    let c = col;
    let written = 0;
    for (const raw of text) {
      if (c >= this.cols) break;
      if (c >= 0) {
        const width = displayWidth(raw);
        const ch = width === 1 ? raw : width === 0 ? "" : "·";
        if (ch) {
          this.overlay[this.cell(c, row)] = { ch, sgr };
          written++;
        } else {
          continue;
        }
      }
      c++;
    }
    return written;
  }

  /**
   * Overlay a line that already carries ANSI styling, one cell per visible
   * character. Each cell records the full attribute state in force at that
   * point (everything since the last reset), so the renderer can switch
   * styles cell by cell without leaking bold or colour into the neighbours.
   */
  putStyled(col: number, row: number, styled: string): number {
    if (row < 0 || row >= this.rows) return 0;
    let c = col;
    let written = 0;
    let state = "";
    let i = 0;
    while (i < styled.length) {
      if (styled[i] === "\x1b") {
        const end = styled.indexOf("m", i);
        if (end === -1) break;
        const seq = styled.slice(i, end + 1);
        state = seq === "\x1b[0m" || seq === "\x1b[m" ? "" : state + seq;
        i = end + 1;
        continue;
      }
      const cp = styled.codePointAt(i) ?? 32;
      const raw = String.fromCodePoint(cp);
      i += raw.length;
      if (c >= this.cols) break;
      if (c >= 0) {
        const width = displayWidth(raw);
        if (width === 0) continue;
        if (width === 2) {
          // A wide glyph owns two cells: the glyph in the first, an empty
          // marker in the second so nothing else draws there and the row
          // still adds up to the right width. At the edge it becomes a dot.
          if (c + 1 >= this.cols) { this.overlay[this.cell(c, row)] = { ch: "·", sgr: state }; written++; c++; continue; }
          this.overlay[this.cell(c, row)] = { ch: raw, sgr: state };
          this.overlay[this.cell(c + 1, row)] = { ch: "", sgr: state };
          written += 2;
          c += 2;
          continue;
        }
        this.overlay[this.cell(c, row)] = { ch: raw, sgr: state };
        written++;
      }
      c++;
    }
    return written;
  }

  /** Every cell in a rectangle is overlaid with a space, hiding dots underneath (pane backdrop). */
  clearRect(col: number, row: number, width: number, height: number): void {
    for (let r = row; r < row + height; r++) {
      for (let c = col; c < col + width; c++) {
        if (r < 0 || r >= this.rows || c < 0 || c >= this.cols) continue;
        this.overlay[this.cell(c, r)] = { ch: " ", sgr: "" };
      }
    }
  }

  render(): string[] {
    const lines: string[] = [];
    for (let row = 0; row < this.rows; row++) {
      let out = "";
      let current = "";
      let dirty = false;
      for (let col = 0; col < this.cols; col++) {
        const idx = this.cell(col, row);
        const over = this.overlay[idx];
        let ch: string;
        let sgr: string;
        if (over) {
          ch = over.ch;
          sgr = over.sgr;
        } else if (this.masks[idx]) {
          ch = String.fromCharCode(0x2800 + this.masks[idx]);
          sgr = hexToSgr(this.colors[idx] ?? "#7f8db3");
        } else {
          ch = " ";
          sgr = "";
        }
        if (sgr !== current) {
          if (current || dirty) out += RESET;
          out += sgr;
          current = sgr;
          dirty = true;
        }
        out += ch;
      }
      if (current || dirty) out += RESET;
      lines.push(out);
    }
    return lines;
  }
}
