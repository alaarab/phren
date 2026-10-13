import { describe, expect, it } from "vitest";
import { memoryItems, paletteMode } from "../ui/shell/palette.js";

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
