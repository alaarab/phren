import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rankResults } from "./cli-hooks-retrieval.js";
import type { DocRow, SqlJsDatabase } from "./shared-index.js";
import { makeTempDir } from "./test-helpers.js";

// Minimal mock DB that returns empty results for all queries.
// rankResults calls queryDocRows (for canonical rows) and getEntityBoostDocs
// (via queryRows). Both flow through db.exec(), so returning empty is sufficient.
function mockDb(): SqlJsDatabase {
  return {
    run: () => {},
    exec: () => [],
    export: () => new Uint8Array(),
    close: () => {},
  };
}

function makeDoc(overrides: Partial<DocRow> & { path: string }): DocRow {
  return {
    project: "test",
    filename: "test.md",
    type: "summary",
    content: "test content",
    ...overrides,
  };
}

describe("rankResults", () => {
  let tmpDir: string;
  let tmpCleanup: () => void;
  const origGitCtxEnv = process.env.CORTEX_FEATURE_GIT_CONTEXT_FILTER;

  beforeEach(() => {
    ({ path: tmpDir, cleanup: tmpCleanup } = makeTempDir("core-search-test-"));
    // Disable git-context filter for predictable scoring
    delete process.env.CORTEX_FEATURE_GIT_CONTEXT_FILTER;
  });

  afterEach(() => {
    tmpCleanup();
    if (origGitCtxEnv === undefined) delete process.env.CORTEX_FEATURE_GIT_CONTEXT_FILTER;
    else process.env.CORTEX_FEATURE_GIT_CONTEXT_FILTER = origGitCtxEnv;
  });

  it("empty input returns empty array without throwing", () => {
    const result = rankResults([], "general", null, null, tmpDir, mockDb());
    expect(result).toEqual([]);
  });

  it("single item returns it unchanged", () => {
    const doc = makeDoc({ path: "/test/only.md", project: "solo" });
    const result = rankResults([doc], "general", null, null, tmpDir, mockDb());
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("/test/only.md");
    expect(result[0].project).toBe("solo");
  });

  it("higher-scoring items appear before lower-scoring items", () => {
    // "canonical" type gets intentBoost of 2 for "general" intent;
    // "summary" type gets 0 for "general" intent.
    const highDoc = makeDoc({ path: "/test/high.md", type: "canonical", content: "high priority" });
    const lowDoc = makeDoc({ path: "/test/low.md", type: "summary", content: "low priority" });

    // Pass them in reverse order to verify sorting
    const result = rankResults([lowDoc, highDoc], "general", null, null, tmpDir, mockDb());
    expect(result.length).toBeGreaterThanOrEqual(2);
    // canonical (intentBoost=2) should come before summary (intentBoost=0)
    const highIdx = result.findIndex(r => r.path === "/test/high.md");
    const lowIdx = result.findIndex(r => r.path === "/test/low.md");
    expect(highIdx).toBeLessThan(lowIdx);
  });

  it("equal-score items sort deterministically by path (stable secondary key)", () => {
    // Create docs with identical types and content so they get identical scores
    const docA = makeDoc({ path: "/test/aaa.md", type: "summary", content: "same", project: "test" });
    const docB = makeDoc({ path: "/test/zzz.md", type: "summary", content: "same", project: "test" });
    const docM = makeDoc({ path: "/test/mmm.md", type: "summary", content: "same", project: "test" });

    // Run multiple times to verify determinism
    const results: string[][] = [];
    for (let i = 0; i < 5; i++) {
      // Shuffle input order each iteration
      const shuffled = i % 2 === 0 ? [docB, docA, docM] : [docM, docB, docA];
      const ranked = rankResults(shuffled, "general", null, null, tmpDir, mockDb());
      results.push(ranked.map(r => r.path));
    }

    // All iterations should produce the same order
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toEqual(results[0]);
    }

    // The stable sort should be alphabetical by path
    const firstResult = results[0];
    expect(firstResult).toEqual(["/test/aaa.md", "/test/mmm.md", "/test/zzz.md"]);
  });

  it("score rounding prevents floating-point instability", () => {
    // The sort uses Math.round(score * 10000) / 10000 to stabilize comparisons.
    // Verify that two docs with very close but identical computed scores
    // still sort deterministically (by path tiebreaker, not by float noise).
    const doc1 = makeDoc({ path: "/test/alpha.md", type: "summary", content: "x", project: "p1" });
    const doc2 = makeDoc({ path: "/test/beta.md", type: "summary", content: "x", project: "p1" });

    // Same type, same content pattern -> same score -> path tiebreaker
    const result = rankResults([doc2, doc1], "general", null, null, tmpDir, mockDb());
    expect(result[0].path).toBe("/test/alpha.md");
    expect(result[1].path).toBe("/test/beta.md");
  });
});
