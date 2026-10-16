import { describe, expect, it } from "vitest";
// @ts-expect-error Plain browser ESM.
import { currentPrompt, firstLine, scrollTarget, shouldShow, stepPrompt, tickPositions, TOP_PAD } from "../ui/chat/outline.js";

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

  it("shows only for three prompts, over two viewports, at 520px or wider", () => {
    const base = { prompts: 3, scrollHeight: 1700, clientHeight: 800, width: 1000 };
    expect(shouldShow(base)).toBe(true);
    expect(shouldShow({ ...base, prompts: 2 })).toBe(false);
    expect(shouldShow({ ...base, scrollHeight: 1600 })).toBe(false);
    expect(shouldShow({ ...base, width: 519 })).toBe(false);
    expect(shouldShow({ ...base, width: 520 })).toBe(true);
    expect(shouldShow({ ...base, clientHeight: 0 })).toBe(false);
  });

  it("cuts a tooltip to the first non-empty line", () => {
    expect(firstLine("\n  Fix the login flow  \nand more")).toBe("Fix the login flow");
    expect(firstLine("x".repeat(300), 10)).toBe("xxxxxxxxx…");
    expect(firstLine(undefined)).toBe("");
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
