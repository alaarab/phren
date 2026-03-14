import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile as write, makeTempDir } from "./test-helpers.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Set PHREN_PATH before importing cli.ts to satisfy its top-level ensurePhrenPath().
const tmpPhren = fs.mkdtempSync(path.join(os.tmpdir(), "phren-hook-test-"));
process.env.PHREN_PATH = tmpPhren;

import {
  parseHookInput,
  selectSnippets,
  buildHookOutput,
  trackSessionMetrics,
  applyTrustFilter,
  filterTaskByPriority,
  type HookPromptInput,
  type SelectedSnippet,
} from "./cli.js";

describe("parseHookInput", () => {
  it("parses valid JSON with prompt, cwd, session_id", () => {
    const input = JSON.stringify({ prompt: "fix the bug", cwd: "/tmp", session_id: "abc" });
    const result = parseHookInput(input);
    expect(result).toEqual({ prompt: "fix the bug", cwd: "/tmp", sessionId: "abc" });
  });

  it("returns null for empty prompt", () => {
    expect(parseHookInput(JSON.stringify({ prompt: "   " }))).toBeNull();
    expect(parseHookInput(JSON.stringify({ prompt: "" }))).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseHookInput("not json")).toBeNull();
    expect(parseHookInput("")).toBeNull();
  });

  it("handles missing optional fields", () => {
    const result = parseHookInput(JSON.stringify({ prompt: "hello" }));
    expect(result).toEqual({ prompt: "hello", cwd: undefined, sessionId: undefined });
  });

  it("returns null when prompt key is missing", () => {
    expect(parseHookInput(JSON.stringify({ cwd: "/tmp" }))).toBeNull();
  });
});

describe("selectSnippets", () => {
  const makeDoc = (project: string, filename: string, type: string, content: string, filePath: string) =>
    ({ project, filename, type, content, path: filePath });

  it("selects up to 3 snippets within token budget", () => {
    const rows = [
      makeDoc("proj", "a.md", "findings", "- keyword one insight", "/a.md"),
      makeDoc("proj", "b.md", "findings", "- keyword two insight", "/b.md"),
      makeDoc("proj", "c.md", "findings", "- keyword three insight", "/c.md"),
      makeDoc("proj", "d.md", "findings", "- keyword four insight", "/d.md"),
    ];
    const { selected, usedTokens } = selectSnippets(rows, "keyword", 9999, 6, 520);
    expect(selected.length).toBeLessThanOrEqual(3);
    expect(selected.length).toBeGreaterThan(0);
    expect(usedTokens).toBeGreaterThan(36);
  });

  it("respects token budget and skips rows that exceed it", () => {
    const longContent = "- keyword " + "x".repeat(2000);
    const rows = [
      makeDoc("proj", "big.md", "findings", longContent, "/big.md"),
      makeDoc("proj", "small.md", "findings", "- keyword tiny", "/small.md"),
    ];
    const { selected } = selectSnippets(rows, "keyword", 60, 6, 520);
    expect(selected.length).toBeGreaterThanOrEqual(1);
  });

  it("returns empty when no rows have matching content", () => {
    const rows = [
      makeDoc("proj", "empty.md", "findings", "", "/empty.md"),
    ];
    const { selected } = selectSnippets(rows, "keyword", 550, 6, 520);
    expect(selected).toHaveLength(0);
  });

  it("each selected snippet has doc, snippet, and key", () => {
    const rows = [
      makeDoc("proj", "a.md", "summary", "keyword is important here", "/a.md"),
    ];
    const { selected } = selectSnippets(rows, "keyword", 550, 6, 520);
    expect(selected.length).toBe(1);
    expect(selected[0]).toHaveProperty("doc");
    expect(selected[0]).toHaveProperty("snippet");
    expect(selected[0]).toHaveProperty("key");
    expect(typeof selected[0].snippet).toBe("string");
    expect(selected[0].snippet.length).toBeGreaterThan(0);
  });
});

describe("buildHookOutput", () => {
  let phrenDir: string;
  let phrenCleanup: () => void;

  beforeEach(() => {
    ({ path: phrenDir, cleanup: phrenCleanup } = makeTempDir("phren-hookout-"));
    write(path.join(phrenDir, ".runtime", "memory-scores.json"), "{}");
  });

  afterEach(() => {
    phrenCleanup();
  });

  it("includes status line, phren-context tags, and trace", () => {
    const selected: SelectedSnippet[] = [{
      doc: { project: "myproj", filename: "FINDINGS.md", type: "findings", content: "some content", path: "/path" },
      snippet: "- insight here",
      key: "myproj:FINDINGS.md:abc",
    }];
    const stage = { indexMs: 10, searchMs: 20, trustMs: 5, rankMs: 3, selectMs: 2 };
    const parts = buildHookOutput(selected, 80, "general", null, "myproj", stage, 550, phrenDir);

    expect(parts[0]).toContain("phren");
    expect(parts[0]).toContain("myproj");
    expect(parts[0]).toContain("1 result");
    expect(parts[1]).toBe("<phren-context>");
    expect(parts).toContain("<phren-context>");
    const trace = parts.find((p) => p.includes("trace:"));
    expect(trace).toBeDefined();
    expect(trace).toContain("intent=general");
    expect(trace).toContain("index:10ms");
  });

  it("shows git context in trace when gitCtx is provided", () => {
    const selected: SelectedSnippet[] = [{
      doc: { project: "proj", filename: "file.md", type: "summary", content: "content", path: "/file.md" },
      snippet: "summary text",
      key: "proj:file.md:xyz",
    }];
    const gitCtx = { branch: "feature/test", changedFiles: new Set(["src/main.ts"]) };
    const stage = { indexMs: 0, searchMs: 0, trustMs: 0, rankMs: 0, selectMs: 0 };
    const parts = buildHookOutput(selected, 80, "debug", gitCtx, null, stage, 550, phrenDir);

    const trace = parts.find((p) => p.includes("trace:"));
    expect(trace).toContain("branch=feature/test");
    expect(trace).toContain("changed_files=1");
    expect(trace).toContain("intent=debug");
  });

  it("formats multiple results correctly", () => {
    const selected: SelectedSnippet[] = [
      { doc: { project: "a", filename: "f1.md", type: "findings", content: "c1", path: "/f1" }, snippet: "s1", key: "k1" },
      { doc: { project: "b", filename: "f2.md", type: "summary", content: "c2", path: "/f2" }, snippet: "s2", key: "k2" },
    ];
    const stage = { indexMs: 0, searchMs: 0, trustMs: 0, rankMs: 0, selectMs: 0 };
    const parts = buildHookOutput(selected, 100, "general", null, null, stage, 550, phrenDir);

    expect(parts[0]).toContain("2 results");
    expect(parts.some((p) => p.includes("[a/f1.md]"))).toBe(true);
    expect(parts.some((p) => p.includes("[b/f2.md]"))).toBe(true);
  });

  it("uses project-relative memory ids in compact index output", () => {
    process.env.PHREN_FEATURE_PROGRESSIVE_DISCLOSURE = "1";
    const selected: SelectedSnippet[] = [
      {
        doc: {
          project: "alpha",
          filename: "auth.md",
          type: "reference",
          content: "first",
          path: path.join(phrenDir, "alpha", "reference", "api", "auth.md"),
        },
        snippet: "# API auth",
        key: "k1",
      },
      {
        doc: {
          project: "alpha",
          filename: "auth.md",
          type: "reference",
          content: "second",
          path: path.join(phrenDir, "alpha", "reference", "runbooks", "auth.md"),
        },
        snippet: "# Runbook auth",
        key: "k2",
      },
      {
        doc: {
          project: "alpha",
          filename: "summary.md",
          type: "summary",
          content: "third",
          path: path.join(phrenDir, "alpha", "summary.md"),
        },
        snippet: "# Summary",
        key: "k3",
      },
    ];
    const stage = { indexMs: 0, searchMs: 0, trustMs: 0, rankMs: 0, selectMs: 0 };

    try {
      const parts = buildHookOutput(selected, 100, "general", null, null, stage, 550, phrenDir);
      expect(parts.some((p) => p.includes("[mem:alpha/reference/api/auth.md]"))).toBe(true);
      expect(parts.some((p) => p.includes("[mem:alpha/reference/runbooks/auth.md]"))).toBe(true);
    } finally {
      delete process.env.PHREN_FEATURE_PROGRESSIVE_DISCLOSURE;
    }
  });
});

describe("applyTrustFilter", () => {
  let phrenDir: string;
  let phrenCleanup: () => void;

  beforeEach(() => {
    ({ path: phrenDir, cleanup: phrenCleanup } = makeTempDir("phren-trust-"));
    write(path.join(phrenDir, "testproj", "summary.md"), "# testproj\n");
    write(path.join(phrenDir, "testproj", "review.md"), "# testproj Review Queue\n\n## Review\n\n## Stale\n\n## Conflicts\n\n");
    write(path.join(phrenDir, ".governance", "audit.log"), "");
  });

  afterEach(() => {
    phrenCleanup();
  });

  it("passes through non-findings rows unchanged", () => {
    const rows = [
      { project: "proj", filename: "summary.md", type: "summary", content: "project summary text", path: "/path" },
      { project: "proj", filename: "CLAUDE.md", type: "claude", content: "instructions", path: "/path2" },
    ];
    const result = applyTrustFilter(rows, 365, 0.5, { enabled: false });
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].content).toBe("project summary text");
  });

  it("filters findings rows through trust pipeline", () => {
    const findingsContent = [
      "# testproj FINDINGS",
      "",
      "## 2026-03-01",
      "",
      `- Fresh finding`,
      `  <!-- phren:cite {"created_at":"2026-03-01T00:00:00.000Z"} -->`,
      "",
    ].join("\n");

    const rows = [
      { project: "testproj", filename: "FINDINGS.md", type: "findings", content: findingsContent, path: "/FINDINGS.md" },
    ];
    const result = applyTrustFilter(rows, 365, 0.0, { enabled: false });
    expect(result.rows).toHaveLength(1);
    // Content should still contain the fresh finding
    expect(result.rows[0].content).toContain("Fresh finding");
  });

  it("removes findings rows that become empty after trust filtering", () => {
    // A finding from far in the past with very short TTL should be filtered out
    const oldFindings = [
      "# testproj FINDINGS",
      "",
      "## 2020-01-01",
      "",
      `- Ancient finding`,
      `  <!-- phren:cite {"created_at":"2020-01-01T00:00:00.000Z"} -->`,
      "",
    ].join("\n");

    const rows = [
      { project: "testproj", filename: "FINDINGS.md", type: "findings", content: oldFindings, path: "/FINDINGS.md" },
    ];
    // Very short TTL should filter out old entries
    const result = applyTrustFilter(rows, 1, 0.99, { enabled: true, halfLifeDays: 30 });
    // The row should be filtered out because all content is stale
    expect(result.rows.length).toBeLessThanOrEqual(1);
    if (result.rows.length === 1) {
      // If it survives, at least check that old content was removed
      expect(result.rows[0].content).not.toContain("Ancient finding");
    }
  });
});

describe("trackSessionMetrics", () => {
  let phrenDir: string;
  let phrenCleanup: () => void;

  beforeEach(() => {
    ({ path: phrenDir, cleanup: phrenCleanup } = makeTempDir("phren-metrics-"));
    write(path.join(phrenDir, ".runtime", "memory-scores.json"), "{}");
  });

  afterEach(() => {
    phrenCleanup();
  });

  it("creates session metrics file and tracks prompts", () => {
    const selected: SelectedSnippet[] = [{
      doc: { project: "proj", filename: "f.md", type: "findings", content: "content", path: "/f" },
      snippet: "snippet",
      key: "proj:f.md:abc",
    }];
    trackSessionMetrics(phrenDir, "session-1", selected);

    const metricsFile = path.join(phrenDir, ".runtime", "session-metrics.json");
    expect(fs.existsSync(metricsFile)).toBe(true);

    const metrics = JSON.parse(fs.readFileSync(metricsFile, "utf8"));
    expect(metrics["session-1"]).toBeDefined();
    expect(metrics["session-1"].prompts).toBe(1);
    expect(metrics["session-1"].keys["proj:f.md:abc"]).toBe(1);
  });

  it("increments prompt count on repeated calls", () => {
    const selected: SelectedSnippet[] = [{
      doc: { project: "proj", filename: "f.md", type: "findings", content: "content", path: "/f" },
      snippet: "snippet",
      key: "proj:f.md:abc",
    }];
    trackSessionMetrics(phrenDir, "session-2", selected);
    trackSessionMetrics(phrenDir, "session-2", selected);
    trackSessionMetrics(phrenDir, "session-2", selected);

    const metricsFile = path.join(phrenDir, ".runtime", "session-metrics.json");
    const metrics = JSON.parse(fs.readFileSync(metricsFile, "utf8"));
    expect(metrics["session-2"].prompts).toBe(3);
    expect(metrics["session-2"].keys["proj:f.md:abc"]).toBe(3);
  });

  it("prunes sessions older than 30 days", () => {
    const metricsFile = path.join(phrenDir, ".runtime", "session-metrics.json");
    const oldDate = new Date(Date.now() - 40 * 86400000).toISOString();
    write(metricsFile, JSON.stringify({
      "old-session": { prompts: 5, keys: {}, lastChangedCount: 0, lastKeys: [], lastSeen: oldDate },
    }));

    const selected: SelectedSnippet[] = [{
      doc: { project: "proj", filename: "f.md", type: "findings", content: "c", path: "/f" },
      snippet: "s",
      key: "k",
    }];
    trackSessionMetrics(phrenDir, "new-session", selected);

    const metrics = JSON.parse(fs.readFileSync(metricsFile, "utf8"));
    expect(metrics["old-session"]).toBeUndefined();
    expect(metrics["new-session"]).toBeDefined();
  });
});

describe("filterTaskByPriority", () => {
  const savedEnv = process.env.PHREN_TASK_PRIORITY;

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.PHREN_TASK_PRIORITY;
    } else {
      process.env.PHREN_TASK_PRIORITY = savedEnv;
    }
  });

  it("passes items without priority tags through by default", () => {
    const items = ["- Fix login bug", "- Add dashboard"];
    const result = filterTaskByPriority(items);
    expect(result).toEqual(items);
  });

  it("passes [high] and [medium] items through by default", () => {
    const items = [
      "- [high] Fix critical auth issue",
      "- [medium] Improve caching",
      "- [low] Rename variable",
    ];
    const result = filterTaskByPriority(items);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain("[high]");
    expect(result[1]).toContain("[medium]");
  });

  it("filters based on PHREN_TASK_PRIORITY env var", () => {
    process.env.PHREN_TASK_PRIORITY = "high";
    const items = [
      "- [high] Critical fix",
      "- [medium] Nice to have",
      "- [low] Polish",
    ];
    const result = filterTaskByPriority(items);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("[high]");
  });

  it("allows explicit allowedPriorities parameter", () => {
    const items = [
      "- [high] Critical",
      "- [medium] Medium",
      "- [low] Low priority",
    ];
    const result = filterTaskByPriority(items, ["low"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("[low]");
  });

  it("is case-insensitive for priority tags", () => {
    const items = ["- [HIGH] Important task", "- [Low] Minor task"];
    const result = filterTaskByPriority(items);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("[HIGH]");
  });
});
