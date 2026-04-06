import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  buildCitationComment,
  parseCitationComment,
  buildSourceComment,
  parseSourceComment,
  isFindingProvenanceSource,
  filterTrustedFindings,
  filterTrustedFindingsDetailed,
  type FindingCitation,
  type FindingProvenance,
} from "../content/citation.js";

// ── isFindingProvenanceSource ──────────────────────────────────────────────

describe("isFindingProvenanceSource", () => {
  it("accepts all valid sources", () => {
    for (const s of ["human", "agent", "hook", "extract", "consolidation", "unknown"]) {
      expect(isFindingProvenanceSource(s)).toBe(true);
    }
  });

  it("rejects invalid strings", () => {
    expect(isFindingProvenanceSource("robot")).toBe(false);
    expect(isFindingProvenanceSource("")).toBe(false);
  });

  it("rejects undefined", () => {
    expect(isFindingProvenanceSource(undefined)).toBe(false);
  });
});

// ── buildCitationComment / parseCitationComment ────────────────────────────

describe("citation comment round-trip", () => {
  it("round-trips a full citation", () => {
    const citation: FindingCitation = {
      created_at: "2025-06-01",
      repo: "/tmp/repo",
      file: "src/main.ts",
      line: 42,
      commit: "abc123",
    };
    const comment = buildCitationComment(citation);
    expect(comment).toContain("phren:cite");
    expect(comment).toContain("2025-06-01");

    const parsed = parseCitationComment(comment);
    expect(parsed).not.toBeNull();
    expect(parsed!.created_at).toBe("2025-06-01");
    expect(parsed!.repo).toBe("/tmp/repo");
    expect(parsed!.file).toBe("src/main.ts");
    expect(parsed!.line).toBe(42);
    expect(parsed!.commit).toBe("abc123");
  });

  it("round-trips a minimal citation", () => {
    const citation: FindingCitation = { created_at: "2025-01-01" };
    const parsed = parseCitationComment(buildCitationComment(citation));
    expect(parsed).not.toBeNull();
    expect(parsed!.created_at).toBe("2025-01-01");
    expect(parsed!.file).toBeUndefined();
    expect(parsed!.line).toBeUndefined();
  });

  it("includes supersedes field", () => {
    const citation: FindingCitation = {
      created_at: "2025-03-01",
      supersedes: "old pattern",
    };
    const parsed = parseCitationComment(buildCitationComment(citation));
    expect(parsed!.supersedes).toBe("old pattern");
  });

  it("includes task_item field", () => {
    const citation: FindingCitation = {
      created_at: "2025-04-01",
      task_item: "Fix the login bug",
    };
    const parsed = parseCitationComment(buildCitationComment(citation));
    expect(parsed!.task_item).toBe("Fix the login bug");
  });
});

describe("parseCitationComment edge cases", () => {
  it("returns null for non-citation lines", () => {
    expect(parseCitationComment("- just a finding")).toBeNull();
    expect(parseCitationComment("<!-- some other comment -->")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseCitationComment("<!-- phren:cite not-json -->")).toBeNull();
  });

  it("returns null when created_at is missing", () => {
    expect(parseCitationComment('<!-- phren:cite {"file":"x.ts"} -->')).toBeNull();
  });

  it("returns null for non-object JSON", () => {
    expect(parseCitationComment('<!-- phren:cite [1,2,3] -->')).toBeNull();
    expect(parseCitationComment('<!-- phren:cite "string" -->')).toBeNull();
  });

  it("ignores non-string repo/file/commit", () => {
    const comment = '<!-- phren:cite {"created_at":"2025-01-01","repo":123,"file":true,"commit":null} -->';
    const parsed = parseCitationComment(comment);
    expect(parsed).not.toBeNull();
    expect(parsed!.repo).toBeUndefined();
    expect(parsed!.file).toBeUndefined();
    expect(parsed!.commit).toBeUndefined();
  });

  it("ignores non-number line", () => {
    const comment = '<!-- phren:cite {"created_at":"2025-01-01","line":"notnum"} -->';
    const parsed = parseCitationComment(comment);
    expect(parsed!.line).toBeUndefined();
  });
});

// ── buildSourceComment / parseSourceComment ────────────────────────────────

describe("source comment round-trip", () => {
  it("round-trips all fields", () => {
    const prov: FindingProvenance = {
      source: "agent",
      machine: "ci-box",
      actor: "bot",
      tool: "cursor",
      model: "claude-3",
      session_id: "s-abc",
      scope: "project",
    };
    const comment = buildSourceComment(prov);
    const parsed = parseSourceComment(`- Finding ${comment}`);
    expect(parsed).toEqual(prov);
  });

  it("returns empty string for empty provenance", () => {
    expect(buildSourceComment({})).toBe("");
  });

  it("parses partial provenance", () => {
    const comment = buildSourceComment({ source: "hook", tool: "copilot" });
    const parsed = parseSourceComment(`- ${comment}`);
    expect(parsed!.source).toBe("hook");
    expect(parsed!.tool).toBe("copilot");
    expect(parsed!.machine).toBeUndefined();
  });

  it("returns null for lines without source comment", () => {
    expect(parseSourceComment("- plain finding")).toBeNull();
  });

  it("returns null when all parsed fields are empty", () => {
    // A source comment with no recognizable fields
    expect(parseSourceComment("<!-- source: -->")).toBeNull();
  });

  it("handles scope with empty string as shared", () => {
    const parsed = parseSourceComment('- Finding <!-- source:agent scope:"" -->');
    expect(parsed).not.toBeNull();
    expect(parsed!.scope).toBe("shared");
  });
});

// ── filterTrustedFindings ──────────────────────────────────────────────────

describe("filterTrustedFindings", () => {
  it("keeps recent findings", () => {
    const today = new Date().toISOString().slice(0, 10);
    const content = [
      "# Test Findings",
      "",
      `## ${today}`,
      "- Fresh finding",
      "",
    ].join("\n");

    const result = filterTrustedFindings(content, 120);
    expect(result).toContain("Fresh finding");
  });

  it("removes stale findings beyond TTL", () => {
    const content = [
      "# Findings",
      "",
      "## 2020-01-01",
      "- Ancient finding",
      "",
    ].join("\n");

    const result = filterTrustedFindings(content, 120);
    expect(result).not.toContain("Ancient finding");
  });

  it("strips archive blocks", () => {
    const today = new Date().toISOString().slice(0, 10);
    const content = [
      "# Findings",
      "",
      `## ${today}`,
      "- Active finding",
      "<!-- phren:archive:start -->",
      "- Archived old thing",
      "<!-- phren:archive:end -->",
      "",
    ].join("\n");

    const result = filterTrustedFindings(content, 120);
    expect(result).toContain("Active finding");
    expect(result).not.toContain("Archived old thing");
  });

  it("skips non-bullet lines", () => {
    const today = new Date().toISOString().slice(0, 10);
    const content = [
      "# Findings",
      "",
      `## ${today}`,
      "Some random paragraph text",
      "- Actual finding",
      "",
    ].join("\n");

    const result = filterTrustedFindings(content, 120);
    expect(result).toContain("Actual finding");
    expect(result).not.toContain("random paragraph");
  });
});

describe("filterTrustedFindingsDetailed", () => {
  it("returns issues for stale findings", () => {
    const content = [
      "# Findings",
      "",
      "## 2019-01-01",
      "- Very old finding",
      "",
    ].join("\n");

    const { content: filtered, issues } = filterTrustedFindingsDetailed(content, { ttlDays: 120 });
    expect(filtered).not.toContain("Very old finding");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].reason).toBe("stale");
  });

  it("accepts numeric opts as ttlDays shorthand", () => {
    const content = [
      "# Findings",
      "",
      "## 2019-01-01",
      "- Old",
      "",
    ].join("\n");

    const { issues } = filterTrustedFindingsDetailed(content, 120);
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("applies confidence decay curve", () => {
    // A finding from ~100 days ago should have reduced confidence
    const d = new Date();
    d.setDate(d.getDate() - 100);
    const date = d.toISOString().slice(0, 10);
    const content = [
      "# Findings",
      "",
      `## ${date}`,
      "- Aging finding",
      "",
    ].join("\n");

    // With very high minConfidence, aging finding should be filtered
    const { content: filtered } = filterTrustedFindingsDetailed(content, {
      ttlDays: 365,
      minConfidence: 0.9,
    });
    expect(filtered).not.toContain("Aging finding");
  });

  it("treats all sources equally for confidence", () => {
    const content = [
      "# Findings",
      "",
      "- Human finding <!-- source:human -->",
      "- Extract finding <!-- source:extract -->",
      "",
    ].join("\n");

    // Both are undated, so they get DEFAULT_UNDATED_CONFIDENCE.
    // No source-based multiplier — both get the same confidence.
    // With no citation both get *0.8 (0.45 * 0.8 = 0.36). Use minConfidence below that.
    const { content: filtered } = filterTrustedFindingsDetailed(content, {
      ttlDays: 365,
      minConfidence: 0.35,
    });
    expect(filtered).toContain("Human finding");
    expect(filtered).toContain("Extract finding");
  });

  it("reduces confidence for uncited findings", () => {
    const today = new Date().toISOString().slice(0, 10);
    const content = [
      "# Findings",
      "",
      `## ${today}`,
      "- Uncited finding",
      "",
    ].join("\n");

    // Uncited findings get *0.8, so with minConfidence=0.9 it should be filtered
    const { content: filtered } = filterTrustedFindingsDetailed(content, {
      ttlDays: 365,
      minConfidence: 0.9,
    });
    expect(filtered).not.toContain("Uncited finding");
  });

  it("uses inline created date when no heading date", () => {
    const today = new Date().toISOString().slice(0, 10);
    const content = [
      "# Findings",
      "",
      `- Fresh finding <!-- created: ${today} -->`,
      "",
    ].join("\n");

    const result = filterTrustedFindings(content, 120);
    expect(result).toContain("Fresh finding");
  });

  it("uses citation created_at when no heading or inline date", () => {
    const today = new Date().toISOString().slice(0, 10);
    const content = [
      "# Findings",
      "",
      "- Cited finding",
      `<!-- phren:cite {"created_at":"${today}"} -->`,
      "",
    ].join("\n");

    const result = filterTrustedFindings(content, 120);
    expect(result).toContain("Cited finding");
  });

  it("applies type-specific decay for observations", () => {
    // Observations have maxAgeDays: 14, so a 20-day-old observation should be filtered
    const d = new Date();
    d.setDate(d.getDate() - 20);
    const date = d.toISOString().slice(0, 10);
    const content = [
      "# Findings",
      "",
      `## ${date}`,
      "- [observation] Temp debug log was present",
      "",
    ].join("\n");

    const { content: filtered, issues } = filterTrustedFindingsDetailed(content, {
      ttlDays: 365,
    });
    expect(filtered).not.toContain("Temp debug log");
    expect(issues.some((i) => i.reason === "stale")).toBe(true);
  });

  it("decisions never decay below floor", () => {
    // Decisions have maxAgeDays: Infinity and floor 0.6.
    // At 200 days, base confidence is d120=0.45, but decision floor lifts to 0.6.
    // Without citation (*0.8) and unknown source, effective = 0.48.
    // Use minConfidence below that to verify the floor is applied.
    const d = new Date();
    d.setDate(d.getDate() - 200);
    const date = d.toISOString().slice(0, 10);
    const content = [
      "# Findings",
      "",
      `## ${date}`,
      "- [decision] We chose PostgreSQL over MySQL",
      "",
    ].join("\n");

    const { content: filtered } = filterTrustedFindingsDetailed(content, {
      ttlDays: 365,
      minConfidence: 0.4,
    });
    expect(filtered).toContain("chose PostgreSQL");
  });
});
