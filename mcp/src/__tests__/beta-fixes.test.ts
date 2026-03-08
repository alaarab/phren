import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, grantAdmin, writeFile } from "../test-helpers.js";
import { escapeRegex, escapeLike } from "../shared-entity-graph.js";
import { applyTrustFilter, markStaleCitations } from "../cli-hooks-retrieval.js";
import { autoArchiveToReference, countActiveFindings } from "../content-archive.js";
import type { DocRow } from "../shared-index.js";

// ── escapeRegex / escapeLike ─────────────────────────────────────────────────

describe("escapeRegex", () => {
  it("escapes all regex metacharacters", () => {
    const metacharacters = ".*+?^${}()|[]\\";
    const escaped = escapeRegex(metacharacters);
    // Every metacharacter should be preceded by a backslash
    expect(escaped).toBe("\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\");
    // The escaped string should be safe to use in RegExp
    const re = new RegExp(escaped);
    expect(re.test(metacharacters)).toBe(true);
    expect(re.test("foobar")).toBe(false);
  });

  it("leaves alphanumeric characters unchanged", () => {
    expect(escapeRegex("hello123")).toBe("hello123");
  });

  it("escapes mixed input correctly", () => {
    const input = "foo.bar[0]";
    const escaped = escapeRegex(input);
    const re = new RegExp(escaped);
    expect(re.test("foo.bar[0]")).toBe(true);
    expect(re.test("fooXbar00]")).toBe(false);
  });
});

describe("escapeLike", () => {
  it("escapes SQL LIKE wildcards", () => {
    expect(escapeLike("100%")).toBe("100\\%");
    expect(escapeLike("foo_bar")).toBe("foo\\_bar");
    expect(escapeLike("a\\b")).toBe("a\\\\b");
  });

  it("leaves normal text unchanged", () => {
    expect(escapeLike("hello")).toBe("hello");
  });
});

// ── Trust filter for reference/knowledge types ───────────────────────────────

describe("applyTrustFilter covers reference and knowledge types", () => {
  let tmp: { path: string; cleanup: () => void };

  beforeEach(() => {
    tmp = makeTempDir("trust-filter-test-");
    grantAdmin(tmp.path);
  });

  afterEach(() => {
    delete process.env.CORTEX_ACTOR;
    tmp.cleanup();
  });

  function makeDocRow(type: string, content: string): DocRow {
    return { project: "testapp", filename: "test.md", type, content, path: "/tmp/testapp/test.md" };
  }

  it("filters stale entries from reference type docs", () => {
    const staleContent = [
      "# Findings",
      "",
      "## 2020-01-01",
      "",
      "- Very old reference entry",
    ].join("\n");

    const rows: DocRow[] = [makeDocRow("reference", staleContent)];
    const filtered = applyTrustFilter(rows, tmp.path, 90, 0.35, {});
    // The stale bullet is removed but the heading "# Findings" remains,
    // so the doc passes through with reduced content (not fully excluded)
    expect(filtered.length).toBe(1);
    expect(filtered[0].content).not.toContain("Very old reference entry");
    expect(filtered[0].content).toContain("Findings");
  });

  it("filters stale entries from knowledge type docs", () => {
    const staleContent = [
      "# Findings",
      "",
      "## 2020-01-01",
      "",
      "- Ancient knowledge entry",
    ].join("\n");

    const rows: DocRow[] = [makeDocRow("knowledge", staleContent)];
    const filtered = applyTrustFilter(rows, tmp.path, 90, 0.35, {});
    // The stale bullet is removed but the heading "# Findings" remains
    expect(filtered.length).toBe(1);
    expect(filtered[0].content).not.toContain("Ancient knowledge entry");
  });

  it("does not filter non-trust types like claude or backlog", () => {
    const content = [
      "# Findings",
      "",
      "## 2020-01-01",
      "",
      "- Very old entry that would be stale",
    ].join("\n");

    const rows: DocRow[] = [makeDocRow("claude", content)];
    const filtered = applyTrustFilter(rows, tmp.path, 90, 0.35, {});
    // claude type should pass through unfiltered
    expect(filtered.length).toBe(1);
    expect(filtered[0].content).toBe(content);
  });
});

// ── Stale citation detection ─────────────────────────────────────────────────

describe("markStaleCitations", () => {
  it("appends [stale citation] when cited file does not exist", () => {
    const snippet = [
      "- Some finding about a deleted file",
      `  <!-- cortex:cite {"created_at":"2025-01-01","file":"/nonexistent/path/deleted.ts"} -->`,
    ].join("\n");

    const result = markStaleCitations(snippet);
    expect(result).toContain("[stale citation]");
    expect(result).toContain("- Some finding about a deleted file [stale citation]");
    // The citation comment line should be skipped
    expect(result).not.toContain("cortex:cite");
  });

  it("does not mark citation when cited file exists", () => {
    // Use a file that definitely exists
    const existingFile = __filename;
    const snippet = [
      "- Finding with valid citation",
      `  <!-- cortex:cite {"created_at":"2025-01-01","file":"${existingFile.replace(/\\/g, "\\\\")}"} -->`,
    ].join("\n");

    const result = markStaleCitations(snippet);
    expect(result).not.toContain("[stale citation]");
    expect(result).toContain("cortex:cite");
  });

  it("passes through lines without citations unchanged", () => {
    const snippet = "- A plain finding without citation";
    const result = markStaleCitations(snippet);
    expect(result).toBe(snippet);
  });
});

// ── Archive state machine guards ─────────────────────────────────────────────

describe("autoArchiveToReference guards", () => {
  let tmp: { path: string; cleanup: () => void };
  const PROJECT = "archivetest";

  function seedProject(cortexPath: string) {
    const dir = path.join(cortexPath, PROJECT);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "summary.md"), `# ${PROJECT}\n`);
  }

  beforeEach(() => {
    tmp = makeTempDir("archive-guard-test-");
    grantAdmin(tmp.path);
    seedProject(tmp.path);
  });

  afterEach(() => {
    delete process.env.CORTEX_ACTOR;
    tmp.cleanup();
  });

  it("returns ok with 0 when no entries exceed keepCount", () => {
    const findingsPath = path.join(tmp.path, PROJECT, "FINDINGS.md");
    fs.writeFileSync(findingsPath, [
      "# Findings",
      "",
      "## 2025-01-01",
      "",
      "- First entry",
      "- Second entry",
      "",
    ].join("\n"));

    const result = autoArchiveToReference(tmp.path, PROJECT, 10);
    expect(result.ok).toBe(true);
    expect(result.data).toBe(0);
  });

  it("does not double-archive entries already in reference files", () => {
    const findingsPath = path.join(tmp.path, PROJECT, "FINDINGS.md");
    // Create FINDINGS.md with 3 entries, keepCount = 1 -> 2 would be archived
    fs.writeFileSync(findingsPath, [
      "# Findings",
      "",
      "## 2025-01-01",
      "",
      "- Database query optimization for large tables",
      "- API endpoint rate limiting configuration",
      "",
      "## 2025-06-01",
      "",
      "- Latest finding to keep",
      "",
    ].join("\n"));

    // Pre-populate reference with one of the entries (simulate previous archive)
    const refDir = path.join(tmp.path, PROJECT, "reference");
    fs.mkdirSync(refDir, { recursive: true });
    fs.writeFileSync(path.join(refDir, "database.md"), [
      "# archivetest - database",
      "",
      "## Archived 2025-01-15",
      "",
      "- Database query optimization for large tables",
      "",
    ].join("\n"));

    const result = autoArchiveToReference(tmp.path, PROJECT, 1);
    expect(result.ok).toBe(true);

    // The database entry should NOT be duplicated in reference
    const dbRef = fs.readFileSync(path.join(refDir, "database.md"), "utf8");
    const occurrences = (dbRef.match(/Database query optimization/g) || []).length;
    expect(occurrences).toBe(1);

    // The other entry should be archived
    const refFiles = fs.readdirSync(refDir).filter(f => f.endsWith(".md"));
    const allRefContent = refFiles.map(f => fs.readFileSync(path.join(refDir, f), "utf8")).join("\n");
    expect(allRefContent).toContain("API endpoint rate limiting");

    // Both should be removed from FINDINGS.md regardless
    const updatedFindings = fs.readFileSync(findingsPath, "utf8");
    expect(updatedFindings).not.toContain("Database query optimization");
    expect(updatedFindings).not.toContain("API endpoint rate limiting");
    expect(updatedFindings).toContain("Latest finding to keep");
  });

  // Note: "atomic write: no partial file on writeFileSync failure" test removed.
  // vi.spyOn(fs, "writeFileSync") does not work in ESM modules — Cannot redefine property on
  // module namespace objects. The implementation does use atomic writes (tmp + rename),
  // but this cannot be tested via ESM spy interception.
});
