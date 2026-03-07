import { describe, it, expect } from "vitest";
import { sanitizeFts5Query, buildRobustFtsQuery, extractKeywords, isValidProjectName, safeProjectPath, clampInt, isFeatureEnabled } from "./utils.js";

describe("sanitizeFts5Query", () => {
  it("handles empty string", () => {
    expect(sanitizeFts5Query("")).toBe("");
  });

  it("strips FTS5 column prefixes", () => {
    expect(sanitizeFts5Query("content:hello")).toBe("hello");
    expect(sanitizeFts5Query("type:doc")).toBe("doc");
  });

  it("strips boolean operators", () => {
    expect(sanitizeFts5Query("foo AND bar")).toBe("foo bar");
    expect(sanitizeFts5Query("foo OR bar NOT baz")).toBe("foo bar baz");
  });

  it("strips special characters", () => {
    expect(sanitizeFts5Query('hello "world')).not.toContain('"');
    expect(sanitizeFts5Query("foo(bar)")).not.toContain("(");
  });

  it("collapses whitespace", () => {
    expect(sanitizeFts5Query("  foo   bar  ")).toBe("foo bar");
  });

  it("strips null bytes", () => {
    expect(sanitizeFts5Query("foo\0bar")).toBe("foo bar");
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
  it("rejects path escape", () => {
    expect(safeProjectPath("/home/user/.cortex", "..", "..", "etc", "passwd")).toBe(null);
  });

  it("allows valid subpath", () => {
    expect(safeProjectPath("/home/user/.cortex", "myproject")).toBe("/home/user/.cortex/myproject");
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
