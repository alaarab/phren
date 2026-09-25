import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sanitizeFts5Query, isValidProjectName, safeProjectPath, extractKeywords, buildRobustFtsQuery, } from "./utils.js";
import { debugLog } from "./shared.js";
import {
  consolidateProjectFindings,
  getWorkflowPolicy,
  updateWorkflowPolicy,
  getIndexPolicy,
  updateIndexPolicy,
  pruneDeadMemories,
} from "./shared/governance.js";
import {
  validateFindingsFormat,
  validateTaskFormat,
  mergeFindings,
  mergeTask,
  filterTrustedFindings,
  addFindingToFile,
  extractConflictVersions,
} from "./shared/content.js";
import { grantAdmin, initTestPhrenRoot, makeTempDir, } from "./test-helpers.js";
import * as path from "path";
import * as fs from "fs";

describe("sanitizeFts5Query", () => {
  // The whitelist keeps letters, digits, hyphens, * and double-quoted phrases'
  // words; everything else becomes a space, then spaces collapse.
  it.each([
    ["multi-word queries pass through", "user login", "user login"],
    ["SQL-like strings become plain search terms", "'; DROP TABLE docs--", "DROP TABLE docs--"],
    ["column filters lose their colon", "type:task", "type task"],
    ["project filters lose their colon", "project:foo", "project foo"],
    ["filename filters lose their colon", "filename:bar", "filename bar"],
    ["URL punctuation is stripped", "https://example.com", "https example com"],
    ["^ anchors are removed", "^start of phrase", "start of phrase"],
    ["double quotes are stripped", '"exact phrase"', "exact phrase"],
    ["empty input stays empty", "", ""],
    ["whitespace-only input becomes empty", "   ", ""],
    ["combined injection attempts are neutralised", '^content:"secret" OR filename:hack\0', "content secret OR filename hack"],
    ["null bytes are stripped", "foo\0bar", "foo bar"],
    ["operator words are kept as plain words", "foo AND bar OR baz NOT qux NEAR quux", "foo AND bar OR baz NOT qux NEAR quux"],
    ["punctuation goes but hyphens inside words stay", "rate-limit @#$ test!", "rate-limit test"],
    ["runs of spaces collapse", "  foo    bar   ", "foo bar"],
    ["the * wildcard survives", "foo*", "foo*"],
    ["braces, brackets and parens are stripped", "foo {bar} [baz] (qux)", "foo bar baz qux"],
    ["apostrophes and underscores become spaces", "it's a test-case with under_score", "it s a test-case with under score"],
  ])("%s", (_label, input, expected) => {
    expect(sanitizeFts5Query(input)).toBe(expected);
  });

  it("truncates input longer than 500 characters", () => {
    expect(sanitizeFts5Query("a".repeat(600))).toHaveLength(500);
  });
});

describe("buildRobustFtsQuery", () => {
  it("returns empty string for empty or fully stripped input", () => {
    expect(buildRobustFtsQuery("")).toBe("");
    expect(buildRobustFtsQuery('""   ')).toBe("");
  });

  it("removes dangerous syntax and keeps stable quoted terms", () => {
    const query = buildRobustFtsQuery('content:"foo" OR path:/tmp && bar');
    expect(query).not.toContain("content:");
    expect(query).not.toContain("&&");
    expect(query).toContain("\"foo\"");
    expect(query).toContain("\"bar\"");
  });
});

describe("extractKeywords", () => {
  it("limits to 10 terms (words + bigrams)", () => {
    const result = extractKeywords("one two three four five six seven eight nine ten eleven");
    expect(result.split(" ").length).toBeLessThanOrEqual(10);
  });
});

describe("safeProjectPath", () => {
  const base = "/tmp/test-phren";

  it("returns resolved path for a valid subdirectory", () => {
    expect(safeProjectPath(base, "my-project")).toBe(path.resolve(base, "my-project"));
    expect(safeProjectPath(base, "project", "subdir")).toBe(path.resolve(base, "project", "subdir"));
  });

  it("rejects traversal that escapes the base", () => {
    expect(safeProjectPath(base, "..", "etc", "passwd")).toBeNull();
    expect(safeProjectPath(base, "..")).toBeNull();
  });

  it("allows the base directory itself", () => {
    const result = safeProjectPath(base);
    expect(result).toBe(path.resolve(base));
  });

  it("rejects prefix attacks (base name as substring)", () => {
    // e.g. base is /tmp/test-phren, attacker tries /tmp/test-phren-evil
    const result = safeProjectPath(base, "..", "test-phren-evil");
    expect(result).toBeNull();
  });
});

describe("isValidProjectName", () => {
  it("rejects uppercase project names", () => {
    expect(isValidProjectName("Phren")).toBe(false);
    expect(isValidProjectName("SamplePortal")).toBe(false);
  });

  it("rejects punctuation outside hyphen and underscore", () => {
    expect(isValidProjectName("native:-home")).toBe(false);
    expect(isValidProjectName("my.project")).toBe(false);
    expect(isValidProjectName("foo\0bar")).toBe(false);
    expect(isValidProjectName("...")).toBe(false);
  });
});

describe("memory workflow policy", () => {
  let tmpRoot: string;
  let phrenDir: string;
  let actor: string;

  let tmpCleanup: () => void;

  beforeEach(() => {
    ({ path: tmpRoot, cleanup: tmpCleanup } = makeTempDir("phren-workflow-test-"));
    phrenDir = path.join(tmpRoot, "phren");
    fs.mkdirSync(path.join(phrenDir, ".config"), { recursive: true });
    actor = grantAdmin(phrenDir, "workflow-admin");
    process.env.PHREN_ACTOR = actor;
  });

  afterEach(() => {
    tmpCleanup();
  });

  it("updates workflow policy with admin permission", () => {
    const updated = updateWorkflowPolicy(phrenDir, {
      lowConfidenceThreshold: 0.55,
      riskySections: ["Review", "Conflicts"],
    });
    expect(updated.ok).toBe(true);
    const policy = getWorkflowPolicy(phrenDir);
    expect(policy.lowConfidenceThreshold).toBe(0.55);
    expect(policy.riskySections).toEqual(["Review", "Conflicts"]);
  });
});

describe("index policy", () => {
  let tmpRoot: string;
  let phrenDir: string;

  let tmpCleanup: () => void;

  beforeEach(() => {
    ({ path: tmpRoot, cleanup: tmpCleanup } = makeTempDir("phren-index-policy-test-"));
    phrenDir = path.join(tmpRoot, "phren");
    fs.mkdirSync(path.join(phrenDir, ".config"), { recursive: true });
    grantAdmin(phrenDir, "index-admin");
  });

  afterEach(() => {
    tmpCleanup();
  });

  it("returns defaults when file is missing", () => {
    const policy = getIndexPolicy(phrenDir);
    expect(policy.includeGlobs).toContain("**/*.md");
    // Skills are invoked, not retrieved: out of the index by default.
    expect(policy.excludeGlobs).toContain("**/skills/**");
    expect(policy.excludeGlobs).toContain("**/.claude/skills/**");
    expect(policy.excludeGlobs).toContain("**/node_modules/**");
    expect(policy.includeHidden).toBe(false);
  });

  it("updates include/exclude globs with admin permission", () => {
    const updated = updateIndexPolicy(phrenDir, {
      includeGlobs: ["**/*.md", "**/skills/**/*.md", ".claude/skills/**/*.md", "notes/**/*.md"],
      excludeGlobs: ["**/.git/**", "**/tmp/**"],
      includeHidden: true,
    });
    expect(updated.ok).toBe(true);
    const policy = getIndexPolicy(phrenDir);
    expect(policy.includeGlobs).toContain("notes/**/*.md");
    expect(policy.excludeGlobs).toContain("**/tmp/**");
    expect(policy.includeHidden).toBe(true);
  });
});

describe("validateFindingsFormat", () => {
  it("returns no issues for valid content", () => {
    const content = "# My Project FINDINGS\n\n## 2024-01-15\n\n- Learned something\n";
    expect(validateFindingsFormat(content)).toEqual([]);
  });

  it("flags missing title heading", () => {
    const content = "## 2024-01-15\n\n- Learned something\n";
    const issues = validateFindingsFormat(content);
    expect(issues.some(i => i.includes("Missing title heading"))).toBe(true);
  });

  it("flags date headings in wrong format", () => {
    const content = "# FINDINGS\n\n## 01/15/2024\n\n- Something\n";
    const issues = validateFindingsFormat(content);
    expect(issues.some(i => i.includes("YYYY-MM-DD"))).toBe(true);
  });

  it("does not flag non-date section headings", () => {
    const content = "# FINDINGS\n\n## General Notes\n\n- Something\n";
    expect(validateFindingsFormat(content)).toEqual([]);
  });

  it("flags partial date strings that start with a digit", () => {
    const content = "# FINDINGS\n\n## 2024-1-5\n\n- Something\n";
    const issues = validateFindingsFormat(content);
    expect(issues.some(i => i.includes("YYYY-MM-DD"))).toBe(true);
  });

  it("returns no issues for multiple valid date headings", () => {
    const content = "# FINDINGS\n\n## 2024-01-15\n\n- A\n\n## 2024-01-16\n\n- B\n";
    expect(validateFindingsFormat(content)).toEqual([]);
  });
});

describe("validateTaskFormat", () => {
  it("returns no issues for valid content", () => {
    const content = "# task\n\n## Active\n\n- Task A\n\n## Queue\n\n## Done\n";
    expect(validateTaskFormat(content)).toEqual([]);
  });

  it("flags missing title heading", () => {
    const content = "## Active\n\n- Task A\n";
    const issues = validateTaskFormat(content);
    expect(issues.some(i => i.includes("Missing title heading"))).toBe(true);
    // No heading at all reports the title and the sections together.
    expect(validateTaskFormat("no heading here").length).toBeGreaterThanOrEqual(2);
  });

  it("flags missing standard sections", () => {
    const content = "# task\n\n- Task A\n";
    const issues = validateTaskFormat(content);
    expect(issues.some(i => i.includes("Missing expected sections"))).toBe(true);
  });

  it("accepts content with only Queue section", () => {
    const content = "# task\n\n## Queue\n\n- Task B\n";
    expect(validateTaskFormat(content)).toEqual([]);
  });
});

describe("extractConflictVersions", () => {
  it("returns null for content without conflict markers", () => {
    expect(extractConflictVersions("normal content\nno conflicts")).toBeNull();
  });

  it("extracts ours and theirs from a simple conflict", () => {
    const content = [
      "<<<<<<< HEAD",
      "our line",
      "=======",
      "their line",
      ">>>>>>> branch",
    ].join("\n");
    const result = extractConflictVersions(content);
    expect(result).not.toBeNull();
    expect(result!.ours).toContain("our line");
    expect(result!.theirs).toContain("their line");
  });

  it("includes non-conflict lines in both versions", () => {
    const content = [
      "shared header",
      "<<<<<<< HEAD",
      "ours",
      "=======",
      "theirs",
      ">>>>>>> branch",
      "shared footer",
    ].join("\n");
    const result = extractConflictVersions(content);
    expect(result!.ours).toContain("shared header");
    expect(result!.ours).toContain("shared footer");
    expect(result!.theirs).toContain("shared header");
    expect(result!.theirs).toContain("shared footer");
  });

  it("excludes conflict marker lines themselves", () => {
    const content = "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> b";
    const result = extractConflictVersions(content);
    expect(result!.ours).not.toContain("<<<<<<<");
    expect(result!.ours).not.toContain("=======");
    expect(result!.ours).not.toContain(">>>>>>>");
  });
});

describe("mergeFindings", () => {
  it("combines entries from both sides", () => {
    const ours = "# FINDINGS\n\n## 2024-01-15\n\n- Ours entry\n";
    const theirs = "# FINDINGS\n\n## 2024-01-15\n\n- Their entry\n";
    const merged = mergeFindings(ours, theirs);
    expect(merged).toContain("- Ours entry");
    expect(merged).toContain("- Their entry");
  });

  it("deduplicates identical entries", () => {
    const entry = "# FINDINGS\n\n## 2024-01-15\n\n- Same entry\n";
    const merged = mergeFindings(entry, entry);
    const count = (merged.match(/- Same entry/g) || []).length;
    expect(count).toBe(1);
  });

  it("sorts dates newest first", () => {
    const ours = "# FINDINGS\n\n## 2024-01-01\n\n- Old\n";
    const theirs = "# FINDINGS\n\n## 2024-06-15\n\n- New\n";
    const merged = mergeFindings(ours, theirs);
    expect(merged.indexOf("2024-06-15")).toBeLessThan(merged.indexOf("2024-01-01"));
  });

  it("merges entries from dates only present in one side", () => {
    const ours = "# FINDINGS\n\n## 2024-01-01\n\n- Only ours\n";
    const theirs = "# FINDINGS\n\n## 2024-06-15\n\n- Only theirs\n";
    const merged = mergeFindings(ours, theirs);
    expect(merged).toContain("- Only ours");
    expect(merged).toContain("- Only theirs");
  });

  it("preserves the title line from ours", () => {
    const ours = "# My Project FINDINGS\n\n## 2024-01-01\n\n- A\n";
    const theirs = "# Other Title\n\n## 2024-01-01\n\n- B\n";
    const merged = mergeFindings(ours, theirs);
    expect(merged.startsWith("# My Project FINDINGS")).toBe(true);
  });
});

describe("mergeTask", () => {
  it("combines items from both sides", () => {
    const ours = "# task\n\n## Active\n\n- Ours task\n\n## Queue\n\n## Done\n";
    const theirs = "# task\n\n## Active\n\n- Their task\n\n## Queue\n\n## Done\n";
    const merged = mergeTask(ours, theirs);
    expect(merged).toContain("- Ours task");
    expect(merged).toContain("- Their task");
  });

  it("deduplicates identical items", () => {
    const content = "# task\n\n## Active\n\n- Same task\n\n## Queue\n\n## Done\n";
    const merged = mergeTask(content, content);
    const count = (merged.match(/- Same task/g) || []).length;
    expect(count).toBe(1);
  });

  it("orders sections Active, Queue, Done first", () => {
    const ours = "# task\n\n## Done\n\n- D\n\n## Active\n\n- A\n\n## Queue\n\n- Q\n";
    const theirs = ours;
    const merged = mergeTask(ours, theirs);
    const activeIdx = merged.indexOf("## Active");
    const queueIdx = merged.indexOf("## Queue");
    const doneIdx = merged.indexOf("## Done");
    expect(activeIdx).toBeLessThan(queueIdx);
    expect(queueIdx).toBeLessThan(doneIdx);
  });

  it("preserves title from ours", () => {
    const ours = "# My Task\n\n## Active\n\n## Queue\n\n## Done\n";
    const theirs = "# Other\n\n## Active\n\n## Queue\n\n## Done\n";
    const merged = mergeTask(ours, theirs);
    expect(merged.startsWith("# My Task")).toBe(true);
  });
});

describe("filterTrustedFindings", () => {
  it("keeps recent uncited bullets and valid cited bullets", () => {
    const tmp = makeTempDir("phren-cite-valid-");
    const file = path.join(tmp.path, "source.ts");
    fs.writeFileSync(file, "line1\nline2\nline3\n");

    const today = new Date().toISOString().slice(0, 10);
    const cited = `<!-- phren:cite ${JSON.stringify({ created_at: new Date().toISOString(), file, line: 2 })} -->`;
    const content = [
      "# Project FINDINGS",
      "",
      `## ${today}`,
      "",
      "- Legacy entry",
      "- Cited entry",
      `  ${cited}`,
      "",
    ].join("\n");

    const filtered = filterTrustedFindings(content, 90);
    expect(filtered).toContain("- Legacy entry");
    expect(filtered).toContain("- Cited entry");

    tmp.cleanup();
  });

  it("drops stale and invalid-citation bullets", () => {
    const content = [
      "# Project FINDINGS",
      "",
      "## 2000-01-01",
      "",
      "- Too old",
      "",
      `## ${new Date().toISOString().slice(0, 10)}`,
      "",
      "- Bad citation",
      `  <!-- phren:cite ${JSON.stringify({ created_at: new Date().toISOString(), file: "/missing/file.ts", line: 1 })} -->`,
      "",
    ].join("\n");

    const filtered = filterTrustedFindings(content, 90);
    expect(filtered).not.toContain("- Too old");
    expect(filtered).not.toContain("- Bad citation");
  });
});

describe("addFindingToFile", () => {
  const originalActor = process.env.PHREN_ACTOR;

  afterEach(() => {
    process.env.PHREN_ACTOR = originalActor;
  });

  it("writes citation metadata alongside a new finding", () => {
    const tmp = makeTempDir("phren-add-finding-");
    const project = "proj";
    const projectDir = path.join(tmp.path, project);
    fs.mkdirSync(projectDir, { recursive: true });
    grantAdmin(tmp.path);

    const result = addFindingToFile(tmp.path, project, "Remember to clear cache", {
      file: "/tmp/source.ts",
      line: 12,
      commit: "abc123",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.status).toBe("created");

    const findings = fs.readFileSync(path.join(projectDir, "FINDINGS.md"), "utf8");
    expect(findings).toContain("<!-- phren:cite");
    expect(findings).toContain("\"file\":\"/tmp/source.ts\"");
    expect(findings).toContain("\"line\":12");

    tmp.cleanup();
  });
});

describe("memory maintenance", () => {
  const originalActor = process.env.PHREN_ACTOR;

  afterEach(() => {
    process.env.PHREN_ACTOR = originalActor;
  });

  it("prunes stale bullets and removes attached/dangling citation comments", () => {
    const tmp = makeTempDir("phren-prune-");
    const phrenDir = tmp.path;
    const project = "proj";
    const projectDir = path.join(phrenDir, project);
    fs.mkdirSync(projectDir, { recursive: true });
    grantAdmin(phrenDir);

    const today = new Date().toISOString().slice(0, 10);
    const content = [
      "# proj FINDINGS",
      "",
      "## 2000-01-01",
      "",
      "- Old bullet",
      "  <!-- phren:cite {\"created_at\":\"2000-01-01T00:00:00.000Z\"} -->",
      "",
      `## ${today}`,
      "",
      "- Fresh bullet",
      "  <!-- phren:cite {\"created_at\":\"2026-01-01T00:00:00.000Z\"} -->",
      "  <!-- phren:cite {\"created_at\":\"2026-01-01T00:00:00.000Z\"} -->",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(projectDir, "FINDINGS.md"), content);

    const result = pruneDeadMemories(phrenDir, project);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.message).toContain("Pruned");
    const next = fs.readFileSync(path.join(projectDir, "FINDINGS.md"), "utf8");
    expect(next).not.toContain("- Old bullet");
    expect(next).toContain("- Fresh bullet");
    // One citation remains (attached to fresh bullet); dangling citation is removed.
    expect((next.match(/<!-- phren:cite/g) || []).length).toBe(1);

    tmp.cleanup();
  });

  it("consolidates duplicate bullets and preserves citation metadata", () => {
    const tmp = makeTempDir("phren-consolidate-");
    const phrenDir = tmp.path;
    const project = "proj";
    const projectDir = path.join(phrenDir, project);
    fs.mkdirSync(projectDir, { recursive: true });
    grantAdmin(phrenDir);

    const today = new Date().toISOString().slice(0, 10);
    const content = [
      "# proj FINDINGS",
      "",
      `## ${today}`,
      "",
      "- Same bullet",
      "- Same bullet",
      "  <!-- phren:cite {\"created_at\":\"2026-01-01T00:00:00.000Z\"} -->",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(projectDir, "FINDINGS.md"), content);

    const result = consolidateProjectFindings(phrenDir, project);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toContain("Consolidated");
    const next = fs.readFileSync(path.join(projectDir, "FINDINGS.md"), "utf8");
    expect((next.match(/- Same bullet/g) || []).length).toBe(1);
    expect((next.match(/<!-- phren:cite/g) || []).length).toBe(1);

    tmp.cleanup();
  });
});

describe("debugLog", () => {
  let tmpDir: string;
  let tmpCleanup: () => void;
  const origEnv = process.env.PHREN_DEBUG;
  const origHome = process.env.HOME;
  const origPhrenPath = process.env.PHREN_PATH;

  beforeEach(() => {
    ({ path: tmpDir, cleanup: tmpCleanup } = makeTempDir("phren-debug-test-"));
    process.env.HOME = tmpDir;
    const phrenDir = path.join(tmpDir, ".phren");
    fs.mkdirSync(phrenDir, { recursive: true });
    initTestPhrenRoot(phrenDir);
    process.env.PHREN_PATH = phrenDir;
  });

  afterEach(() => {
    process.env.PHREN_DEBUG = origEnv;
    process.env.HOME = origHome;
    if (origPhrenPath === undefined) delete process.env.PHREN_PATH;
    else process.env.PHREN_PATH = origPhrenPath;
    tmpCleanup();
  });

  it("does not write when PHREN_DEBUG is unset", () => {
    delete process.env.PHREN_DEBUG;
    debugLog("should not appear");
    const logFile = path.join(tmpDir, ".phren", ".runtime", "debug.log");
    expect(fs.existsSync(logFile)).toBe(false);
  });

  it("writes to debug.log when PHREN_DEBUG is set", () => {
    process.env.PHREN_DEBUG = "1";
    debugLog("hello from test");
    debugLog("second");
    const logFile = path.join(tmpDir, ".phren", ".runtime", "debug.log");
    expect(fs.existsSync(logFile)).toBe(true);
    const contents = fs.readFileSync(logFile, "utf8");
    expect(contents).toContain("hello from test");
    expect(contents).toContain("second");
  });
});
