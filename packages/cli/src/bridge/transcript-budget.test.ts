import { describe, expect, it } from "vitest";
import { clampRows, PAGE_BYTES } from "./transcript-budget.js";

describe("a transcript line too large for a page", () => {
  it("keeps tool arguments stored as JSON text parseable", () => {
    const call = { type: "response_item", payload: { type: "function_call", name: "apply_patch", call_id: "call_1",
      arguments: JSON.stringify({ path: "src/a.ts", content: "a".repeat(1_000_000) }) } };
    const { rows, size } = clampRows([call]);
    expect(size).toBeLessThanOrEqual(PAGE_BYTES);
    const payload = rows[0].payload as { call_id: string; arguments: string };
    expect(payload.call_id).toBe("call_1");
    const args = JSON.parse(payload.arguments);
    expect(args.path).toBe("src/a.ts");
    expect(args.content).toContain("characters left out");
  });

  it("keeps the start and end of a list of thousands of short items, each still an item", () => {
    const content = Array.from({ length: 50_000 }, (_, at) => ({ type: "text", text: `item ${at}` }));
    const { rows, size } = clampRows([{ type: "user", message: { role: "user", content } }]);
    expect(size).toBeLessThanOrEqual(PAGE_BYTES);
    const kept = (rows[0].message as { content: { type: string; text: string }[] }).content;
    expect(kept.every(item => item.type === "text")).toBe(true);
    expect([kept[0].text, kept.at(-1)!.text]).toEqual(["item 0", "item 49999"]);
  });

  it("never cuts inside a surrogate pair, which a phone's JSON decoder refuses", () => {
    for (const lead of ["", "a"]) {
      const { rows, size } = clampRows([{ message: { content: lead + "😀".repeat(300_000) } }]);
      expect(size).toBeLessThanOrEqual(PAGE_BYTES);
      expect(((rows[0].message as { content: string }).content).isWellFormed()).toBe(true);
    }
  });
});
