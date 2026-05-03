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
} from "./cli/cli.js";

// ── Task #5: rankResults no longer hard-filters ─────────────────────────────

describe("rankResults: file-match boost (not filter)", () => {
  const makeDoc = (project: string, filename: string, type: string, content: string, filePath: string) =>
    ({ project, filename, type, content, path: filePath });

  it("keeps results that do not match changed files", () => {
    const rows = [
      makeDoc("proj", "a.md", "findings", "- some insight about debugging", "/proj/a.md"),
      makeDoc("proj", "b.md", "findings", "- another insight about testing", "/proj/b.md"),
    ];
    const gitCtx = { branch: "main", changedFiles: new Set(["src/foo.ts"]) };
    const ranked = rankResults(rows, "general", gitCtx, null, tmpPhren, null);
    expect(ranked.length).toBe(2);
  });

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

  it("returns all results when no changedFiles", () => {
    const rows = [
      makeDoc("proj", "a.md", "findings", "- insight one", "/a.md"),
      makeDoc("proj", "b.md", "findings", "- insight two", "/b.md"),
      makeDoc("proj", "c.md", "findings", "- insight three", "/c.md"),
    ];
    const ranked = rankResults(rows, "general", null, null, tmpPhren, null);
    expect(ranked.length).toBe(3);
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

  it("returns 1.0 when no CLAUDE.md exists", () => {
    const boost = getProjectGlobBoost(tmpPhren, "glob-proj", "/some/dir", undefined);
    expect(boost).toBe(1.0);
  });

  it("returns 1.0 when CLAUDE.md has no frontmatter", () => {
    fs.writeFileSync(path.join(projDir, "CLAUDE.md"), "# Project\n\nNo frontmatter here.\n");
    const boost = getProjectGlobBoost(tmpPhren, "glob-proj", "/some/dir", undefined);
    expect(boost).toBe(1.0);
  });

  it("returns 1.3 when cwd matches a glob pattern", () => {
    fs.writeFileSync(
      path.join(projDir, "CLAUDE.md"),
      '---\nglobs:\n  - "src/**/*.ts"\n---\n# Project\n'
    );
    const boost = getProjectGlobBoost(tmpPhren, "glob-proj", "src/foo/bar.ts", undefined);
    expect(boost).toBe(1.3);
  });

  it("returns 0.7 when globs defined but nothing matches", () => {
    fs.writeFileSync(
      path.join(projDir, "CLAUDE.md"),
      '---\nglobs:\n  - "lib/**/*.py"\n---\n# Project\n'
    );
    const boost = getProjectGlobBoost(tmpPhren, "glob-proj", "src/foo.ts", undefined);
    expect(boost).toBe(0.7);
  });

  it("returns 1.3 when a changedFile matches a glob", () => {
    fs.writeFileSync(
      path.join(projDir, "CLAUDE.md"),
      '---\nglobs:\n  - "*.ts"\n---\n# Project\n'
    );
    const boost = getProjectGlobBoost(tmpPhren, "glob-proj", "/unrelated", new Set(["foo.ts"]));
    expect(boost).toBe(1.3);
  });

  it("supports inline YAML array globs", () => {
    fs.writeFileSync(
      path.join(projDir, "CLAUDE.md"),
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

  it("does not emit a pitfall for try/catch additions (heuristic deleted)", () => {
    // Adding error handling is normal code, not a pitfall. The old heuristic produced
    // ~21 false positives for every real one in observed stores; it's removed in 0.1.25.
    const candidates = extractToolFindings(
      "Write",
      { file_path: "/src/handler.ts", content: "try {\n  await fetchData();\n} catch (err) {\n  log(err);\n}" },
      "ok"
    );
    const errorHandling = candidates.find((c) => c.text.includes("error handling added"));
    expect(errorHandling).toBeUndefined();
  });

  it("emits [bug] for Bash with explicit is_error signal on a non-noisy command", () => {
    const candidates = extractToolFindings(
      "Bash",
      { command: "npm run build" },
      "Error: Cannot find module '@/utils'\n  at Module._resolveFilename",
      { is_error: true, stdout: "", stderr: "Error: Cannot find module" }
    );
    const bug = candidates.find((c) => c.text.includes("[bug]"));
    expect(bug).toBeDefined();
    expect(bug!.confidence).toBe(0.55);
    expect(bug!.text).toContain("npm run build");
  });

  it("does NOT emit [bug] for Bash without an explicit error signal (no exit_code, no is_error)", () => {
    // Pre-0.1.25 this matched the word "error" in stdout and produced a [bug].
    // grep/find/curl etc. routinely contain "error" in their output without failing.
    const candidates = extractToolFindings(
      "Bash",
      { command: "ls /src" },
      "error.js\nhandler.js"
    );
    expect(candidates.find((c) => c.text.startsWith("[bug] command"))).toBeUndefined();
  });

  it("does NOT emit [bug] for grep with exit_code=1 (no-match is not a bug)", () => {
    const candidates = extractToolFindings(
      "Bash",
      { command: "grep -rn 'never-matches' src/" },
      "",
      { is_error: true, exit_code: 1, stdout: "", stderr: "" }
    );
    expect(candidates.find((c) => c.text.startsWith("[bug] command"))).toBeUndefined();
  });

  it("does NOT emit [bug] for find with non-zero exit (noisy command allowlist)", () => {
    const candidates = extractToolFindings(
      "Bash",
      { command: "find . -name '*.tmp'" },
      "find: '/restricted': Permission denied",
      { is_error: true, exit_code: 1 }
    );
    expect(candidates.find((c) => c.text.startsWith("[bug] command"))).toBeUndefined();
  });

  it("does NOT emit [bug] for `cmd || true` (user already silencing failure)", () => {
    const candidates = extractToolFindings(
      "Bash",
      { command: "rm -f /nonexistent || true" },
      "rm: cannot remove '/nonexistent': No such file or directory",
      { is_error: true, exit_code: 1 }
    );
    expect(candidates.find((c) => c.text.startsWith("[bug] command"))).toBeUndefined();
  });

  it("emits [bug] for non-noisy command with non-zero exit_code even without is_error", () => {
    const candidates = extractToolFindings(
      "Bash",
      { command: "cargo test" },
      "test result: FAILED. 0 passed; 3 failed",
      { exit_code: 101 }
    );
    const bug = candidates.find((c) => c.text.startsWith("[bug] command"));
    expect(bug).toBeDefined();
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
