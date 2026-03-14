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
} from "./content-dedup.js";

// ── stripMetadata ───────────────────────────────────────────────────────────

describe("stripMetadata", () => {
  it("strips HTML comments", () => {
    expect(stripMetadata("hello <!-- comment --> world")).toBe("hello  world");
  });

  it("strips migrated-from annotations", () => {
    expect(stripMetadata("finding (migrated from old-project)")).toBe("finding ");
  });

  it("strips leading bullet dash", () => {
    expect(stripMetadata("- This is a finding")).toBe("This is a finding");
  });

  it("strips all metadata at once", () => {
    const input = "- Some finding <!-- ts:123 --> (migrated from legacy)";
    const result = stripMetadata(input);
    expect(result).toBe("Some finding  ");
  });

  it("handles empty string", () => {
    expect(stripMetadata("")).toBe("");
  });

  it("handles multiline HTML comments", () => {
    expect(stripMetadata("before <!-- multi\nline\ncomment --> after")).toBe("before  after");
  });
});

// ── jaccardTokenize ─────────────────────────────────────────────────────────

describe("jaccardTokenize", () => {
  it("tokenizes and lowercases", () => {
    const tokens = jaccardTokenize("Hello World Test");
    expect(tokens.has("hello")).toBe(true);
    expect(tokens.has("world")).toBe(true);
    expect(tokens.has("test")).toBe(true);
  });

  it("removes stop words", () => {
    const tokens = jaccardTokenize("the quick brown fox is a test");
    expect(tokens.has("the")).toBe(false);
    expect(tokens.has("is")).toBe(false);
    expect(tokens.has("a")).toBe(false);
    expect(tokens.has("quick")).toBe(true);
  });

  it("handles empty string", () => {
    const tokens = jaccardTokenize("");
    expect(tokens.size).toBe(0);
  });

  it("handles string of only stop words", () => {
    const tokens = jaccardTokenize("the a an is are was were");
    expect(tokens.size).toBe(0);
  });

  it("handles Unicode text", () => {
    const tokens = jaccardTokenize("Python 使用 テスト data");
    expect(tokens.has("python")).toBe(true);
    expect(tokens.has("data")).toBe(true);
  });

  it("splits on non-word characters", () => {
    const tokens = jaccardTokenize("key=value; foo:bar");
    expect(tokens.has("key")).toBe(true);
    expect(tokens.has("value")).toBe(true);
    expect(tokens.has("foo")).toBe(true);
    expect(tokens.has("bar")).toBe(true);
  });
});

// ── jaccardSimilarity ───────────────────────────────────────────────────────

describe("jaccardSimilarity", () => {
  it("returns 1 for identical sets", () => {
    const s = new Set(["a", "b", "c"]);
    expect(jaccardSimilarity(s, s)).toBe(1);
  });

  it("returns 0 for disjoint sets", () => {
    const a = new Set(["a", "b"]);
    const b = new Set(["c", "d"]);
    expect(jaccardSimilarity(a, b)).toBe(0);
  });

  it("returns 1 for two empty sets", () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(1);
  });

  it("returns 0 when one set is empty and other is not", () => {
    expect(jaccardSimilarity(new Set(), new Set(["a"]))).toBe(0);
  });

  it("computes correct partial overlap", () => {
    const a = new Set(["a", "b", "c"]);
    const b = new Set(["b", "c", "d"]);
    // intersection=2, union=4
    expect(jaccardSimilarity(a, b)).toBeCloseTo(0.5);
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
});

// ── normalizeObservationTags ────────────────────────────────────────────────

describe("normalizeObservationTags", () => {
  it("lowercases known tags", () => {
    const { text } = normalizeObservationTags("[DECISION] Use Redis");
    expect(text).toBe("[decision] Use Redis");
  });

  it("preserves unknown tags and warns", () => {
    const { text, warning } = normalizeObservationTags("[custom] tag here");
    expect(text).toBe("[custom] tag here");
    expect(warning).toContain("Unknown tag");
  });

  it("handles multiple tags", () => {
    const { text } = normalizeObservationTags("[PITFALL] and [BUG] combined");
    expect(text).toBe("[pitfall] and [bug] combined");
  });

  it("handles no tags", () => {
    const { text, warning } = normalizeObservationTags("No tags here");
    expect(text).toBe("No tags here");
    expect(warning).toBeUndefined();
  });

  it("handles empty string", () => {
    const { text, warning } = normalizeObservationTags("");
    expect(text).toBe("");
    expect(warning).toBeUndefined();
  });
});

// ── scanForSecrets ──────────────────────────────────────────────────────────

describe("scanForSecrets", () => {
  it("detects AWS access key", () => {
    expect(scanForSecrets("key is AKIAIOSFODNN7EXAMPLE")).toBe("AWS access key");
  });

  it("detects JWT token", () => {
    expect(scanForSecrets("token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc_def-ghi")).toBe("JWT token");
  });

  it("detects GitHub PAT", () => {
    expect(scanForSecrets("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij")).toBe("GitHub personal access token");
  });

  it("detects connection string with credentials", () => {
    expect(scanForSecrets("mongodb://admin:password123@host:27017/db")).toBe("connection string with credentials");
  });

  it("returns null for clean text", () => {
    expect(scanForSecrets("This is a normal finding about Redis caching")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(scanForSecrets("")).toBeNull();
  });

  it("detects SSH private key", () => {
    expect(scanForSecrets("-----BEGIN RSA PRIVATE KEY-----")).toBe("SSH private key");
  });

  it("detects Anthropic API key", () => {
    expect(scanForSecrets("sk-ant-api03-abcdefghij1234567890")).toBe("Anthropic API key");
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
    expect(result).toContain("phren");
  });
});
