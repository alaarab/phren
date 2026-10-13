import { describe, expect, it } from "vitest";
import { askItem, memoryItems, paletteMode, projectItems, pullItems } from "../ui/shell/palette.js";

describe("paletteMode", () => {
  it("reads > as commands, ? as the project's memory, anything else as everything", () => {
    expect(paletteMode("> split")).toEqual({ mode: "commands", query: "split" });
    expect(paletteMode("?  login token ")).toEqual({ mode: "memory", query: "login token" });
    expect(paletteMode(" app.ts")).toEqual({ mode: "all", query: "app.ts" });
  });
});

describe("memoryItems", () => {
  it("keeps the Hook's order and labels findings by type and truths as truths, with the match share", () => {
    const rows = memoryItems([
      { kind: "finding", score: 0.82, matched: 3, text: "Set TZ=UTC in the date tests.", finding: { id: "fid:a1", type: "pitfall" } },
      { kind: "truth", score: 0.4, matched: 2, text: "Never push to main.", finding: null },
    ], { computer: "This computer", project: "phren" });
    expect(rows.map((r) => [r.title, r.meta, r.icon])).toEqual([
      ["Set TZ=UTC in the date tests.", "pitfall · 82%", "◆"],
      ["Never push to main.", "truth · 40%", "★"],
    ]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
  });
});

describe("pullItems", () => {
  const pull = (number: number, checks: string | null) => ({ key: `mini/${number}`, computer: "mini", project: "phren", child: { id: String(number) }, number, title: `Change ${number}`, checks, ref: "#" });

  it("lists the watched requests failing first, each opening its session's PRs", () => {
    const opened: unknown[] = [];
    const items = pullItems([pull(7, "passing"), pull(9, "failing"), pull(8, "pending")], (computer: string, child: unknown) => opened.push([computer, child]));
    expect(items.map((i) => [i.title, i.icon, i.meta])).toEqual([
      ["#9 Change 9", "✕", "Checks failing · phren · mini"],
      ["#8 Change 8", "●", "Checks running · phren · mini"],
      ["#7 Change 7", "✓", "Checks passing · phren · mini"],
    ]);
    expect(items[0].boost).toBeGreaterThan(items[1].boost);
    items[0].run();
    expect(opened).toEqual([["mini", { id: "9" }]]);
  });

  it("is empty before the watch has looked", () => {
    expect(pullItems(null, () => {})).toEqual([]);
  });
});

describe("projectItems", () => {
  it("lists each computer's projects and opens the chosen one", () => {
    const opened: unknown[] = [];
    const items = projectItems([{ computer: "mini", name: "phren" }, { computer: "jets", name: "gitboy" }], (p: unknown) => opened.push(p));
    expect(items.map((i) => [i.group, i.title, i.meta])).toEqual([["Projects", "phren", "Project · mini"], ["Projects", "gitboy", "Project · jets"]]);
    items[1].run();
    expect(opened).toEqual([{ computer: "jets", name: "gitboy" }]);
  });
});

describe("askItem", () => {
  it("offers to ask the typed question in a quick chat on the active project", () => {
    const opened: unknown[] = [];
    const item = askItem("why did login break?", { computer: "mini", project: "phren" }, (o: unknown) => opened.push(o))!;
    expect([item.title, item.meta]).toEqual(["Ask in a quick chat: why did login break?", "phren · mini"]);
    item.run();
    expect(opened).toEqual([{ chat: true, project: "phren", computer: "mini", prompt: "why did login break?", title: "Quick chat about phren" }]);
    expect(askItem("", { computer: "mini", project: "phren" }, () => {})).toBeNull();
    expect(askItem("hi", null, () => {})).toBeNull();
  });
});
