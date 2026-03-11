import { describe, it, expect } from "vitest";
import { buildHookOutput } from "../cli-hooks-output.js";
import type { SelectedSnippet } from "../shared-retrieval.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const TEST_CORTEX_PATH = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-hooks-output-"));

function makeSnippet(overrides: Partial<SelectedSnippet> = {}): SelectedSnippet {
  return {
    doc: {
      project: "test-project",
      filename: "FINDINGS.md",
      type: "findings",
      content: "- Some finding content",
      path: "/test/FINDINGS.md",
    },
    snippet: "- Some finding content",
    key: "test-project/FINDINGS.md",
    score: 1.0,
    ...overrides,
  };
}

describe("cli-hooks-output", () => {
  describe("buildHookOutput", () => {
    it("returns array with status line, context tags, and trace", () => {
      const selected = [makeSnippet()];
      const parts = buildHookOutput(
        selected,
        50,
        "test-query",
        null,
        "test-project",
        { indexMs: 1, searchMs: 2, trustMs: 3, rankMs: 4, selectMs: 5 },
        500,
        TEST_CORTEX_PATH
      );

      expect(parts[0]).toContain("cortex");
      expect(parts[0]).toContain("test-project");
      expect(parts[0]).toContain("1 result");
      expect(parts[1]).toBe("<cortex-context>");
      expect(parts[parts.length - 2]).toBe("<cortex-context>");
      expect(parts[parts.length - 1]).toContain("trace:");
    });

    it("shows N results in status line for multiple snippets", () => {
      const selected = [makeSnippet(), makeSnippet({ key: "test-project/other.md" })];
      const parts = buildHookOutput(
        selected,
        100,
        "query",
        null,
        "test-project",
        { indexMs: 0, searchMs: 0, trustMs: 0, rankMs: 0, selectMs: 0 },
        1000,
        TEST_CORTEX_PATH
      );
      expect(parts[0]).toContain("2 results");
    });

    it("includes branch and changed files info in trace when git context provided", () => {
      const gitCtx = { branch: "feature/auth", changedFiles: new Set(["src/auth.ts"]) };
      const parts = buildHookOutput(
        [makeSnippet()],
        50,
        "auth",
        gitCtx,
        "test-project",
        { indexMs: 0, searchMs: 0, trustMs: 0, rankMs: 0, selectMs: 0 },
        500,
        TEST_CORTEX_PATH
      );
      const trace = parts[parts.length - 1];
      expect(trace).toContain("branch=feature/auth");
      expect(trace).toContain("changed_files=1");
    });

    it("omits project label when detectedProject is null", () => {
      const parts = buildHookOutput(
        [makeSnippet()],
        50,
        "query",
        null,
        null,
        { indexMs: 0, searchMs: 0, trustMs: 0, rankMs: 0, selectMs: 0 },
        500,
        TEST_CORTEX_PATH
      );
      expect(parts[0]).not.toContain(" \u00b7 test-project");
    });

    it("trims middle items when over token budget with 3+ snippets", () => {
      const bigSnippet = (key: string) =>
        makeSnippet({ snippet: "x".repeat(2000), key });
      const selected = [
        bigSnippet("a"),
        bigSnippet("b"),
        bigSnippet("c"),
        bigSnippet("d"),
      ];
      const parts = buildHookOutput(
        selected,
        2000,
        "query",
        null,
        "test-project",
        { indexMs: 0, searchMs: 0, trustMs: 0, rankMs: 0, selectMs: 0 },
        100, // very tight budget
        TEST_CORTEX_PATH
      );
      // Should have fewer snippet blocks than input
      const snippetBlocks = parts.filter(p => p.startsWith("["));
      expect(snippetBlocks.length).toBeLessThan(4);
    });
  });
});
