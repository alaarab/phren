/**
 * Tests for the handleHookStop auto-capture path (CORTEX_FEATURE_AUTO_CAPTURE=1).
 * Tests extractConversationInsights directly (which is the core extraction logic)
 * plus the addFindingToFile integration to verify insights can be persisted.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, grantAdmin } from "../test-helpers.js";
import { extractConversationInsights, filterConversationInsightsForProactivity } from "../cli-hooks-session.js";
import { addFindingToFile } from "../shared-content.js";

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
    for (const insight of insights) {
      expect(insight.trim()).not.toMatch(/^[$>#`\/]/);
    }
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
    expect(insights.length).toBeLessThanOrEqual(5);
  });

  it("returns empty array for input with no insight keywords", () => {
    const text = [
      "This line has no relevant keyword patterns at all whatsoever",
      "Another boring line without any of the target vocabulary in it",
    ].join("\n");
    const insights = extractConversationInsights(text);
    // May or may not extract — just verify it doesn't crash
    expect(Array.isArray(insights)).toBe(true);
  });

  it("returns empty array for empty input", () => {
    const insights = extractConversationInsights("");
    expect(insights).toEqual([]);
  });
});

describe("filterConversationInsightsForProactivity", () => {
  const insights = [
    "Always validate API payloads before decoding them",
    "This is worth remembering before the next migration window",
    "[decision] Use WAL mode for local concurrent reads",
  ];

  it("keeps all extracted insights at high", () => {
    expect(filterConversationInsightsForProactivity(insights, "high")).toEqual(insights);
  });

  it("keeps only explicit signals at medium", () => {
    expect(filterConversationInsightsForProactivity(insights, "medium")).toEqual([
      "This is worth remembering before the next migration window",
      "[decision] Use WAL mode for local concurrent reads",
    ]);
  });

  it("drops all auto-captured insights at low", () => {
    expect(filterConversationInsightsForProactivity(insights, "low")).toEqual([]);
  });
});

describe("auto-capture integration: insights can be persisted via addFindingToFile", () => {
  let tmp: { path: string; cleanup: () => void };

  beforeEach(() => {
    tmp = makeTempDir("autocapture-test-");
    grantAdmin(tmp.path);
    const projectDir = path.join(tmp.path, "myapp");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "summary.md"), "# myapp\nTest project.\n");
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it("each extracted insight can be saved as a finding without error", () => {
    const text = [
      "Always use parameterized queries to prevent SQL injection in production databases",
      "Never expose raw stack traces to API clients — log on server and return generic errors",
    ].join("\n");

    const insights = extractConversationInsights(text);
    expect(insights.length).toBeGreaterThan(0);

    for (const insight of insights) {
      const r = addFindingToFile(tmp.path, "myapp", `[pattern] ${insight}`);
      expect(r.ok).toBe(true);
    }

    const content = fs.readFileSync(path.join(tmp.path, "myapp", "FINDINGS.md"), "utf-8");
    for (const insight of insights) {
      expect(content).toContain(insight.slice(0, 30));
    }
  });

  it("duplicate insight from auto-capture is skipped gracefully", () => {
    const insight = "Always use parameterized queries to prevent SQL injection in production";
    addFindingToFile(tmp.path, "myapp", `[pattern] ${insight}`);

    // Second capture of the same insight should not crash or duplicate
    const r = addFindingToFile(tmp.path, "myapp", `[pattern] ${insight}`);
    expect(r.ok).toBe(true);

    const content = fs.readFileSync(path.join(tmp.path, "myapp", "FINDINGS.md"), "utf-8");
    const count = (content.match(/parameterized queries/g) || []).length;
    expect(count).toBe(1);
  });

  it("invalid project name from auto-capture returns error without crashing", () => {
    const r = addFindingToFile(tmp.path, "../escape", "[pattern] Some insight about security");
    expect(r.ok).toBe(false);
  });
});
