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
import { displayWidth, padToWidth } from "../render.js";
/** How long a recall's bubble stays at its node before the feed alone carries it. */
export const LIVE_BUBBLE_MS = 6000;
/** Cells the border and inner padding add around the text. */
export const BUBBLE_CHROME_COLS = 4;
export const BUBBLE_CHROME_ROWS = 2;
/**
 * Where to put a bubble of the given text size next to an anchor cell. Prefers
 * beside the anchor on the side with room, then above or below it, and never
 * covers the anchor itself: a bubble that hides the node it is about has
 * failed at its one job. Returns null when it could never fit, so the caller
 * shrinks the text.
 */
export function placeBubble(anchor, cols, rows, innerWidth, innerHeight) {
    const width = innerWidth + BUBBLE_CHROME_COLS;
    const height = innerHeight + BUBBLE_CHROME_ROWS;
    if (width > cols || height > rows)
        return null;
    const gap = 2;
    const clampRow = (r) => Math.max(0, Math.min(rows - height, r));
    const clampCol = (c) => Math.max(0, Math.min(cols - width, c));
    const beside = (side) => {
        const col = side === "right" ? anchor.col + 1 + gap : anchor.col - gap - width;
        const row = clampRow(anchor.row - Math.floor(height / 2));
        const tailRow = Math.max(row + 1, Math.min(row + height - 2, anchor.row));
        return { col, row, width, height, side, tailRow, tailCol: side === "right" ? col : col + width - 1 };
    };
    if (cols - (anchor.col + 1 + gap) >= width)
        return beside("right");
    if (anchor.col - gap >= width)
        return beside("left");
    // No room beside it: go above or below, whichever has the space, and slide
    // sideways within the canvas while keeping the tail on the anchor's column.
    const stacked = (side) => {
        const row = side === "below" ? anchor.row + 1 + 1 : anchor.row - 1 - height;
        const col = clampCol(anchor.col - Math.floor(width / 2));
        const tailCol = Math.max(col + 1, Math.min(col + width - 2, anchor.col));
        return { col, row, width, height, side, tailRow: side === "below" ? row : row + height - 1, tailCol };
    };
    if (rows - (anchor.row + 2) >= height)
        return stacked("below");
    if (anchor.row - 1 >= height)
        return stacked("above");
    return null;
}
/**
 * The bubble's rows, each exactly `innerWidth + 4` cells wide. Beside the
 * anchor, the tail is a `┤` / `├` on the border row level with it; above or
 * below, a `┬` / `┴` on the cap, on the anchor's column.
 */
export function bubbleRows(lines, innerWidth, placement, style = {}) {
    const frame = style.frame ?? ((s) => s);
    const cap = (label, left, right, tail) => {
        const span = innerWidth + 2;
        let bar;
        let styledLabel = "";
        if (!label || displayWidth(label) > innerWidth - 1) {
            bar = Array.from({ length: span }, () => "─");
        }
        else {
            // "─ label ─…": the label is spliced in after one bar cell.
            bar = Array.from({ length: span }, () => "─");
            styledLabel = label;
        }
        if (tail !== null) {
            const at = placement.tailCol - placement.col - 1;
            if (at >= 0 && at < span)
                bar[at] = tail;
        }
        if (!styledLabel)
            return frame(`${left}${bar.join("")}${right}`);
        const labelWidth = displayWidth(styledLabel);
        // Keep the tail if it falls outside the label's span; the label wins otherwise.
        const head = bar.slice(0, 1).join("");
        const tailPart = bar.slice(1 + 1 + labelWidth + 1).join("");
        return `${frame(`${left}${head} `)}${styledLabel}${frame(` ${tailPart}${right}`)}`;
    };
    const out = [cap(style.title, "╭", "╮", placement.side === "below" ? "┴" : null)];
    lines.forEach((line, i) => {
        const rowIndex = placement.row + 1 + i;
        const tail = rowIndex === placement.tailRow;
        const left = frame(tail && placement.side === "right" ? "┤" : "│");
        const right = frame(tail && placement.side === "left" ? "├" : "│");
        out.push(`${left} ${padToWidth(line, innerWidth)} ${right}`);
    });
    out.push(cap(style.footer, "╰", "╯", placement.side === "above" ? "┬" : null));
    return out;
}
