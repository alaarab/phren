import { refreshCitationFreshness } from "../content/citation-freshness.js";
import { selectSnippets } from "../shared/retrieval.js";
import { describe, it, expect, vi } from "vitest";
import { buildHookOutput } from "../cli/hooks-output.js";
import type { SelectedSnippet } from "../shared/retrieval.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const TEST_PHREN_PATH = fs.mkdtempSync(path.join(os.tmpdir(), "phren-hooks-output-"));

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
  // The whole point of printing the key: memory_feedback scores an
  // entryScoreKey, and until it appeared in the injected header there was no
  // way for an agent to learn one. Nothing asserted it, so the feature could
  // regress silently.
  describe("feedback key in snippet headers", () => {
    it("prints the score key as an fb: token an agent can pass back", () => {
      const parts = buildHookOutput(
        [makeSnippet({ key: "test-project/FINDINGS.md:a1b2c3d4e5f6" })],
        50,
        "test-query",
        null,
        "test-project",
        { indexMs: 1, searchMs: 2, trustMs: 3, rankMs: 4, selectMs: 5 },
        500,
        TEST_PHREN_PATH
      );

      const header = parts.find((p) => p.startsWith("[") && p.includes("(findings)"));
      expect(header).toBeDefined();
      expect(header).toContain("fb:test-project/FINDINGS.md:a1b2c3d4e5f6");
    });

    it("emits one fb: token per rendered snippet", () => {
      const selected = [
        makeSnippet({ key: "p/FINDINGS.md:aaaaaaaaaaaa" }),
        makeSnippet({ key: "p/FINDINGS.md:bbbbbbbbbbbb" }),
      ];
      const parts = buildHookOutput(
        selected, 50, "q", null, "p",
        { indexMs: 1, searchMs: 1, trustMs: 1, rankMs: 1, selectMs: 1 },
        5000, TEST_PHREN_PATH
      );
      const keys = parts.join("\n").match(/fb:\S+/g) || [];
      expect(keys).toHaveLength(2);
      expect(keys).toContain("fb:p/FINDINGS.md:aaaaaaaaaaaa");
      expect(keys).toContain("fb:p/FINDINGS.md:bbbbbbbbbbbb");
    });
  });

  describe("buildHookOutput", () => {
    it("omits project label when detectedProject is null", () => {
      const parts = buildHookOutput(
        [makeSnippet()],
        50,
        "query",
        null,
        null,
        { indexMs: 0, searchMs: 0, trustMs: 0, rankMs: 0, selectMs: 0 },
        500,
        TEST_PHREN_PATH
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
        TEST_PHREN_PATH
      );
      // Should have fewer snippet blocks than input
      const snippetBlocks = parts.filter(p => p.startsWith("["));
      expect(snippetBlocks.length).toBeLessThan(4);
    });
  });
});


it("keeps cached citation warnings in the Clanker compact index without network", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clanker-freshness-"));
  const project = "test-project";
  const citation = { created_at: "2026-10-15T00:00:00Z", file: "src/cache.ts", commit: "abcdef1" };
  fs.mkdirSync(path.join(root, project));
  fs.writeFileSync(path.join(root, project, "phren.project.yaml"), "remote: https://gitboy.example/alice/app.git\n");
  const content = `- Redis cache avoids double charges <!-- fid:12345678 -->\n  <!-- phren:cite ${JSON.stringify(citation)} -->`;
  const doc = { project, filename: "FINDINGS.md", type: "findings", content, path: path.join(root, project, "FINDINGS.md") };
  await refreshCitationFreshness([citation], { phrenPath: root, projectRemote: "https://gitboy.example/alice/app.git", budgetMs: 1500,
    fetchImpl: async () => new Response(JSON.stringify({ paths: [{ path: citation.file, changed: true, last_commit: null }] })) });
  vi.stubEnv("PHREN_CLANKER", "on");
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network"));
  try {
    const { selected, usedTokens } = selectSnippets([doc], "Redis cache", 2000, 8, 1200);
    const output = buildHookOutput(selected, usedTokens, "query", null, project, {}, 2000, root, undefined, "Redis cache").join("\n");
    expect(output).toContain('fid:12345678');
    expect(output).toContain('[may be out of date: src/cache.ts changed since cited]');
    expect(output.match(/\[may be out of date:/g)).toHaveLength(1);
    expect(network).not.toHaveBeenCalled();
  } finally { network.mockRestore(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); }
});
