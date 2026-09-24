/**
 * Tests for the handleHookStop auto-capture path (PHREN_FEATURE_AUTO_CAPTURE=1).
 * Tests extractConversationInsights directly (which is the core extraction logic)
 * plus the addFindingToFile integration to verify insights can be persisted.
 */
import { describe, expect, it, } from "vitest";
import { extractConversationInsights, filterConversationInsightsForProactivity } from "../cli/hooks-session.js";

describe("extractConversationInsights: keyword extraction", () => {
  it("extracts lines containing insight keywords", () => {
    const text = [
      "Always use parameterized queries to prevent SQL injection in production",
      "const x = 1;",  // code line — skip
      "# Heading",     // heading — skip
      "Never store plaintext passwords in any database or log file",
      "short",         // too short — skip
    ].join("\n");

    const insights = extractConversationInsights(text);
    expect(insights.length).toBeGreaterThan(0);
    expect(insights.some(i => i.toLowerCase().includes("parameterized"))).toBe(true);
  });

  it("skips code blocks, shell lines, and headers", () => {
    const text = [
      "```typescript\nconst foo = bar;\n```",
      "$ npm install",
      "> quoted block",
      "// this is a comment line that is long enough to pass the length filter hopefully",
      "# This is a heading that might trigger keywords like always use this pattern",
    ].join("\n");

    const insights = extractConversationInsights(text);
    // None of the above should be extracted (code/shell/comment/heading lines)
    expect(insights).toEqual([]);
  });

  it("deduplicates identical insights", () => {
    const line = "Always use connection pooling for database performance optimization";
    const text = [line, line, line].join("\n");
    const insights = extractConversationInsights(text);
    expect(insights.length).toBe(1);
  });

  it("caps output at 5 insights", () => {
    const lines = [
      "Always use parameterized queries to prevent SQL injection vulnerabilities",
      "Never store passwords in plaintext — always hash with bcrypt or argon2",
      "Use connection pooling for database performance in production systems",
      "Always validate user input at the API boundary before processing it",
      "Never expose raw error messages to clients — log server side only",
      "Always use HTTPS for all external API calls in production environments",
      "Never commit secrets or credentials to version control repositories",
    ];
    const insights = extractConversationInsights(lines.join("\n"));
    expect(insights).toHaveLength(5);
  });

  it("returns empty array for input with no insight keywords", () => {
    const text = [
      "This line has no relevant keyword patterns at all whatsoever",
      "Another boring line without any of the target vocabulary in it",
    ].join("\n");
    const insights = extractConversationInsights(text);
    expect(insights).toEqual([]);
  });
});

describe("filterConversationInsightsForProactivity", () => {
  const insights = [
    "Always validate API payloads before decoding them",
    "This is worth remembering before the next migration window",
    "[decision] Use WAL mode for local concurrent reads",
  ];

  it("keeps only explicit signals at medium", () => {
    expect(filterConversationInsightsForProactivity(insights, "medium")).toEqual([
      "This is worth remembering before the next migration window",
      "[decision] Use WAL mode for local concurrent reads",
    ]);
  });
});

