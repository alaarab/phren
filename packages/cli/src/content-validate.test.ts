import { describe, it, expect } from "vitest";
import { mergeFindings, validateFinding } from "./content/validate.js";

describe("mergeFindings", () => {
  it("preserves provenance comments after bullet lines", () => {
    const ours = [
      "# Findings",
      "",
      "## 2025-01-15",
      "",
      "- Use batch API calls for performance",
      '<!-- phren:cite {"file":"api.ts","line":42} -->',
      "- Cache invalidation needs TTL",
      "",
    ].join("\n");

    const theirs = [
      "# Findings",
      "",
      "## 2025-01-15",
      "",
      "- Retry logic must use exponential backoff",
      '<!-- phren:cite {"file":"retry.ts","line":10} -->',
      "",
    ].join("\n");

    const merged = mergeFindings(ours, theirs);

    // All three bullet findings should be present
    expect(merged).toContain("- Use batch API calls for performance");
    expect(merged).toContain("- Cache invalidation needs TTL");
    expect(merged).toContain("- Retry logic must use exponential backoff");

    // Provenance comments must survive
    expect(merged).toContain('<!-- phren:cite {"file":"api.ts","line":42} -->');
    expect(merged).toContain('<!-- phren:cite {"file":"retry.ts","line":10} -->');
  });

  it("deduplicates by bullet text, keeping ours provenance", () => {
    const ours = [
      "# Findings",
      "",
      "## 2025-01-15",
      "",
      "- Same finding in both",
      '<!-- phren:cite {"file":"ours.ts","line":1} -->',
      "",
    ].join("\n");

    const theirs = [
      "# Findings",
      "",
      "## 2025-01-15",
      "",
      "- Same finding in both",
      '<!-- phren:cite {"file":"theirs.ts","line":99} -->',
      "",
    ].join("\n");

    const merged = mergeFindings(ours, theirs);

    // Should only appear once
    const matches = merged.match(/- Same finding in both/g);
    expect(matches).toHaveLength(1);

    // Ours provenance wins
    expect(merged).toContain('<!-- phren:cite {"file":"ours.ts","line":1} -->');
    expect(merged).not.toContain('<!-- phren:cite {"file":"theirs.ts","line":99} -->');
  });

  it("handles multi-line provenance comments", () => {
    const ours = [
      "# Findings",
      "",
      "## 2025-02-01",
      "",
      "- Complex finding with metadata",
      '<!-- phren:cite {"file":"a.ts","line":5} -->',
      "<!-- phren:confidence 0.9 -->",
      "",
    ].join("\n");

    const theirs = [
      "# Findings",
      "",
      "## 2025-02-01",
      "",
      "- Another finding",
      "",
    ].join("\n");

    const merged = mergeFindings(ours, theirs);

    expect(merged).toContain("- Complex finding with metadata");
    expect(merged).toContain('<!-- phren:cite {"file":"a.ts","line":5} -->');
    expect(merged).toContain("<!-- phren:confidence 0.9 -->");
    expect(merged).toContain("- Another finding");
  });

  it("merges findings across different dates", () => {
    const ours = [
      "# Findings",
      "",
      "## 2025-01-15",
      "",
      "- Finding A",
      '<!-- phren:cite {"file":"a.ts"} -->',
      "",
    ].join("\n");

    const theirs = [
      "# Findings",
      "",
      "## 2025-01-16",
      "",
      "- Finding B",
      '<!-- phren:cite {"file":"b.ts"} -->',
      "",
    ].join("\n");

    const merged = mergeFindings(ours, theirs);

    // Both dates and findings present
    expect(merged).toContain("## 2025-01-16");
    expect(merged).toContain("## 2025-01-15");
    expect(merged).toContain("- Finding A");
    expect(merged).toContain("- Finding B");
    expect(merged).toContain('<!-- phren:cite {"file":"a.ts"} -->');
    expect(merged).toContain('<!-- phren:cite {"file":"b.ts"} -->');

    // Newer date first
    const idx16 = merged.indexOf("## 2025-01-16");
    const idx15 = merged.indexOf("## 2025-01-15");
    expect(idx16).toBeLessThan(idx15);
  });

  it("handles findings without provenance comments", () => {
    const ours = [
      "# Findings",
      "",
      "## 2025-01-15",
      "",
      "- Simple finding without comments",
      "",
    ].join("\n");

    const theirs = [
      "# Findings",
      "",
      "## 2025-01-15",
      "",
      "- Another simple finding",
      "",
    ].join("\n");

    const merged = mergeFindings(ours, theirs);

    expect(merged).toContain("- Simple finding without comments");
    expect(merged).toContain("- Another simple finding");
  });
});

describe("validateFinding", () => {
  it.each([
    ["", "empty"],
    ["   ", "empty"],
    ["x".repeat(2001), "2000"],
  ])("rejects %j", (text, message) => {
    expect(validateFinding(text)).toContain(message);
  });

  it("reports the actual length of an oversized finding", () => {
    expect(validateFinding("x".repeat(2001))).toContain("2001");
  });

  it.each([100, 2000])("accepts a finding of %i chars (2000 is the inclusive limit)", (length) => {
    expect(validateFinding("b".repeat(length))).toBeNull();
  });
});
