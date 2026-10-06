import { describe, expect, it } from "vitest";
import { stripAnsi } from "../render.js";
import { bubbleRows, placeBubble } from "./bubble.js";

describe("placeBubble", () => {
  it("sits to the right of the anchor when there is room, with a gap for the tail", () => {
    const p = placeBubble({ col: 10, row: 10 }, 120, 30, 30, 4)!;
    expect(p.side).toBe("right");
    expect(p.col).toBe(13);
    expect(p.width).toBe(34);
    expect(p.height).toBe(6);
    expect(p.tailRow).toBe(10);
  });

  it("flips to the left when the right edge is close", () => {
    const p = placeBubble({ col: 110, row: 10 }, 120, 30, 30, 4)!;
    expect(p.side).toBe("left");
    expect(p.col + p.width).toBe(108);
  });

  it("clamps into the canvas instead of running off the top or bottom", () => {
    const top = placeBubble({ col: 10, row: 0 }, 120, 30, 30, 4)!;
    expect(top.row).toBe(0);
    expect(top.tailRow).toBe(1); // still on a text row, not the border
    const bottom = placeBubble({ col: 10, row: 29 }, 120, 30, 30, 4)!;
    expect(bottom.row + bottom.height).toBe(30);
    expect(bottom.tailRow).toBe(bottom.row + bottom.height - 2);
  });

  it("goes below or above when neither side has room, and never covers its anchor", () => {
    // A wide bubble on a canvas where the anchor sits mid-width: no side fits.
    const below = placeBubble({ col: 40, row: 5 }, 80, 30, 60, 4)!;
    expect(below.side).toBe("below");
    expect(below.row).toBe(7);
    expect(below.tailCol).toBe(40);
    const above = placeBubble({ col: 40, row: 25 }, 80, 30, 60, 4)!;
    expect(above.side).toBe("above");
    expect(above.row + above.height).toBe(24);
    // Property: wherever the anchor is, the bubble never contains it.
    for (let col = 0; col < 80; col += 7) for (let row = 0; row < 30; row += 5) {
      const p = placeBubble({ col, row }, 80, 30, 60, 4);
      if (!p) continue;
      const inside = col >= p.col && col < p.col + p.width && row >= p.row && row < p.row + p.height;
      expect(inside, `anchor ${col},${row} covered by ${JSON.stringify(p)}`).toBe(false);
    }
  });

  it("refuses a bubble that could never fit, so the caller can shrink it", () => {
    expect(placeBubble({ col: 5, row: 5 }, 40, 20, 50, 4)).toBeNull();
    expect(placeBubble({ col: 5, row: 5 }, 40, 20, 20, 30)).toBeNull();
  });
});

describe("bubbleRows", () => {
  it("draws a box of exact width with the tail on the anchor's side", () => {
    const rows = bubbleRows(["hello", "world"], 10, { side: "right", tailRow: 6, row: 4, col: 0, tailCol: 0 }, { title: "finding", footer: "␣ close" });
    expect(rows).toHaveLength(4);
    for (const r of rows) expect(stripAnsi(r).length).toBe(14);
    expect(stripAnsi(rows[0])).toBe("╭─ finding ──╮");
    expect(stripAnsi(rows[1])).toBe("│ hello      │");
    expect(stripAnsi(rows[2])).toBe("┤ world      │"); // row 6 = tail, facing left toward the anchor
    expect(stripAnsi(rows[3])).toBe("╰─ ␣ close ──╯");
  });

  it("puts the tail on the right border when the bubble sits left of the anchor", () => {
    const rows = bubbleRows(["a"], 4, { side: "left", tailRow: 1, row: 0, col: 0, tailCol: 7 });
    expect(stripAnsi(rows[1])).toBe("│ a    ├");
  });

  it("drops a title that would not fit rather than overflowing the border", () => {
    const rows = bubbleRows(["a"], 4, { side: "right", tailRow: 1, row: 0, col: 0, tailCol: 0 }, { title: "much too long a title" });
    expect(stripAnsi(rows[0])).toBe("╭──────╮");
  });

  it("puts the tail on the cap, on the anchor's column, when stacked", () => {
    const below = bubbleRows(["a"], 6, { side: "below", tailRow: 0, row: 0, col: 10, tailCol: 14 });
    expect(stripAnsi(below[0])).toBe("╭───┴────╮");
    const above = bubbleRows(["a"], 6, { side: "above", tailRow: 2, row: 0, col: 10, tailCol: 12 }, { footer: "x" });
    expect(stripAnsi(above[2])).toBe("╰─ x ────╯"); // the footer label wins over the tail where they overlap
    const aboveNoFooter = bubbleRows(["a"], 6, { side: "above", tailRow: 2, row: 0, col: 10, tailCol: 12 });
    expect(stripAnsi(aboveNoFooter[2])).toBe("╰─┬──────╯");
  });
});
