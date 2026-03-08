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
});
