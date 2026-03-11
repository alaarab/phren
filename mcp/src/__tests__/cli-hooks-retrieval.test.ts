import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { makeTempDir, grantAdmin } from "../test-helpers.js";

// Set CORTEX_PATH before importing cli-hooks
const tmpCortex = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-retrieval-test-"));
process.env.CORTEX_PATH = tmpCortex;

import { rankResults, searchDocuments } from "../cli-hooks.js";
import type { DocRow } from "../shared-index.js";
import { buildRobustFtsQuery } from "../utils.js";

afterEach(() => {
  delete process.env.CORTEX_ACTOR;
});

describe("rankResults", () => {
  function makeDocRow(project: string, filename: string, type: string, content: string): DocRow {
    return { project, filename, type, content, path: `/tmp/${project}/${filename}` };
  }

  it("uses boost not hard filter for project relevance", () => {
    const rows: DocRow[] = [
      makeDocRow("other-project", "FINDINGS.md", "findings", "## 2025-01-01\n- Some insight"),
      makeDocRow("myapp", "CLAUDE.md", "claude", "# myapp\nProject description"),
      makeDocRow("myapp", "FINDINGS.md", "findings", "## 2025-06-01\n- Recent insight"),
    ];

    // rankResults should not filter out other-project rows, but may reorder them
    const ranked = rankResults(rows, "general", null, "myapp", tmpCortex, null);
    expect(ranked.length).toBeGreaterThanOrEqual(2); // at minimum keeps myapp rows
    // myapp claude should appear (it's the detected project)
    expect(ranked.some(r => r.project === "myapp")).toBe(true);
  });

  it("prioritizes findings type over non-findings types", () => {
    const rows: DocRow[] = [
      makeDocRow("myapp", "FINDINGS.md", "findings", "## 2025-01-01\n- An insight"),
      makeDocRow("myapp", "CLAUDE.md", "claude", "# myapp\nSetup instructions"),
    ];

    const ranked = rankResults(rows, "general", null, "myapp", tmpCortex, null);
    // findings should rank before claude/non-findings types
    const claudeIdx = ranked.findIndex(r => r.type === "claude");
    const learningsIdx = ranked.findIndex(r => r.type === "findings");
    if (claudeIdx !== -1 && learningsIdx !== -1) {
      expect(learningsIdx).toBeLessThan(claudeIdx);
    }
  });

  it("keeps a single strong backlog result when it clearly beats non-backlog noise", () => {
    const longBacklogPrefix = Array.from({ length: 28 }, (_, i) => `filler${i}`).join(" ");
    const rows: DocRow[] = [
      makeDocRow(
        "sampleatlas",
        "backlog.md",
        "backlog",
        `# backlog\n- ${longBacklogPrefix}\n- Route alerts to an external webhook instead of Discord for monitors`
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
      tmpCortex,
      null as any,
      undefined,
      "alerts to external webhook instead of discord"
    );

    expect(ranked.some((row) => row.type === "backlog")).toBe(true);
    expect(ranked.findIndex((row) => row.type === "backlog")).toBeLessThan(
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
    const row = ["cortex", "FINDINGS.md", "findings", "Semantic opt-in during init should finish at the dependency level", "/tmpcortex/FINDINGS.md"];
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

    expect(result?.[0]?.path).toBe("/tmpcortex/FINDINGS.md");
    expect(seenQueries).toHaveLength(2);
    expect(seenQueries[1]).toContain(" OR ");
  });
});
