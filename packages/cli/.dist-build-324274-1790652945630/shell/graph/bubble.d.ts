/**
 * Speech bubbles on the graph canvas.
 *
 * Two uses, one primitive. Press space on a node and its whole text opens in
 * a bubble beside it, wrapped wide enough to actually read, because the side
 * pane is a column and a long finding does not fit in a column. In watch
 * mode, a recall that just landed gets a small bubble at its node for a few
 * seconds, so what phren is remembering shows where it lives rather than only
 * in a feed. Pure geometry and strings; the view draws the result.
 */
export type BubbleSide = "left" | "right" | "above" | "below";
export interface BubblePlacement {
    col: number;
    row: number;
    width: number;
    height: number;
    /** Which side of the anchor the bubble sits on. */
    side: BubbleSide;
    /** For left/right: the bubble row level with the anchor, where the tail attaches. */
    tailRow: number;
    /** For above/below: the bubble column level with the anchor. */
    tailCol: number;
}
/** How long a recall's bubble stays at its node before the feed alone carries it. */
export declare const LIVE_BUBBLE_MS = 6000;
/** Cells the border and inner padding add around the text. */
export declare const BUBBLE_CHROME_COLS = 4;
export declare const BUBBLE_CHROME_ROWS = 2;
/**
 * Where to put a bubble of the given text size next to an anchor cell. Prefers
 * beside the anchor on the side with room, then above or below it, and never
 * covers the anchor itself: a bubble that hides the node it is about has
 * failed at its one job. Returns null when it could never fit, so the caller
 * shrinks the text.
 */
export declare function placeBubble(anchor: {
    col: number;
    row: number;
}, cols: number, rows: number, innerWidth: number, innerHeight: number): BubblePlacement | null;
export interface BubbleStyle {
    title?: string;
    footer?: string;
    /** Applied to the border and chrome; the text carries its own styling. */
    frame?: (s: string) => string;
}
/**
 * The bubble's rows, each exactly `innerWidth + 4` cells wide. Beside the
 * anchor, the tail is a `┤` / `├` on the border row level with it; above or
 * below, a `┬` / `┴` on the cap, on the anchor's column.
 */
export declare function bubbleRows(lines: string[], innerWidth: number, placement: Pick<BubblePlacement, "side" | "tailRow" | "tailCol" | "row" | "col">, style?: BubbleStyle): string[];
