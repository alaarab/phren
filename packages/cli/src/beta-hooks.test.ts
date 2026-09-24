import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Set PHREN_PATH before importing to satisfy top-level ensurePhrenPath().
const tmpPhren = fs.mkdtempSync(path.join(os.tmpdir(), "phren-beta-test-"));
process.env.PHREN_PATH = tmpPhren;

import {
  rankResults,
  parseCitations,
  validateCitation,
  annotateStale,
  getProjectGlobBoost,
  clearProjectGlobCache,
  clearCitationValidCache,
  extractToolFindings,
  filterToolFindingsForProactivity,
} from "./cli/hooks.js";

// ── Task #5: rankResults no longer hard-filters ─────────────────────────────

describe("rankResults: file-match boost (not filter)", () => {
  const makeDoc = (project: string, filename: string, type: string, content: string, filePath: string) =>
    ({ project, filename, type, content, path: filePath });

  it("boosts file-matching results to the top", () => {
    const rows = [
      makeDoc("proj", "a.md", "findings", "- unrelated insight", "/proj/a.md"),
      makeDoc("proj", "b.md", "findings", "- insight about foo.ts", "/proj/foo.ts"),
    ];
    const gitCtx = { branch: "main", changedFiles: new Set(["foo.ts"]) };
    const ranked = rankResults(rows, "general", gitCtx, null, tmpPhren, null);
    expect(ranked.length).toBe(2);
    // The file-matching result should be first
    expect(ranked[0].path).toBe("/proj/foo.ts");
  });
});

// ── Task #6: Project glob matching ──────────────────────────────────────────

describe("getProjectGlobBoost", () => {
  let projDir: string;

  beforeEach(() => {
    clearProjectGlobCache();
    projDir = path.join(tmpPhren, "glob-proj");
    fs.mkdirSync(projDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(projDir, { recursive: true, force: true });
  });

  it("returns 1.0 when no AGENTS.md exists", () => {
    const boost = getProjectGlobBoost(tmpPhren, "glob-proj", "/some/dir", undefined);
    expect(boost).toBe(1.0);
  });

  it("returns 1.0 when AGENTS.md has no frontmatter", () => {
    fs.writeFileSync(path.join(projDir, "AGENTS.md"), "# Project\n\nNo frontmatter here.\n");
    const boost = getProjectGlobBoost(tmpPhren, "glob-proj", "/some/dir", undefined);
    expect(boost).toBe(1.0);
  });

  it("returns 1.3 when cwd matches a glob pattern", () => {
    fs.writeFileSync(
      path.join(projDir, "AGENTS.md"),
      '---\nglobs:\n  - "src/**/*.ts"\n---\n# Project\n'
    );
    const boost = getProjectGlobBoost(tmpPhren, "glob-proj", "src/foo/bar.ts", undefined);
    expect(boost).toBe(1.3);
  });

  it("returns 0.7 when globs defined but nothing matches", () => {
    fs.writeFileSync(
      path.join(projDir, "AGENTS.md"),
      '---\nglobs:\n  - "lib/**/*.py"\n---\n# Project\n'
    );
    const boost = getProjectGlobBoost(tmpPhren, "glob-proj", "src/foo.ts", undefined);
    expect(boost).toBe(0.7);
  });

  it("returns 1.3 when a changedFile matches a glob", () => {
    fs.writeFileSync(
      path.join(projDir, "AGENTS.md"),
      '---\nglobs:\n  - "*.ts"\n---\n# Project\n'
    );
    const boost = getProjectGlobBoost(tmpPhren, "glob-proj", "/unrelated", new Set(["foo.ts"]));
    expect(boost).toBe(1.3);
  });

  it("supports inline YAML array globs", () => {
    fs.writeFileSync(
      path.join(projDir, "AGENTS.md"),
      '---\nglobs: ["src/**", "lib/**"]\n---\n# Project\n'
    );
    const boost = getProjectGlobBoost(tmpPhren, "glob-proj", "src/index.ts", undefined);
    expect(boost).toBe(1.3);
  });
});

// ── Task #7: Citation validation ────────────────────────────────────────────

describe("parseCitations", () => {
  it("returns empty for no citations", () => {
    expect(parseCitations("No citations here")).toEqual([]);
  });

  it("parses multiple citations", () => {
    const text = [
      'See <!-- phren:cite {"created_at":"2026-03-01T00:00:00.000Z","file":"/tmp/a.ts","line":1} -->',
      'and <!-- phren:cite {"created_at":"2026-03-01T00:00:00.000Z","file":"/tmp/b.ts","line":2} -->',
    ].join(" ");
    const citations = parseCitations(text);
    expect(citations).toHaveLength(2);
    expect(citations.every(c => c.citation)).toBe(true);
  });

  it("parses phren citation comments", () => {
    const citations = parseCitations('Insight <!-- phren:cite {"created_at":"2026-03-01T00:00:00.000Z","file":"/tmp/demo.ts","line":3} -->');
    expect(citations).toEqual([
      {
        citation: {
          created_at: "2026-03-01T00:00:00.000Z",
          file: "/tmp/demo.ts",
          line: 3,
        },
      },
    ]);
  });
});

describe("validateCitation", () => {
  let tmpFile: string;

  beforeEach(() => {
    clearCitationValidCache();
    tmpFile = path.join(tmpPhren, "cite-test.txt");
    fs.writeFileSync(tmpFile, "line one\nline two\nline three\n");
  });

  afterEach(() => {
    try { fs.unlinkSync(tmpFile); } catch { /* ok */ }
  });

  it("returns true for valid canonical citations", () => {
    expect(validateCitation({
      citation: {
        created_at: "2026-03-01T00:00:00.000Z",
        file: tmpFile,
        line: 2,
      },
    })).toBe(true);
  });

  it("returns false for phren citations pointing to missing files", () => {
    expect(validateCitation({
      citation: {
        created_at: "2026-03-01T00:00:00.000Z",
        file: "/nonexistent/file.ts",
        line: 1,
      },
    })).toBe(false);
  });
});

describe("annotateStale", () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(tmpPhren, "stale-test.txt");
    fs.writeFileSync(tmpFile, "content here\n");
  });

  afterEach(() => {
    try { fs.unlinkSync(tmpFile); } catch { /* ok */ }
  });

  it("returns snippet unchanged when no citations", () => {
    expect(annotateStale("plain text")).toBe("plain text");
  });

  it("marks phren citation comments stale when validation fails", () => {
    const result = annotateStale('insight <!-- phren:cite {"created_at":"2026-03-01T00:00:00.000Z","file":"/no/such/file.ts","line":1} -->');
    expect(result).toContain("[citation stale]");
  });
});

// ── Task #8: extractToolFindings ───────────────────────────────────────────

describe("extractToolFindings", () => {
  it("extracts explicit [pitfall] tag from tool output", () => {
    const candidates = extractToolFindings(
      "Read",
      {},
      "[pitfall] Always check null before accessing .value"
    );
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    const pitfallEntry = candidates.find((c) => c.text.includes("[pitfall]"));
    expect(pitfallEntry).toBeDefined();
    expect(pitfallEntry!.confidence).toBe(0.85);
  });

  it("extracts explicit [decision] tag from tool output", () => {
    const candidates = extractToolFindings(
      "Bash",
      { command: "npm test" },
      "All good. [decision] Use vitest over jest for speed"
    );
    const decision = candidates.find((c) => c.text.includes("[decision]"));
    expect(decision).toBeDefined();
    expect(decision!.confidence).toBe(0.85);
  });

  it("extracts TODO/FIXME from Edit tool input", () => {
    const candidates = extractToolFindings(
      "Edit",
      { file_path: "/src/app.ts", new_string: "// TODO: handle edge case\nreturn value;" },
      "ok"
    );
    const todo = candidates.find((c) => c.text.includes("[pitfall]") && c.text.includes("TODO"));
    expect(todo).toBeDefined();
    expect(todo!.confidence).toBe(0.45);
  });

  it("returns empty for normal successful tool output", () => {
    const candidates = extractToolFindings("Read", {}, "file content here without any signals");
    expect(candidates).toEqual([]);
  });

  it("extracts [bug] tag from any tool output", () => {
    const candidates = extractToolFindings(
      "Grep",
      { pattern: "foo" },
      "Some results found. [bug] Race condition in concurrent writes"
    );
    const bug = candidates.find((c) => c.text.includes("[bug]"));
    expect(bug).toBeDefined();
    expect(bug!.confidence).toBe(0.85);
  });

  it("does NOT capture markdown TOC anchors as [pattern] (#pattern) entries", () => {
    // Regression: a README with `- [Pattern](#pattern)` used to match
    // EXPLICIT_TAG_PATTERN and emit "[pattern] (#pattern)" candidates.
    // (Originally reproduced with "[Architecture](#architecture)" — that tag
    // was dropped from the vocabulary, so the example now uses "pattern",
    // which is still offered/produced and still needs the same guard.)
    const candidates = extractToolFindings(
      "Read",
      { file_path: "/repo/README.md" },
      "## Table of Contents\n- [Pattern](#pattern)\n- [Releases](#releases)\n"
    );
    const tocAnchor = candidates.find((c) => c.text.includes("(#pattern)"));
    expect(tocAnchor).toBeUndefined();
  });

  it("does NOT capture markdown reference links as tagged findings", () => {
    const candidates = extractToolFindings(
      "Read",
      { file_path: "/repo/notes.md" },
      "See [bug][1] for context.\n\n[1]: https://example.com/issue/42\n"
    );
    const bug = candidates.find((c) => c.text === "[bug] [1]");
    expect(bug).toBeUndefined();
  });

  it("still extracts genuine inline tags when followed by space then content (positive guard)", () => {
    const candidates = extractToolFindings(
      "Read",
      { file_path: "/repo/notes.md" },
      "Notes: [pattern] Wrap retry budgets per request, never per call site."
    );
    const pattern = candidates.find((c) => c.text.startsWith("[pattern]"));
    expect(pattern).toBeDefined();
    expect(pattern!.text).toContain("Wrap retry budgets");
  });

  it("prefers changed content over escaped tool-response blobs for Edit explicit tags", () => {
    const candidates = extractToolFindings(
      "Edit",
      { file_path: "/src/app.ts", new_string: "// [pattern] Keep retry budgets capped per request" },
      '{"ok":true,"diff":"// [pattern] Keep retry budgets capped per request\\nconst next = 1;"}'
    );
    const pattern = candidates.find((c) => c.text.includes("[pattern]"));
    expect(pattern).toBeDefined();
    expect(pattern!.text).toContain("Keep retry budgets capped per request");
    expect(pattern!.text).not.toContain('\\"');
    expect(pattern!.text).not.toContain("\\n");
  });
});

describe("filterToolFindingsForProactivity", () => {
  const candidates = [
    { text: "[decision] Use WAL mode for local reads", confidence: 0.85, explicit: true },
    { text: "[bug] command 'npm test' failed: ENOENT", confidence: 0.55, explicit: false },
  ];

  it("keeps explicit and heuristic candidates at high", () => {
    expect(filterToolFindingsForProactivity(candidates, "high")).toEqual(candidates);
  });

  it("keeps only explicit candidates at medium", () => {
    expect(filterToolFindingsForProactivity(candidates, "medium")).toEqual([
      { text: "[decision] Use WAL mode for local reads", confidence: 0.85, explicit: true },
    ]);
  });

  it("drops all hook-tool candidates at low", () => {
    expect(filterToolFindingsForProactivity(candidates, "low")).toEqual([]);
  });
});
