import { describe, it, expect } from "vitest";
import { buildRobustFtsQuery, sanitizeFts5Query, extractKeywords } from "./utils.js";
import { extractSnippet } from "./shared.js";

describe("buildRobustFtsQuery edge cases", () => {
  it("deduplicates repeated terms", () => {
    const query = buildRobustFtsQuery("auth auth auth");
    const matches = query.match(/"auth"/g);
    expect(matches).toHaveLength(1);
  });

  it("expands multiple synonym groups in one query", () => {
    const query = buildRobustFtsQuery("auth cache");
    expect(query).toContain('"authentication"');
    expect(query).toContain('"caching"');
  });

  it("filters out single-character terms", () => {
    const query = buildRobustFtsQuery("a b cd");
    expect(query).not.toContain('"a"');
    expect(query).not.toContain('"b"');
    expect(query).toContain('"cd"');
  });

  it("strips double quotes from within terms", () => {
    const result = buildRobustFtsQuery('some "quoted" thing');
    expect(result).not.toContain('""');
  });

  it("handles many terms without crashing", () => {
    const manyTerms = Array.from({ length: 50 }, (_, i) => `term${i}`).join(" ");
    const result = buildRobustFtsQuery(manyTerms);
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("OR");
  });
});

describe("sanitizeFts5Query edge cases", () => {
  it("strips null bytes", () => {
    expect(sanitizeFts5Query("foo\0bar")).toBe("foo bar");
  });

  it("strips FTS5 boolean operators", () => {
    const result = sanitizeFts5Query("foo AND bar OR baz NOT qux NEAR quux");
    expect(result).not.toMatch(/\bAND\b/i);
    expect(result).not.toMatch(/\bOR\b/i);
    expect(result).not.toMatch(/\bNOT\b/i);
    expect(result).not.toMatch(/\bNEAR\b/i);
    expect(result).toContain("foo");
    expect(result).toContain("bar");
    expect(result).toContain("quux");
  });

  it("strips special punctuation but keeps hyphens in words", () => {
    const result = sanitizeFts5Query("rate-limit @#$ test!");
    expect(result).toContain("rate-limit");
    expect(result).not.toContain("@");
    expect(result).not.toContain("#");
    expect(result).not.toContain("!");
  });

  it("collapses multiple spaces into one", () => {
    const result = sanitizeFts5Query("  foo    bar   ");
    expect(result).toBe("foo bar");
  });

  it("preserves URL-like strings minus special chars", () => {
    const result = sanitizeFts5Query("https://example.com/path");
    expect(result).toContain("https");
    expect(result).toContain("example.com");
  });
});

describe("extractSnippet", () => {
  const sampleDoc = [
    "# Project Overview",
    "",
    "This is an introduction to the project.",
    "",
    "## Authentication",
    "",
    "The auth module handles login and OAuth tokens.",
    "It supports JWT and session-based auth.",
    "",
    "## Database",
    "",
    "We use SQLite with WAL mode for reads.",
    "The connection pool handles concurrency.",
    "",
    "## Deployment",
    "",
    "Deploy via CI pipeline to production.",
  ].join("\n");

  it("returns lines around the best matching term", () => {
    const snippet = extractSnippet(sampleDoc, "auth");
    expect(snippet).toContain("auth");
  });

  it("prefers lines near headings", () => {
    const snippet = extractSnippet(sampleDoc, "auth");
    // Should pick content near the ## Authentication heading, not the Deployment section
    expect(snippet).toContain("auth module");
    expect(snippet).not.toContain("Deploy");
  });

  it("returns the start of the file when query has no matches", () => {
    const snippet = extractSnippet(sampleDoc, "xyznonexistent");
    expect(snippet).toContain("Project Overview");
  });

  it("returns the start of the file for empty query", () => {
    const snippet = extractSnippet(sampleDoc, "");
    expect(snippet).toContain("Project Overview");
  });

  it("scores multi-term matches higher", () => {
    const snippet = extractSnippet(sampleDoc, "SQLite WAL");
    expect(snippet).toContain("SQLite");
    expect(snippet).toContain("WAL");
  });

  it("respects the lines parameter", () => {
    const snippet = extractSnippet(sampleDoc, "auth", 2);
    const lineCount = snippet.split("\n").length;
    expect(lineCount).toBeLessThanOrEqual(3); // bestIdx-1 to bestIdx+lines-1
  });

  it("handles single-line content", () => {
    const snippet = extractSnippet("Just one line with auth", "auth");
    expect(snippet).toContain("auth");
  });

  it("handles content with no headings", () => {
    const noHeadings = "Line one about auth\nLine two about database\nLine three about deploy";
    const snippet = extractSnippet(noHeadings, "database");
    expect(snippet).toContain("database");
  });

  it("strips FTS operators from the query before matching", () => {
    const snippet = extractSnippet(sampleDoc, '"auth" OR "login"');
    expect(snippet).toContain("auth");
  });
});

describe("extractKeywords", () => {
  it("removes stop words from the result", () => {
    const result = extractKeywords("the quick brown fox is very fast");
    expect(result).not.toContain("the");
    expect(result).not.toContain("is");
    expect(result).not.toContain("very");
    expect(result).toContain("quick");
    expect(result).toContain("brown");
  });

  it("generates bigrams from adjacent keywords", () => {
    const result = extractKeywords("rate limit config");
    expect(result).toContain("rate limit");
    expect(result).toContain("limit config");
  });

  it("caps output at 10 tokens", () => {
    const longInput = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa";
    const tokens = extractKeywords(longInput).split(" ");
    // Individual words + bigrams, capped at 10
    expect(tokens.length).toBeLessThanOrEqual(20); // bigrams count as 2 words in the joined string
    const result = extractKeywords(longInput);
    // The function caps at 10 entries (words + bigrams)
    const entries = result.split(/\s+/);
    expect(entries.length).toBeLessThanOrEqual(20);
  });

  it("strips punctuation before extracting", () => {
    const result = extractKeywords("auth-module! @config #deploy");
    expect(result).toContain("auth-module");
    expect(result).toContain("config");
    expect(result).toContain("deploy");
  });

  it("returns empty string for all-stop-word input", () => {
    const result = extractKeywords("the is a an and or but in on at");
    expect(result).toBe("");
  });
});
