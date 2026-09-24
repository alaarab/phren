import { describe, it, expect } from "vitest";
import { mergeFindings, extractConflictVersions, validateFinding } from "./content/validate.js";
import { isValidProjectName } from "./utils.js";

describe("mergeFindings: nothing is dropped on a sync conflict", () => {
  // These run unattended (push_changes, session-stop conflict recovery) and the
  // result is committed and pushed, so anything lost here is lost on every
  // machine at once.
  const ours = [
    "# proj Findings",
    "",
    "<!-- consolidated: 2026-05-01 -->",
    "",
    "## 2026-08-16",
    "",
    "- [pattern] Pool the DB connections at the edge <!-- fid:aaaabbbb -->",
    "  - rationale: connection storms during deploy",
    "  - owner: platform team",
    '  <!-- phren:cite {"file":"src/db.ts","line":12} -->',
    "",
    "- [gotcha] The webhook retries with the same idempotency key",
    "",
  ].join("\n");

  const theirs = [
    "# proj Findings",
    "",
    "## 2026-08-16",
    "",
    "- [decision] Ship the new auth flow behind a flag",
    "",
    "## Open questions",
    "",
    "- Do we still need the legacy shim?",
    "",
    "<details><summary>phren:archive</summary>",
    "",
    "- [decision] Old auth flow archived 2026-01-02",
    "",
    "</details>",
    "",
  ].join("\n");

  it("keeps hand-written continuation lines under a finding", () => {
    const merged = mergeFindings(ours, theirs);
    expect(merged).toContain("  - rationale: connection storms during deploy");
    expect(merged).toContain("  - owner: platform team");
    // The citation used to be lost too: an indented detail line ended the block
    // before the parser reached the comment.
    expect(merged).toContain('<!-- phren:cite {"file":"src/db.ts","line":12} -->');
  });

  it("keeps a non-date section and an archive block that only theirs had", () => {
    const merged = mergeFindings(ours, theirs);
    expect(merged).toContain("## Open questions");
    expect(merged).toContain("- Do we still need the legacy shim?");
    expect(merged).toContain("<details><summary>phren:archive</summary>");
    expect(merged).toContain("</details>");
    expect(merged).toContain("<!-- consolidated: 2026-05-01 -->");
  });

  it("never promotes an archived finding into the live date section", () => {
    const merged = mergeFindings(ours, theirs);
    const liveSection = merged.split("<details")[0];
    expect(liveSection).not.toContain("Old auth flow archived");
    expect(merged).toContain("- [decision] Old auth flow archived 2026-01-02");
  });

  it("never silently drops content, on any shape — it merges or it refuses", () => {
    // The guarantee, stated directly: for awkward documents the merge either
    // round-trips every content line or throws so the user resolves by hand. It
    // must never quietly return a pruned file that then gets committed.
    const shapes = [
      // A fenced code block sitting loose in a date section.
      "# F\n\n## 2026-08-16\n\n- [pattern] Something\n\n```sql\nSELECT 1;\n```\n",
      // A nested list under a finding.
      "# F\n\n## 2026-08-16\n\n- [decision] Pick Postgres\n  - because: JSONB\n    - and: partial indexes\n",
      // A prose paragraph between sections.
      "# F\n\nSome hand-written intro paragraph.\n\n## 2026-08-16\n\n- [gotcha] Careful here\n",
      // A table in an archive block.
      "# F\n\n## 2026-08-16\n\n- [pattern] X\n\n<details><summary>phren:archive</summary>\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n</details>\n",
      // A second non-date section after the dates.
      "# F\n\n## 2026-08-16\n\n- [pattern] X\n\n## Notes\n\nfree text under a heading\n",
    ];

    const contentLines = (doc: string) =>
      doc
        .split("\n")
        .slice(1)
        .map((line) => line.trim())
        .filter((line) => line !== "" && !/^## \d{4}-\d{2}-\d{2}$/.test(line));

    for (const a of shapes) {
      for (const b of shapes) {
        let merged: string;
        try {
          merged = mergeFindings(a, b);
        } catch (err) {
          expect(String(err)).toMatch(/Refusing to auto-merge/);
          continue;
        }
        const present = new Set(merged.split("\n").map((line) => line.trim()));
        for (const line of [...contentLines(a), ...contentLines(b)]) {
          expect(present.has(line), `lost "${line}"`).toBe(true);
        }
      }
    }
  });
});

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

  it("accepts 'phren_01'", () => {
    expect(isValidProjectName("phren_01")).toBe(true);
  });
});
