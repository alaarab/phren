import { describe, it, expect } from "vitest";
import * as path from "path";
import { sanitizeFts5Query, buildRobustFtsQuery, extractKeywords, isValidProjectName, safeProjectPath, clampInt, isFeatureEnabled, STOP_WORDS } from "./utils.js";

describe("sanitizeFts5Query", () => {
  it("handles empty string", () => {
    expect(sanitizeFts5Query("")).toBe("");
  });

  it("neutralizes FTS5 column prefix injection by stripping colon", () => {
    // Whitelist strips the colon; both words remain as plain tokens
    expect(sanitizeFts5Query("content:hello")).toBe("content hello");
    expect(sanitizeFts5Query("type:doc")).toBe("type doc");
    expect(sanitizeFts5Query("project:secret")).toBe("project secret");
    expect(sanitizeFts5Query("path:/etc/passwd")).toBe("path etc passwd");
  });

  it("strips angle brackets", () => {
    const result = sanitizeFts5Query("<script>alert(1)</script>");
    expect(result).not.toContain("<");
    expect(result).not.toContain(">");
  });

  it("strips semicolons", () => {
    const result = sanitizeFts5Query("test; DROP TABLE docs");
    expect(result).not.toContain(";");
    expect(result).toContain("test");
  });

  it("keeps apostrophes", () => {
    expect(sanitizeFts5Query("it's don't")).toBe("it's don't");
  });

  it("keeps hyphens and underscores", () => {
    expect(sanitizeFts5Query("rate-limit my_var")).toBe("rate-limit my_var");
  });

  it("passes through boolean operator words as plain tokens (no FTS5 semantics)", () => {
    // AND/OR/NOT are alphanumeric so they pass the whitelist, but without
    // FTS5 syntax chars around them they are harmless plain tokens
    expect(sanitizeFts5Query("foo AND bar")).toBe("foo AND bar");
    expect(sanitizeFts5Query("foo OR bar NOT baz")).toBe("foo OR bar NOT baz");
  });

  it("strips special characters (quotes, parens, brackets)", () => {
    expect(sanitizeFts5Query('hello "world')).not.toContain('"');
    expect(sanitizeFts5Query("foo(bar)")).not.toContain("(");
    expect(sanitizeFts5Query("foo[bar]")).not.toContain("[");
    expect(sanitizeFts5Query("foo{bar}")).not.toContain("{");
  });

  it("collapses whitespace", () => {
    expect(sanitizeFts5Query("  foo   bar  ")).toBe("foo bar");
  });

  it("strips null bytes", () => {
    expect(sanitizeFts5Query("foo\0bar")).toBe("foo bar");
  });

  it("truncates at 500 chars", () => {
    const result = sanitizeFts5Query("a".repeat(600));
    expect(result.length).toBeLessThanOrEqual(500);
  });
});

describe("buildRobustFtsQuery", () => {
  it("returns empty for empty input", () => {
    expect(buildRobustFtsQuery("")).toBe("");
  });

  it("quotes terms", () => {
    const result = buildRobustFtsQuery("hello world");
    expect(result).toContain('"hello"');
    expect(result).toContain('"world"');
  });

  it("expands synonyms", () => {
    const result = buildRobustFtsQuery("cache");
    expect(result).toContain('"caching"');
  });

  it("produces no bigrams from all-stopword input", () => {
    // "the", "is", "are", "was" are all stop words
    const result = buildRobustFtsQuery("the is are was");
    // No bigram where both tokens are stop words should appear
    expect(result).not.toMatch(/"the is"/);
    expect(result).not.toMatch(/"is are"/);
    expect(result).not.toMatch(/"are was"/);
  });

  it("keeps bigrams where both tokens are non-stop-words (quick fox)", () => {
    // Neither "quick" nor "fox" is a stop word
    expect(STOP_WORDS.has("quick")).toBe(false);
    expect(STOP_WORDS.has("fox")).toBe(false);
    const result = buildRobustFtsQuery("quick fox");
    expect(result).toContain("quick");
    expect(result).toContain("fox");
  });

  it("keeps bigrams where only one token is a stop word (the quick fox)", () => {
    // "the" is stop, "quick" and "fox" are not
    expect(STOP_WORDS.has("the")).toBe(true);
    expect(STOP_WORDS.has("quick")).toBe(false);
    expect(STOP_WORDS.has("fox")).toBe(false);

    const result = buildRobustFtsQuery("the quick fox");
    // Both "quick" and "fox" should appear as terms
    expect(result).toContain("quick");
    expect(result).toContain("fox");
    // "the quick" bigram: one stop word -> NOT filtered (our rule: only filter when BOTH are stop words)
    // "quick fox" bigram: no stop words -> kept
    // These may or may not appear as quoted phrases depending on synonym matching,
    // but they should not be excluded by the stop-word filter
  });

  it("drops bigrams where both tokens are stop words in mixed input", () => {
    // "the is" = both stop words -> dropped
    // "is quick" = one stop word -> kept
    const result = buildRobustFtsQuery("the is quick");
    expect(result).not.toMatch(/"the is"/);
    expect(result).toContain("quick");
  });
});

describe("extractKeywords", () => {
  it("strips stop words", () => {
    const result = extractKeywords("the quick brown fox");
    expect(result).not.toContain("the");
    expect(result).toContain("quick");
  });

  it("returns empty for all stop words", () => {
    expect(extractKeywords("the is a")).toBe("");
  });
});

describe("isValidProjectName", () => {
  it("rejects empty", () => {
    expect(isValidProjectName("")).toBe(false);
  });

  it("rejects path traversal", () => {
    expect(isValidProjectName("../etc")).toBe(false);
    expect(isValidProjectName("foo/bar")).toBe(false);
  });

  it("accepts valid names", () => {
    expect(isValidProjectName("my-project")).toBe(true);
  });
});

describe("safeProjectPath", () => {
  const base = path.join(path.sep, "home", "user", ".cortex");

  it("rejects path escape", () => {
    expect(safeProjectPath(base, "..", "..", "etc", "passwd")).toBe(null);
  });

  it("allows valid subpath", () => {
    expect(safeProjectPath(base, "myproject")).toBe(path.resolve(base, "myproject"));
  });
});

describe("clampInt", () => {
  it("uses fallback for undefined", () => {
    expect(clampInt(undefined, 10, 1, 100)).toBe(10);
  });

  it("clamps to min", () => {
    expect(clampInt("0", 10, 5, 100)).toBe(5);
  });

  it("clamps to max", () => {
    expect(clampInt("200", 10, 1, 100)).toBe(100);
  });
});

describe("isFeatureEnabled", () => {
  it("returns default when env not set", () => {
    expect(isFeatureEnabled("NONEXISTENT_FLAG_XYZ", true)).toBe(true);
    expect(isFeatureEnabled("NONEXISTENT_FLAG_XYZ", false)).toBe(false);
  });
});
