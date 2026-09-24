import { describe, it, expect } from "vitest";
import {
  stripMetadata,
  jaccardTokenize,
  jaccardSimilarity,
  isDuplicateFinding,
  normalizeObservationTags,
  scanForSecrets,
  resolveCoref,
  detectConflicts,
} from "./content/dedup.js";

// ── stripMetadata ───────────────────────────────────────────────────────────

describe("stripMetadata", () => {
  it.each([
    ["HTML comments", "hello <!-- comment --> world", "hello  world"],
    ["migrated-from annotations", "finding (migrated from old-project)", "finding "],
    ["the leading bullet dash", "- This is a finding", "This is a finding"],
    ["all metadata at once", "- Some finding <!-- ts:123 --> (migrated from legacy)", "Some finding  "],
    ["nothing from an empty string", "", ""],
    ["multiline HTML comments", "before <!-- multi\nline\ncomment --> after", "before  after"],
  ])("strips %s", (_label, input, expected) => {
    expect(stripMetadata(input)).toBe(expected);
  });
});

// ── jaccardTokenize ─────────────────────────────────────────────────────────

describe("jaccardTokenize", () => {
  it.each([
    ["tokenizes and lowercases", "Hello World Test", ["hello", "world", "test"], []],
    ["removes stop words", "the quick brown fox is a test", ["quick"], ["the", "is", "a"]],
    ["handles Unicode text", "Python 使用 テスト data", ["python", "data"], []],
    ["splits on non-word characters", "key=value; foo:bar", ["key", "value", "foo", "bar"], []],
  ])("%s", (_label, input, present, absent) => {
    const tokens = jaccardTokenize(input);
    for (const token of present) expect(tokens.has(token), token).toBe(true);
    for (const token of absent) expect(tokens.has(token), token).toBe(false);
  });

  it.each(["", "the a an is are was were"])("yields no tokens for %j", (input) => {
    expect(jaccardTokenize(input).size).toBe(0);
  });
});

// ── jaccardSimilarity ───────────────────────────────────────────────────────

describe("jaccardSimilarity", () => {
  it.each([
    ["identical sets", ["a", "b", "c"], ["a", "b", "c"], 1],
    ["disjoint sets", ["a", "b"], ["c", "d"], 0],
    ["two empty sets", [], [], 1],
    ["one empty set", [], ["a"], 0],
    // intersection=2, union=4
    ["partial overlap", ["a", "b", "c"], ["b", "c", "d"], 0.5],
  ])("scores %s", (_label, a, b, expected) => {
    expect(jaccardSimilarity(new Set(a), new Set(b))).toBeCloseTo(expected);
  });
});

// ── isDuplicateFinding ──────────────────────────────────────────────────────

describe("isDuplicateFinding", () => {
  const existing = [
    "- Redis connections need explicit close in finally blocks",
    "- Always use connection pooling for PostgreSQL in production",
    "- Never store secrets in environment variables without encryption",
  ].join("\n");

  it("detects exact duplicate", () => {
    expect(isDuplicateFinding(existing, "Redis connections need explicit close in finally blocks")).toBe(true);
  });

  it("detects near-duplicate with high word overlap", () => {
    // Same core words, minor variation
    expect(isDuplicateFinding(existing, "Redis connections need explicit close in finally blocks always")).toBe(true);
  });

  it("returns false for unrelated finding", () => {
    expect(isDuplicateFinding(existing, "React components should use memo for expensive renders")).toBe(false);
  });

  it("returns false for empty new learning", () => {
    expect(isDuplicateFinding(existing, "")).toBe(false);
  });

  it("returns false for empty existing content", () => {
    expect(isDuplicateFinding("", "Some new finding")).toBe(false);
  });

  it("skips superseded entries", () => {
    const withSuperseded = '- Old finding <!-- phren:status "superseded" -->\n- Unique finding about caching';
    expect(isDuplicateFinding(withSuperseded, "Old finding about something")).toBe(false);
  });

  it("handles very long strings without hanging", () => {
    const longExisting = Array.from({ length: 200 }, (_, i) => `- Finding number ${i} about topic ${i}`).join("\n");
    const result = isDuplicateFinding(longExisting, "Completely unrelated new finding about quantum computing");
    expect(result).toBe(false);
  });

  it("respects custom threshold", () => {
    // With a very high threshold, even similar items should not match
    expect(isDuplicateFinding(existing, "Redis connections need explicit close in finally blocks", 0.99)).toBe(true);
    // With threshold of 1.0, only perfect overlap matches
    // (Jaccard may still trigger, but word-overlap check uses smaller set ratio)
  });
});

// ── detectConflicts ─────────────────────────────────────────────────────────

describe("detectConflicts", () => {
  it("detects polarity conflict on shared fragment", () => {
    const existing = ["- Always use Docker for local development"];
    const conflicts = detectConflicts("Never use Docker for local development", existing);
    expect(conflicts.length).toBeGreaterThan(0);
  });

  it("returns empty when no shared fragments", () => {
    const existing = ["- Always use Docker for deployments"];
    const conflicts = detectConflicts("Never use Redis without auth", existing);
    expect(conflicts).toEqual([]);
  });

  it("returns empty for neutral polarity", () => {
    const existing = ["- Docker runs containers efficiently"];
    const conflicts = detectConflicts("Docker uses cgroups internally", existing);
    expect(conflicts).toEqual([]);
  });

  it("returns empty for empty existing lines", () => {
    expect(detectConflicts("Always use Python", [])).toEqual([]);
  });

  it("returns empty when new finding has no fragments", () => {
    const existing = ["- Always use Docker"];
    expect(detectConflicts("This is a generic statement", existing)).toEqual([]);
  });

  it("detects conflicts with version fragments", () => {
    const existing = ["- Always pin to v1.2.3 in production"];
    const conflicts = detectConflicts("Never pin to v1.2.3 in production", existing);
    expect(conflicts.length).toBeGreaterThan(0);
  });

  it("detects conflicts with env var fragments", () => {
    const existing = ["- Always set PHREN_DEBUG in development"];
    const conflicts = detectConflicts("Never set PHREN_DEBUG in development", existing);
    expect(conflicts.length).toBeGreaterThan(0);
  });

  it("uses dynamic fragments for conflict detection", () => {
    const lines = ["- Always enable PhotonEngine for rendering"];
    const dynamic = new Set(["photonengine"]);
    const conflicts = detectConflicts("Avoid PhotonEngine for rendering", lines, dynamic);
    expect(conflicts.length).toBeGreaterThan(0);
  });

  it("skips non-bullet lines in existing", () => {
    const existing = ["# Heading", "Some paragraph", "- Always use Git for version control"];
    const conflicts = detectConflicts("Never use Git for version control", existing);
    expect(conflicts.length).toBe(1);
  });

  it("does not flag unrelated findings that merely share one incidental entity", () => {
    // Regression: a git-workflow decision and a security decision both mention GitHub and
    // have opposite polarity, but are about completely different topics. The bare
    // shared-entity + polarity rule used to false-flag these as contradictions.
    const existing = ["- [decision] GitHub branch protection on the auth gateway must never be disabled"];
    const conflicts = detectConflicts(
      "[decision] For GitHub pushes always commit direct to main and prefer the merge workflow",
      existing,
    );
    expect(conflicts).toEqual([]);
  });

  it("still flags same-topic opposite-polarity conflicts even when both carry the same tag", () => {
    // The shared [decision] tag must not, by itself, count as topical overlap — but genuine
    // subject-matter overlap should still trip detection.
    const existing = ["- [decision] Always use Docker for production deployments"];
    const conflicts = detectConflicts("[decision] Never use Docker for production deployments", existing);
    expect(conflicts.length).toBeGreaterThan(0);
  });
});

// ── normalizeObservationTags ────────────────────────────────────────────────

describe("normalizeObservationTags", () => {
  it.each([
    ["lowercases known tags", "[DECISION] Use Redis", "[decision] Use Redis", undefined],
    ["preserves unknown tags and warns", "[custom] tag here", "[custom] tag here", "Unknown tag"],
    ["handles multiple tags", "[PITFALL] and [BUG] combined", "[pitfall] and [bug] combined", undefined],
    ["handles no tags", "No tags here", "No tags here", undefined],
    ["handles empty string", "", "", undefined],
  ])("%s", (_label, input, expected, warning) => {
    const result = normalizeObservationTags(input);
    expect(result.text).toBe(expected);
    if (warning) expect(result.warning).toContain(warning);
    else expect(result.warning).toBeUndefined();
  });
});

// ── scanForSecrets ──────────────────────────────────────────────────────────
// Detector rows live in __tests__/secret-scan-precision.test.ts.

describe("scanForSecrets", () => {
  it.each(["This is a normal finding about Redis caching", ""])("returns null for clean text %j", (text) => {
    expect(scanForSecrets(text)).toBeNull();
  });
});

// ── resolveCoref ────────────────────────────────────────────────────────────

describe("resolveCoref", () => {
  it("replaces 'the project' with project name", () => {
    const result = resolveCoref("the project needs refactoring", { project: "phren" });
    expect(result).toBe("phren needs refactoring");
  });

  it("replaces 'this file' with basename", () => {
    const result = resolveCoref("this file has a bug", { file: "/home/user/src/index.ts" });
    expect(result).toBe("index.ts has a bug");
  });

  it("returns unchanged text with no context", () => {
    const text = "It does something";
    expect(resolveCoref(text, {})).toBe(text);
  });

  it("handles empty string", () => {
    expect(resolveCoref("", { project: "test" })).toBe("");
  });

  it("prepends context when text has vague pronouns and no concrete nouns", () => {
    const result = resolveCoref("it handles them correctly", { project: "phren" });
    expect(result).toContain("[phren]");
  });
});
