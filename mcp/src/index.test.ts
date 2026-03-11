import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sanitizeFts5Query, isValidProjectName, safeProjectPath, extractKeywords, buildRobustFtsQuery, STOP_WORDS } from "./utils.js";
import { debugLog } from "./shared.js";
import {
  consolidateProjectFindings,
  getWorkflowPolicy,
  updateWorkflowPolicy,
  getIndexPolicy,
  updateIndexPolicy,
  pruneDeadMemories,
} from "./shared-governance.js";
import {
  validateFindingsFormat,
  validateTaskFormat,
  mergeFindings,
  mergeTask,
  filterTrustedFindings,
  addFindingToFile,
  extractConflictVersions,
} from "./shared-content.js";
import { grantAdmin, makeTempDir, runCliExec } from "./test-helpers.js";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

const runCli = runCliExec;

describe("sanitizeFts5Query", () => {
  it("passes through a normal query", () => {
    expect(sanitizeFts5Query("authentication")).toBe("authentication");
  });

  it("handles multi-word queries", () => {
    const result = sanitizeFts5Query("user login");
    expect(result).toBe("user login");
  });

  it("normalizes SQL-like strings into plain search terms", () => {
    const result = sanitizeFts5Query("'; DROP TABLE docs--");
    // Whitelist sanitizer strips semicolons but preserves apostrophes
    expect(result).not.toContain(";");
    expect(result).toContain("DROP");
  });

  it("removes FTS5 column filter prefixes", () => {
    const result = sanitizeFts5Query("content:secret");
    // Whitelist strips colon, so "content:secret" becomes "content secret"
    expect(result).not.toContain(":");
    expect(result).toContain("content");
    expect(result).toContain("secret");
  });

  it("removes all known column filters", () => {
    // Whitelist strips colons, so "type:task" -> "type task"
    expect(sanitizeFts5Query("type:task")).toContain("task");
    expect(sanitizeFts5Query("type:task")).not.toContain(":");
    expect(sanitizeFts5Query("project:foo")).toContain("foo");
    expect(sanitizeFts5Query("project:foo")).not.toContain(":");
    expect(sanitizeFts5Query("filename:bar")).toContain("bar");
    expect(sanitizeFts5Query("filename:bar")).not.toContain(":");
  });

  it("preserves URL words (dots are stripped by whitelist)", () => {
    const result = sanitizeFts5Query("https://example.com");
    expect(result).toContain("https");
    // Dots are stripped by whitelist sanitizer
    expect(result).not.toContain(".");
    expect(result).not.toContain("//");
  });

  it("removes null bytes", () => {
    const result = sanitizeFts5Query("hello\0world");
    expect(result).toBe("hello world");
  });

  it("removes FTS5 ^ anchors", () => {
    const result = sanitizeFts5Query("^start of phrase");
    expect(result).toBe("start of phrase");
  });

  it("preserves double quotes for quoted phrases", () => {
    const result = sanitizeFts5Query('"exact phrase"');
    expect(result).toBe('"exact phrase"');
  });

  it("returns empty string for empty input", () => {
    expect(sanitizeFts5Query("")).toBe("");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(sanitizeFts5Query("   ")).toBe("");
  });

  it("handles combined injection attempts", () => {
    const result = sanitizeFts5Query('^content:"secret" OR filename:hack\0');
    expect(result).not.toContain("^");
    expect(result).not.toContain("\0");
    expect(result).not.toContain(":");
    // Double quotes are now preserved for quoted phrase support
    // Whitelist sanitizer keeps letters-only words; OR word may remain
    expect(result).toContain("content");
    expect(result).toContain("secret");
    expect(result).toContain("hack");
  });
});

describe("buildRobustFtsQuery", () => {
  it("quotes terms and expands known synonyms", () => {
    const query = buildRobustFtsQuery("throttling");
    expect(query).toContain("\"throttling\"");
    expect(query).toContain("\"rate limit\"");
    expect(query).toContain(" OR ");
  });

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

describe("isValidProjectName", () => {
  it("accepts a valid name", () => {
    expect(isValidProjectName("my-project")).toBe(true);
  });

  it("rejects dot-prefixed names (.hidden)", () => {
    expect(isValidProjectName(".hidden")).toBe(false);
  });

  it("accepts alphanumeric names", () => {
    expect(isValidProjectName("project123")).toBe(true);
  });

  it("rejects path traversal with ..", () => {
    expect(isValidProjectName("../etc")).toBe(false);
  });

  it("rejects forward slash", () => {
    expect(isValidProjectName("foo/bar")).toBe(false);
  });

  it("rejects backslash", () => {
    expect(isValidProjectName("foo\\bar")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidProjectName("")).toBe(false);
  });

  it("rejects null byte", () => {
    expect(isValidProjectName("foo\0bar")).toBe(false);
  });

  it("rejects bare double dots", () => {
    expect(isValidProjectName("..")).toBe(false);
  });

  it("rejects triple dots containing ..", () => {
    expect(isValidProjectName("...")).toBe(false);
  });
});

describe("extractKeywords", () => {
  it("removes stop words", () => {
    const result = extractKeywords("fix the rate limiter in sampleatlas");
    expect(result).not.toContain("the");
    expect(result).not.toContain("in");
    expect(result).toContain("rate");
    expect(result).toContain("limiter");
    expect(result).toContain("sampleatlas");
  });

  it("returns empty string for only stop words", () => {
    expect(extractKeywords("the is a an")).toBe("");
  });

  it("limits to 10 terms (words + bigrams)", () => {
    const result = extractKeywords("one two three four five six seven eight nine ten eleven");
    expect(result.split(" ").length).toBeLessThanOrEqual(10);
  });

  it("strips punctuation", () => {
    const result = extractKeywords("what's the auth? (login)");
    expect(result).not.toContain("?");
    expect(result).not.toContain("(");
  });

  it("handles empty string", () => {
    expect(extractKeywords("")).toBe("");
  });

  it("removes single-character words", () => {
    const result = extractKeywords("a b c deploy");
    expect(result).toBe("deploy");
  });
});

describe("safeProjectPath", () => {
  const base = "/tmp/test-cortex";

  it("returns resolved path for a valid subdirectory", () => {
    const result = safeProjectPath(base, "my-project");
    expect(result).toBe(path.resolve(base, "my-project"));
  });

  it("rejects traversal that escapes the base", () => {
    const result = safeProjectPath(base, "..", "etc", "passwd");
    expect(result).toBeNull();
  });

  it("rejects simple parent traversal", () => {
    const result = safeProjectPath(base, "..");
    expect(result).toBeNull();
  });

  it("allows the base directory itself", () => {
    const result = safeProjectPath(base);
    expect(result).toBe(path.resolve(base));
  });

  it("allows nested paths within base", () => {
    const result = safeProjectPath(base, "project", "subdir");
    expect(result).toBe(path.resolve(base, "project", "subdir"));
  });

  it("rejects prefix attacks (base name as substring)", () => {
    // e.g. base is /tmp/test-cortex, attacker tries /tmp/test-cortex-evil
    const result = safeProjectPath(base, "..", "test-cortex-evil");
    expect(result).toBeNull();
  });
});

describe("isValidProjectName", () => {
  it("accepts canonical lowercase project names", () => {
    expect(isValidProjectName("cortex")).toBe(true);
    expect(isValidProjectName("project-center")).toBe(true);
    expect(isValidProjectName("m4l_builder")).toBe(true);
  });

  it("rejects uppercase project names", () => {
    expect(isValidProjectName("Cortex")).toBe(false);
    expect(isValidProjectName("SamplePortal")).toBe(false);
  });

  it("rejects punctuation outside hyphen and underscore", () => {
    expect(isValidProjectName("native:-home")).toBe(false);
    expect(isValidProjectName("my.project")).toBe(false);
  });
});

describe("memory workflow policy", () => {
  let tmpRoot: string;
  let cortexDir: string;
  let actor: string;

  let tmpCleanup: () => void;

  beforeEach(() => {
    ({ path: tmpRoot, cleanup: tmpCleanup } = makeTempDir("cortex-workflow-test-"));
    cortexDir = path.join(tmpRoot, "cortex");
    fs.mkdirSync(path.join(cortexDir, ".governance"), { recursive: true });
    actor = grantAdmin(cortexDir, "workflow-admin");
    process.env.CORTEX_ACTOR = actor;
  });

  afterEach(() => {
    tmpCleanup();
  });

  it("returns defaults when no workflow policy file exists", () => {
    const policy = getWorkflowPolicy(cortexDir);
    expect(policy.requireMaintainerApproval).toBe(false);
    expect(policy.lowConfidenceThreshold).toBe(0.7);
    expect(policy.riskySections).toContain("Stale");
  });

  it("updates workflow policy with admin permission", () => {
    const updated = updateWorkflowPolicy(cortexDir, {
      requireMaintainerApproval: false,
      lowConfidenceThreshold: 0.55,
      riskySections: ["Review", "Conflicts"],
    });
    expect(updated.ok).toBe(true);
    const policy = getWorkflowPolicy(cortexDir);
    expect(policy.requireMaintainerApproval).toBe(false);
    expect(policy.lowConfidenceThreshold).toBe(0.55);
    expect(policy.riskySections).toEqual(["Review", "Conflicts"]);
  });
});

describe("index policy", () => {
  let tmpRoot: string;
  let cortexDir: string;

  let tmpCleanup: () => void;

  beforeEach(() => {
    ({ path: tmpRoot, cleanup: tmpCleanup } = makeTempDir("cortex-index-policy-test-"));
    cortexDir = path.join(tmpRoot, "cortex");
    fs.mkdirSync(path.join(cortexDir, ".governance"), { recursive: true });
    grantAdmin(cortexDir, "index-admin");
  });

  afterEach(() => {
    tmpCleanup();
  });

  it("returns defaults when file is missing", () => {
    const policy = getIndexPolicy(cortexDir);
    expect(policy.includeGlobs).toContain("**/*.md");
    expect(policy.includeGlobs).toContain("**/skills/**/*.md");
    expect(policy.includeGlobs).toContain(".claude/skills/**/*.md");
    expect(policy.excludeGlobs).toContain("**/node_modules/**");
    expect(policy.includeHidden).toBe(false);
  });

  it("updates include/exclude globs with admin permission", () => {
    const updated = updateIndexPolicy(cortexDir, {
      includeGlobs: ["**/*.md", "**/skills/**/*.md", ".claude/skills/**/*.md", "notes/**/*.md"],
      excludeGlobs: ["**/.git/**", "**/tmp/**"],
      includeHidden: true,
    });
    expect(updated.ok).toBe(true);
    const policy = getIndexPolicy(cortexDir);
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

  it("can return multiple issues at once", () => {
    const issues = validateTaskFormat("no heading here");
    expect(issues.length).toBeGreaterThanOrEqual(2);
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
    const tmp = makeTempDir("cortex-cite-valid-");
    const file = path.join(tmp.path, "source.ts");
    fs.writeFileSync(file, "line1\nline2\nline3\n");

    const today = new Date().toISOString().slice(0, 10);
    const cited = `<!-- cortex:cite ${JSON.stringify({ created_at: new Date().toISOString(), file, line: 2 })} -->`;
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
      `  <!-- cortex:cite ${JSON.stringify({ created_at: new Date().toISOString(), file: "/missing/file.ts", line: 1 })} -->`,
      "",
    ].join("\n");

    const filtered = filterTrustedFindings(content, 90);
    expect(filtered).not.toContain("- Too old");
    expect(filtered).not.toContain("- Bad citation");
  });
});

describe("addFindingToFile", () => {
  const originalActor = process.env.CORTEX_ACTOR;

  afterEach(() => {
    process.env.CORTEX_ACTOR = originalActor;
  });

  it("writes citation metadata alongside a new finding", () => {
    const tmp = makeTempDir("cortex-add-finding-");
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
    if (result.ok) expect(result.data).toContain("added insight");

    const findings = fs.readFileSync(path.join(projectDir, "FINDINGS.md"), "utf8");
    expect(findings).toContain("<!-- cortex:cite");
    expect(findings).toContain("\"file\":\"/tmp/source.ts\"");
    expect(findings).toContain("\"line\":12");

    tmp.cleanup();
  });
});

describe("memory maintenance", () => {
  const originalActor = process.env.CORTEX_ACTOR;

  afterEach(() => {
    process.env.CORTEX_ACTOR = originalActor;
  });

  it("prunes stale bullets and removes attached/dangling citation comments", () => {
    const tmp = makeTempDir("cortex-prune-");
    const cortexDir = tmp.path;
    const project = "proj";
    const projectDir = path.join(cortexDir, project);
    fs.mkdirSync(projectDir, { recursive: true });
    grantAdmin(cortexDir);

    const today = new Date().toISOString().slice(0, 10);
    const content = [
      "# proj FINDINGS",
      "",
      "## 2000-01-01",
      "",
      "- Old bullet",
      "  <!-- cortex:cite {\"created_at\":\"2000-01-01T00:00:00.000Z\"} -->",
      "",
      `## ${today}`,
      "",
      "- Fresh bullet",
      "  <!-- cortex:cite {\"created_at\":\"2026-01-01T00:00:00.000Z\"} -->",
      "  <!-- cortex:cite {\"created_at\":\"2026-01-01T00:00:00.000Z\"} -->",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(projectDir, "FINDINGS.md"), content);

    const result = pruneDeadMemories(cortexDir, project);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toContain("Pruned");
    const next = fs.readFileSync(path.join(projectDir, "FINDINGS.md"), "utf8");
    expect(next).not.toContain("- Old bullet");
    expect(next).toContain("- Fresh bullet");
    // One citation remains (attached to fresh bullet); dangling citation is removed.
    expect((next.match(/<!-- cortex:cite/g) || []).length).toBe(1);

    tmp.cleanup();
  });

  it("consolidates duplicate bullets and preserves citation metadata", () => {
    const tmp = makeTempDir("cortex-consolidate-");
    const cortexDir = tmp.path;
    const project = "proj";
    const projectDir = path.join(cortexDir, project);
    fs.mkdirSync(projectDir, { recursive: true });
    grantAdmin(cortexDir);

    const today = new Date().toISOString().slice(0, 10);
    const content = [
      "# proj FINDINGS",
      "",
      `## ${today}`,
      "",
      "- Same bullet",
      "- Same bullet",
      "  <!-- cortex:cite {\"created_at\":\"2026-01-01T00:00:00.000Z\"} -->",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(projectDir, "FINDINGS.md"), content);

    const result = consolidateProjectFindings(cortexDir, project);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toContain("Consolidated");
    const next = fs.readFileSync(path.join(projectDir, "FINDINGS.md"), "utf8");
    expect((next.match(/- Same bullet/g) || []).length).toBe(1);
    expect((next.match(/<!-- cortex:cite/g) || []).length).toBe(1);

    tmp.cleanup();
  });
});

describe("debugLog", () => {
  let tmpDir: string;
  let tmpCleanup: () => void;
  const origEnv = process.env.CORTEX_DEBUG;
  const origHome = process.env.HOME;

  beforeEach(() => {
    ({ path: tmpDir, cleanup: tmpCleanup } = makeTempDir("cortex-debug-test-"));
    process.env.HOME = tmpDir;
    fs.mkdirSync(path.join(tmpDir, ".cortex"), { recursive: true });
  });

  afterEach(() => {
    process.env.CORTEX_DEBUG = origEnv;
    process.env.HOME = origHome;
    tmpCleanup();
  });

  it("does not write when CORTEX_DEBUG is unset", () => {
    delete process.env.CORTEX_DEBUG;
    debugLog("should not appear");
    const logFile = path.join(tmpDir, ".cortex", ".runtime", "debug.log");
    expect(fs.existsSync(logFile)).toBe(false);
  });

  it("writes to debug.log when CORTEX_DEBUG is set", () => {
    process.env.CORTEX_DEBUG = "1";
    debugLog("hello from test");
    const logFile = path.join(tmpDir, ".cortex", ".runtime", "debug.log");
    expect(fs.existsSync(logFile)).toBe(true);
    const contents = fs.readFileSync(logFile, "utf8");
    expect(contents).toContain("hello from test");
  });

  it("appends successive messages", () => {
    process.env.CORTEX_DEBUG = "1";
    debugLog("first");
    debugLog("second");
    const logFile = path.join(tmpDir, ".cortex", ".runtime", "debug.log");
    const contents = fs.readFileSync(logFile, "utf8");
    expect(contents).toContain("first");
    expect(contents).toContain("second");
  });
});
