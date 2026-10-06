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
export type ColorMode = "truecolor" | "256";
/** Tests pin the mode; real terminals are sniffed from COLORTERM/TERM. */
export declare function setColorMode(mode: ColorMode | null): void;
export declare function colorMode(): ColorMode;
export declare function hexToRgb(hex: string): [number, number, number];
export declare function rgbToHex(r: number, g: number, b: number): string;
/** Linear blend from `from` toward `to` by `t` in [0, 1]. */
export declare function blendHex(from: string, to: string, t: number): string;
/** Nearest xterm-256 index: 6×6×6 colour cube, or the grey ramp for greys. */
export declare function hexToAnsi256(hex: string): number;
/** Foreground SGR for a hex colour in the active colour mode. */
export declare function hexToSgr(hex: string): string;
export interface DotOptions {
    /** Higher z wins when two draws hit the same cell (node dots beat edges). */
    z?: number;
    /** Light every other dot along a line. */
    dotted?: boolean;
}
export declare class BrailleCanvas {
    readonly cols: number;
    readonly rows: number;
    private readonly masks;
    private readonly zs;
    private readonly colors;
    private readonly overlay;
    constructor(cols: number, rows: number);
    get dotWidth(): number;
    get dotHeight(): number;
    private cell;
    setDot(x: number, y: number, color: string, z?: number): void;
    /** Bresenham in dot space. */
    line(x0: number, y0: number, x1: number, y1: number, color: string, opts?: DotOptions): void;
    /** Filled disc in dot space; radius 0 lights a single dot. */
    disc(cx: number, cy: number, radius: number, color: string, z?: number): void;
    /**
     * True when the cells [col, col+width) on `row` hold no overlay text —
     * and, with `avoidDots`, no braille dots either, so a label does not
     * paint over somebody else's node or edge.
     */
    isFree(col: number, row: number, width: number, avoidDots?: boolean): boolean;
    /**
     * Write styled text into the overlay. Characters wider than one cell are
     * replaced with `·` so the row stays exactly `cols` wide. Returns the number
     * of cells written (0 when the text starts off-canvas).
     */
    putText(col: number, row: number, text: string, sgr?: string): number;
    /**
     * Overlay a line that already carries ANSI styling, one cell per visible
     * character. Each cell records the full attribute state in force at that
     * point (everything since the last reset), so the renderer can switch
     * styles cell by cell without leaking bold or colour into the neighbours.
     */
    putStyled(col: number, row: number, styled: string): number;
    /** Every cell in a rectangle is overlaid with a space, hiding dots underneath (pane backdrop). */
    clearRect(col: number, row: number, width: number, height: number): void;
    render(): string[];
}
