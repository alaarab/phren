import { describe, expect, it } from "vitest";
// @ts-expect-error Plain browser ESM.
import { clusterTicks, currentPrompt, firstLine, layoutFractions, MAX_FOLD_SHARE, MIN_GAP, scrollTarget, shouldShow, stepPrompt, tickLabel, tickPositions, TOP_PAD } from "../ui/chat/outline.js";
// @ts-expect-error Plain browser ESM.
import { onlyRail } from "../ui/chat/find-bar.js";

describe("prompt outline: placement", () => {
  it("positions ticks as a fraction of the content height, clamped", () => {
    expect(tickPositions([0, 500, 2000], 2000)).toEqual([0, 0.25, 1]);
    expect(tickPositions([-10, 3000], 2000)).toEqual([0, 1]);
    expect(tickPositions([100], 0)).toEqual([0]);
  });

  it("lands a prompt just below the top, within the scrollable range", () => {
    expect(scrollTarget(1000)).toBe(1000 - TOP_PAD);
    expect(scrollTarget(5)).toBe(0);
    expect(scrollTarget(1900, 2000, 800)).toBe(1200);
  });

  it("shows for three loaded prompts at 520px or wider, with folded prompts or drawn content over two viewports", () => {
    const base = { prompts: 3, folded: 0, scrollHeight: 1700, clientHeight: 800, width: 1000 };
    expect(shouldShow(base)).toBe(true);
    expect(shouldShow({ ...base, prompts: 2 })).toBe(false);
    expect(shouldShow({ ...base, scrollHeight: 1600 })).toBe(false);
    // Folded prompts are something to jump to, however short the drawn content.
    expect(shouldShow({ ...base, scrollHeight: 1000, folded: 1 })).toBe(true);
    expect(shouldShow({ ...base, scrollHeight: 1000, folded: 1, prompts: 2 })).toBe(false);
    expect(shouldShow({ ...base, width: 519 })).toBe(false);
    expect(shouldShow({ ...base, width: 520 })).toBe(true);
    expect(shouldShow({ ...base, clientHeight: 0 })).toBe(false);
  });

  it("spaces folded prompts evenly in a compressed top segment above the drawn ones", () => {
    const none = layoutFractions({ offsets: [0, 1000], folded: 0, scrollHeight: 2000 });
    expect(none.folded).toEqual([]);
    expect(none.drawn).toEqual([0, 0.5]);
    expect(none.divider).toBeNull();

    const some = layoutFractions({ offsets: [0, 1000], folded: 2, scrollHeight: 2000 });
    expect(some.folded).toHaveLength(2);
    expect(some.folded[1] - some.folded[0]).toBeCloseTo(0.05);
    const many = layoutFractions({ offsets: [0, 1000], folded: 78, scrollHeight: 2000 });
    expect(many.folded).toHaveLength(78);
    expect(Math.max(...many.folded)).toBeLessThanOrEqual(MAX_FOLD_SHARE);
    expect(many.divider!).toBeGreaterThan(MAX_FOLD_SHARE);
    expect(many.drawn[0]).toBeGreaterThan(many.divider!);
    expect(many.drawn[1]).toBeGreaterThan(many.drawn[0]);
    expect(many.drawn[1]).toBeLessThanOrEqual(1);
  });

  it("cuts a tooltip to the first non-empty line and labels merged ticks as a range", () => {
    expect(firstLine("\n  Fix the login flow  \nand more")).toBe("Fix the login flow");
    expect(firstLine("x".repeat(300), 10)).toBe("xxxxxxxxx…");
    expect(firstLine(undefined)).toBe("");
    expect(tickLabel(2, 2, "Cover it")).toBe("Prompt 3: Cover it");
    expect(tickLabel(11, 14, "Cover it")).toBe("Prompts 12–15: Cover it");
  });
});

describe("prompt outline: crowded rails", () => {
  it("merges ticks closer than the minimum gap and keeps every prompt in exactly one run", () => {
    // 80 prompts over a 500px rail: far closer than MIN_GAP.
    const px = Array.from({ length: 80 }, (_, i) => (i / 79) * 500);
    const runs = clusterTicks(px);
    expect(runs.length).toBeLessThan(80);
    expect(runs.length).toBeLessThanOrEqual(Math.floor(500 / MIN_GAP) + 1);
    expect(runs[0].first).toBe(0);
    expect(runs[runs.length - 1].last).toBe(79);
    runs.forEach((run, i) => {
      expect(run.last).toBeGreaterThanOrEqual(run.first);
      if (i) expect(run.first).toBe(runs[i - 1].last + 1);
      if (i) expect(px[run.first] - px[runs[i - 1].first]).toBeGreaterThanOrEqual(MIN_GAP);
    });
  });

  it("leaves well-spaced ticks alone", () => {
    expect(clusterTicks([0, 30, 60])).toEqual([{ first: 0, last: 0 }, { first: 1, last: 1 }, { first: 2, last: 2 }]);
    expect(clusterTicks([])).toEqual([]);
  });
});

describe("prompt outline: current prompt and stepping", () => {
  const offsets = [0, 1000, 2000, 3000];

  it("is the last prompt at or above the top quarter of the view", () => {
    expect(currentPrompt(offsets, 0, 800)).toBe(0);
    expect(currentPrompt(offsets, 700, 800)).toBe(0);
    expect(currentPrompt(offsets, 800, 800)).toBe(1);
    expect(currentPrompt(offsets, 2900, 800)).toBe(3);
    expect(currentPrompt([500], 0, 800)).toBe(0);
    expect(currentPrompt([], 0, 800)).toBe(-1);
  });

  it("steps to the previous and next prompt, and stops at the ends", () => {
    const at = scrollTarget(2000, 5000, 800);
    expect(stepPrompt(offsets, at, -1, 5000, 800)).toBe(1);
    expect(stepPrompt(offsets, at, 1, 5000, 800)).toBe(3);
    expect(stepPrompt(offsets, 0, -1, 5000, 800)).toBe(-1);
    expect(stepPrompt(offsets, scrollTarget(3000, 5000, 800), 1, 5000, 800)).toBe(-1);
    // Between prompts: up goes to the one above, down to the one below.
    expect(stepPrompt(offsets, 1400, -1, 5000, 800)).toBe(1);
    expect(stepPrompt(offsets, 1400, 1, 5000, 800)).toBe(2);
  });

  it("does not step onto a prompt the end of the content cannot scroll to", () => {
    // Content only 3200 tall: the last prompt's goal clamps to the bottom (2400).
    expect(stepPrompt([0, 1000, 3000], 2400, 1, 3200, 800)).toBe(-1);
  });
});

describe("find in chat ignores the rail", () => {
  const inside = { closest: (sel: string) => (sel === ".ct-outline" ? {} : null) };
  const outside = { closest: () => null };
  it("skips mutation batches that are all inside the outline", () => {
    expect(onlyRail([{ target: { nodeType: 1, ...inside } }, { target: { nodeType: 3, parentElement: inside } }])).toBe(true);
    expect(onlyRail([{ target: { nodeType: 1, ...inside } }, { target: { nodeType: 1, ...outside } }])).toBe(false);
    expect(onlyRail([])).toBe(false);
  });
});
