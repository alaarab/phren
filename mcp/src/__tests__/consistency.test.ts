import { describe, it, expect } from "vitest";
import { FINDING_TYPES, FINDING_TAGS, DOC_TYPES } from "../shared.js";
import { entryScoreKey } from "../shared-governance.js";

describe("taxonomy consistency", () => {
  it("FINDING_TYPES is a subset of FINDING_TAGS", () => {
    for (const t of FINDING_TYPES) {
      expect(FINDING_TAGS).toContain(t);
    }
  });

  it("DOC_TYPES includes findings and canonical", () => {
    expect(DOC_TYPES).toContain("findings");
    expect(DOC_TYPES).toContain("canonical");
  });

  it("FINDING_TYPES has all 6 unified tags", () => {
    expect(FINDING_TYPES).toHaveLength(6);
    expect(FINDING_TYPES).toContain("decision");
    expect(FINDING_TYPES).toContain("pitfall");
    expect(FINDING_TYPES).toContain("pattern");
    expect(FINDING_TYPES).toContain("tradeoff");
    expect(FINDING_TYPES).toContain("architecture");
    expect(FINDING_TYPES).toContain("bug");
  });
});

describe("entryScoreKey stability", () => {
  it("produces the same key for content with trailing text beyond 200 chars", () => {
    const base = "Redis connections need explicit close in finally blocks. ".repeat(5);
    const keyA = entryScoreKey("proj", "FINDINGS.md", base);
    const keyB = entryScoreKey("proj", "FINDINGS.md", base + " extra content that would differ if not sliced ".repeat(10));
    expect(keyA).toBe(keyB);
  });

  it("produces different keys for different projects", () => {
    const content = "Some finding text for testing";
    const keyA = entryScoreKey("proj-a", "FINDINGS.md", content);
    const keyB = entryScoreKey("proj-b", "FINDINGS.md", content);
    expect(keyA).not.toBe(keyB);
  });

  it("produces different keys for different filenames", () => {
    const content = "Some finding text";
    const keyA = entryScoreKey("proj", "FINDINGS.md", content);
    const keyB = entryScoreKey("proj", "CLAUDE.md", content);
    expect(keyA).not.toBe(keyB);
  });
});
