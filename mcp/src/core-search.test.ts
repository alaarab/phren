import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rankResults, selectSnippets } from "./cli-hooks-retrieval.js";
import { queryRows, type DbRow, type SqlJsDatabase } from "./shared-index.js";
import type { DocRow } from "./shared-index.js";
import { buildRobustFtsQuery, extractKeywords } from "./utils.js";
import { keywordFallbackSearch } from "./core-search.js";
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

// ── queryRows ──────────────────────────────────────────────────────────────────

describe("queryRows", () => {
  it("returns null for empty query result", () => {
    const db: SqlJsDatabase = {
      run: () => {},
      exec: () => [],
      export: () => new Uint8Array(),
      close: () => {},
    };
    const result = queryRows(db, "SELECT * FROM docs WHERE 1=0", []);
    expect(result).toBeNull();
  });

  it("returns shaped results when exec returns rows", () => {
    const fakeRow: DbRow = ["proj", "file.md", "summary", "content here", "/path"];
    const db: SqlJsDatabase = {
      run: () => {},
      exec: () => [{ columns: ["project", "filename", "type", "content", "path"], values: [fakeRow] }],
      export: () => new Uint8Array(),
      close: () => {},
    };
    const result = queryRows(db, "SELECT * FROM docs", []);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0][0]).toBe("proj");
    expect(result![0][3]).toBe("content here");
  });

  it("returns null when exec throws", () => {
    const db: SqlJsDatabase = {
      run: () => {},
      exec: () => { throw new Error("SQL error"); },
      export: () => new Uint8Array(),
      close: () => {},
    };
    const result = queryRows(db, "INVALID SQL", []);
    expect(result).toBeNull();
  });
});

// ── selectSnippets ─────────────────────────────────────────────────────────────

describe("selectSnippets", () => {
  it("respects token budget by limiting selected snippets", () => {
    const docs: DocRow[] = [
      makeDoc({ path: "/a.md", content: "A ".repeat(500), type: "findings" }),
      makeDoc({ path: "/b.md", content: "B ".repeat(500), type: "findings" }),
      makeDoc({ path: "/c.md", content: "C ".repeat(500), type: "findings" }),
    ];
    // Very small token budget should limit how many snippets are included
    const { selected, usedTokens } = selectSnippets(docs, "test", 80, 10, 200);
    expect(selected.length).toBeLessThanOrEqual(3);
    expect(usedTokens).toBeLessThanOrEqual(200); // should stay within a reasonable range
  });

  it("returns empty array for empty input", () => {
    const { selected, usedTokens } = selectSnippets([], "test", 500, 10, 2000);
    expect(selected).toEqual([]);
    expect(usedTokens).toBe(36); // base overhead
  });

  it("includes snippet text in selected results", () => {
    const docs: DocRow[] = [
      makeDoc({ path: "/x.md", content: "Important finding about authentication", type: "summary" }),
    ];
    const { selected } = selectSnippets(docs, "authentication", 500, 10, 2000);
    expect(selected.length).toBe(1);
    expect(selected[0].snippet).toContain("authentication");
  });
});

// ── Synonym expansion ──────────────────────────────────────────────────────────

describe("synonym expansion in buildRobustFtsQuery", () => {
  it("expands known synonym pairs", () => {
    // "auth" should expand to include "authentication", "authorization", "login", "oauth", "jwt"
    const query = buildRobustFtsQuery("auth");
    expect(query).toContain("auth");
    expect(query).toContain("OR");
    // At least one synonym should appear
    expect(query).toMatch(/authentication|authorization|login|oauth|jwt/);
  });

  it("returns terms without OR when no synonyms match", () => {
    const query = buildRobustFtsQuery("xyznonexistent");
    expect(query).toBe('"xyznonexistent"');
    expect(query).not.toContain("OR");
  });

  it("handles multi-word synonym keys like rate limit", () => {
    const query = buildRobustFtsQuery("rate limit");
    // "rate limit" is a bigram synonym key, should expand
    expect(query).toContain("rate limit");
    expect(query).toContain("OR");
    expect(query).toMatch(/throttle|429/);
  });
});

// ── Search with project filter ─────────────────────────────────────────────────

describe("keywordFallbackSearch with project filter", () => {
  it("only returns rows matching the specified project", () => {
    const rows: DbRow[] = [
      ["proj-a", "FINDINGS.md", "findings", "caching strategy for redis", "/a/FINDINGS.md"],
      ["proj-b", "FINDINGS.md", "findings", "caching strategy for memcached", "/b/FINDINGS.md"],
    ];
    const db: SqlJsDatabase = {
      run: () => {},
      exec: (sql: string) => {
        // Return only proj-a rows when WHERE project = ? is in the query
        if (sql.includes("project = ?")) {
          return [{ columns: ["project", "filename", "type", "content", "path"], values: [rows[0]] }];
        }
        return [{ columns: ["project", "filename", "type", "content", "path"], values: rows }];
      },
      export: () => new Uint8Array(),
      close: () => {},
    };

    const result = keywordFallbackSearch(db, "caching strategy", { project: "proj-a", limit: 10 });
    expect(result).not.toBeNull();
    // All returned rows should be from proj-a (since the SQL filters by project)
    for (const row of result!) {
      expect(row[0]).toBe("proj-a");
    }
  });

  it("returns null for empty query", () => {
    const db: SqlJsDatabase = {
      run: () => {},
      exec: () => [{ columns: ["project", "filename", "type", "content", "path"], values: [["p", "f.md", "t", "content", "/p"]] }],
      export: () => new Uint8Array(),
      close: () => {},
    };
    // All stop words should result in null
    const result = keywordFallbackSearch(db, "the is a", { limit: 10 });
    expect(result).toBeNull();
  });
});

// ── extractKeywords bigram stop-word filtering ─────────────────────────────────

describe("extractKeywords stop-word filtering", () => {
  it("does not include stop words in output", () => {
    const keywords = extractKeywords("the quick brown fox is very fast");
    expect(keywords).not.toMatch(/\bthe\b/);
    expect(keywords).not.toMatch(/\bis\b/);
    expect(keywords).not.toMatch(/\bvery\b/);
    expect(keywords).toContain("quick");
    expect(keywords).toContain("brown");
    expect(keywords).toContain("fox");
    expect(keywords).toContain("fast");
  });

  it("generates bigrams from non-stop-words only", () => {
    const keywords = extractKeywords("rate limit exceeded");
    // Should contain bigram "rate limit" and "limit exceeded"
    expect(keywords).toContain("rate limit");
    expect(keywords).toContain("limit exceeded");
  });
});
