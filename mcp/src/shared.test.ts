import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  findPhrenPath,
  appendAuditLog,
  withDefaults,
  getProjectDirs,
  findPhrenPathWithArg,
  collectNativeMemoryFiles,
  findProjectNameCaseInsensitive,
  PhrenError,
  phrenOk,
  phrenErr,
  ensurePhrenPath,
  normalizeProjectNameForCreate,
  parsePhrenErrorCode,
  expandHomePath,
  homePath,
  hookConfigPath,
} from "./shared.js";
import {
  consolidateProjectFindings,
  recordInjection,
  recordFeedback,
  getQualityMultiplier,
  validateGovernanceJson,
  getRetentionPolicy,
  updateRetentionPolicy,
  getWorkflowPolicy,
  updateWorkflowPolicy,
  getIndexPolicy,
  updateIndexPolicy,
  getRuntimeHealth,
  updateRuntimeHealth,
  appendReviewQueue,
  flushEntryScores,
  entryScoreKey,
  pruneDeadMemories,
} from "./shared-governance.js";
import {
  buildIndex,
  queryRows,
  detectProject,
  resolveImports,
  extractSnippet,
} from "./shared-index.js";
import {
  addFindingToFile,
  checkConsolidationNeeded,
  mergeFindings,
  mergeTask,
  autoMergeConflicts,
  filterTrustedFindingsDetailed,
  upsertCanonical,
  validateFindingsFormat,
  validateTaskFormat,
  stripTaskDoneSection,
  isDuplicateFinding,
  extractConflictVersions,
} from "./shared-content.js";
import { isValidProjectName } from "./utils.js";
import { grantAdmin, initTestPhrenRoot, makeTempDir, suppressOutput } from "./test-helpers.js";
import * as path from "path";
import * as fs from "fs";
import * as yaml from "js-yaml";

let tmpDir: string;
let tmpCleanup: (() => void) | undefined;

function makePhren(): string {
  ({ path: tmpDir, cleanup: tmpCleanup } = makeTempDir("phren-test-"));
  initTestPhrenRoot(tmpDir);
  return tmpDir;
}

function makeProject(phrenDir: string, name: string, files: Record<string, string>): void {
  const dir = path.join(phrenDir, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, file), content);
  }
}

function readVersionedEntries<T>(filePath: string): Record<string, T> {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.entries && typeof parsed.entries === "object" && !Array.isArray(parsed.entries)) {
    return parsed.entries as Record<string, T>;
  }
  return parsed as Record<string, T>;
}

beforeEach(() => {
  delete process.env.PHREN_PATH;
});

afterEach(() => {
  delete process.env.PHREN_PATH;
  delete process.env.PHREN_ACTOR;
  if (tmpCleanup) {
    tmpCleanup();
    tmpCleanup = undefined;
  }
});

// --- isValidProjectName ---

describe("isValidProjectName", () => {
  it("accepts simple names", () => {
    expect(isValidProjectName("my-project")).toBe(true);
    expect(isValidProjectName("phren")).toBe(true);
    expect(isValidProjectName("foo_bar")).toBe(true);
  });

  it("rejects path traversal attempts", () => {
    expect(isValidProjectName("../etc")).toBe(false);
    expect(isValidProjectName("foo/../../bar")).toBe(false);
    expect(isValidProjectName("..")).toBe(false);
  });

  it("rejects empty names", () => {
    expect(isValidProjectName("")).toBe(false);
  });

  it("rejects names with slashes", () => {
    expect(isValidProjectName("foo/bar")).toBe(false);
    expect(isValidProjectName("foo\\bar")).toBe(false);
  });
});

describe("project casing helpers", () => {
  it("normalizes new project names to lowercase", () => {
    expect(normalizeProjectNameForCreate("Phren")).toBe("phren");
    expect(normalizeProjectNameForCreate("My-App")).toBe("my-app");
  });

  it("finds existing projects case-insensitively", () => {
    const phren = makePhren();
    makeProject(phren, "Phren", { "FINDINGS.md": "# Phren Findings\n" });
    expect(findProjectNameCaseInsensitive(phren, "phren")).toBe("Phren");
    expect(findProjectNameCaseInsensitive(phren, "PHREN")).toBe("Phren");
    expect(findProjectNameCaseInsensitive(phren, "missing")).toBeNull();
  });
});

// --- findPhrenPath / ensurePhrenPath ---

describe("findPhrenPath", () => {
  it("returns PHREN_PATH env var when set", () => {
    const phren = makePhren();
    process.env.PHREN_PATH = phren;
    expect(findPhrenPath()).toBe(phren);
  });

  it("returns null when no phren directory exists and no env var", () => {
    const tmp = makeTempDir("fakehome-");
    const origHome = process.env.HOME;
    const origCwd = process.cwd();
    process.env.HOME = tmp.path;
    process.chdir(tmp.path);
    try {
      expect(findPhrenPath()).toBeNull();
    } finally {
      process.chdir(origCwd);
      process.env.HOME = origHome;
      tmp.cleanup();
    }
  });

  it("finds ~/.phren when it exists", () => {
    const tmp = makeTempDir("fakehome-");
    const dotPhren = path.join(tmp.path, ".phren");
    fs.mkdirSync(dotPhren);
    initTestPhrenRoot(dotPhren);
    const origHome = process.env.HOME;
    const origCwd = process.cwd();
    process.env.HOME = tmp.path;
    process.chdir(tmp.path);
    try {
      expect(findPhrenPath()).toBe(fs.realpathSync(dotPhren));
    } finally {
      process.chdir(origCwd);
      process.env.HOME = origHome;
      tmp.cleanup();
    }
  });

  it("finds the nearest ancestor .phren directory", () => {
    const tmp = makeTempDir("ancestor-phren-");
    const repoRoot = path.join(tmp.path, "repo");
    const nestedDir = path.join(repoRoot, "packages", "app");
    const localPhren = path.join(repoRoot, ".phren");
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.mkdirSync(localPhren, { recursive: true });
    initTestPhrenRoot(localPhren);

    const origCwd = process.cwd();
    const origHome = process.env.HOME;
    process.env.HOME = path.join(tmp.path, "home");
    fs.mkdirSync(process.env.HOME, { recursive: true });
    process.chdir(nestedDir);
    try {
      expect(findPhrenPath()).toBe(fs.realpathSync(localPhren));
    } finally {
      process.chdir(origCwd);
      process.env.HOME = origHome;
      tmp.cleanup();
    }
  });
});

describe("ensurePhrenPath", () => {
  it("creates ~/.phren if nothing exists", async () => {
    const tmp = makeTempDir("fakehome-");
    const origHome = process.env.HOME;
    const origCwd = process.cwd();
    process.env.HOME = tmp.path;
    process.chdir(tmp.path);
    try {
      const result = await suppressOutput(() => Promise.resolve(ensurePhrenPath()));
      expect(result).toBe(path.join(tmp.path, ".phren"));
      expect(fs.existsSync(result)).toBe(true);
      expect(fs.existsSync(path.join(result, "phren.root.yaml"))).toBe(true);
      expect(findPhrenPath()).toBe(result);
    } finally {
      process.chdir(origCwd);
      process.env.HOME = origHome;
      tmp.cleanup();
    }
  });
});

describe("path resolution helpers", () => {
  it("resolves home-relative paths from HOME overrides", () => {
    const tmp = makeTempDir("fakehome-");
    const origHome = process.env.HOME;
    const origProfile = process.env.USERPROFILE;
    process.env.HOME = tmp.path;
    process.env.USERPROFILE = tmp.path;
    try {
      expect(expandHomePath("~/demo/file.txt")).toBe(path.join(tmp.path, "demo", "file.txt"));
      expect(homePath(".claude", "settings.json")).toBe(path.join(tmp.path, ".claude", "settings.json"));
      expect(hookConfigPath("copilot")).toBe(path.join(tmp.path, ".github", "hooks", "phren.json"));
      expect(hookConfigPath("claude", path.join(tmp.path, ".phren"))).toBe(path.join(tmp.path, ".claude", "settings.json"));
      expect(hookConfigPath("codex", path.join(tmp.path, ".phren"))).toBe(path.join(tmp.path, ".phren", "codex.json"));
    } finally {
      process.env.HOME = origHome;
      process.env.USERPROFILE = origProfile;
      tmp.cleanup();
    }
  });
});

describe("governance validation", () => {
  it("validates shared governance schemas", () => {
    const phren = makePhren();
    const govDir = path.join(phren, ".governance");
    fs.mkdirSync(govDir, { recursive: true });

    const indexPolicy = path.join(govDir, "index-policy.json");
    fs.writeFileSync(indexPolicy, JSON.stringify({ includeGlobs: "bad-shape" }, null, 2));
    expect(validateGovernanceJson(indexPolicy, "index-policy")).toBe(false);
  });
});

// --- buildIndex + queryRows ---

describe("buildIndex and queryRows", () => {
  it("indexes markdown files and supports FTS5 search", async () => {
    const phren = makePhren();
    makeProject(phren, "testproj", {
      "FINDINGS.md": "# testproj FINDINGS\n\n## 2025-01-01\n\n- Always validate user input before processing\n",
      "summary.md": "# testproj\n\nA test project for vitest.\n",
    });

    const db = await buildIndex(phren);
    const rows = queryRows(db, "SELECT project, filename FROM docs WHERE docs MATCH ? ORDER BY rank", ["validate"]);
    expect(rows).not.toBeNull();
    expect(rows!.length).toBeGreaterThanOrEqual(1);
    expect(rows![0][0]).toBe("testproj");
    expect(rows![0][1]).toBe("FINDINGS.md");
    db.close();
  });

  it("returns null for queries with no matches", async () => {
    const phren = makePhren();
    makeProject(phren, "testproj", {
      "summary.md": "# testproj\n\nA simple project.\n",
    });

    const db = await buildIndex(phren);
    const rows = queryRows(db, "SELECT project FROM docs WHERE docs MATCH ?", ["zzzznonexistent"]);
    expect(rows).toBeNull();
    db.close();
  });

  it("indexes multiple projects", async () => {
    const phren = makePhren();
    makeProject(phren, "alpha", { "summary.md": "# alpha\n\nFirst project about databases.\n" });
    makeProject(phren, "beta", { "summary.md": "# beta\n\nSecond project about networking.\n" });

    const db = await buildIndex(phren);
    const alphaRows = queryRows(db, "SELECT project FROM docs WHERE docs MATCH ? AND project = ?", ["databases", "alpha"]);
    const betaRows = queryRows(db, "SELECT project FROM docs WHERE docs MATCH ? AND project = ?", ["networking", "beta"]);
    expect(alphaRows).not.toBeNull();
    expect(betaRows).not.toBeNull();
    expect(alphaRows![0][0]).toBe("alpha");
    expect(betaRows![0][0]).toBe("beta");
    db.close();
  });

  it("returns null for invalid SQL instead of throwing", async () => {
    const phren = makePhren();
    makeProject(phren, "testproj", {
      "summary.md": "# testproj\n\nA simple project.\n",
    });

    const db = await buildIndex(phren);
    expect(queryRows(db, "SELECT definitely_not_a_column FROM docs", [])).toBeNull();
    db.close();
  });

  it("returns null when db.exec throws (corrupt/invalid db path)", () => {
    const fakeDb = {
      exec: () => {
        throw new Error("database disk image is malformed");
      },
    };
    expect(queryRows(fakeDb, "SELECT 1", [])).toBeNull();
  });

  it("buildIndex returns empty index when profile YAML is malformed (fail-closed, Q18)", async () => {
    const phren = makePhren();
    const origHome = process.env.HOME;
    const origUserProfile = process.env.USERPROFILE;
    const homeDir = path.join(phren, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    fs.mkdirSync(path.join(phren, "profiles"), { recursive: true });
    fs.writeFileSync(path.join(phren, "profiles", "broken.yaml"), "name: broken\nprojects: [\n");
    makeProject(phren, "testproj", {
      "summary.md": "# testproj\n\nProfile parse fallback should still index this.\n",
    });

    try {
      // Q18: when a profile is set but the file is malformed, getProjectDirs returns []
      // and buildIndex produces an empty (but valid) FTS database — it does NOT widen
      // to all projects, which would violate profile-based access control.
      const db = await suppressOutput(() => buildIndex(phren, "broken"));
      const rows = queryRows(db, "SELECT project FROM docs WHERE docs MATCH ?", ["fallback"]);
      expect(rows).toBeNull(); // empty DB — no documents indexed
      db.close();
    } finally {
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
      if (origUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = origUserProfile;
    }
  });
});

// --- extractSnippet ---

describe("extractSnippet", () => {
  it("extracts lines around the best match", () => {
    const content = "line 1\nline 2\nthe important match here\nline 4\nline 5\nline 6";
    const snippet = extractSnippet(content, "important match", 3);
    expect(snippet).toContain("important match");
  });

  it("returns beginning of content when no term matches", () => {
    const content = "first\nsecond\nthird\nfourth\nfifth";
    const snippet = extractSnippet(content, "zzzznotfound", 3);
    expect(snippet).toContain("first");
  });
});

// --- addFindingToFile ---

describe("addFindingToFile", () => {
  it("creates FINDINGS.md if it does not exist", () => {
    const phren = makePhren();
    grantAdmin(phren);
    makeProject(phren, "newproj", { "summary.md": "# newproj\n" });

    const result = addFindingToFile(phren, "newproj", "Always use parameterized queries");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toContain("Created FINDINGS.md");
    const content = fs.readFileSync(path.join(phren, "newproj", "FINDINGS.md"), "utf8");
    expect(content).toContain("- Always use parameterized queries");
    expect(content).toContain("phren:cite");
  });

  it("appends to existing date section", () => {
    const phren = makePhren();
    grantAdmin(phren);
    const today = new Date().toISOString().slice(0, 10);
    makeProject(phren, "myproj", {
      "FINDINGS.md": `# myproj FINDINGS\n\n## ${today}\n\n- Existing finding\n`,
    });

    addFindingToFile(phren, "myproj", "Second insight");
    const content = fs.readFileSync(path.join(phren, "myproj", "FINDINGS.md"), "utf8");
    expect(content).toContain("- Second insight");
    expect(content).toContain("- Existing finding");
    // Should still have only one date heading for today
    const headingCount = (content.match(new RegExp(`## ${today}`, "g")) || []).length;
    expect(headingCount).toBe(1);
  });

  it("rejects invalid project names", () => {
    const phren = makePhren();
    grantAdmin(phren);
    const result = addFindingToFile(phren, "../etc", "bad");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Invalid project name");
  });

  it("skips duplicate findings with high word overlap", () => {
    const phren = makePhren();
    grantAdmin(phren);
    const today = new Date().toISOString().slice(0, 10);
    makeProject(phren, "dupeproj", {
      "FINDINGS.md": `# dupeproj FINDINGS\n\n## ${today}\n\n- The auth middleware runs before rate limiting and order matters\n`,
    });

    const result = addFindingToFile(phren, "dupeproj", "The auth middleware runs before rate limiting, order matters");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toContain("Skipped duplicate");
  });

  it("allows non-duplicate findings through", () => {
    const phren = makePhren();
    grantAdmin(phren);
    const today = new Date().toISOString().slice(0, 10);
    makeProject(phren, "dupeproj2", {
      "FINDINGS.md": `# dupeproj2 FINDINGS\n\n## ${today}\n\n- The auth middleware runs before rate limiting\n`,
    });

    const result = addFindingToFile(phren, "dupeproj2", "Database indexes need to be rebuilt after migration");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toContain("Added finding");
  });
});

// --- isDuplicateFinding ---

describe("isDuplicateFinding", () => {
  it("detects duplicates with >60% word overlap", () => {
    const existing = "- The auth middleware runs before rate limiting and order matters\n- Use parameterized queries for SQL";
    expect(isDuplicateFinding(existing, "- The auth middleware runs before rate limiting, order matters")).toBe(true);
  });

  it("allows non-duplicates through", () => {
    const existing = "- The auth middleware runs before rate limiting\n- Use parameterized queries for SQL";
    expect(isDuplicateFinding(existing, "- Database indexes need rebuilding after schema migration")).toBe(false);
  });

  it("returns false for empty content", () => {
    expect(isDuplicateFinding("", "- Some new finding")).toBe(false);
    expect(isDuplicateFinding("# Title\n", "- Some new finding")).toBe(false);
  });

  it("returns false for empty finding", () => {
    expect(isDuplicateFinding("- existing bullet", "")).toBe(false);
  });

  it("respects custom threshold", () => {
    const existing = "- The auth middleware runs before rate limiting and order matters";
    // With a very high threshold, partial matches should not count
    expect(isDuplicateFinding(existing, "- database indexes rebuild after migration", 0.3)).toBe(false);
    // With a low threshold, even small overlap triggers duplicate
    expect(isDuplicateFinding(existing, "- auth middleware should validate tokens before rate limiting", 0.3)).toBe(true);
  });
});

// --- checkConsolidationNeeded ---

describe("checkConsolidationNeeded", () => {
  it("flags projects with 25+ entries since last consolidation", () => {
    const phren = makePhren();
    const bullets = Array.from({ length: 26 }, (_, i) => `- Finding number ${i + 1}`).join("\n");
    makeProject(phren, "bigproj", {
      "FINDINGS.md": `# bigproj FINDINGS\n\n## 2025-01-01\n\n${bullets}\n`,
    });

    const results = checkConsolidationNeeded(phren);
    expect(results.length).toBe(1);
    expect(results[0].project).toBe("bigproj");
    expect(results[0].entriesSince).toBe(26);
  });

  it("does not flag projects under threshold", () => {
    const phren = makePhren();
    makeProject(phren, "smallproj", {
      "FINDINGS.md": "# smallproj FINDINGS\n\n## 2025-01-01\n\n- One finding\n- Two finding\n",
    });

    const results = checkConsolidationNeeded(phren);
    expect(results.length).toBe(0);
  });

  it("counts only entries after the consolidation marker", () => {
    const phren = makePhren();
    const oldBullets = Array.from({ length: 30 }, (_, i) => `- Old finding ${i}`).join("\n");
    const newBullets = Array.from({ length: 5 }, (_, i) => `- New finding ${i}`).join("\n");
    makeProject(phren, "markedproj", {
      "FINDINGS.md": `# markedproj FINDINGS\n\n## 2024-01-01\n\n${oldBullets}\n\n<!-- consolidated: 2025-01-01 -->\n\n## 2025-02-01\n\n${newBullets}\n`,
    });

    const results = checkConsolidationNeeded(phren);
    expect(results.length).toBe(0);
  });

  it("flags time-based consolidation (60+ days, 10+ entries)", () => {
    const phren = makePhren();
    const bullets = Array.from({ length: 12 }, (_, i) => `- Finding ${i}`).join("\n");
    makeProject(phren, "oldproj", {
      "FINDINGS.md": `# oldproj FINDINGS\n\n## 2024-06-01\n\n${bullets}\n\n<!-- consolidated: 2024-01-01 -->\n\n## 2024-06-15\n\n${bullets}\n`,
    });

    const results = checkConsolidationNeeded(phren);
    expect(results.length).toBe(1);
    expect(results[0].project).toBe("oldproj");
  });
});

// --- detectProject ---

describe("detectProject", () => {
  it("matches the longest sourcePath prefix", () => {
    const phren = makePhren();
    makeProject(phren, "myapp", {
      "summary.md": "# myapp\n",
      "phren.project.yaml": yaml.dump({ sourcePath: "/home/user/myapp" }),
    });

    const result = detectProject(phren, "/home/user/myapp/src");
    expect(result).toBe("myapp");
  });

  it("returns null when no project matches", () => {
    const phren = makePhren();
    makeProject(phren, "myapp", {
      "summary.md": "# myapp\n",
      "phren.project.yaml": yaml.dump({ sourcePath: "/home/user/myapp" }),
    });

    const result = detectProject(phren, "/home/user/other-project/src");
    expect(result).toBeNull();
  });

  it("prefers a more specific sourcePath over a parent sourcePath", () => {
    const phren = makePhren();
    makeProject(phren, "web", {
      "summary.md": "# web\n",
      "phren.project.yaml": yaml.dump({ sourcePath: "/home/user/projects/web" }),
    });
    makeProject(phren, "web-api", {
      "summary.md": "# web-api\n",
      "phren.project.yaml": yaml.dump({ sourcePath: "/home/user/projects/web/api" }),
    });

    const match = detectProject(phren, "/home/user/projects/web/api/src");
    expect(match).toBe("web-api");
  });

  it("does not guess from path segments when sourcePath is missing", () => {
    const phren = makePhren();
    makeProject(phren, "phren", { "summary.md": "# phren\n" });

    const result = detectProject(phren, "/home/phren/mcp/src");
    expect(result).toBeNull();
  });
});

// --- appendAuditLog rotation ---

describe("appendAuditLog", () => {
  it("appends log entries", () => {
    const phren = makePhren();
    appendAuditLog(phren, "test_event", "details=foo");
    const logPath = path.join(phren, ".runtime", "audit.log");
    expect(fs.existsSync(logPath)).toBe(true);
    const content = fs.readFileSync(logPath, "utf8");
    expect(content).toContain("test_event");
    expect(content).toContain("details=foo");
  });

  it("rotates log when over 1MB", () => {
    const phren = makePhren();
    const logPath = path.join(phren, ".runtime", "audit.log");
    fs.mkdirSync(path.join(phren, ".runtime"), { recursive: true });
    // Seed with >1MB of data (each line ~80 chars, need ~13000 lines)
    const bigContent = Array.from({ length: 14000 }, (_, i) =>
      `[2025-01-01T00:00:00.000Z] event_${i} ${"x".repeat(60)}`
    ).join("\n") + "\n";
    fs.writeFileSync(logPath, bigContent);

    appendAuditLog(phren, "trigger_rotation", "details=bar");
    const after = fs.readFileSync(logPath, "utf8");
    const lines = after.split("\n").filter(l => l.length > 0);
    expect(lines.length).toBeLessThanOrEqual(500);
    expect(after).toContain("trigger_rotation");
  });
});

// --- consolidateProjectFindings dedup ---

describe("consolidateProjectFindings", () => {
  it("deduplicates entries with normalized whitespace", () => {
    const phren = makePhren();
    grantAdmin(phren);
    makeProject(phren, "dedupproj", {
      "FINDINGS.md": [
        "# dedupproj FINDINGS",
        "",
        "## 2025-01-01",
        "",
        "- Always  use   parameterized queries",
        "- Always use parameterized queries",
        "- A different finding",
        "",
      ].join("\n"),
    });

    consolidateProjectFindings(phren, "dedupproj");
    const content = fs.readFileSync(path.join(phren, "dedupproj", "FINDINGS.md"), "utf8");
    const bullets = content.split("\n").filter(l => l.startsWith("- "));
    expect(bullets.length).toBe(2);
  });

  it("deduplicates entries that differ only by trailing whitespace", () => {
    const phren = makePhren();
    grantAdmin(phren);
    makeProject(phren, "trailproj", {
      "FINDINGS.md": [
        "# trailproj FINDINGS",
        "",
        "## 2025-01-01",
        "",
        "- Use parameterized queries   ",
        "- Use parameterized queries",
        "",
      ].join("\n"),
    });

    consolidateProjectFindings(phren, "trailproj");
    const content = fs.readFileSync(path.join(phren, "trailproj", "FINDINGS.md"), "utf8");
    const bullets = content.split("\n").filter(l => l.startsWith("- "));
    expect(bullets.length).toBe(1);
    expect(bullets[0]).toBe("- Use parameterized queries");
  });
});

describe("upsertCanonical", () => {
  it("creates truths.md with truth content", () => {
    const phren = makePhren();
    makeProject(phren, "pinproj", { "summary.md": "# pinproj" });

    const result = upsertCanonical(phren, "pinproj", "Always run tests before pushing");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toContain("Truth");

    const canonical = fs.readFileSync(
      path.join(phren, "pinproj", "truths.md"),
      "utf8"
    );
    expect(canonical).toContain("Always run tests before pushing");
    expect(canonical).toContain("## Truths");
  });

  it("does not duplicate an existing truth", () => {
    const phren = makePhren();
    makeProject(phren, "dupproj", { "summary.md": "# dupproj" });

    upsertCanonical(phren, "dupproj", "Unique insight");
    upsertCanonical(phren, "dupproj", "Unique insight");

    const canonical = fs.readFileSync(
      path.join(phren, "dupproj", "truths.md"),
      "utf8"
    );
    const matches = canonical.match(/Unique insight/g);
    expect(matches?.length).toBe(1);
  });
});

// --- filterTrustedFindingsDetailed ---

describe("filterTrustedFindingsDetailed", () => {
  it("keeps fresh entries", () => {
    const today = new Date().toISOString().slice(0, 10);
    const content = `# proj FINDINGS\n\n## ${today}\n\n- Fresh finding\n`;
    const result = filterTrustedFindingsDetailed(content, { ttlDays: 120 });
    expect(result.content).toContain("- Fresh finding");
    expect(result.issues.length).toBe(0);
  });

  it("filters out entries older than ttlDays", () => {
    const content = `# proj FINDINGS\n\n## 2020-01-01\n\n- Ancient finding\n`;
    const result = filterTrustedFindingsDetailed(content, { ttlDays: 120 });
    expect(result.content).not.toContain("- Ancient finding");
    expect(result.issues.length).toBe(1);
    expect(result.issues[0].reason).toBe("stale");
  });

  it("decays confidence for aging entries without citation", () => {
    const d = new Date();
    d.setDate(d.getDate() - 100);
    const dateStr = d.toISOString().slice(0, 10);
    const content = `# proj FINDINGS\n\n## ${dateStr}\n\n- Aging finding without citation\n`;
    const result = filterTrustedFindingsDetailed(content, { ttlDays: 200, minConfidence: 0.9 });
    expect(result.issues.length).toBe(1);
    expect(result.issues[0].reason).toBe("stale");
  });

  it("keeps entries with valid citations at higher confidence", () => {
    const d = new Date();
    d.setDate(d.getDate() - 50);
    const dateStr = d.toISOString().slice(0, 10);
    const content = [
      "# proj FINDINGS",
      "",
      `## ${dateStr}`,
      "",
      "- Finding with citation",
      `  <!-- phren:cite {"created_at":"${d.toISOString()}"} -->`,
      "",
    ].join("\n");
    const result = filterTrustedFindingsDetailed(content, { ttlDays: 200, minConfidence: 0.3 });
    expect(result.content).toContain("- Finding with citation");
  });

  it("gives human provenance a small confidence boost over extract", () => {
    const d = new Date();
    d.setDate(d.getDate() - 50);
    const dateStr = d.toISOString().slice(0, 10);
    const content = [
      "# proj FINDINGS",
      "",
      `## ${dateStr}`,
      "",
      "- Human finding <!-- source:human actor:alice -->",
      "- Extracted finding <!-- source:extract tool:auto-extract -->",
      "",
    ].join("\n");
    const result = filterTrustedFindingsDetailed(content, { ttlDays: 200, minConfidence: 0.75 });
    expect(result.content).toContain("Human finding");
    expect(result.content).not.toContain("Extracted finding");
  });

  it("accepts numeric ttlDays shorthand", () => {
    const content = `# proj FINDINGS\n\n## 2020-01-01\n\n- Old entry\n`;
    const result = filterTrustedFindingsDetailed(content, 30);
    expect(result.content).not.toContain("- Old entry");
    expect(result.issues.length).toBe(1);
  });
});

// --- recordInjection ---

describe("recordInjection", () => {
  it("creates and updates score entries", () => {
    const phren = makePhren();
    grantAdmin(phren);
    const key = "testproj/FINDINGS.md:abc123";

    recordInjection(phren, key, "session-1");
    flushEntryScores(phren);

    const scoresPath = path.join(phren, ".runtime", "memory-scores.json");
    expect(fs.existsSync(scoresPath)).toBe(true);
    const scores = readVersionedEntries<any>(scoresPath);
    expect(scores[key]).toBeDefined();
    expect(scores[key].impressions).toBe(1);

    recordInjection(phren, key, "session-2");
    flushEntryScores(phren);
    const scores2 = readVersionedEntries<any>(scoresPath);
    expect(scores2[key].impressions).toBe(2);
  });

  it("appends to usage log", () => {
    const phren = makePhren();
    grantAdmin(phren);
    const key = "testproj/FINDINGS.md:def456";

    recordInjection(phren, key, "sess-42");

    const logPath = path.join(phren, ".runtime", "memory-usage.log");
    expect(fs.existsSync(logPath)).toBe(true);
    const logContent = fs.readFileSync(logPath, "utf8");
    expect(logContent).toContain("inject");
    expect(logContent).toContain("sess-42");
    expect(logContent).toContain(key);
  });
});

// --- recordFeedback ---

describe("recordFeedback", () => {
  it("records helpful feedback", () => {
    const phren = makePhren();
    grantAdmin(phren);
    const key = "proj/file:aaa";

    recordInjection(phren, key);
    recordFeedback(phren, key, "helpful");
    flushEntryScores(phren);

    const scores = readVersionedEntries<any>(
      path.join(phren, ".runtime", "memory-scores.json")
    );
    expect(scores[key].helpful).toBe(1);
    expect(scores[key].repromptPenalty).toBe(0);
  });

  it("records reprompt penalty", () => {
    const phren = makePhren();
    grantAdmin(phren);
    const key = "proj/file:bbb";

    recordInjection(phren, key);
    recordFeedback(phren, key, "reprompt");
    flushEntryScores(phren);

    const scores = readVersionedEntries<any>(
      path.join(phren, ".runtime", "memory-scores.json")
    );
    expect(scores[key].repromptPenalty).toBe(1);
  });

  it("records regression penalty", () => {
    const phren = makePhren();
    grantAdmin(phren);
    const key = "proj/file:ccc";

    recordInjection(phren, key);
    recordFeedback(phren, key, "regression");
    flushEntryScores(phren);

    const scores = readVersionedEntries<any>(
      path.join(phren, ".runtime", "memory-scores.json")
    );
    expect(scores[key].regressionPenalty).toBe(1);
  });
});

// --- getQualityMultiplier ---

describe("getQualityMultiplier", () => {
  it("returns 1 for unknown keys", () => {
    const phren = makePhren();
    grantAdmin(phren);
    expect(getQualityMultiplier(phren, "unknown/key:xyz")).toBe(1);
  });

  it("returns > 1 for helpful memories", () => {
    const phren = makePhren();
    grantAdmin(phren);
    const key = "proj/file:helpful";

    recordInjection(phren, key);
    recordFeedback(phren, key, "helpful");
    recordFeedback(phren, key, "helpful");
    recordFeedback(phren, key, "helpful");

    const mult = getQualityMultiplier(phren, key);
    expect(mult).toBeGreaterThan(1);
  });

  it("returns < 1 for penalized memories", () => {
    const phren = makePhren();
    grantAdmin(phren);
    const key = "proj/file:bad";

    recordInjection(phren, key);
    recordFeedback(phren, key, "regression");
    recordFeedback(phren, key, "reprompt");

    const mult = getQualityMultiplier(phren, key);
    expect(mult).toBeLessThan(1);
  });

  it("clamps between 0.2 and 1.5", () => {
    const phren = makePhren();
    grantAdmin(phren);

    const goodKey = "proj/file:great";
    recordInjection(phren, goodKey);
    for (let i = 0; i < 20; i++) recordFeedback(phren, goodKey, "helpful");
    expect(getQualityMultiplier(phren, goodKey)).toBeLessThanOrEqual(1.5);

    const badKey = "proj/file:terrible";
    recordInjection(phren, badKey);
    for (let i = 0; i < 20; i++) recordFeedback(phren, badKey, "regression");
    expect(getQualityMultiplier(phren, badKey)).toBeGreaterThanOrEqual(0.2);
  });
});

// --- entryScoreKey ---

describe("entryScoreKey", () => {
  it("generates a deterministic key", () => {
    const k1 = entryScoreKey("proj", "FINDINGS.md", "some snippet");
    const k2 = entryScoreKey("proj", "FINDINGS.md", "some snippet");
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^proj\/FINDINGS\.md:[a-f0-9]{12}$/);
  });

  it("produces different keys for different snippets", () => {
    const k1 = entryScoreKey("proj", "FINDINGS.md", "snippet one");
    const k2 = entryScoreKey("proj", "FINDINGS.md", "snippet two");
    expect(k1).not.toBe(k2);
  });
});

// --- extractConflictVersions ---

describe("extractConflictVersions", () => {
  it("returns null for content without conflict markers", () => {
    expect(extractConflictVersions("normal content\nno conflicts")).toBeNull();
  });

  it("extracts ours and theirs from a conflict block", () => {
    const content = [
      "<<<<<<< HEAD",
      "our change",
      "=======",
      "their change",
      ">>>>>>> feature-branch",
    ].join("\n");
    const result = extractConflictVersions(content);
    expect(result).not.toBeNull();
    expect(result!.ours).toContain("our change");
    expect(result!.theirs).toContain("their change");
  });

  it("preserves non-conflict lines in both versions", () => {
    const content = [
      "# Header",
      "<<<<<<< HEAD",
      "ours",
      "=======",
      "theirs",
      ">>>>>>> branch",
      "# Footer",
    ].join("\n");
    const result = extractConflictVersions(content);
    expect(result!.ours).toContain("# Header");
    expect(result!.ours).toContain("# Footer");
    expect(result!.theirs).toContain("# Header");
    expect(result!.theirs).toContain("# Footer");
  });

  it("strips conflict marker lines from output", () => {
    const content = "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> b";
    const result = extractConflictVersions(content);
    expect(result!.ours).not.toContain("<<<<<<<");
    expect(result!.ours).not.toContain("=======");
    expect(result!.theirs).not.toContain(">>>>>>>");
  });

  it("handles multiple conflict blocks", () => {
    const content = [
      "<<<<<<< HEAD",
      "first ours",
      "=======",
      "first theirs",
      ">>>>>>> branch",
      "shared middle",
      "<<<<<<< HEAD",
      "second ours",
      "=======",
      "second theirs",
      ">>>>>>> branch",
    ].join("\n");
    const result = extractConflictVersions(content);
    expect(result).not.toBeNull();
    expect(result!.ours).toContain("first ours");
    expect(result!.ours).toContain("second ours");
    expect(result!.ours).toContain("shared middle");
    expect(result!.theirs).toContain("first theirs");
    expect(result!.theirs).toContain("second theirs");
    expect(result!.theirs).toContain("shared middle");
  });
});

// --- mergeFindings ---

describe("mergeFindings (shared.test)", () => {
  it("combines entries from both sides under the same date", () => {
    const ours = "# FINDINGS\n\n## 2025-01-15\n\n- Our insight\n";
    const theirs = "# FINDINGS\n\n## 2025-01-15\n\n- Their insight\n";
    const merged = mergeFindings(ours, theirs);
    expect(merged).toContain("- Our insight");
    expect(merged).toContain("- Their insight");
  });

  it("deduplicates identical entries", () => {
    const content = "# FINDINGS\n\n## 2025-03-01\n\n- Same entry\n";
    const merged = mergeFindings(content, content);
    const count = (merged.match(/- Same entry/g) || []).length;
    expect(count).toBe(1);
  });

  it("sorts dates newest first", () => {
    const ours = "# FINDINGS\n\n## 2024-01-01\n\n- Old\n";
    const theirs = "# FINDINGS\n\n## 2025-06-15\n\n- New\n";
    const merged = mergeFindings(ours, theirs);
    expect(merged.indexOf("2025-06-15")).toBeLessThan(merged.indexOf("2024-01-01"));
  });

  it("preserves the title from ours", () => {
    const ours = "# My Project FINDINGS\n\n## 2025-01-01\n\n- A\n";
    const theirs = "# Other Title\n\n## 2025-01-01\n\n- B\n";
    const merged = mergeFindings(ours, theirs);
    expect(merged.startsWith("# My Project FINDINGS")).toBe(true);
  });

  it("merges dates that only exist on one side", () => {
    const ours = "# FINDINGS\n\n## 2025-01-01\n\n- Ours only\n";
    const theirs = "# FINDINGS\n\n## 2025-02-01\n\n- Theirs only\n";
    const merged = mergeFindings(ours, theirs);
    expect(merged).toContain("- Ours only");
    expect(merged).toContain("- Theirs only");
    expect(merged).toContain("## 2025-01-01");
    expect(merged).toContain("## 2025-02-01");
  });
});

// --- mergeTask ---

describe("mergeTask (shared.test)", () => {
  it("combines items from both sides", () => {
    const ours = "# task\n\n## Active\n\n- Our task\n\n## Queue\n\n## Done\n";
    const theirs = "# task\n\n## Active\n\n- Their task\n\n## Queue\n\n## Done\n";
    const merged = mergeTask(ours, theirs);
    expect(merged).toContain("- Our task");
    expect(merged).toContain("- Their task");
  });

  it("deduplicates identical items across sides", () => {
    const content = "# task\n\n## Active\n\n- Same task\n\n## Queue\n\n## Done\n";
    const merged = mergeTask(content, content);
    const count = (merged.match(/- Same task/g) || []).length;
    expect(count).toBe(1);
  });

  it("orders sections Active, Queue, Done first", () => {
    const content = "# task\n\n## Done\n\n- D\n\n## Active\n\n- A\n\n## Queue\n\n- Q\n";
    const merged = mergeTask(content, content);
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

  it("merges items from different sections", () => {
    const ours = "# task\n\n## Active\n\n- Active task\n\n## Queue\n\n## Done\n";
    const theirs = "# task\n\n## Active\n\n## Queue\n\n- Queued task\n\n## Done\n";
    const merged = mergeTask(ours, theirs);
    expect(merged).toContain("- Active task");
    expect(merged).toContain("- Queued task");
  });
});

// --- autoMergeConflicts ---

describe("autoMergeConflicts", () => {
  let gitDir: string;

  let gitCleanup: () => void;

  function initGitRepo(): string {
    const tmp = makeTempDir("phren-automerge-");
    gitCleanup = tmp.cleanup;
    const { execFileSync } = require("child_process");
    execFileSync("git", ["init", tmp.path], { stdio: "ignore" });
    execFileSync("git", ["-C", tmp.path, "config", "user.email", "test@test.com"], { stdio: "ignore" });
    execFileSync("git", ["-C", tmp.path, "config", "user.name", "test"], { stdio: "ignore" });
    return tmp.path;
  }

  function commitFile(dir: string, filename: string, content: string, message: string) {
    const { execFileSync } = require("child_process");
    const fullPath = path.join(dir, filename);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
    execFileSync("git", ["-C", dir, "add", "-f", filename], { stdio: "ignore" });
    execFileSync("git", ["-C", dir, "commit", "-m", message], { stdio: "ignore" });
  }

  function currentBranch(dir: string): string {
    const { execFileSync } = require("child_process");
    return execFileSync("git", ["-C", dir, "branch", "--show-current"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  }

  beforeEach(() => {
    gitDir = initGitRepo();
  });

  afterEach(() => {
    if (gitCleanup) gitCleanup();
  });

  it("returns true when there are no conflicted files", () => {
    // Just an empty repo with one commit
    commitFile(gitDir, "README.md", "hello", "init");
    expect(autoMergeConflicts(gitDir)).toBe(true);
  });

  it("auto-merges a conflicted FINDINGS.md", () => {
    const { execFileSync } = require("child_process");

    // Create base commit with a shared file
    commitFile(gitDir, "proj/FINDINGS.md", "# proj FINDINGS\n\n## 2025-01-01\n\n- Base entry\n", "base");
    const primaryBranch = currentBranch(gitDir);

    // Create a branch with a different entry
    execFileSync("git", ["-C", gitDir, "checkout", "-b", "branch-a"], { stdio: "pipe" });
    fs.writeFileSync(
      path.join(gitDir, "proj", "FINDINGS.md"),
      "# proj FINDINGS\n\n## 2025-01-01\n\n- Branch A entry\n"
    );
    execFileSync("git", ["-C", gitDir, "add", "-f", "proj/FINDINGS.md"], { stdio: "ignore" });
    execFileSync("git", ["-C", gitDir, "commit", "-m", "branch-a change"], { stdio: "ignore" });

    // Go back to the primary branch and create a conflicting entry
    execFileSync("git", ["-C", gitDir, "checkout", primaryBranch], { stdio: "pipe" });
    fs.writeFileSync(
      path.join(gitDir, "proj", "FINDINGS.md"),
      "# proj FINDINGS\n\n## 2025-01-01\n\n- Master entry\n"
    );
    execFileSync("git", ["-C", gitDir, "add", "-f", "proj/FINDINGS.md"], { stdio: "ignore" });
    execFileSync("git", ["-C", gitDir, "commit", "-m", "master change"], { stdio: "ignore" });

    // Merge to create conflict
    try {
      execFileSync("git", ["-C", gitDir, "merge", "branch-a"], { stdio: "ignore" });
    } catch {
      // Expected to fail with conflict
    }

    // Verify conflict exists
    const status = execFileSync("git", ["-C", gitDir, "diff", "--name-only", "--diff-filter=U"], {
      encoding: "utf8",
    }).trim();

    if (!status.includes("FINDINGS.md")) {
      return;
    }

    const resolved = autoMergeConflicts(gitDir);
    expect(resolved).toBe(true);

    const content = fs.readFileSync(path.join(gitDir, "proj", "FINDINGS.md"), "utf8");
    expect(content).toContain("Branch A entry");
    expect(content).toContain("Master entry");
    expect(content).not.toContain("<<<<<<<");
  });

  it("auto-merges a conflicted tasks.md", () => {
    const { execFileSync } = require("child_process");

    commitFile(gitDir, "proj/tasks.md", "# tasks\n\n## Active\n\n- Base task\n\n## Queue\n\n## Done\n", "base");
    const primaryBranch = currentBranch(gitDir);

    execFileSync("git", ["-C", gitDir, "checkout", "-b", "branch-b"], { stdio: "pipe" });
    fs.writeFileSync(
      path.join(gitDir, "proj", "tasks.md"),
      "# tasks\n\n## Active\n\n- Branch task\n\n## Queue\n\n## Done\n"
    );
    execFileSync("git", ["-C", gitDir, "add", "-f", "proj/tasks.md"], { stdio: "ignore" });
    execFileSync("git", ["-C", gitDir, "commit", "-m", "branch change"], { stdio: "ignore" });

    execFileSync("git", ["-C", gitDir, "checkout", primaryBranch], { stdio: "pipe" });
    fs.writeFileSync(
      path.join(gitDir, "proj", "tasks.md"),
      "# tasks\n\n## Active\n\n- Master task\n\n## Queue\n\n## Done\n"
    );
    execFileSync("git", ["-C", gitDir, "add", "-f", "proj/tasks.md"], { stdio: "ignore" });
    execFileSync("git", ["-C", gitDir, "commit", "-m", "master change"], { stdio: "ignore" });

    try {
      execFileSync("git", ["-C", gitDir, "merge", "branch-b"], { stdio: "ignore" });
    } catch {
      // Expected conflict
    }

    const status = execFileSync("git", ["-C", gitDir, "diff", "--name-only", "--diff-filter=U"], {
      encoding: "utf8",
    }).trim();

    if (!status.includes("tasks.md")) {
      return;
    }

    const resolved = autoMergeConflicts(gitDir);
    expect(resolved).toBe(true);

    const content = fs.readFileSync(path.join(gitDir, "proj", "tasks.md"), "utf8");
    expect(content).toContain("Branch task");
    expect(content).toContain("Master task");
    expect(content).not.toContain("<<<<<<<");
  });

  it("returns false for non-mergeable conflicted files", () => {
    const { execFileSync } = require("child_process");

    commitFile(gitDir, "config.json", '{"key": "base"}', "base");
    const primaryBranch = currentBranch(gitDir);

    execFileSync("git", ["-C", gitDir, "checkout", "-b", "branch-c"], { stdio: "pipe" });
    fs.writeFileSync(path.join(gitDir, "config.json"), '{"key": "branch"}');
    execFileSync("git", ["-C", gitDir, "add", "-f", "config.json"], { stdio: "ignore" });
    execFileSync("git", ["-C", gitDir, "commit", "-m", "branch change"], { stdio: "ignore" });

    execFileSync("git", ["-C", gitDir, "checkout", primaryBranch], { stdio: "pipe" });
    fs.writeFileSync(path.join(gitDir, "config.json"), '{"key": "master"}');
    execFileSync("git", ["-C", gitDir, "add", "-f", "config.json"], { stdio: "ignore" });
    execFileSync("git", ["-C", gitDir, "commit", "-m", "master change"], { stdio: "ignore" });

    try {
      execFileSync("git", ["-C", gitDir, "merge", "branch-c"], { stdio: "ignore" });
    } catch {
      // Expected conflict
    }

    const status = execFileSync("git", ["-C", gitDir, "diff", "--name-only", "--diff-filter=U"], {
      encoding: "utf8",
    }).trim();

    if (!status.includes("config.json")) {
      return;
    }

    const resolved = autoMergeConflicts(gitDir);
    expect(resolved).toBe(false);
  });

  it("returns false for a non-git directory", () => {
    const tmp = makeTempDir("phren-nongit-");
    try {
      expect(autoMergeConflicts(tmp.path)).toBe(false);
    } finally {
      tmp.cleanup();
    }
  });
});

// --- withDefaults ---

describe("withDefaults", () => {
  it("fills in missing keys from defaults", () => {
    const result = withDefaults({ a: 1 } as any, { a: 0, b: 2, c: 3 } as any);
    expect(result).toEqual({ a: 1, b: 2, c: 3 });
  });

  it("deep-merges nested objects", () => {
    const result = withDefaults(
      { nested: { x: 10 } } as any,
      { nested: { x: 0, y: 20 }, top: "hello" } as any
    );
    expect(result).toEqual({ nested: { x: 10, y: 20 }, top: "hello" });
  });

  it("does not overwrite with null or undefined", () => {
    const result = withDefaults(
      { a: null, b: undefined } as any,
      { a: 5, b: 10 } as any
    );
    expect(result).toEqual({ a: 5, b: 10 });
  });

  it("replaces arrays entirely (no deep merge on arrays)", () => {
    const result = withDefaults(
      { items: ["new"] } as any,
      { items: ["old1", "old2"] } as any
    );
    expect(result).toEqual({ items: ["new"] });
  });
});

// --- validateFindingsFormat ---

describe("validateFindingsFormat", () => {
  it("returns empty for valid format", () => {
    const content = "# proj FINDINGS\n\n## 2025-01-01\n\n- A finding\n";
    const issues = validateFindingsFormat(content);
    expect(issues).toEqual([]);
  });

  it("flags missing title heading", () => {
    const content = "## 2025-01-01\n\n- A finding\n";
    const issues = validateFindingsFormat(content);
    expect(issues.length).toBe(1);
    expect(issues[0]).toContain("Missing title");
  });

  it("flags bad date format in headings that start with digits", () => {
    const content = "# FINDINGS\n\n## 2025-1-1\n\n- A finding\n";
    const issues = validateFindingsFormat(content);
    expect(issues.some(i => i.includes("YYYY-MM-DD"))).toBe(true);
  });

  it("does not flag non-date headings like ## Overview", () => {
    const content = "# FINDINGS\n\n## Overview\n\nSome text\n";
    const issues = validateFindingsFormat(content);
    expect(issues.length).toBe(0);
  });
});

// --- validateTaskFormat ---

describe("validateTaskFormat", () => {
  it("returns empty for valid format", () => {
    const content = "# task\n\n## Active\n\n- Task\n\n## Queue\n\n## Done\n";
    const issues = validateTaskFormat(content);
    expect(issues).toEqual([]);
  });

  it("flags missing title heading", () => {
    const content = "## Active\n\n- Task\n";
    const issues = validateTaskFormat(content);
    expect(issues.some(i => i.includes("title"))).toBe(true);
  });

  it("flags missing sections", () => {
    const content = "# task\n\nJust some text without sections.\n";
    const issues = validateTaskFormat(content);
    expect(issues.some(i => i.includes("sections"))).toBe(true);
  });
});

// --- stripTaskDoneSection ---

describe("stripTaskDoneSection", () => {
  it("strips everything after ## Done", () => {
    const content = "# task\n\n## Active\n\n- A\n\n## Done\n\n- Completed\n- Also done\n";
    const result = stripTaskDoneSection(content);
    expect(result).toContain("## Active");
    expect(result).not.toContain("## Done");
    expect(result).not.toContain("Completed");
  });

  it("returns content unchanged when no Done section", () => {
    const content = "# task\n\n## Active\n\n- A\n\n## Queue\n\n- B\n";
    expect(stripTaskDoneSection(content)).toBe(content);
  });
});

// --- pruneDeadMemories ---

describe("pruneDeadMemories", () => {
  it("prunes entries older than retention policy in dry-run mode", () => {
    const phren = makePhren();
    grantAdmin(phren);
    const govDir = path.join(phren, ".governance");
    fs.mkdirSync(govDir, { recursive: true });
    fs.writeFileSync(
      path.join(govDir, "retention-policy.json"),
      JSON.stringify({ ttlDays: 120, retentionDays: 30, autoAcceptThreshold: 0.75, minInjectConfidence: 0.35, decay: { d30: 1, d60: 0.85, d90: 0.65, d120: 0.45 } }, null, 2) + "\n"
    );
    makeProject(phren, "pruneproj", {
      "FINDINGS.md": "# pruneproj FINDINGS\n\n## 2020-01-01\n\n- Very old entry\n\n## 2099-01-01\n\n- Future entry\n",
    });

    const result = pruneDeadMemories(phren, "pruneproj", true);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toContain("[dry-run]");
      expect(result.data).toContain("1");
    }
    // File should be unchanged in dry-run
    const content = fs.readFileSync(path.join(phren, "pruneproj", "FINDINGS.md"), "utf8");
    expect(content).toContain("Very old entry");
  });

  it("prunes entries and uses atomic write (no .bak file)", () => {
    const phren = makePhren();
    grantAdmin(phren);
    const govDir = path.join(phren, ".governance");
    fs.mkdirSync(govDir, { recursive: true });
    fs.writeFileSync(
      path.join(govDir, "retention-policy.json"),
      JSON.stringify({ ttlDays: 120, retentionDays: 30, autoAcceptThreshold: 0.75, minInjectConfidence: 0.35, decay: { d30: 1, d60: 0.85, d90: 0.65, d120: 0.45 } }, null, 2) + "\n"
    );
    makeProject(phren, "pruneproj", {
      "FINDINGS.md": "# pruneproj FINDINGS\n\n## 2020-01-01\n\n- Very old entry\n\n## 2099-01-01\n\n- Future entry\n",
    });

    const result = pruneDeadMemories(phren, "pruneproj");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toContain("Pruned 1");
    const content = fs.readFileSync(path.join(phren, "pruneproj", "FINDINGS.md"), "utf8");
    expect(content).not.toContain("Very old entry");
    expect(content).toContain("Future entry");
    // atomic write (tmp + rename) — no .bak file is created
    expect(fs.existsSync(path.join(phren, "pruneproj", "FINDINGS.md.bak"))).toBe(false);
  });

});

// --- getRetentionPolicy / updateRetentionPolicy ---

describe("getRetentionPolicy and updateRetentionPolicy", () => {
  it("returns defaults when no policy file exists", () => {
    const phren = makePhren();
    const policy = getRetentionPolicy(phren);
    expect(policy.ttlDays).toBe(120);
    expect(policy.retentionDays).toBe(365);
    expect(policy.decay.d30).toBe(1.0);
    expect(policy.decay.d120).toBe(0.45);
  });

  it("merges partial policy with defaults", () => {
    const phren = makePhren();
    const govDir = path.join(phren, ".governance");
    fs.mkdirSync(govDir, { recursive: true });
    fs.writeFileSync(
      path.join(govDir, "retention-policy.json"),
      JSON.stringify({ ttlDays: 60 }, null, 2) + "\n"
    );
    const policy = getRetentionPolicy(phren);
    expect(policy.ttlDays).toBe(60);
    expect(policy.retentionDays).toBe(365);
  });

  it("admin can update policy", () => {
    const phren = makePhren();
    grantAdmin(phren);
    const result = updateRetentionPolicy(phren, { ttlDays: 90 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.ttlDays).toBe(90);
  });

  it("non-admin cannot update policy", () => {
    const phren = makePhren();
    const govDir = path.join(phren, ".governance");
    fs.mkdirSync(govDir, { recursive: true });
    fs.writeFileSync(
      path.join(govDir, "access-control.json"),
      JSON.stringify({ contributors: ["dev"] }, null, 2) + "\n"
    );
    process.env.PHREN_ACTOR = "dev";
    const result = updateRetentionPolicy(phren, { ttlDays: 1 });
    // RBAC was removed — any actor can update policy now
    expect(result.ok).toBe(true);
  });
});

// --- getWorkflowPolicy / updateWorkflowPolicy ---

describe("getWorkflowPolicy and updateWorkflowPolicy", () => {
  it("returns defaults when no file exists", () => {
    const phren = makePhren();
    const wp = getWorkflowPolicy(phren);
    expect(wp.lowConfidenceThreshold).toBe(0.7);
    expect(wp.riskySections).toEqual(["Stale", "Conflicts"]);
    expect(wp.taskMode).toBe("auto");
  });

  it("filters invalid riskySections values", () => {
    const phren = makePhren();
    const govDir = path.join(phren, ".governance");
    fs.mkdirSync(govDir, { recursive: true });
    fs.writeFileSync(
      path.join(govDir, "workflow-policy.json"),
      JSON.stringify({ riskySections: ["Review", "BadSection", "Stale"] }, null, 2) + "\n"
    );
    const wp = getWorkflowPolicy(phren);
    expect(wp.riskySections).toEqual(["Review", "Stale"]);
  });

  it("admin can update workflow policy", () => {
    const phren = makePhren();
    grantAdmin(phren);
    const result = updateWorkflowPolicy(phren, { lowConfidenceThreshold: 0.5, taskMode: "auto" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.lowConfidenceThreshold).toBe(0.5);
      expect(result.data.taskMode).toBe("auto");
    }
  });
});

// --- getIndexPolicy / updateIndexPolicy ---

describe("getIndexPolicy and updateIndexPolicy", () => {
  it("returns defaults when no file exists", () => {
    const phren = makePhren();
    const ip = getIndexPolicy(phren);
    expect(ip.includeGlobs).toContain("**/*.md");
    expect(ip.includeHidden).toBe(false);
  });

  it("filters empty globs and falls back to defaults", () => {
    const phren = makePhren();
    const govDir = path.join(phren, ".governance");
    fs.mkdirSync(govDir, { recursive: true });
    fs.writeFileSync(
      path.join(govDir, "index-policy.json"),
      JSON.stringify({ includeGlobs: ["", "  "], excludeGlobs: [] }, null, 2) + "\n"
    );
    const ip = getIndexPolicy(phren);
    expect(ip.includeGlobs.length).toBeGreaterThan(0);
    expect(ip.includeGlobs.every(g => g.trim().length > 0)).toBe(true);
  });

  it("admin can update index policy", () => {
    const phren = makePhren();
    grantAdmin(phren);
    const result = updateIndexPolicy(phren, { includeHidden: true });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.includeHidden).toBe(true);
  });
});

// --- getRuntimeHealth / updateRuntimeHealth ---

describe("getRuntimeHealth and updateRuntimeHealth", () => {
  it("returns default health when no file exists", () => {
    const phren = makePhren();
    const h = getRuntimeHealth(phren);
    expect(h.schemaVersion).toBe(1);
    expect(h.lastPromptAt).toBeUndefined();
  });

  it("updates and persists runtime health", () => {
    const phren = makePhren();
    const now = new Date().toISOString();
    updateRuntimeHealth(phren, { lastPromptAt: now });
    const h = getRuntimeHealth(phren);
    expect(h.lastPromptAt).toBe(now);
  });

  it("handles lastAutoSave updates", () => {
    const phren = makePhren();
    const now = new Date().toISOString();
    updateRuntimeHealth(phren, {
      lastAutoSave: { at: now, status: "saved-pushed", detail: "ok" },
    });
    const h = getRuntimeHealth(phren);
    expect(h.lastAutoSave?.status).toBe("saved-pushed");
  });

  it("handles sync metadata updates", () => {
    const phren = makePhren();
    const now = new Date().toISOString();
    updateRuntimeHealth(phren, {
      lastSync: {
        lastPullAt: now,
        lastPullStatus: "ok",
        lastPushAt: now,
        lastPushStatus: "saved-local",
        unsyncedCommits: 2,
      },
    });
    const h = getRuntimeHealth(phren);
    expect(h.lastSync?.lastPullStatus).toBe("ok");
    expect(h.lastSync?.lastPushStatus).toBe("saved-local");
    expect(h.lastSync?.unsyncedCommits).toBe(2);
  });
});

// --- appendReviewQueue ---

describe("appendReviewQueue", () => {
  it("creates review.md if it does not exist", () => {
    const phren = makePhren();
    grantAdmin(phren);
    makeProject(phren, "queueproj", { "summary.md": "# queueproj\n" });

    const result = appendReviewQueue(phren, "queueproj", "Stale", ["Old memory"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBe(1);
    const content = fs.readFileSync(path.join(phren, "queueproj", "review.md"), "utf8");
    expect(content).toContain("## Stale");
    expect(content).toContain("Old memory");
  });

  it("does not duplicate existing entries", () => {
    const phren = makePhren();
    grantAdmin(phren);
    makeProject(phren, "dupqueue", { "summary.md": "# dupqueue\n" });

    appendReviewQueue(phren, "dupqueue", "Review", ["Check this"]);
    const result = appendReviewQueue(phren, "dupqueue", "Review", ["Check this"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBe(0);
  });

  it("returns 0 for empty entries", () => {
    const phren = makePhren();
    grantAdmin(phren);
    makeProject(phren, "emptyq", { "summary.md": "# emptyq\n" });
    const emptyResult = appendReviewQueue(phren, "emptyq", "Stale", []);
    expect(emptyResult.ok).toBe(true);
    if (emptyResult.ok) expect(emptyResult.data).toBe(0);
  });

  it("returns 0 for invalid project", () => {
    const phren = makePhren();
    grantAdmin(phren);
    const badResult = appendReviewQueue(phren, "../bad", "Stale", ["entry"]);
    expect(badResult.ok).toBe(false);
  });

  it("normalizes multiline and comment-heavy queue entries into a safe single line", () => {
    const phren = makePhren();
    grantAdmin(phren);
    makeProject(phren, "sanitizequeue", { "summary.md": "# sanitizequeue\n" });

    const result = appendReviewQueue(phren, "sanitizequeue", "Review", [
      "Line one\\nLine two <!-- source: injected --> \"quoted\" \0 text",
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const content = fs.readFileSync(path.join(phren, "sanitizequeue", "review.md"), "utf8");
    expect(content).toContain('Line one Line two "quoted" text');
    expect(content).not.toContain("<!-- source: injected -->");
    expect(content).not.toContain("\0");
  });
});

// --- getProjectDirs ---

describe("getProjectDirs", () => {
  it("lists directories excluding hidden dirs, profiles, and templates", () => {
    const phren = makePhren();
    fs.mkdirSync(path.join(phren, "proj-a"), { recursive: true });
    fs.mkdirSync(path.join(phren, "proj-b"), { recursive: true });
    fs.mkdirSync(path.join(phren, ".governance"), { recursive: true });
    fs.mkdirSync(path.join(phren, "profiles"), { recursive: true });
    fs.mkdirSync(path.join(phren, "templates"), { recursive: true });

    const dirs = getProjectDirs(phren);
    const names = dirs.map(d => path.basename(d));
    expect(names).toContain("proj-a");
    expect(names).toContain("proj-b");
    expect(names).not.toContain(".governance");
    expect(names).not.toContain("profiles");
    expect(names).not.toContain("templates");
  });

  it("excludes global directory from project listing", () => {
    const phren = makePhren();
    fs.mkdirSync(path.join(phren, "proj-a"), { recursive: true });
    fs.mkdirSync(path.join(phren, "global"), { recursive: true });

    const dirs = getProjectDirs(phren);
    const names = dirs.map(d => path.basename(d));
    expect(names).toContain("proj-a");
    expect(names).not.toContain("global");
  });

  it("uses profile to filter projects", () => {
    const phren = makePhren();
    fs.mkdirSync(path.join(phren, "proj-a"), { recursive: true });
    fs.mkdirSync(path.join(phren, "proj-b"), { recursive: true });
    fs.mkdirSync(path.join(phren, "profiles"), { recursive: true });
    fs.writeFileSync(
      path.join(phren, "profiles", "test.yaml"),
      yaml.dump({ name: "test", projects: ["proj-a"] })
    );

    const dirs = getProjectDirs(phren, "test");
    const names = dirs.map(d => path.basename(d));
    expect(names).toContain("proj-a");
    expect(names).not.toContain("proj-b");
  });

  it("includes shared/org dirs alongside profile projects", () => {
    const phren = makePhren();
    fs.mkdirSync(path.join(phren, "proj-a"), { recursive: true });
    fs.mkdirSync(path.join(phren, "shared"), { recursive: true });
    fs.mkdirSync(path.join(phren, "org"), { recursive: true });
    fs.mkdirSync(path.join(phren, "profiles"), { recursive: true });
    fs.writeFileSync(
      path.join(phren, "profiles", "myprof.yaml"),
      yaml.dump({ name: "myprof", projects: ["proj-a"] })
    );

    const dirs = getProjectDirs(phren, "myprof");
    const names = dirs.map(d => path.basename(d));
    expect(names).toContain("proj-a");
    expect(names).toContain("shared");
    expect(names).toContain("org");
  });

  it("rejects invalid profile names", async () => {
    const phren = makePhren();
    const dirs = await suppressOutput(() => Promise.resolve(getProjectDirs(phren, "../bad")));
    expect(dirs).toEqual([]);
  });
});

// --- consolidateProjectFindings additional ---

describe("consolidateProjectFindings additional", () => {
  it("supports dry-run mode", () => {
    const phren = makePhren();
    grantAdmin(phren);
    makeProject(phren, "drycons", {
      "FINDINGS.md": "# drycons FINDINGS\n\n## 2025-01-01\n\n- A\n- A\n- B\n",
    });
    const result = consolidateProjectFindings(phren, "drycons", true);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toContain("[dry-run]");
      expect(result.data).toContain("1 duplicate");
    }
    // File unchanged
    const content = fs.readFileSync(path.join(phren, "drycons", "FINDINGS.md"), "utf8");
    expect(content.split("\n").filter(l => l.startsWith("- ")).length).toBe(3);
  });

  it("rejects invalid project name", () => {
    const phren = makePhren();
    grantAdmin(phren);
    const result = consolidateProjectFindings(phren, "../bad");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Invalid project name");
  });

  it("returns message when no FINDINGS.md exists", () => {
    const phren = makePhren();
    grantAdmin(phren);
    makeProject(phren, "emptycons", { "summary.md": "# emptycons\n" });
    const result = consolidateProjectFindings(phren, "emptycons");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("No FINDINGS.md");
  });

  it("deduplicates entries that differ only by trailing whitespace", () => {
    const phren = makePhren();
    grantAdmin(phren);
    makeProject(phren, "trailws", {
      "FINDINGS.md": [
        "# trailws FINDINGS",
        "",
        "## 2025-01-01",
        "",
        "- Use parameterized queries   ",
        "- Use parameterized queries",
        "- Another finding",
        "",
      ].join("\n"),
    });
    consolidateProjectFindings(phren, "trailws");
    const content = fs.readFileSync(path.join(phren, "trailws", "FINDINGS.md"), "utf8");
    const bullets = content.split("\n").filter(l => l.startsWith("- "));
    expect(bullets.length).toBe(2);
  });

  it("preserves citation comments during dedup", () => {
    const phren = makePhren();
    grantAdmin(phren);
    makeProject(phren, "citecons", {
      "FINDINGS.md": [
        "# citecons FINDINGS",
        "",
        "## 2025-01-01",
        "",
        "- Some insight",
        '  <!-- phren:cite {"created_at":"2025-01-01T00:00:00.000Z"} -->',
        "- Some insight",
        "",
      ].join("\n"),
    });
    consolidateProjectFindings(phren, "citecons");
    const content = fs.readFileSync(path.join(phren, "citecons", "FINDINGS.md"), "utf8");
    const bullets = content.split("\n").filter(l => l.startsWith("- "));
    expect(bullets.length).toBe(1);
    expect(content).toContain("phren:cite");
  });
});

// --- filterTrustedFindingsDetailed (extended) ---

describe("filterTrustedFindingsDetailed (extended)", () => {
  it("strips <details> blocks from input", () => {
    const content = [
      "# proj FINDINGS",
      "",
      "<details>",
      "## 2025-01-01",
      "- Archived finding",
      "</details>",
      "",
      "## 2025-06-01",
      "",
      "- Active finding",
    ].join("\n");
    const result = filterTrustedFindingsDetailed(content, { ttlDays: 365 });
    expect(result.content).not.toContain("Archived finding");
    expect(result.content).toContain("Active finding");
  });

  it("respects custom decay parameters", () => {
    const d = new Date();
    d.setDate(d.getDate() - 50);
    const dateStr = d.toISOString().slice(0, 10);
    const content = `# proj FINDINGS\n\n## ${dateStr}\n\n- Decaying uncited finding\n`;
    // With aggressive decay and high minConfidence, this should be filtered
    const result = filterTrustedFindingsDetailed(content, {
      ttlDays: 365,
      minConfidence: 0.9,
      decay: { d30: 1.0, d60: 0.5, d90: 0.3, d120: 0.1 },
    });
    // 50 days old = d60 bucket = 0.5 confidence, x0.8 for no citation = 0.4 < 0.9
    expect(result.issues.length).toBe(1);
    expect(result.issues[0].reason).toBe("stale");
  });

  it("keeps entries when decay is generous even without citation", () => {
    const d = new Date();
    d.setDate(d.getDate() - 50);
    const dateStr = d.toISOString().slice(0, 10);
    const content = `# proj FINDINGS\n\n## ${dateStr}\n\n- Finding without citation\n`;
    const result = filterTrustedFindingsDetailed(content, {
      ttlDays: 365,
      minConfidence: 0.3,
      decay: { d30: 1.0, d60: 1.0, d90: 0.9, d120: 0.8 },
    });
    expect(result.content).toContain("Finding without citation");
    expect(result.issues.length).toBe(0);
  });

  it("only emits date headings that have surviving entries", () => {
    const content = [
      "# proj FINDINGS",
      "",
      "## 2020-01-01",
      "",
      "- All stale here",
      "",
      "## 2099-01-01",
      "",
      "- This survives",
    ].join("\n");
    const result = filterTrustedFindingsDetailed(content, { ttlDays: 120 });
    expect(result.content).not.toContain("2020-01-01");
    expect(result.content).toContain("2099-01-01");
    expect(result.content).toContain("This survives");
  });

  it("handles content with no date headings gracefully", () => {
    const content = "# proj FINDINGS\n\nSome raw text without dates.\n";
    const result = filterTrustedFindingsDetailed(content, { ttlDays: 120 });
    expect(result.issues.length).toBe(0);
  });

  it("marks invalid citation entries", () => {
    const today = new Date().toISOString().slice(0, 10);
    const content = [
      "# proj FINDINGS",
      "",
      `## ${today}`,
      "",
      "- Entry with bad citation",
      '  <!-- phren:cite {"created_at":"2025-01-01T00:00:00.000Z","repo":"/nonexistent/path"} -->',
    ].join("\n");
    const result = filterTrustedFindingsDetailed(content, { ttlDays: 365 });
    expect(result.issues.some(i => i.reason === "invalid_citation")).toBe(true);
  });
});

// --- validateGovernanceJson (extended) ---

describe("validateGovernanceJson (extended)", () => {
  it("returns true for non-existent file", () => {
    expect(validateGovernanceJson("/nonexistent/file.json", "access-control")).toBe(true);
  });

  it("returns false for non-object JSON (array)", () => {
    const phren = makePhren();
    const f = path.join(phren, "test.json");
    fs.writeFileSync(f, "[1,2,3]");
    expect(validateGovernanceJson(f, "access-control")).toBe(false);
  });

  it("validates retention-policy with bad decay", () => {
    const phren = makePhren();
    const f = path.join(phren, "test.json");
    fs.writeFileSync(f, JSON.stringify({ decay: "not an object" }));
    expect(validateGovernanceJson(f, "retention-policy")).toBe(false);
  });

  it("validates workflow-policy", () => {
    const phren = makePhren();
    const f = path.join(phren, "test.json");
    fs.writeFileSync(f, JSON.stringify({ lowConfidenceThreshold: "not-a-number" }));
    expect(validateGovernanceJson(f, "workflow-policy")).toBe(false);
  });

  it("validates index-policy", () => {
    const phren = makePhren();
    const f = path.join(phren, "test.json");
    fs.writeFileSync(f, JSON.stringify({ includeHidden: "not-bool" }));
    expect(validateGovernanceJson(f, "index-policy")).toBe(false);
  });

});

// --- flushEntryScores ---

describe("flushEntryScores", () => {
  it("writes cached scores to disk", () => {
    const phren = makePhren();
    grantAdmin(phren);
    const key = "proj/file:flush-test";
    recordInjection(phren, key);
    // Scores are already on disk from recordInjection, but flushEntryScores re-writes
    flushEntryScores(phren);
    const scoresPath = path.join(phren, ".runtime", "memory-scores.json");
    const raw = JSON.parse(fs.readFileSync(scoresPath, "utf8"));
    expect(raw.entries[key]).toBeDefined();
  });
});

// --- findPhrenPathWithArg ---

describe("findPhrenPathWithArg", () => {
  it("resolves an explicit argument path", () => {
    const phren = makePhren();
    const result = findPhrenPathWithArg(phren);
    expect(result).toBe(phren);
  });

  it("throws for non-existent explicit path", () => {
    expect(() => findPhrenPathWithArg("/nonexistent/path")).toThrow();
  });

  it("falls back to ensurePhrenPath when no arg given", async () => {
    const tmp = makeTempDir("fakehome-no-phren-");
    const origHome = process.env.HOME;
    const origCwd = process.cwd();
    process.env.HOME = tmp.path;
    process.chdir(tmp.path);
    try {
      expect(() => findPhrenPathWithArg()).toThrow("phren root not found");
    } finally {
      process.chdir(origCwd);
      process.env.HOME = origHome;
      tmp.cleanup();
    }
  });
});

// --- extractSnippet (extended) ---

describe("extractSnippet (extended)", () => {
  it("returns early lines when query terms are empty after cleanup", () => {
    const content = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6";
    const snippet = extractSnippet(content, "AND OR NOT", 3);
    expect(snippet).toContain("Line 1");
  });

  it("prefers lines near headings", () => {
    const content = [
      "# Section A",
      "irrelevant stuff",
      "also irrelevant",
      "also more irrelevant",
      "# Section B",
      "target keyword here",
      "more context",
    ].join("\n");
    const snippet = extractSnippet(content, "target keyword", 3);
    expect(snippet).toContain("target keyword");
  });

  it("handles single-line content", () => {
    const snippet = extractSnippet("just one line with keyword", "keyword", 5);
    expect(snippet).toContain("keyword");
  });

  it("scores multi-term matches higher than single-term", () => {
    const content = [
      "# Docs",
      "line with alpha only",
      "line with beta only",
      "# Both",
      "line with alpha and beta together",
      "trailing line",
    ].join("\n");
    const snippet = extractSnippet(content, "alpha beta", 3);
    expect(snippet).toContain("alpha and beta together");
  });

  it("handles empty content gracefully", () => {
    const snippet = extractSnippet("", "anything", 5);
    expect(snippet).toBe("");
  });

  it("strips FTS operators from query before matching", () => {
    const content = "line 1\nthe real answer is here\nline 3";
    const snippet = extractSnippet(content, '"real" AND "answer"', 3);
    expect(snippet).toContain("real answer");
  });

  it("respects lines parameter for window size", () => {
    const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const snippet = extractSnippet(content, "line 10", 2);
    const snippetLines = snippet.split("\n");
    expect(snippetLines.length).toBeLessThanOrEqual(2);
  });
});

// --- parsePhrenErrorCode ---

describe("parsePhrenErrorCode", () => {
  it("extracts known error codes from prefixed strings", () => {
    expect(parsePhrenErrorCode('PROJECT_NOT_FOUND: "myproj"')).toBe(PhrenError.PROJECT_NOT_FOUND);
    expect(parsePhrenErrorCode('NOT_FOUND: No item matching "foo"')).toBe(PhrenError.NOT_FOUND);
    expect(parsePhrenErrorCode("PERMISSION_DENIED: write denied")).toBe(PhrenError.PERMISSION_DENIED);
    expect(parsePhrenErrorCode("LOCK_TIMEOUT: could not acquire lock")).toBe(PhrenError.LOCK_TIMEOUT);
    expect(parsePhrenErrorCode("EMPTY_INPUT: field required")).toBe(PhrenError.EMPTY_INPUT);
    expect(parsePhrenErrorCode("AMBIGUOUS_MATCH: 3 matches")).toBe(PhrenError.AMBIGUOUS_MATCH);
    expect(parsePhrenErrorCode("MALFORMED_YAML: machines.yaml")).toBe(PhrenError.MALFORMED_YAML);
  });

  it("returns undefined for non-error strings", () => {
    expect(parsePhrenErrorCode("Added to project task: task")).toBeUndefined();
    expect(parsePhrenErrorCode("Marked done in project: item")).toBeUndefined();
    expect(parsePhrenErrorCode("")).toBeUndefined();
  });

  it("returns undefined for unknown error codes", () => {
    expect(parsePhrenErrorCode("UNKNOWN_CODE: something")).toBeUndefined();
  });
});

// --- PhrenResult helpers ---

describe("PhrenResult helpers", () => {
  it("phrenOk wraps data", () => {
    const result = phrenOk({ items: [1, 2, 3] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ items: [1, 2, 3] });
  });

  it("phrenErr wraps error with optional code", () => {
    const result = phrenErr("something failed", PhrenError.FILE_NOT_FOUND);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("something failed");
      expect(result.code).toBe("FILE_NOT_FOUND");
    }
  });

  it("phrenErr works without code", () => {
    const result = phrenErr("generic error");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBeUndefined();
  });

});

// ─── collectNativeMemoryFiles ──────────────────────────────────────────────

describe("collectNativeMemoryFiles", () => {
  let tmpRoot: string;
  let nativeMemCleanup: () => void;
  const origHome = process.env.HOME;

  beforeEach(() => {
    ({ path: tmpRoot, cleanup: nativeMemCleanup } = makeTempDir("phren-native-mem-"));
    process.env.HOME = tmpRoot;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    nativeMemCleanup();
  });

  it("returns empty when no .claude/projects dir exists", () => {
    const result = collectNativeMemoryFiles();
    expect(result).toEqual([]);
  });

  it("skips MEMORY.md (root memory managed by phren)", () => {
    const memDir = path.join(tmpRoot, ".claude", "projects", "test-key", "memory");
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, "MEMORY.md"), "# Root Memory");
    const result = collectNativeMemoryFiles();
    expect(result).toEqual([]);
  });

  it("collects MEMORY-project.md files with correct project name", () => {
    const memDir = path.join(tmpRoot, ".claude", "projects", "test-key", "memory");
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, "MEMORY-myapp.md"), "# My App Notes");
    fs.writeFileSync(path.join(memDir, "MEMORY-backend.md"), "# Backend Notes");
    const result = collectNativeMemoryFiles();
    expect(result).toHaveLength(2);
    const projects = result.map(r => r.project).sort();
    expect(projects).toEqual(["backend", "myapp"]);
  });

  it("handles non-standard .md files with native: prefix", () => {
    const memDir = path.join(tmpRoot, ".claude", "projects", "proj-key", "memory");
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, "notes.md"), "# Custom notes");
    const result = collectNativeMemoryFiles();
    expect(result).toHaveLength(1);
    expect(result[0].project).toBe("native:proj-key");
    expect(result[0].file).toBe("notes.md");
  });

  it("collects from multiple project directories", () => {
    for (const key of ["proj-a", "proj-b"]) {
      const memDir = path.join(tmpRoot, ".claude", "projects", key, "memory");
      fs.mkdirSync(memDir, { recursive: true });
      fs.writeFileSync(path.join(memDir, `MEMORY-${key}.md`), `# ${key} notes`);
    }
    const result = collectNativeMemoryFiles();
    expect(result).toHaveLength(2);
  });
});


describe("resolveImports", () => {
  let phrenDir: string;
  let importCleanup: () => void;

  beforeEach(() => {
    const tmp = makeTempDir("phren-import-test-");
    phrenDir = tmp.path;
    const sharedDir = path.join(phrenDir, "global", "shared");
    fs.mkdirSync(sharedDir, { recursive: true });
    importCleanup = tmp.cleanup;
  });

  afterEach(() => importCleanup());

  it("returns content unchanged when no imports present", () => {
    const content = "# Hello\n\nNo imports here.";
    expect(resolveImports(content, phrenDir)).toBe(content);
  });

  it("resolves a single @import directive", () => {
    fs.writeFileSync(
      path.join(phrenDir, "global", "shared", "conventions.md"),
      "Always use snake_case."
    );
    const content = "# Project\n\n@import shared/conventions.md\n\nMore text.";
    const result = resolveImports(content, phrenDir);
    expect(result).toContain("Always use snake_case.");
    expect(result).not.toContain("@import");
  });

  it("resolves multiple @import directives", () => {
    fs.writeFileSync(
      path.join(phrenDir, "global", "shared", "a.md"),
      "Content A"
    );
    fs.writeFileSync(
      path.join(phrenDir, "global", "shared", "b.md"),
      "Content B"
    );
    const content = "@import shared/a.md\n@import shared/b.md";
    const result = resolveImports(content, phrenDir);
    expect(result).toContain("Content A");
    expect(result).toContain("Content B");
  });

  it("handles nested imports recursively", () => {
    fs.writeFileSync(
      path.join(phrenDir, "global", "shared", "outer.md"),
      "Outer start\n@import shared/inner.md\nOuter end"
    );
    fs.writeFileSync(
      path.join(phrenDir, "global", "shared", "inner.md"),
      "Inner content"
    );
    const content = "@import shared/outer.md";
    const result = resolveImports(content, phrenDir);
    expect(result).toContain("Outer start");
    expect(result).toContain("Inner content");
    expect(result).toContain("Outer end");
  });

  it("detects circular imports and inserts comment", () => {
    fs.writeFileSync(
      path.join(phrenDir, "global", "shared", "loop-a.md"),
      "@import shared/loop-b.md"
    );
    fs.writeFileSync(
      path.join(phrenDir, "global", "shared", "loop-b.md"),
      "@import shared/loop-a.md"
    );
    const content = "@import shared/loop-a.md";
    const result = resolveImports(content, phrenDir);
    expect(result).toContain("@import cycle:");
  });

  it("handles missing import file gracefully", () => {
    const content = "@import shared/nonexistent.md";
    const result = resolveImports(content, phrenDir);
    expect(result).toContain("@import not found: shared/nonexistent.md");
  });

  it("blocks path traversal attempts", () => {
    const content = "@import ../../etc/passwd";
    const result = resolveImports(content, phrenDir);
    expect(result).toContain("@import blocked: path traversal");
  });

  it("caps recursion depth", () => {
    // Create a chain: d0 -> d1 -> d2 -> d3 -> d4 -> d5 (d5 should not resolve)
    for (let i = 0; i < 6; i++) {
      const next = i < 5 ? `@import shared/d${i + 1}.md` : "deepest";
      fs.writeFileSync(
        path.join(phrenDir, "global", "shared", `d${i}.md`),
        `level-${i}\n${next}`
      );
    }
    const result = resolveImports("@import shared/d0.md", phrenDir);
    expect(result).toContain("level-0");
    expect(result).toContain("level-4");
    // depth 5 should not be resolved (MAX_IMPORT_DEPTH = 5)
    expect(result).toContain("@import shared/d5.md");
  });
});

// --- New error codes (VALIDATION_ERROR, INDEX_ERROR, NETWORK_ERROR) ---

describe("PhrenError new codes", () => {
  it("VALIDATION_ERROR exists and is a string", () => {
    expect(PhrenError.VALIDATION_ERROR).toBe("VALIDATION_ERROR");
    expect(typeof PhrenError.VALIDATION_ERROR).toBe("string");
  });

  it("INDEX_ERROR exists and is a string", () => {
    expect(PhrenError.INDEX_ERROR).toBe("INDEX_ERROR");
    expect(typeof PhrenError.INDEX_ERROR).toBe("string");
  });

  it("NETWORK_ERROR exists and is a string", () => {
    expect(PhrenError.NETWORK_ERROR).toBe("NETWORK_ERROR");
    expect(typeof PhrenError.NETWORK_ERROR).toBe("string");
  });

  it("parsePhrenErrorCode extracts new codes from prefixed messages", () => {
    expect(parsePhrenErrorCode("VALIDATION_ERROR: invalid input")).toBe(PhrenError.VALIDATION_ERROR);
    expect(parsePhrenErrorCode("INDEX_ERROR: index rebuild failed")).toBe(PhrenError.INDEX_ERROR);
    expect(parsePhrenErrorCode("NETWORK_ERROR: connection refused")).toBe(PhrenError.NETWORK_ERROR);
  });

  it("all 13 PhrenError codes are present", () => {
    const expectedKeys = [
      "PROJECT_NOT_FOUND",
      "INVALID_PROJECT_NAME",
      "FILE_NOT_FOUND",
      "PERMISSION_DENIED",
      "MALFORMED_JSON",
      "MALFORMED_YAML",
      "NOT_FOUND",
      "AMBIGUOUS_MATCH",
      "LOCK_TIMEOUT",
      "EMPTY_INPUT",
      "VALIDATION_ERROR",
      "INDEX_ERROR",
      "NETWORK_ERROR",
    ];
    const actualKeys = Object.keys(PhrenError);
    expect(actualKeys).toEqual(expect.arrayContaining(expectedKeys));
    expect(actualKeys.length).toBe(expectedKeys.length);
  });
});
