import { describe, it, expect } from "vitest";
import { buildFtsQueryVariants, buildRelaxedFtsQuery, buildRobustFtsQuery, sanitizeFts5Query, extractKeywords } from "./utils.js";
import { extractSnippet } from "./shared/index.js";

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

  it("handles many terms without crashing", () => {
    const manyTerms = Array.from({ length: 50 }, (_, i) => `term${i}`).join(" ");
    const result = buildRobustFtsQuery(manyTerms);
    expect(result.length).toBeGreaterThan(0);
    // Terms without synonym matches are AND'd together
    expect(result).toContain("AND");
  });
});

describe("buildRelaxedFtsQuery", () => {
  it("builds a pairwise relaxed rescue query for longer prompts", () => {
    const query = buildRelaxedFtsQuery("semantic search setup during init with ollama");
    expect(query).toContain(" OR ");
    expect(query).toContain(" AND ");
    expect(query).toContain("\"semantic\"");
  });

  it("returns OR query for short 2-word inputs instead of empty string", () => {
    const result = buildRelaxedFtsQuery("auth cache");
    expect(result).toContain("OR");
    expect(result).toContain("auth");
    expect(result).toContain("cache");
  });
});

describe("buildFtsQueryVariants", () => {
  it("returns strict query first and appends a distinct relaxed fallback", () => {
    const variants = buildFtsQueryVariants("alerts to external webhook instead of discord");
    expect(variants.length).toBeGreaterThan(1);
    expect(variants[0]).toContain("\"alerts\"");
    expect(variants[1]).toContain(" OR ");
  });
});

describe("sanitizeFts5Query edge cases", () => {
  it("strips null bytes", () => {
    expect(sanitizeFts5Query("foo\0bar")).toBe("foo bar");
  });

  it("strips FTS5 boolean operators", () => {
    const result = sanitizeFts5Query("foo AND bar OR baz NOT qux NEAR quux");
    // Whitelist sanitizer keeps letters-only words like AND/OR/NOT/NEAR; only special chars stripped
    expect(result).toContain("foo");
    expect(result).toContain("bar");
    expect(result).toContain("quux");
    // No special chars (parens, colon, etc.)
    expect(result).not.toContain("(");
    expect(result).not.toContain(")");
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
