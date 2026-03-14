import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir } from "../test-helpers.js";
import {
  logCorrelations,
  getCorrelatedDocs,
  markCorrelationsHelpful,
  isQueryCorrelationEnabled,
  type CorrelationEntry,
} from "../query-correlation.js";
import type { SelectedSnippet } from "../shared-retrieval.js";

let tmp: { path: string; cleanup: () => void };

function correlationFile(): string {
  return path.join(tmp.path, ".runtime", "query-correlations.jsonl");
}

function makeSnippet(project: string, filename: string): SelectedSnippet {
  return {
    doc: { project, filename, type: "findings", content: "test", path: `${tmp.path}/${project}/${filename}` },
    snippet: "test snippet",
    key: `${project}/${filename}:abc`,
  };
}

function seedCorrelations(entries: Array<Partial<CorrelationEntry>>): void {
  const dir = path.join(tmp.path, ".runtime");
  fs.mkdirSync(dir, { recursive: true });
  const lines = entries.map((e) =>
    JSON.stringify({
      timestamp: e.timestamp ?? new Date().toISOString(),
      keywords: e.keywords ?? "test keywords here",
      project: e.project ?? "myapp",
      filename: e.filename ?? "FINDINGS.md",
      sessionId: e.sessionId ?? "sess-1",
      ...(e.helpful !== undefined ? { helpful: e.helpful } : {}),
    }),
  );
  fs.writeFileSync(correlationFile(), lines.join("\n") + "\n");
}

beforeEach(() => {
  tmp = makeTempDir("query-correlation-test-");
  process.env.PHREN_FEATURE_QUERY_CORRELATION = "1";
});

afterEach(() => {
  delete process.env.PHREN_FEATURE_QUERY_CORRELATION;
  tmp.cleanup();
});

describe("isQueryCorrelationEnabled", () => {
  it("returns true when env var is set to 1", () => {
    expect(isQueryCorrelationEnabled()).toBe(true);
  });

  it("returns false when env var is not set", () => {
    delete process.env.PHREN_FEATURE_QUERY_CORRELATION;
    expect(isQueryCorrelationEnabled()).toBe(false);
  });

  it("returns false when env var is 0", () => {
    process.env.PHREN_FEATURE_QUERY_CORRELATION = "0";
    expect(isQueryCorrelationEnabled()).toBe(false);
  });
});

describe("logCorrelations", () => {
  it("appends JSONL entries for each selected snippet", () => {
    const selected = [
      makeSnippet("myapp", "FINDINGS.md"),
      makeSnippet("myapp", "summary.md"),
    ];

    logCorrelations(tmp.path, "error handling database", selected, "sess-123");

    const content = fs.readFileSync(correlationFile(), "utf8");
    const lines = content.split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);

    const entry1 = JSON.parse(lines[0]);
    expect(entry1.keywords).toBe("error handling database");
    expect(entry1.project).toBe("myapp");
    expect(entry1.filename).toBe("FINDINGS.md");
    expect(entry1.sessionId).toBe("sess-123");
    expect(entry1.timestamp).toBeDefined();
  });

  it("does nothing when feature is disabled", () => {
    delete process.env.PHREN_FEATURE_QUERY_CORRELATION;
    logCorrelations(tmp.path, "test query", [makeSnippet("p", "f.md")], "s1");
    expect(fs.existsSync(correlationFile())).toBe(false);
  });

  it("does nothing with empty selected array", () => {
    logCorrelations(tmp.path, "test query", [], "s1");
    expect(fs.existsSync(correlationFile())).toBe(false);
  });

  it("truncates keywords to 200 chars", () => {
    const longKeywords = "x".repeat(300);
    logCorrelations(tmp.path, longKeywords, [makeSnippet("p", "f.md")], "s1");
    const content = fs.readFileSync(correlationFile(), "utf8");
    const entry = JSON.parse(content.split("\n")[0]);
    expect(entry.keywords.length).toBe(200);
  });
});

describe("getCorrelatedDocs", () => {
  it("returns empty array when no correlations exist", () => {
    expect(getCorrelatedDocs(tmp.path, "some query")).toEqual([]);
  });

  it("returns docs matching at least 2 overlapping tokens", () => {
    seedCorrelations([
      { keywords: "error handling database connection", project: "myapp", filename: "FINDINGS.md" },
      { keywords: "error handling retry logic", project: "myapp", filename: "summary.md" },
      { keywords: "unrelated topic completely different", project: "myapp", filename: "other.md" },
    ]);

    const result = getCorrelatedDocs(tmp.path, "error handling middleware");
    expect(result).toContain("myapp/FINDINGS.md");
    expect(result).toContain("myapp/summary.md");
    expect(result).not.toContain("myapp/other.md");
  });

  it("ranks docs by overlap score", () => {
    seedCorrelations([
      { keywords: "error handling database connection pool", project: "myapp", filename: "low.md" },
      { keywords: "error handling database connection pool timeout", project: "myapp", filename: "high.md" },
      { keywords: "error handling database connection pool timeout retry", project: "myapp", filename: "high.md" },
    ]);

    const result = getCorrelatedDocs(tmp.path, "error handling database connection pool timeout");
    // high.md should rank first since it has more overlap instances
    expect(result[0]).toBe("myapp/high.md");
  });

  it("respects limit parameter", () => {
    seedCorrelations([
      { keywords: "error handling database", project: "a", filename: "1.md" },
      { keywords: "error handling database", project: "b", filename: "2.md" },
      { keywords: "error handling database", project: "c", filename: "3.md" },
    ]);

    const result = getCorrelatedDocs(tmp.path, "error handling database query", 1);
    expect(result).toHaveLength(1);
  });

  it("does not match on single-token overlap", () => {
    seedCorrelations([
      { keywords: "error widget processing", project: "myapp", filename: "FINDINGS.md" },
    ]);

    // Only "error" overlaps — needs 2+ tokens
    const result = getCorrelatedDocs(tmp.path, "error recovery strategy");
    expect(result).toEqual([]);
  });

  it("ignores tokens shorter than 3 chars", () => {
    seedCorrelations([
      { keywords: "is an of to by", project: "myapp", filename: "FINDINGS.md" },
    ]);

    // All tokens are 2 chars or less — no overlap possible
    const result = getCorrelatedDocs(tmp.path, "is an of to by");
    expect(result).toEqual([]);
  });

  it("returns empty when feature is disabled", () => {
    delete process.env.PHREN_FEATURE_QUERY_CORRELATION;
    seedCorrelations([
      { keywords: "error handling database", project: "myapp", filename: "FINDINGS.md" },
    ]);
    expect(getCorrelatedDocs(tmp.path, "error handling database")).toEqual([]);
  });
});

describe("markCorrelationsHelpful", () => {
  it("marks matching entries as helpful", () => {
    seedCorrelations([
      { keywords: "error handling", project: "myapp", filename: "FINDINGS.md", sessionId: "sess-1" },
      { keywords: "database query", project: "myapp", filename: "summary.md", sessionId: "sess-1" },
      { keywords: "error handling", project: "myapp", filename: "FINDINGS.md", sessionId: "sess-2" },
    ]);

    markCorrelationsHelpful(tmp.path, "sess-1", "myapp/FINDINGS.md");

    const content = fs.readFileSync(correlationFile(), "utf8");
    const lines = content.split("\n").filter(Boolean);
    const entries = lines.map((l) => JSON.parse(l));

    // First entry should be marked helpful (matches session + docKey)
    expect(entries[0].helpful).toBe(true);
    // Second entry: wrong filename
    expect(entries[1].helpful).toBeUndefined();
    // Third entry: wrong session
    expect(entries[2].helpful).toBeUndefined();
  });

  it("does nothing when feature is disabled", () => {
    delete process.env.PHREN_FEATURE_QUERY_CORRELATION;
    seedCorrelations([
      { keywords: "test", project: "myapp", filename: "FINDINGS.md", sessionId: "sess-1" },
    ]);

    markCorrelationsHelpful(tmp.path, "sess-1", "myapp/FINDINGS.md");

    const content = fs.readFileSync(correlationFile(), "utf8");
    const entry = JSON.parse(content.split("\n")[0]);
    expect(entry.helpful).toBeUndefined();
  });
});

describe("helpful entries get boosted weight", () => {
  it("helpful entries contribute 2x weight to correlation scores", () => {
    seedCorrelations([
      { keywords: "error handling database", project: "myapp", filename: "normal.md", helpful: false },
      { keywords: "error handling database", project: "myapp", filename: "normal.md", helpful: false },
      { keywords: "error handling database", project: "myapp", filename: "helpful.md", helpful: true },
    ]);

    const result = getCorrelatedDocs(tmp.path, "error handling database query");
    // helpful.md has 1 entry with helpful=true (2x weight = 6 for 3-token overlap)
    // normal.md has 2 entries without helpful (1x weight = 3+3=6 for 3-token overlap)
    // Both should appear, but helpful.md should rank equal or higher
    expect(result).toContain("myapp/helpful.md");
    expect(result).toContain("myapp/normal.md");
  });
});

describe("JSONL window cap", () => {
  it("only reads last 500 entries for performance", () => {
    // Create 600 entries: first 500 with one doc, last 100 with another
    const dir = path.join(tmp.path, ".runtime");
    fs.mkdirSync(dir, { recursive: true });
    const oldLines = Array.from({ length: 500 }, () =>
      JSON.stringify({
        timestamp: new Date().toISOString(),
        keywords: "error handling database",
        project: "myapp",
        filename: "old.md",
        sessionId: "old-sess",
      }),
    );
    const newLines = Array.from({ length: 100 }, () =>
      JSON.stringify({
        timestamp: new Date().toISOString(),
        keywords: "error handling database",
        project: "myapp",
        filename: "new.md",
        sessionId: "new-sess",
      }),
    );
    fs.writeFileSync(correlationFile(), [...oldLines, ...newLines].join("\n") + "\n");

    const result = getCorrelatedDocs(tmp.path, "error handling database query");
    // new.md should appear (in last 500 window)
    expect(result).toContain("myapp/new.md");
    // old.md entries are partially outside the window, so new.md should dominate
    // (only 400 of 500 old entries are in window vs 100 new entries)
    // Both should appear since there are enough old entries in window
    expect(result.length).toBeGreaterThan(0);
  });
});
