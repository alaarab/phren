import { describe, it, expect } from "vitest";
import { mergeFindings, extractConflictVersions, validateFinding } from "./content-validate.js";
import { isValidProjectName } from "./utils.js";

describe("mergeFindings", () => {
  it("preserves provenance comments after bullet lines", () => {
    const ours = [
      "# Findings",
      "",
      "## 2025-01-15",
      "",
      "- Use batch API calls for performance",
      '<!-- cortex:cite {"file":"api.ts","line":42} -->',
      "- Cache invalidation needs TTL",
      "",
    ].join("\n");

    const theirs = [
      "# Findings",
      "",
      "## 2025-01-15",
      "",
      "- Retry logic must use exponential backoff",
      '<!-- cortex:cite {"file":"retry.ts","line":10} -->',
      "",
    ].join("\n");

    const merged = mergeFindings(ours, theirs);

    // All three bullet findings should be present
    expect(merged).toContain("- Use batch API calls for performance");
    expect(merged).toContain("- Cache invalidation needs TTL");
    expect(merged).toContain("- Retry logic must use exponential backoff");

    // Provenance comments must survive
    expect(merged).toContain('<!-- cortex:cite {"file":"api.ts","line":42} -->');
    expect(merged).toContain('<!-- cortex:cite {"file":"retry.ts","line":10} -->');
  });

  it("deduplicates by bullet text, keeping ours provenance", () => {
    const ours = [
      "# Findings",
      "",
      "## 2025-01-15",
      "",
      "- Same finding in both",
      '<!-- cortex:cite {"file":"ours.ts","line":1} -->',
      "",
    ].join("\n");

    const theirs = [
      "# Findings",
      "",
      "## 2025-01-15",
      "",
      "- Same finding in both",
      '<!-- cortex:cite {"file":"theirs.ts","line":99} -->',
      "",
    ].join("\n");

    const merged = mergeFindings(ours, theirs);

    // Should only appear once
    const matches = merged.match(/- Same finding in both/g);
    expect(matches).toHaveLength(1);

    // Ours provenance wins
    expect(merged).toContain('<!-- cortex:cite {"file":"ours.ts","line":1} -->');
    expect(merged).not.toContain('<!-- cortex:cite {"file":"theirs.ts","line":99} -->');
  });

  it("handles multi-line provenance comments", () => {
    const ours = [
      "# Findings",
      "",
      "## 2025-02-01",
      "",
      "- Complex finding with metadata",
      '<!-- cortex:cite {"file":"a.ts","line":5} -->',
      "<!-- cortex:confidence 0.9 -->",
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
    expect(merged).toContain('<!-- cortex:cite {"file":"a.ts","line":5} -->');
    expect(merged).toContain("<!-- cortex:confidence 0.9 -->");
    expect(merged).toContain("- Another finding");
  });

  it("merges findings across different dates", () => {
    const ours = [
      "# Findings",
      "",
      "## 2025-01-15",
      "",
      "- Finding A",
      '<!-- cortex:cite {"file":"a.ts"} -->',
      "",
    ].join("\n");

    const theirs = [
      "# Findings",
      "",
      "## 2025-01-16",
      "",
      "- Finding B",
      '<!-- cortex:cite {"file":"b.ts"} -->',
      "",
    ].join("\n");

    const merged = mergeFindings(ours, theirs);

    // Both dates and findings present
    expect(merged).toContain("## 2025-01-16");
    expect(merged).toContain("## 2025-01-15");
    expect(merged).toContain("- Finding A");
    expect(merged).toContain("- Finding B");
    expect(merged).toContain('<!-- cortex:cite {"file":"a.ts"} -->');
    expect(merged).toContain('<!-- cortex:cite {"file":"b.ts"} -->');

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
  it("rejects empty string", () => {
    expect(validateFinding("")).not.toBeNull();
    expect(validateFinding("")).toContain("empty");
  });

  it("rejects whitespace-only string", () => {
    expect(validateFinding("   ")).not.toBeNull();
    expect(validateFinding("   ")).toContain("empty");
  });

  it("rejects strings over 2000 chars", () => {
    const long = "x".repeat(2001);
    const error = validateFinding(long);
    expect(error).not.toBeNull();
    expect(error).toContain("2000");
    expect(error).toContain("2001");
  });

  it("accepts a valid 100-char finding", () => {
    const valid = "a".repeat(100);
    expect(validateFinding(valid)).toBeNull();
  });

  it("accepts a finding at exactly 2000 chars", () => {
    const boundary = "b".repeat(2000);
    expect(validateFinding(boundary)).toBeNull();
  });
});

describe("isValidProjectName edge cases", () => {
  it("rejects '.'", () => {
    expect(isValidProjectName(".")).toBe(false);
  });

  it("rejects '..'", () => {
    expect(isValidProjectName("..")).toBe(false);
  });

  it("rejects names starting with dot (.hidden)", () => {
    expect(isValidProjectName(".hidden")).toBe(false);
  });

  it("rejects names starting with hyphen (-flag)", () => {
    expect(isValidProjectName("-flag")).toBe(false);
  });

  it("accepts 'my-project'", () => {
    expect(isValidProjectName("my-project")).toBe(true);
  });

  it("accepts 'cortex_01'", () => {
    expect(isValidProjectName("cortex_01")).toBe(true);
  });
});
