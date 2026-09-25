import { describe, it, expect } from "vitest";
import { rrfMerge, recencyBoost } from "../shared/retrieval.js";
import type { DocRow } from "../shared/index.js";

function makeDocRow(project: string, filename: string, type: string, content = ""): DocRow {
  return { project, filename, type, content, path: `/tmp/${project}/${filename}` };
}

describe("rrfMerge", () => {
  it("documents appearing in multiple tiers rank higher than single-tier docs", () => {
    const docA = makeDocRow("proj", "a.md", "findings");
    const docB = makeDocRow("proj", "b.md", "findings");
    const docC = makeDocRow("proj", "c.md", "findings");

    // docA appears in both tiers, docB and docC only in one
    const tier1 = [docA, docB];
    const tier2 = [docC, docA];

    const merged = rrfMerge([tier1, tier2]);
    // docA should be first (appears in 2 tiers)
    expect(merged[0].path).toBe(docA.path);
  });

  it("deduplicates by path key", () => {
    const doc = makeDocRow("proj", "findings.md", "findings");
    const tier1 = [doc];
    const tier2 = [doc];

    const merged = rrfMerge([tier1, tier2]);
    expect(merged.length).toBe(1);
  });

  it("handles empty tiers gracefully", () => {
    const doc = makeDocRow("proj", "a.md", "findings");
    const merged = rrfMerge([[], [doc], []]);
    expect(merged.length).toBe(1);
    expect(merged[0].path).toBe(doc.path);
    expect(rrfMerge([[], [], []])).toEqual([]);
  });
});

describe("recencyBoost", () => {
  it("returns 0.3 for findings <= 7 days old", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(recencyBoost("findings", today)).toBe(0.3);
  });

  it("returns 0.15 for findings 8-30 days old", () => {
    const d = new Date();
    d.setDate(d.getDate() - 15);
    const dateStr = d.toISOString().slice(0, 10);
    expect(recencyBoost("findings", dateStr)).toBe(0.15);
  });

  it("returns 0 for findings > 30 days old", () => {
    const d = new Date();
    d.setDate(d.getDate() - 60);
    const dateStr = d.toISOString().slice(0, 10);
    expect(recencyBoost("findings", dateStr)).toBe(0);
  });

  it("returns 0 for non-findings type", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(recencyBoost("claude", today)).toBe(0);
    expect(recencyBoost("task", today)).toBe(0);
  });

  it("returns 0 for invalid date string", () => {
    expect(recencyBoost("findings", "not-a-date")).toBe(0);
    expect(recencyBoost("findings", "")).toBe(0);
  });
});
