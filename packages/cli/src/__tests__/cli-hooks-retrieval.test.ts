import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { makeTempDir, grantAdmin } from "../test-helpers.js";

// Set PHREN_PATH before importing cli-hooks
const tmpPhren = fs.mkdtempSync(path.join(os.tmpdir(), "phren-retrieval-test-"));
process.env.PHREN_PATH = tmpPhren;

import { rankResults, searchDocuments, applyRelevanceFloor, DEFAULT_MIN_QUERY_RELEVANCE } from "../cli/hooks.js";
import type { DocRow } from "../shared/index.js";
import { buildRobustFtsQuery } from "../utils.js";

afterEach(() => {
  delete process.env.PHREN_ACTOR;
});

describe("rankResults", () => {
  function makeDocRow(project: string, filename: string, type: string, content: string): DocRow {
    return { project, filename, type, content, path: `/tmp/${project}/${filename}` };
  }

  it("uses boost not hard filter for project relevance", () => {
    const rows: DocRow[] = [
      makeDocRow("other-project", "FINDINGS.md", "findings", "## 2025-01-01\n- Some insight"),
      makeDocRow("myapp", "AGENTS.md", "claude", "# myapp\nProject description"),
      makeDocRow("myapp", "FINDINGS.md", "findings", "## 2025-06-01\n- Recent insight"),
    ];

    // rankResults should not filter out other-project rows, but may reorder them
    const ranked = rankResults(rows, "general", null, "myapp", tmpPhren, null);
    expect(ranked.length).toBeGreaterThanOrEqual(2); // at minimum keeps myapp rows
    // myapp claude should appear (it's the detected project)
    expect(ranked.some(r => r.project === "myapp")).toBe(true);
  });

  it("prioritizes findings type over non-findings types", () => {
    const rows: DocRow[] = [
      makeDocRow("myapp", "FINDINGS.md", "findings", "## 2025-01-01\n- An insight"),
      makeDocRow("myapp", "AGENTS.md", "claude", "# myapp\nSetup instructions"),
    ];

    const ranked = rankResults(rows, "general", null, "myapp", tmpPhren, null);
    // findings should rank before claude/non-findings types
    const claudeIdx = ranked.findIndex(r => r.type === "claude");
    const learningsIdx = ranked.findIndex(r => r.type === "findings");
    if (claudeIdx !== -1 && learningsIdx !== -1) {
      expect(learningsIdx).toBeLessThan(claudeIdx);
    }
  });

  it("keeps a single strong task result when it clearly beats non-task noise", () => {
    const longTaskPrefix = Array.from({ length: 28 }, (_, i) => `filler${i}`).join(" ");
    const rows: DocRow[] = [
      makeDocRow(
        "sampleatlas",
        "tasks.md",
        "task",
        `# task\n- ${longTaskPrefix}\n- Route alerts to an external webhook instead of Discord for monitors`
      ),
      makeDocRow(
        "sampleportal",
        "FINDINGS.md",
        "findings",
        "## 2025-06-01\n- Discord notifications exist for project reports"
      ),
      makeDocRow(
        "sampleops",
        "restart-ableton.md",
        "skill",
        "Restart Ableton when a monitoring session hangs"
      ),
    ];

    const ranked = rankResults(
      rows,
      "general",
      null,
      null,
      tmpPhren,
      null as any,
      undefined,
      "alerts to external webhook instead of discord"
    );

    expect(ranked.some((row) => row.type === "task")).toBe(true);
    expect(ranked.findIndex((row) => row.type === "task")).toBeLessThan(
      ranked.findIndex((row) => row.project === "sampleops")
    );
  });
});

describe("searchDocuments", () => {
  it("returns null for empty database", () => {
    // Mock db that returns empty results
    const mockDb = {
      exec: () => [],
    };
    const result = searchDocuments(mockDb, "test query", "test", "test", null);
    expect(result).toBeNull();
  });

  it("passes through the safe query to the database", () => {
    // searchDocuments passes the safeQuery directly to FTS5 MATCH
    // Verify it attempts queries with the provided search term
    let queryCalled = false;
    const mockDb = {
      exec: (sql: string, params: any[]) => {
        if (sql.includes("MATCH") && params.length > 0) {
          queryCalled = true;
        }
        return [];
      },
    };
    searchDocuments(mockDb, "test query", "test query", "test,query", null);
    expect(queryCalled).toBe(true);
  });

  it("uses deterministic rowid windows for semantic fallback instead of ORDER BY RANDOM", () => {
    const sqlCalls: string[] = [];
    const row = [42, "proj", "FINDINGS.md", "findings", "retry transient failures in background jobs", "/tmp/proj/FINDINGS.md"];
    const mockDb = {
      exec: (sql: string, params: any[]) => {
        sqlCalls.push(sql);
        if (sql.includes("MATCH")) return [];
        if (sql.includes("MIN(rowid)")) {
          return [{ columns: ["min_rowid", "max_rowid", "count"], values: [[1, 500, 500]] }];
        }
        if (sql.includes("rowid >= ?")) {
          return [{ columns: ["rowid", "project", "filename", "type", "content", "path"], values: [row] }];
        }
        if (sql.includes("rowid < ?")) return [];
        return [];
      },
    };

    const result = searchDocuments(mockDb as any, "missing", "retry transient failures", "retry failures", null);
    expect(result).not.toBeNull();
    expect(result?.[0]?.path).toBe("/tmp/proj/FINDINGS.md");
    expect(sqlCalls.some((sql) => sql.includes("ORDER BY RANDOM"))).toBe(false);
    expect(sqlCalls.some((sql) => sql.includes("rowid >= ?"))).toBe(true);
  });

  it("retries with a relaxed FTS query when the strict lexical query misses", () => {
    const strictQuery = buildRobustFtsQuery("semantic search setup during init with ollama");
    const seenQueries: string[] = [];
    const row = ["phren", "FINDINGS.md", "findings", "Semantic opt-in during init should finish at the dependency level", "/tmpphren/FINDINGS.md"];
    const mockDb = {
      exec: (sql: string, params: any[]) => {
        if (sql.includes("MATCH")) {
          seenQueries.push(String(params[0]));
          if (seenQueries.length === 1) return [];
          return [{ columns: ["project", "filename", "type", "content", "path"], values: [row] }];
        }
        if (sql.includes("MIN(rowid)")) {
          return [{ columns: ["min_rowid", "max_rowid", "count"], values: [[1, 1, 0]] }];
        }
        return [];
      },
    };

    const result = searchDocuments(
      mockDb as any,
      strictQuery,
      "semantic search setup during init with ollama",
      "semantic search setup during init ollama",
      null
    );

    expect(result?.[0]?.path).toBe("/tmpphren/FINDINGS.md");
    expect(seenQueries).toHaveLength(2);
    expect(seenQueries[1]).toContain(" OR ");
  });
});

describe("applyRelevanceFloor", () => {
  function makeDocRow(project: string, filename: string, type: string, content: string): DocRow {
    return { project, filename, type, content, path: `/tmp/${project}/${filename}` };
  }

  const KEYWORDS = "webhook discord alerts monitor";

  it("drops a doc with zero query overlap (priors-only ranking noise)", () => {
    const rows = [makeDocRow("zeta", "notes.md", "findings", "The quick brown fox jumps over the lazy dog")];
    const kept = applyRelevanceFloor(rows, KEYWORDS, null, null);
    expect(kept).toHaveLength(0); // inject nothing rather than noise
  });

  it("keeps a doc whose text actually matches the prompt", () => {
    const rows = [
      makeDocRow("zeta", "notes.md", "findings", "Route alerts to an external webhook instead of discord for monitors"),
    ];
    const kept = applyRelevanceFloor(rows, KEYWORDS, null, null);
    expect(kept).toHaveLength(1);
  });

  it("keeps a structurally-relevant doc (changed file) even with no textual overlap", () => {
    const rows = [makeDocRow("myapp", "auth-config.md", "findings", "nothing lexically relevant here at all")];
    const gitCtx = { branch: "main", changedFiles: new Set(["auth-config.md"]) };
    const kept = applyRelevanceFloor(rows, KEYWORDS, gitCtx, "myapp");
    expect(kept).toHaveLength(1);
  });

  it("holds a canonical doc for the detected project to the same bar as any other", () => {
    const rows = [makeDocRow("myapp", "AGENTS.md", "canonical", "unrelated project overview text")];
    expect(applyRelevanceFloor(rows, KEYWORDS, null, "myapp")).toHaveLength(0);
    const matching = [makeDocRow("myapp", "AGENTS.md", "canonical", "- Alerts go to the discord webhook.")];
    expect(applyRelevanceFloor(matching, KEYWORDS, null, "myapp")).toHaveLength(1);
  });

  it("needs two keywords in one bullet, not scattered across a file", () => {
    const archive = makeDocRow("other", "reference/topics/ops.md", "reference",
      "- The webhook retries three times.\n- Discord rate limits bursts.\n- Alerts page the on-call.");
    expect(applyRelevanceFloor([archive], KEYWORDS, null, "myapp")).toHaveLength(0);
    const together = makeDocRow("other", "reference/topics/ops.md", "reference",
      "- Unrelated bullet.\n- Discord alerts go through the webhook proxy.");
    expect(applyRelevanceFloor([together], KEYWORDS, null, "myapp")).toHaveLength(1);
  });

  it("weighs keywords by rarity: common words together clear nothing", () => {
    const doc = makeDocRow("max", "notes.md", "findings", "- Push the fix to main before the release.");
    const common = new Map([["push", 0.22], ["main", 0.18]]);
    expect(applyRelevanceFloor([doc], "push main", null, "max", undefined, common)).toHaveLength(0);
    const rare = new Map([["push", 0.22], ["main", 0.45]]);
    expect(applyRelevanceFloor([doc], "push main", null, "max", undefined, rare)).toHaveLength(1);
  });

  it("never matches the path: every store path contains .phren", () => {
    const doc = { ...makeDocRow("objectstudio", "FINDINGS.md", "findings", "- Delegation notes for the studio."),
      path: "/home/sam/.phren/objectstudio/FINDINGS.md" };
    expect(applyRelevanceFloor([doc], "phren delegation", null, null, undefined, new Map([["phren", 0.9], ["delegation", 0.9]]))).toHaveLength(0);
  });

  it("is a no-op when the floor is 0 (disabled)", () => {
    const rows = [makeDocRow("zeta", "notes.md", "findings", "totally unrelated content")];
    const kept = applyRelevanceFloor(rows, KEYWORDS, null, null, 0);
    expect(kept).toHaveLength(1);
  });

  it("injects nothing when the prompt has fewer keywords than a bullet must match (\"Yes\")", () => {
    const rows = [makeDocRow("zeta", "notes.md", "findings", "- yes, totally unrelated content")];
    expect(applyRelevanceFloor(rows, "", null, null)).toHaveLength(0);
    expect(applyRelevanceFloor(rows, "yes", null, null)).toHaveLength(0);
    // A changed file is still a tie to the work.
    const changed = makeDocRow("zeta", "auth-config.md", "findings", "anything");
    expect(applyRelevanceFloor([changed], "yes", { changedFiles: new Set(["auth-config.md"]) }, "zeta")).toHaveLength(1);
  });

  it("exposes a sane default floor in (0, 1)", () => {
    expect(DEFAULT_MIN_QUERY_RELEVANCE).toBeGreaterThan(0);
    expect(DEFAULT_MIN_QUERY_RELEVANCE).toBeLessThan(1);
  });
});
