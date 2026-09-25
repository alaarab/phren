/**
 * Collision resolver for the memory viewer's screen-space labels. Fixed
 * rectangles only: group labels always win, leaves rank by priority, then
 * stickiness, then degree then recency, hysteresis stops marginal overlaps
 * from flickering a label out, and the draw cap counts every label with a
 * floor large enough to keep project landmarks on a phone-sized viewport.
 */

import { describe, expect, it } from "vitest";
import { labelDrawCap, rectsIntersect, resolveLabelOverlaps } from "./labels.js";
import type { LabelCandidate, LabelRect } from "./labels.js";

function rect(x: number, y: number, w = 100, h = 20): LabelRect {
  return { x0: x, y0: y, x1: x + w, y1: y + h };
}

function candidate(id: string, r: LabelRect, over: Partial<LabelCandidate> = {}): LabelCandidate {
  return { id, rect: r, isGroup: false, degree: 0, recency: 0, ...over };
}

describe("rectsIntersect", () => {
  it("is true only for overlapping interiors", () => {
    expect(rectsIntersect(rect(0, 0), rect(50, 5))).toBe(true);
    expect(rectsIntersect(rect(0, 0), rect(100, 0))).toBe(false);
    expect(rectsIntersect(rect(0, 0), rect(200, 0))).toBe(false);
    expect(rectsIntersect(rect(0, 0), rect(0, 20))).toBe(false);
  });
});

describe("labelDrawCap", () => {
  it("scales with viewport area inside min/max bounds", () => {
    // Floor is 40 so a phone canvas still fits a full project navigator.
    expect(labelDrawCap(390, 750)).toBe(40);
    expect(labelDrawCap(10, 10)).toBe(40);
    expect(labelDrawCap(8000, 8000)).toBe(72);
    expect(labelDrawCap(1200, 900, { areaPerLabel: 6000 })).toBe(72);
    expect(labelDrawCap(400, 500, { areaPerLabel: 4000, min: 4, max: 100 })).toBe(50);
    expect(labelDrawCap(2000, 2000)).toBe(72); // area share above floor
  });
});

describe("resolveLabelOverlaps", () => {
  it("keeps non-intersecting labels", () => {
    const visible = resolveLabelOverlaps(
      [candidate("a", rect(0, 0)), candidate("b", rect(400, 0))],
      { cap: 10 },
    );
    expect([...visible].sort()).toEqual(["a", "b"]);
  });

  it("hides a finding whose rectangle intersects a group label", () => {
    const visible = resolveLabelOverlaps(
      [
        candidate("g", rect(100, 40, 120, 22), { isGroup: true, degree: 26, recency: 1 }),
        candidate("f", rect(140, 48, 90, 16), { degree: 4, recency: 9 }),
      ],
      { cap: 10 },
    );
    expect(visible.has("g")).toBe(true);
    expect(visible.has("f")).toBe(false);
  });

  it("never lets a group yield to a higher-degree leaf", () => {
    const visible = resolveLabelOverlaps(
      [
        candidate("f", rect(0, 0, 200, 40), { degree: 99, recency: 99 }),
        candidate("g", rect(10, 5, 120, 22), { isGroup: true, degree: 1, recency: 0 }),
      ],
      { cap: 10 },
    );
    expect(visible.has("g")).toBe(true);
    expect(visible.has("f")).toBe(false);
  });

  it("hides the lower-ranked group when two group labels overlap", () => {
    const visible = resolveLabelOverlaps(
      [
        candidate("big", rect(0, 0, 140, 22), { isGroup: true, degree: 26 }),
        candidate("small", rect(20, 4, 140, 22), { isGroup: true, degree: 3 }),
      ],
      { cap: 10 },
    );
    expect(visible.has("big")).toBe(true);
    expect(visible.has("small")).toBe(false);

    const byRecency = resolveLabelOverlaps(
      [
        candidate("older", rect(0, 0, 140, 22), { isGroup: true, degree: 5, recency: 100 }),
        candidate("newer", rect(20, 4, 140, 22), { isGroup: true, degree: 5, recency: 200 }),
      ],
      { cap: 10 },
    );
    expect(byRecency.has("newer")).toBe(true);
    expect(byRecency.has("older")).toBe(false);
  });

  it("ranks overlapping leaves by degree, then recency", () => {
    const byDegree = resolveLabelOverlaps(
      [
        candidate("low", rect(0, 0), { degree: 1, recency: 99 }),
        candidate("high", rect(10, 2), { degree: 12, recency: 0 }),
      ],
      { cap: 10 },
    );
    expect(byDegree.has("high")).toBe(true);
    expect(byDegree.has("low")).toBe(false);

    const byRecency = resolveLabelOverlaps(
      [
        candidate("old", rect(0, 0), { degree: 5, recency: 100 }),
        candidate("new", rect(10, 2), { degree: 5, recency: 200 }),
      ],
      { cap: 10 },
    );
    expect(byRecency.has("new")).toBe(true);
    expect(byRecency.has("old")).toBe(false);
  });

  it("applies focus priority before stickiness and degree within a tier", () => {
    const visible = resolveLabelOverlaps(
      [
        candidate("hub", rect(0, 0), { degree: 1, priority: 0 }),
        candidate("hovered", rect(10, 2), { degree: 0, priority: 3 }),
      ],
      { cap: 10 },
    );
    expect(visible.has("hovered")).toBe(true);
    expect(visible.has("hub")).toBe(false);

    // Priority still outranks a sticky lower-priority leaf.
    const stickyLoses = resolveLabelOverlaps(
      [
        candidate("hovered", rect(10, 2), { degree: 0, priority: 3 }),
        candidate("shown", rect(0, 0), { degree: 5, priority: 0 }),
      ],
      { cap: 10, previousVisible: new Set(["shown"]) },
    );
    expect(stickyLoses.has("hovered")).toBe(true);
    expect(stickyLoses.has("shown")).toBe(false);
  });

  it("hysteresis keeps a previously visible leaf through a marginal overlap", () => {
    // Sticky outranks the higher-degree newcomer, so it is placed first and
    // the newcomer's hysteresis expansion hits the shown label.
    const sticky = resolveLabelOverlaps(
      [
        candidate("newcomer", rect(98, 0), { degree: 50 }),
        candidate("shown", rect(0, 0), { degree: 1 }),
      ],
      { cap: 10, previousVisible: new Set(["shown"]), hysteresisPx: 3 },
    );
    expect(sticky.has("shown")).toBe(true);
    expect(sticky.has("newcomer")).toBe(false);

    const fresh = resolveLabelOverlaps(
      [
        candidate("newcomer", rect(98, 0), { degree: 50 }),
        candidate("shown", rect(0, 0), { degree: 1 }),
      ],
      { cap: 10, previousVisible: new Set(), hysteresisPx: 3 },
    );
    expect(fresh.has("newcomer")).toBe(true);
    expect(fresh.has("shown")).toBe(false);
  });

  it("lets a sticky leaf survive a higher-priority neighbour via shrink", () => {
    // Hovered newcomer places first (priority); the sticky leaf shrinks by
    // the dead band and still fits beside a marginal overlap.
    const visible = resolveLabelOverlaps(
      [
        candidate("hovered", rect(98, 0), { degree: 50, priority: 3 }),
        candidate("shown", rect(0, 0), { degree: 1, priority: 0 }),
      ],
      { cap: 10, previousVisible: new Set(["shown"]), hysteresisPx: 3 },
    );
    expect(visible.has("hovered")).toBe(true);
    expect(visible.has("shown")).toBe(true);
  });

  it("still drops a sticky leaf that hard-overlaps a group", () => {
    const visible = resolveLabelOverlaps(
      [
        candidate("g", rect(0, 0, 120, 22), { isGroup: true }),
        candidate("f", rect(40, 4, 80, 16), { degree: 9 }),
      ],
      { cap: 10, previousVisible: new Set(["f"]), hysteresisPx: 3 },
    );
    expect(visible.has("g")).toBe(true);
    expect(visible.has("f")).toBe(false);
  });

  it("blocks a new leaf that only clears a shown label without hysteresis room", () => {
    const visible = resolveLabelOverlaps(
      [
        candidate("shown", rect(0, 0), { degree: 5, recency: 100 }),
        candidate("newcomer", rect(105, 0), { degree: 5, recency: 100 }),
      ],
      { cap: 10, previousVisible: new Set(["shown"]), hysteresisPx: 6 },
    );
    expect(visible.has("shown")).toBe(true);
    expect(visible.has("newcomer")).toBe(false);

    const roomy = resolveLabelOverlaps(
      [
        candidate("shown", rect(0, 0), { degree: 5, recency: 100 }),
        candidate("newcomer", rect(110, 0), { degree: 5, recency: 100 }),
      ],
      { cap: 10, previousVisible: new Set(["shown"]), hysteresisPx: 6 },
    );
    expect(roomy.has("shown")).toBe(true);
    expect(roomy.has("newcomer")).toBe(true);
  });

  it("does not false-block a sticky leaf when shrink inverts a tiny rect", () => {
    // 5px-wide sticky label, 3px dead band: erosion would invert the rect.
    // An inverted rect must count as empty, not as a wild intersection that
    // drops the sticky label against a large neighbour it does not overlap.
    const far: LabelCandidate = candidate("far", rect(50, 0, 5, 4), { degree: 1 });
    const near: LabelCandidate = candidate("near", rect(0, 0, 40, 20), { degree: 9 });
    const visible = resolveLabelOverlaps(
      [near, far],
      { cap: 10, previousVisible: new Set(["far"]), hysteresisPx: 3 },
    );
    // "far" is 10px clear of "near"; sticky erosion must not invent a hit.
    expect(visible.has("far")).toBe(true);
    expect(visible.has("near")).toBe(true);
  });

  it("counts groups in the draw cap and keeps landmarks first", () => {
    const candidates = [
      candidate("g1", rect(0, 0), { isGroup: true, degree: 3 }),
      candidate("g2", rect(0, 40), { isGroup: true, degree: 2 }),
      candidate("g3", rect(0, 80), { isGroup: true, degree: 1 }),
      candidate("f1", rect(0, 120), { degree: 9 }),
      candidate("f2", rect(0, 160), { degree: 8 }),
      candidate("f3", rect(0, 200), { degree: 7 }),
    ];
    const visible = resolveLabelOverlaps(candidates, { cap: 4 });
    expect([...visible].sort()).toEqual(["f1", "g1", "g2", "g3"]);
  });

  it("keeps a sticky low-degree leaf over a higher-degree newcomer under a tight cap", () => {
    const candidates = [
      candidate("shown", rect(0, 0), { degree: 1 }),
      candidate("newcomer", rect(400, 0), { degree: 50 }),
    ];
    const sticky = resolveLabelOverlaps(candidates, {
      cap: 1,
      previousVisible: new Set(["shown"]),
    });
    expect([...sticky]).toEqual(["shown"]);

    const fresh = resolveLabelOverlaps(candidates, {
      cap: 1,
      previousVisible: new Set(),
    });
    expect([...fresh]).toEqual(["newcomer"]);
  });

  it("handles empty candidates and cap 0 without throwing", () => {
    expect(resolveLabelOverlaps([], { cap: 10 }).size).toBe(0);
    expect(resolveLabelOverlaps([], { cap: 0 }).size).toBe(0);
    // Cap counts groups too: nothing draws at a zero budget.
    const visible = resolveLabelOverlaps(
      [
        candidate("g", rect(0, 0), { isGroup: true }),
        candidate("f", rect(200, 0), { degree: 3 }),
      ],
      { cap: 0 },
    );
    expect(visible.size).toBe(0);
  });

  it("keeps the first candidate when ids are duplicated", () => {
    const visible = resolveLabelOverlaps(
      [
        candidate("dup", rect(0, 0), { degree: 1, recency: 100 }),
        candidate("dup", rect(400, 0), { degree: 99, recency: 999 }),
        candidate("other", rect(800, 0), { degree: 1 }),
      ],
      { cap: 10 },
    );
    expect([...visible].sort()).toEqual(["dup", "other"]);
    // First "dup" is rank-low; a second copy with the same id cannot re-place
    // at a different rect or steal a better rank.
    const contested = resolveLabelOverlaps(
      [
        candidate("dup", rect(0, 0), { degree: 1 }),
        candidate("dup", rect(0, 0), { degree: 99 }),
        candidate("rival", rect(10, 2), { degree: 50 }),
      ],
      { cap: 10 },
    );
    expect(contested.has("dup")).toBe(true);
    expect(contested.has("rival")).toBe(false);
  });

  it("writes into a caller-supplied Set without allocating a new one", () => {
    const into = new Set(["stale"]);
    const result = resolveLabelOverlaps(
      [candidate("a", rect(0, 0)), candidate("b", rect(400, 0))],
      { cap: 10, into },
    );
    expect(result).toBe(into);
    expect([...into].sort()).toEqual(["a", "b"]);
  });

  it("inserts a readability pad between rectangles", () => {
    const pair = (pad: number) =>
      resolveLabelOverlaps(
        [candidate("a", rect(0, 0, 100, 20)), candidate("b", rect(105, 0, 100, 20), { degree: 1 })],
        { cap: 10, pad },
      );
    expect(pair(0).size).toBe(2);
    expect(pair(6).size).toBe(1);
  });
});
