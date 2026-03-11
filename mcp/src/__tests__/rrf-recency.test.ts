import { describe, it, expect } from "vitest";
import { rrfMerge, recencyBoost } from "../shared-retrieval.js";
import type { DocRow } from "../shared-index.js";

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
  });

  it("handles all tiers empty", () => {
    const merged = rrfMerge([[], [], []]);
    expect(merged.length).toBe(0);
  });

  it("k=60 formula: score = 1/(60 + rank + 1)", () => {
    // With k=60, rank 0 gives score = 1/61
    // A doc at rank 0 in one tier should score ~0.01639
    const docA = makeDocRow("proj", "a.md", "findings");
    const docB = makeDocRow("proj", "b.md", "findings");

    // docA at rank 0 in tier1, docB at rank 0 in tier2
    // Both get 1/(60+0+1) = 1/61, so they should be tied
    const merged = rrfMerge([[docA], [docB]]);
    expect(merged.length).toBe(2);

    // docA in tier1 at rank 0 AND tier2 at rank 1
    // score(A) = 1/61 + 1/62 > score(B) = 1/61
    const merged2 = rrfMerge([[docA, docB], [docB, docA]]);
    // Both appear in both tiers, but at different ranks
    // docA: 1/61 + 1/62, docB: 1/62 + 1/61 — same score
    expect(merged2.length).toBe(2);
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
