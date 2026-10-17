import { describe, expect, it } from "vitest";
import { closeTargets, keptNotice, planClose, tabMenuItems } from "../ui/shell/tab-close.js";

const order = ["a", "b", "c", "d"];

describe("closeTargets", () => {
  it("others: everything but the tab, rightmost first", () => {
    expect(closeTargets(order, "b", "others")).toEqual(["d", "c", "a"]);
  });
  it("right: only the tabs after it, rightmost first", () => {
    expect(closeTargets(order, "b", "right")).toEqual(["d", "c"]);
    expect(closeTargets(order, "d", "right")).toEqual([]);
  });
  it("does nothing for an unknown tab or mode", () => {
    expect(closeTargets(order, "x", "others")).toEqual([]);
    expect(closeTargets(order, "a", "self")).toEqual([]);
  });
  it("does not change its input", () => {
    const copy = [...order];
    closeTargets(copy, "a", "others");
    expect(copy).toEqual(order);
  });
});

describe("tabMenuItems", () => {
  const enabled = (o: string[], id: string) => Object.fromEntries(tabMenuItems(o, id).map((i) => [i.id, i.enabled]));
  it("lists the four entries in order", () => {
    expect(tabMenuItems(order, "b").map((i) => i.label)).toEqual(["Close", "Close others", "Close to the right", "Move to new split (right)"]);
  });
  it("disables what would do nothing", () => {
    expect(enabled(["a"], "a")).toEqual({ close: true, others: false, right: false, split: false });
    expect(enabled(order, "d")).toEqual({ close: true, others: true, right: false, split: true });
    expect(enabled(order, "a")).toEqual({ close: true, others: true, right: true, split: true });
  });
  it("is empty for a tab that is not there", () => {
    expect(tabMenuItems(order, "x")).toEqual([]);
  });
});

describe("planClose", () => {
  it("closes clean tabs and asks about the first dirty one only", () => {
    const dirty = new Set(["d", "b"]);
    expect(planClose(["d", "c", "b", "a"], (id: string) => dirty.has(id))).toEqual({ clean: ["c", "a"], ask: "d", kept: 1 });
  });
  it("asks about nothing when all are clean", () => {
    expect(planClose(["b", "a"], () => false)).toEqual({ clean: ["b", "a"], ask: null, kept: 0 });
  });
  it("one dirty tab is asked about and nothing is kept", () => {
    expect(planClose(["a"], () => true)).toEqual({ clean: [], ask: "a", kept: 0 });
  });
});

describe("keptNotice", () => {
  it("is silent for none and counts the rest", () => {
    expect(keptNotice(0)).toBeNull();
    expect(keptNotice(1)).toBe("1 more tab has unsaved changes and stayed open");
    expect(keptNotice(3)).toBe("3 more tabs have unsaved changes and stayed open");
  });
});
