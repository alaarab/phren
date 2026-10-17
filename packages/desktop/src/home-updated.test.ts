import { describe, expect, it } from "vitest";
import { updatedLabel } from "../ui/sections/home/updated.js";

const NOW = Date.parse("2026-10-16T12:00:00Z");

describe("updatedLabel", () => {
  it("counts seconds, minutes and hours since the load", () => {
    expect(updatedLabel(NOW - 12_000, NOW)).toBe("Updated 12s ago");
    expect(updatedLabel(NOW - 3 * 60_000, NOW)).toBe("Updated 3m ago");
    expect(updatedLabel(NOW - 2 * 3_600_000, NOW)).toBe("Updated 2h ago");
  });
  it("says just now under ten seconds, and nothing before a first load", () => {
    expect(updatedLabel(NOW - 2_000, NOW)).toBe("Updated just now");
    expect(updatedLabel(undefined, NOW)).toBe("");
  });
});
