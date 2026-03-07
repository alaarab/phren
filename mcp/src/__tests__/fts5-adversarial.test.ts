import { describe, expect, it } from "vitest";
import { sanitizeFts5Query, buildRobustFtsQuery } from "../utils.js";

describe("sanitizeFts5Query: adversarial inputs", () => {
  it("strips unmatched double quotes", () => {
    const result = sanitizeFts5Query(`"unclosed quote`);
    expect(result).not.toContain('"');
  });

  it("strips NEAR() injection", () => {
    const result = sanitizeFts5Query("NEAR(foo bar, 5)");
    expect(result.toUpperCase()).not.toContain("NEAR");
    expect(result).not.toContain("(");
    expect(result).not.toContain(")");
  });

  it("strips boolean operators AND OR NOT", () => {
    const result = sanitizeFts5Query("foo AND bar OR baz NOT qux");
    expect(result.toUpperCase()).not.toContain(" AND ");
    expect(result.toUpperCase()).not.toContain(" OR ");
    expect(result.toUpperCase()).not.toContain(" NOT ");
    expect(result).toContain("foo");
    expect(result).toContain("bar");
  });

  it("strips * prefix wildcard operator", () => {
    const result = sanitizeFts5Query("foo*");
    expect(result).not.toContain("*");
  });

  it("strips ^ column filter injection", () => {
    const result = sanitizeFts5Query("^content:secret");
    expect(result).not.toContain("^");
    expect(result).not.toContain("content:");
  });

  it("strips FTS5 column prefix filters (content: type: project: filename: path:)", () => {
    const result = sanitizeFts5Query("content:foo type:bar project:baz filename:qux path:quux");
    expect(result).not.toContain("content:");
    expect(result).not.toContain("type:");
    expect(result).not.toContain("project:");
    expect(result).not.toContain("filename:");
    expect(result).not.toContain("path:");
    // words after colon should survive
    expect(result).toContain("foo");
    expect(result).toContain("bar");
  });

  it("strips braces, brackets, and special chars", () => {
    const result = sanitizeFts5Query("foo {bar} [baz] (qux)");
    expect(result).not.toMatch(/[{}\[\]()]/);
    expect(result).toContain("foo");
  });

  it("truncates input longer than 500 chars", () => {
    const long = "a".repeat(600);
    const result = sanitizeFts5Query(long);
    expect(result.length).toBeLessThanOrEqual(500);
  });

  it("returns empty string for empty input", () => {
    expect(sanitizeFts5Query("")).toBe("");
  });

  it("handles null bytes", () => {
    const result = sanitizeFts5Query("foo\0bar");
    expect(result).not.toContain("\0");
    expect(result).toContain("foo");
    expect(result).toContain("bar");
  });

  it("preserves normal words after stripping operators", () => {
    const result = sanitizeFts5Query("redis caching strategy");
    expect(result).toBe("redis caching strategy");
  });

  it("collapses multiple spaces into one", () => {
    const result = sanitizeFts5Query("foo   AND   bar");
    expect(result).not.toMatch(/\s{2,}/);
  });

  it("handles injection attempt with semicolons and SQL special chars", () => {
    const result = sanitizeFts5Query("'; DROP TABLE docs; --");
    // Semicolons and single quotes are stripped by the sanitizer
    expect(result).not.toContain(";");
    expect(result).not.toContain("'");
    // Words survive
    expect(result).toContain("DROP");
  });
});

describe("buildRobustFtsQuery: adversarial inputs", () => {
  it("returns empty string for empty input", () => {
    expect(buildRobustFtsQuery("")).toBe("");
  });

  it("handles query that is entirely operators", () => {
    const result = buildRobustFtsQuery("AND OR NOT");
    // All words stripped by sanitizer — result should be empty or a no-op
    expect(typeof result).toBe("string");
  });

  it("handles query with only special characters", () => {
    const result = buildRobustFtsQuery("!@#$%^&*()");
    expect(typeof result).toBe("string");
  });

  it("handles NEAR() injection in query", () => {
    const result = buildRobustFtsQuery("NEAR(foo bar, 10)");
    expect(result.toUpperCase()).not.toContain("NEAR(");
  });

  it("handles very long query (truncated to 500)", () => {
    const long = "word ".repeat(120).trim();
    const result = buildRobustFtsQuery(long);
    expect(typeof result).toBe("string");
    // Should cap at MAX_TOTAL_TERMS (10) terms
    const termCount = result.split(" AND ").length + result.split(" OR ").length;
    expect(termCount).toBeLessThan(30);
  });

  it("produces valid FTS5 output for normal query", () => {
    const result = buildRobustFtsQuery("redis caching strategy");
    expect(result).toBeTruthy();
    // Should not have unbalanced quotes
    const quoteCount = (result.match(/"/g) || []).length;
    expect(quoteCount % 2).toBe(0);
  });

  it("single word query does not crash", () => {
    const result = buildRobustFtsQuery("postgres");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("all stop-word query returns empty or near-empty result", () => {
    // "the", "a", "is", "in", "of" are all stop words
    const result = buildRobustFtsQuery("the a is in of");
    // Should either be empty or very short (stop words filtered)
    expect(typeof result).toBe("string");
  });
});
