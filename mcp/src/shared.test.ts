import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  findCortexPath,
  appendAuditLog,
  withDefaults,
  getProjectDirs,
  findCortexPathWithArg,
  collectNativeMemoryFiles,
  findProjectNameCaseInsensitive,
  CortexError,
  cortexOk,
  cortexErr,
  ensureCortexPath,
  normalizeProjectNameForCreate,
  parseCortexErrorCode,
  expandHomePath,
  homePath,
  hookConfigPath,
} from "./shared.js";
import {
  consolidateProjectFindings,
  recordInjection,
  recordFeedback,
  getQualityMultiplier,
  checkPermission,
  getAccessControl,
  updateAccessControl,
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
  enforceCanonicalLocks,
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
import { grantAdmin, makeTempDir, suppressOutput } from "./test-helpers.js";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as yaml from "js-yaml";

let tmpDir: string;
let tmpCleanup: (() => void) | undefined;

function makeCortex(): string {
  ({ path: tmpDir, cleanup: tmpCleanup } = makeTempDir("cortex-test-"));
  return tmpDir;
}

function makeProject(cortexDir: string, name: string, files: Record<string, string>): void {
  const dir = path.join(cortexDir, name);
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
  delete process.env.CORTEX_PATH;
});

afterEach(() => {
  delete process.env.CORTEX_PATH;
  delete process.env.CORTEX_ACTOR;
  if (tmpCleanup) {
    tmpCleanup();
    tmpCleanup = undefined;
  }
});

// --- isValidProjectName ---

describe("isValidProjectName", () => {
  it("accepts simple names", () => {
    expect(isValidProjectName("my-project")).toBe(true);
    expect(isValidProjectName("cortex")).toBe(true);
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
    expect(normalizeProjectNameForCreate("Cortex")).toBe("cortex");
    expect(normalizeProjectNameForCreate("My-App")).toBe("my-app");
  });

  it("finds existing projects case-insensitively", () => {
    const cortex = makeCortex();
    makeProject(cortex, "Cortex", { "FINDINGS.md": "# Cortex Findings\n" });
    expect(findProjectNameCaseInsensitive(cortex, "cortex")).toBe("Cortex");
    expect(findProjectNameCaseInsensitive(cortex, "CORTEX")).toBe("Cortex");
    expect(findProjectNameCaseInsensitive(cortex, "missing")).toBeNull();
  });
});

// --- findCortexPath / ensureCortexPath ---

describe("findCortexPath", () => {
  it("returns CORTEX_PATH env var when set", () => {
    const cortex = makeCortex();
    process.env.CORTEX_PATH = cortex;
    expect(findCortexPath()).toBe(cortex);
  });

  it("returns null when no cortex directory exists and no env var", () => {
    const tmp = makeTempDir("fakehome-");
    const origHome = process.env.HOME;
    process.env.HOME = tmp.path;
    try {
      expect(findCortexPath()).toBeNull();
    } finally {
      process.env.HOME = origHome;
      tmp.cleanup();
    }
  });

  it("finds ~/.cortex when it exists", () => {
    const tmp = makeTempDir("fakehome-");
    const dotCortex = path.join(tmp.path, ".cortex");
    fs.mkdirSync(dotCortex);
    const origHome = process.env.HOME;
    process.env.HOME = tmp.path;
    try {
      expect(findCortexPath()).toBe(dotCortex);
    } finally {
      process.env.HOME = origHome;
      tmp.cleanup();
    }
  });
});

describe("ensureCortexPath", () => {
  it("creates ~/.cortex if nothing exists", async () => {
    const tmp = makeTempDir("fakehome-");
    const origHome = process.env.HOME;
    process.env.HOME = tmp.path;
    try {
      const result = await suppressOutput(() => Promise.resolve(ensureCortexPath()));
      expect(result).toBe(path.join(tmp.path, ".cortex"));
      expect(fs.existsSync(result)).toBe(true);
      expect(fs.existsSync(path.join(result, "README.md"))).toBe(true);
      expect(findCortexPath()).toBe(result);
    } finally {
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
      expect(hookConfigPath("copilot")).toBe(path.join(tmp.path, ".github", "hooks", "cortex.json"));
      expect(hookConfigPath("claude", path.join(tmp.path, ".cortex"))).toBe(path.join(tmp.path, ".claude", "settings.json"));
      expect(hookConfigPath("codex", path.join(tmp.path, ".cortex"))).toBe(path.join(tmp.path, ".cortex", "codex.json"));
    } finally {
      process.env.HOME = origHome;
      process.env.USERPROFILE = origProfile;
      tmp.cleanup();
    }
  });
});

describe("governance validation", () => {
  it("validates shared governance schemas", () => {
    const cortex = makeCortex();
    const govDir = path.join(cortex, ".governance");
    fs.mkdirSync(govDir, { recursive: true });

    const accessControl = path.join(govDir, "access-control.json");
    fs.writeFileSync(accessControl, JSON.stringify({ admins: ["root"], maintainers: [], contributors: [], viewers: [] }, null, 2));
    expect(validateGovernanceJson(accessControl, "access-control")).toBe(true);

    const indexPolicy = path.join(govDir, "index-policy.json");
    fs.writeFileSync(indexPolicy, JSON.stringify({ includeGlobs: "bad-shape" }, null, 2));
    expect(validateGovernanceJson(indexPolicy, "index-policy")).toBe(false);
  });
});

// --- buildIndex + queryRows ---

describe("buildIndex and queryRows", () => {
  it("indexes markdown files and supports FTS5 search", async () => {
    const cortex = makeCortex();
    makeProject(cortex, "testproj", {
      "FINDINGS.md": "# testproj FINDINGS\n\n## 2025-01-01\n\n- Always validate user input before processing\n",
      "summary.md": "# testproj\n\nA test project for vitest.\n",
    });

    const db = await buildIndex(cortex);
    const rows = queryRows(db, "SELECT project, filename FROM docs WHERE docs MATCH ? ORDER BY rank", ["validate"]);
    expect(rows).not.toBeNull();
    expect(rows!.length).toBeGreaterThanOrEqual(1);
    expect(rows![0][0]).toBe("testproj");
    expect(rows![0][1]).toBe("FINDINGS.md");
    db.close();
  });

  it("returns null for queries with no matches", async () => {
    const cortex = makeCortex();
    makeProject(cortex, "testproj", {
      "summary.md": "# testproj\n\nA simple project.\n",
    });

    const db = await buildIndex(cortex);
    const rows = queryRows(db, "SELECT project FROM docs WHERE docs MATCH ?", ["zzzznonexistent"]);
    expect(rows).toBeNull();
    db.close();
  });

  it("indexes multiple projects", async () => {
    const cortex = makeCortex();
    makeProject(cortex, "alpha", { "summary.md": "# alpha\n\nFirst project about databases.\n" });
    makeProject(cortex, "beta", { "summary.md": "# beta\n\nSecond project about networking.\n" });

    const db = await buildIndex(cortex);
    const alphaRows = queryRows(db, "SELECT project FROM docs WHERE docs MATCH ? AND project = ?", ["databases", "alpha"]);
    const betaRows = queryRows(db, "SELECT project FROM docs WHERE docs MATCH ? AND project = ?", ["networking", "beta"]);
    expect(alphaRows).not.toBeNull();
    expect(betaRows).not.toBeNull();
    expect(alphaRows![0][0]).toBe("alpha");
    expect(betaRows![0][0]).toBe("beta");
    db.close();
  });

  it("returns null for invalid SQL instead of throwing", async () => {
    const cortex = makeCortex();
    makeProject(cortex, "testproj", {
      "summary.md": "# testproj\n\nA simple project.\n",
    });

    const db = await buildIndex(cortex);
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
    const cortex = makeCortex();
    const origHome = process.env.HOME;
    const origUserProfile = process.env.USERPROFILE;
    const homeDir = path.join(cortex, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    fs.mkdirSync(path.join(cortex, "profiles"), { recursive: true });
    fs.writeFileSync(path.join(cortex, "profiles", "broken.yaml"), "name: broken\nprojects: [\n");
    makeProject(cortex, "testproj", {
      "summary.md": "# testproj\n\nProfile parse fallback should still index this.\n",
    });

    try {
      // Q18: when a profile is set but the file is malformed, getProjectDirs returns []
      // and buildIndex produces an empty (but valid) FTS database — it does NOT widen
      // to all projects, which would violate profile-based access control.
      const db = await suppressOutput(() => buildIndex(cortex, "broken"));
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
    const cortex = makeCortex();
    grantAdmin(cortex);
    makeProject(cortex, "newproj", { "summary.md": "# newproj\n" });

    const result = addFindingToFile(cortex, "newproj", "Always use parameterized queries");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toContain("Created FINDINGS.md");
    const content = fs.readFileSync(path.join(cortex, "newproj", "FINDINGS.md"), "utf8");
    expect(content).toContain("- Always use parameterized queries");
    expect(content).toContain("cortex:cite");
  });

  it("appends to existing date section", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const today = new Date().toISOString().slice(0, 10);
    makeProject(cortex, "myproj", {
      "FINDINGS.md": `# myproj FINDINGS\n\n## ${today}\n\n- Existing finding\n`,
    });

    addFindingToFile(cortex, "myproj", "Second insight");
    const content = fs.readFileSync(path.join(cortex, "myproj", "FINDINGS.md"), "utf8");
    expect(content).toContain("- Second insight");
    expect(content).toContain("- Existing finding");
    // Should still have only one date heading for today
    const headingCount = (content.match(new RegExp(`## ${today}`, "g")) || []).length;
    expect(headingCount).toBe(1);
  });

  it("rejects invalid project names", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const result = addFindingToFile(cortex, "../etc", "bad");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Invalid project name");
  });

  it("skips duplicate findings with high word overlap", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const today = new Date().toISOString().slice(0, 10);
    makeProject(cortex, "dupeproj", {
      "FINDINGS.md": `# dupeproj FINDINGS\n\n## ${today}\n\n- The auth middleware runs before rate limiting and order matters\n`,
    });

    const result = addFindingToFile(cortex, "dupeproj", "The auth middleware runs before rate limiting, order matters");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toContain("Skipped duplicate");
  });

  it("allows non-duplicate findings through", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const today = new Date().toISOString().slice(0, 10);
    makeProject(cortex, "dupeproj2", {
      "FINDINGS.md": `# dupeproj2 FINDINGS\n\n## ${today}\n\n- The auth middleware runs before rate limiting\n`,
    });

    const result = addFindingToFile(cortex, "dupeproj2", "Database indexes need to be rebuilt after migration");
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
    const cortex = makeCortex();
    const bullets = Array.from({ length: 26 }, (_, i) => `- Finding number ${i + 1}`).join("\n");
    makeProject(cortex, "bigproj", {
      "FINDINGS.md": `# bigproj FINDINGS\n\n## 2025-01-01\n\n${bullets}\n`,
    });

    const results = checkConsolidationNeeded(cortex);
    expect(results.length).toBe(1);
    expect(results[0].project).toBe("bigproj");
    expect(results[0].entriesSince).toBe(26);
  });

  it("does not flag projects under threshold", () => {
    const cortex = makeCortex();
    makeProject(cortex, "smallproj", {
      "FINDINGS.md": "# smallproj FINDINGS\n\n## 2025-01-01\n\n- One finding\n- Two finding\n",
    });

    const results = checkConsolidationNeeded(cortex);
    expect(results.length).toBe(0);
  });

  it("counts only entries after the consolidation marker", () => {
    const cortex = makeCortex();
    const oldBullets = Array.from({ length: 30 }, (_, i) => `- Old finding ${i}`).join("\n");
    const newBullets = Array.from({ length: 5 }, (_, i) => `- New finding ${i}`).join("\n");
    makeProject(cortex, "markedproj", {
      "FINDINGS.md": `# markedproj FINDINGS\n\n## 2024-01-01\n\n${oldBullets}\n\n<!-- consolidated: 2025-01-01 -->\n\n## 2025-02-01\n\n${newBullets}\n`,
    });

    const results = checkConsolidationNeeded(cortex);
    expect(results.length).toBe(0);
  });

  it("flags time-based consolidation (60+ days, 10+ entries)", () => {
    const cortex = makeCortex();
    const bullets = Array.from({ length: 12 }, (_, i) => `- Finding ${i}`).join("\n");
    makeProject(cortex, "oldproj", {
      "FINDINGS.md": `# oldproj FINDINGS\n\n## 2024-06-01\n\n${bullets}\n\n<!-- consolidated: 2024-01-01 -->\n\n## 2024-06-15\n\n${bullets}\n`,
    });

    const results = checkConsolidationNeeded(cortex);
    expect(results.length).toBe(1);
    expect(results[0].project).toBe("oldproj");
  });
});

// --- detectProject ---

describe("detectProject", () => {
  it("matches project name in cwd path segments", () => {
    const cortex = makeCortex();
    makeProject(cortex, "myapp", { "summary.md": "# myapp\n" });

    const result = detectProject(cortex, "/home/user/myapp/src");
    expect(result).toBe("myapp");
  });

  it("returns null when no project matches", () => {
    const cortex = makeCortex();
    makeProject(cortex, "myapp", { "summary.md": "# myapp\n" });

    const result = detectProject(cortex, "/home/user/other-project/src");
    expect(result).toBeNull();
  });

  it("short names (<=3 chars) only match the last path segment", () => {
    const cortex = makeCortex();
    makeProject(cortex, "api", { "summary.md": "# api\n" });

    // "api" appears as a middle segment, should NOT match
    const noMatch = detectProject(cortex, "/home/user/api/controllers");
    expect(noMatch).toBeNull();

    // "api" is the last segment, should match
    const match = detectProject(cortex, "/home/user/projects/api");
    expect(match).toBe("api");
  });

  it("longer names match any path segment", () => {
    const cortex = makeCortex();
    makeProject(cortex, "cortex", { "summary.md": "# cortex\n" });

    const result = detectProject(cortex, "/home/cortex/mcp/src");
    expect(result).toBe("cortex");
  });
});

// --- appendAuditLog rotation ---

describe("appendAuditLog", () => {
  it("appends log entries", () => {
    const cortex = makeCortex();
    appendAuditLog(cortex, "test_event", "details=foo");
    const logPath = path.join(cortex, ".runtime", "audit.log");
    expect(fs.existsSync(logPath)).toBe(true);
    const content = fs.readFileSync(logPath, "utf8");
    expect(content).toContain("test_event");
    expect(content).toContain("details=foo");
  });

  it("rotates log when over 1MB", () => {
    const cortex = makeCortex();
    const logPath = path.join(cortex, ".runtime", "audit.log");
    fs.mkdirSync(path.join(cortex, ".runtime"), { recursive: true });
    // Seed with >1MB of data (each line ~80 chars, need ~13000 lines)
    const bigContent = Array.from({ length: 14000 }, (_, i) =>
      `[2025-01-01T00:00:00.000Z] event_${i} ${"x".repeat(60)}`
    ).join("\n") + "\n";
    fs.writeFileSync(logPath, bigContent);

    appendAuditLog(cortex, "trigger_rotation", "details=bar");
    const after = fs.readFileSync(logPath, "utf8");
    const lines = after.split("\n").filter(l => l.length > 0);
    expect(lines.length).toBeLessThanOrEqual(500);
    expect(after).toContain("trigger_rotation");
  });
});

// --- consolidateProjectFindings dedup ---

describe("consolidateProjectFindings", () => {
  it("deduplicates entries with normalized whitespace", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    makeProject(cortex, "dedupproj", {
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

    consolidateProjectFindings(cortex, "dedupproj");
    const content = fs.readFileSync(path.join(cortex, "dedupproj", "FINDINGS.md"), "utf8");
    const bullets = content.split("\n").filter(l => l.startsWith("- "));
    expect(bullets.length).toBe(2);
  });

  it("deduplicates entries that differ only by trailing whitespace", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    makeProject(cortex, "trailproj", {
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

    consolidateProjectFindings(cortex, "trailproj");
    const content = fs.readFileSync(path.join(cortex, "trailproj", "FINDINGS.md"), "utf8");
    const bullets = content.split("\n").filter(l => l.startsWith("- "));
    expect(bullets.length).toBe(1);
    expect(bullets[0]).toBe("- Use parameterized queries");
  });
});

describe("RBAC and canonical locks", () => {
  let cortex: string;
  const origActor = process.env.CORTEX_ACTOR;

  function setupAccess(acl: { admins?: string[]; maintainers?: string[]; contributors?: string[]; viewers?: string[] }) {
    const govDir = path.join(cortex, ".governance");
    fs.mkdirSync(govDir, { recursive: true });
    fs.writeFileSync(
      path.join(govDir, "access-control.json"),
      JSON.stringify({ admins: [], maintainers: [], contributors: [], viewers: [], ...acl }, null, 2) + "\n"
    );
  }

  let rbacCleanup: () => void;

  beforeEach(() => {
    ({ path: cortex, cleanup: rbacCleanup } = makeTempDir("cortex-rbac-"));
  });

  afterEach(() => {
    process.env.CORTEX_ACTOR = origActor;
    rbacCleanup();
  });

  describe("checkPermission", () => {
    it("admin can perform any action", () => {
      setupAccess({ admins: ["alice"] });
      for (const action of ["read", "write", "queue", "pin", "policy", "delete"] as const) {
        expect(checkPermission(cortex, action, "alice")).toBeNull();
      }
    });

    it("maintainer can do everything except policy", () => {
      setupAccess({ maintainers: ["bob"] });
      expect(checkPermission(cortex, "read", "bob")).toBeNull();
      expect(checkPermission(cortex, "write", "bob")).toBeNull();
      expect(checkPermission(cortex, "pin", "bob")).toBeNull();
      expect(checkPermission(cortex, "delete", "bob")).toBeNull();
      expect(checkPermission(cortex, "policy", "bob")).toContain("Permission denied");
    });

    it("contributor can read, write, and queue but not pin, delete, or policy", () => {
      setupAccess({ contributors: ["carol"] });
      expect(checkPermission(cortex, "read", "carol")).toBeNull();
      expect(checkPermission(cortex, "write", "carol")).toBeNull();
      expect(checkPermission(cortex, "queue", "carol")).toBeNull();
      expect(checkPermission(cortex, "pin", "carol")).toContain("Permission denied");
      expect(checkPermission(cortex, "delete", "carol")).toContain("Permission denied");
      expect(checkPermission(cortex, "policy", "carol")).toContain("Permission denied");
    });

    it("viewer can only read", () => {
      setupAccess({ viewers: ["dave"] });
      expect(checkPermission(cortex, "read", "dave")).toBeNull();
      expect(checkPermission(cortex, "write", "dave")).toContain("Permission denied");
      expect(checkPermission(cortex, "pin", "dave")).toContain("Permission denied");
      expect(checkPermission(cortex, "policy", "dave")).toContain("Permission denied");
    });

    it("unknown actor gets viewer role (least privilege)", () => {
      setupAccess({ admins: ["alice"] });
      expect(checkPermission(cortex, "read", "stranger")).toBeNull();
      expect(checkPermission(cortex, "write", "stranger")).toContain("Permission denied");
    });

    it("uses a local maintainer override when the actor is absent from the shared ACL", () => {
      setupAccess({ admins: ["alice"] });
      fs.mkdirSync(path.join(cortex, ".runtime"), { recursive: true });
      fs.writeFileSync(
        path.join(cortex, ".runtime", "access-control.local.json"),
        JSON.stringify({ maintainers: ["stranger"] }, null, 2) + "\n",
      );
      expect(checkPermission(cortex, "write", "stranger")).toBeNull();
      expect(checkPermission(cortex, "policy", "stranger")).toContain("Permission denied");
    });

    it("prefers the shared ACL when it explicitly lists the actor", () => {
      setupAccess({ viewers: ["dave"] });
      fs.mkdirSync(path.join(cortex, ".runtime"), { recursive: true });
      fs.writeFileSync(
        path.join(cortex, ".runtime", "access-control.local.json"),
        JSON.stringify({ maintainers: ["dave"] }, null, 2) + "\n",
      );
      expect(checkPermission(cortex, "write", "dave")).toContain("Permission denied");
    });

    it("denial message includes actor name and role", () => {
      setupAccess({ viewers: ["eve"] });
      const denial = checkPermission(cortex, "write", "eve");
      expect(denial).toContain("eve");
      expect(denial).toContain("viewer");
      expect(denial).toContain("write");
    });

    it("ignores caller-controlled env actors outside explicit test mode", () => {
      const origEnvActor = process.env.CORTEX_ACTOR;
      const origUser = process.env.USER;
      const origNodeEnv = process.env.NODE_ENV;
      const origVitestWorkerId = process.env.VITEST_WORKER_ID;
      const currentUser = os.userInfo().username;
      setupAccess({ admins: [currentUser], viewers: ["spoofed-admin"] });

      delete process.env.VITEST_WORKER_ID;
      delete process.env.NODE_ENV;
      delete process.env.CORTEX_TRUST_ENV_ACTOR;
      process.env.CORTEX_ACTOR = "spoofed-admin";
      process.env.USER = "spoofed-admin";

      try {
        expect(checkPermission(cortex, "write")).toBeNull();
      } finally {
        if (origEnvActor === undefined) delete process.env.CORTEX_ACTOR;
        else process.env.CORTEX_ACTOR = origEnvActor;
        if (origUser === undefined) delete process.env.USER;
        else process.env.USER = origUser;
        if (origNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = origNodeEnv;
        if (origVitestWorkerId === undefined) delete process.env.VITEST_WORKER_ID;
        else process.env.VITEST_WORKER_ID = origVitestWorkerId;
      }
    });
  });

  describe("enforceCanonicalLocks", () => {
    it("creates a lock entry on first run and restores drifted content", () => {
      setupAccess({ admins: ["test-admin"] });
      process.env.CORTEX_ACTOR = "test-admin";
      makeProject(cortex, "lockproj", {
        "CANONICAL_MEMORIES.md": "# Canonical\n\n- Important fact\n",
      });

      // First run: creates the lock
      const first = enforceCanonicalLocks(cortex, "lockproj");
      expect(first).toContain("checked=1");
      expect(first).toContain("restored=0");

      // Tamper with the file
      fs.writeFileSync(
        path.join(cortex, "lockproj", "CANONICAL_MEMORIES.md"),
        "# Tampered\n\n- Wrong info\n"
      );

      // Second run: detects drift and restores
      const second = enforceCanonicalLocks(cortex, "lockproj");
      expect(second).toContain("restored=1");

      const restored = fs.readFileSync(
        path.join(cortex, "lockproj", "CANONICAL_MEMORIES.md"),
        "utf8"
      );
      expect(restored).toContain("Important fact");
      expect(restored).not.toContain("Tampered");
    });

    it("does not restore when content matches the lock", () => {
      setupAccess({ admins: ["test-admin"] });
      process.env.CORTEX_ACTOR = "test-admin";
      makeProject(cortex, "stable", {
        "CANONICAL_MEMORIES.md": "# Stable\n\n- Unchanged\n",
      });

      enforceCanonicalLocks(cortex, "stable");
      const result = enforceCanonicalLocks(cortex, "stable");
      expect(result).toContain("restored=0");
    });
  });

  describe("upsertCanonical", () => {
    it("creates CANONICAL_MEMORIES.md and locks the entry", () => {
      setupAccess({ admins: ["test-admin"] });
      process.env.CORTEX_ACTOR = "test-admin";
      makeProject(cortex, "pinproj", { "summary.md": "# pinproj" });

      const result = upsertCanonical(cortex, "pinproj", "Always run tests before pushing");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data).toContain("Pinned");

      const canonical = fs.readFileSync(
        path.join(cortex, "pinproj", "CANONICAL_MEMORIES.md"),
        "utf8"
      );
      expect(canonical).toContain("Always run tests before pushing");
      expect(canonical).toContain("## Pinned");

      // Lock file should exist
      const lockData = readVersionedEntries<{ hash: string }>(
        path.join(cortex, ".runtime", "canonical-locks.json")
      );
      expect(lockData["pinproj/CANONICAL_MEMORIES.md"]).toBeDefined();
      expect(lockData["pinproj/CANONICAL_MEMORIES.md"].hash).toBeTruthy();
    });

    it("does not duplicate an existing pinned memory", () => {
      setupAccess({ admins: ["test-admin"] });
      process.env.CORTEX_ACTOR = "test-admin";
      makeProject(cortex, "dupproj", { "summary.md": "# dupproj" });

      upsertCanonical(cortex, "dupproj", "Unique insight");
      upsertCanonical(cortex, "dupproj", "Unique insight");

      const canonical = fs.readFileSync(
        path.join(cortex, "dupproj", "CANONICAL_MEMORIES.md"),
        "utf8"
      );
      const matches = canonical.match(/Unique insight/g);
      expect(matches?.length).toBe(1);
    });

    it("denies pinning when actor lacks permission", () => {
      setupAccess({ viewers: ["readonly"] });
      process.env.CORTEX_ACTOR = "readonly";
      makeProject(cortex, "nopinproj", { "summary.md": "# nopinproj" });

      const result = upsertCanonical(cortex, "nopinproj", "Should be denied");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("Permission denied");
      expect(fs.existsSync(path.join(cortex, "nopinproj", "CANONICAL_MEMORIES.md"))).toBe(false);
    });
  });

  describe("updateAccessControl", () => {
    it("admin can update access control", () => {
      setupAccess({ admins: ["boss"] });
      process.env.CORTEX_ACTOR = "boss";

      const result = updateAccessControl(cortex, { contributors: ["newdev"] });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.contributors).toContain("newdev");

      const acl = getAccessControl(cortex);
      expect(acl.contributors).toContain("newdev");
    });

    it("non-admin cannot update access control", () => {
      setupAccess({ contributors: ["dev"] });
      process.env.CORTEX_ACTOR = "dev";

      const result = updateAccessControl(cortex, { admins: ["dev"] });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("Permission denied");
    });
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
      `  <!-- cortex:cite {"created_at":"${d.toISOString()}"} -->`,
      "",
    ].join("\n");
    const result = filterTrustedFindingsDetailed(content, { ttlDays: 200, minConfidence: 0.3 });
    expect(result.content).toContain("- Finding with citation");
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
    const cortex = makeCortex();
    grantAdmin(cortex);
    const key = "testproj/FINDINGS.md:abc123";

    recordInjection(cortex, key, "session-1");
    flushEntryScores(cortex);

    const scoresPath = path.join(cortex, ".runtime", "memory-scores.json");
    expect(fs.existsSync(scoresPath)).toBe(true);
    const scores = readVersionedEntries<any>(scoresPath);
    expect(scores[key]).toBeDefined();
    expect(scores[key].impressions).toBe(1);

    recordInjection(cortex, key, "session-2");
    flushEntryScores(cortex);
    const scores2 = readVersionedEntries<any>(scoresPath);
    expect(scores2[key].impressions).toBe(2);
  });

  it("appends to usage log", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const key = "testproj/FINDINGS.md:def456";

    recordInjection(cortex, key, "sess-42");

    const logPath = path.join(cortex, ".runtime", "memory-usage.log");
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
    const cortex = makeCortex();
    grantAdmin(cortex);
    const key = "proj/file:aaa";

    recordInjection(cortex, key);
    recordFeedback(cortex, key, "helpful");
    flushEntryScores(cortex);

    const scores = readVersionedEntries<any>(
      path.join(cortex, ".runtime", "memory-scores.json")
    );
    expect(scores[key].helpful).toBe(1);
    expect(scores[key].repromptPenalty).toBe(0);
  });

  it("records reprompt penalty", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const key = "proj/file:bbb";

    recordInjection(cortex, key);
    recordFeedback(cortex, key, "reprompt");
    flushEntryScores(cortex);

    const scores = readVersionedEntries<any>(
      path.join(cortex, ".runtime", "memory-scores.json")
    );
    expect(scores[key].repromptPenalty).toBe(1);
  });

  it("records regression penalty", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const key = "proj/file:ccc";

    recordInjection(cortex, key);
    recordFeedback(cortex, key, "regression");
    flushEntryScores(cortex);

    const scores = readVersionedEntries<any>(
      path.join(cortex, ".runtime", "memory-scores.json")
    );
    expect(scores[key].regressionPenalty).toBe(1);
  });
});

// --- getQualityMultiplier ---

describe("getQualityMultiplier", () => {
  it("returns 1 for unknown keys", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    expect(getQualityMultiplier(cortex, "unknown/key:xyz")).toBe(1);
  });

  it("returns > 1 for helpful memories", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const key = "proj/file:helpful";

    recordInjection(cortex, key);
    recordFeedback(cortex, key, "helpful");
    recordFeedback(cortex, key, "helpful");
    recordFeedback(cortex, key, "helpful");

    const mult = getQualityMultiplier(cortex, key);
    expect(mult).toBeGreaterThan(1);
  });

  it("returns < 1 for penalized memories", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const key = "proj/file:bad";

    recordInjection(cortex, key);
    recordFeedback(cortex, key, "regression");
    recordFeedback(cortex, key, "reprompt");

    const mult = getQualityMultiplier(cortex, key);
    expect(mult).toBeLessThan(1);
  });

  it("clamps between 0.2 and 1.5", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);

    const goodKey = "proj/file:great";
    recordInjection(cortex, goodKey);
    for (let i = 0; i < 20; i++) recordFeedback(cortex, goodKey, "helpful");
    expect(getQualityMultiplier(cortex, goodKey)).toBeLessThanOrEqual(1.5);

    const badKey = "proj/file:terrible";
    recordInjection(cortex, badKey);
    for (let i = 0; i < 20; i++) recordFeedback(cortex, badKey, "regression");
    expect(getQualityMultiplier(cortex, badKey)).toBeGreaterThanOrEqual(0.2);
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
    const tmp = makeTempDir("cortex-automerge-");
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
    const tmp = makeTempDir("cortex-nongit-");
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
    const cortex = makeCortex();
    grantAdmin(cortex);
    const govDir = path.join(cortex, ".governance");
    fs.writeFileSync(
      path.join(govDir, "retention-policy.json"),
      JSON.stringify({ ttlDays: 120, retentionDays: 30, autoAcceptThreshold: 0.75, minInjectConfidence: 0.35, decay: { d30: 1, d60: 0.85, d90: 0.65, d120: 0.45 } }, null, 2) + "\n"
    );
    makeProject(cortex, "pruneproj", {
      "FINDINGS.md": "# pruneproj FINDINGS\n\n## 2020-01-01\n\n- Very old entry\n\n## 2099-01-01\n\n- Future entry\n",
    });

    const result = pruneDeadMemories(cortex, "pruneproj", true);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toContain("[dry-run]");
      expect(result.data).toContain("1");
    }
    // File should be unchanged in dry-run
    const content = fs.readFileSync(path.join(cortex, "pruneproj", "FINDINGS.md"), "utf8");
    expect(content).toContain("Very old entry");
  });

  it("prunes entries and uses atomic write (no .bak file)", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const govDir = path.join(cortex, ".governance");
    fs.writeFileSync(
      path.join(govDir, "retention-policy.json"),
      JSON.stringify({ ttlDays: 120, retentionDays: 30, autoAcceptThreshold: 0.75, minInjectConfidence: 0.35, decay: { d30: 1, d60: 0.85, d90: 0.65, d120: 0.45 } }, null, 2) + "\n"
    );
    makeProject(cortex, "pruneproj", {
      "FINDINGS.md": "# pruneproj FINDINGS\n\n## 2020-01-01\n\n- Very old entry\n\n## 2099-01-01\n\n- Future entry\n",
    });

    const result = pruneDeadMemories(cortex, "pruneproj");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toContain("Pruned 1");
    const content = fs.readFileSync(path.join(cortex, "pruneproj", "FINDINGS.md"), "utf8");
    expect(content).not.toContain("Very old entry");
    expect(content).toContain("Future entry");
    // atomic write (tmp + rename) — no .bak file is created
    expect(fs.existsSync(path.join(cortex, "pruneproj", "FINDINGS.md.bak"))).toBe(false);
  });

  it("denies prune when actor lacks delete permission", () => {
    const cortex = makeCortex();
    const govDir = path.join(cortex, ".governance");
    fs.mkdirSync(govDir, { recursive: true });
    fs.writeFileSync(
      path.join(govDir, "access-control.json"),
      JSON.stringify({ admins: [], contributors: ["dev"], viewers: [] }, null, 2) + "\n"
    );
    process.env.CORTEX_ACTOR = "dev";
    const result = pruneDeadMemories(cortex, "proj");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Permission denied");
  });
});

// --- getRetentionPolicy / updateRetentionPolicy ---

describe("getRetentionPolicy and updateRetentionPolicy", () => {
  it("returns defaults when no policy file exists", () => {
    const cortex = makeCortex();
    const policy = getRetentionPolicy(cortex);
    expect(policy.ttlDays).toBe(120);
    expect(policy.retentionDays).toBe(365);
    expect(policy.decay.d30).toBe(1.0);
    expect(policy.decay.d120).toBe(0.45);
  });

  it("merges partial policy with defaults", () => {
    const cortex = makeCortex();
    const govDir = path.join(cortex, ".governance");
    fs.mkdirSync(govDir, { recursive: true });
    fs.writeFileSync(
      path.join(govDir, "retention-policy.json"),
      JSON.stringify({ ttlDays: 60 }, null, 2) + "\n"
    );
    const policy = getRetentionPolicy(cortex);
    expect(policy.ttlDays).toBe(60);
    expect(policy.retentionDays).toBe(365);
  });

  it("admin can update policy", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const result = updateRetentionPolicy(cortex, { ttlDays: 90 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.ttlDays).toBe(90);
  });

  it("non-admin cannot update policy", () => {
    const cortex = makeCortex();
    const govDir = path.join(cortex, ".governance");
    fs.mkdirSync(govDir, { recursive: true });
    fs.writeFileSync(
      path.join(govDir, "access-control.json"),
      JSON.stringify({ contributors: ["dev"] }, null, 2) + "\n"
    );
    process.env.CORTEX_ACTOR = "dev";
    const result = updateRetentionPolicy(cortex, { ttlDays: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Permission denied");
  });
});

// --- getWorkflowPolicy / updateWorkflowPolicy ---

describe("getWorkflowPolicy and updateWorkflowPolicy", () => {
  it("returns defaults when no file exists", () => {
    const cortex = makeCortex();
    const wp = getWorkflowPolicy(cortex);
    expect(wp.requireMaintainerApproval).toBe(false);
    expect(wp.lowConfidenceThreshold).toBe(0.7);
    expect(wp.riskySections).toEqual(["Stale", "Conflicts"]);
    expect(wp.taskMode).toBe("manual");
  });

  it("filters invalid riskySections values", () => {
    const cortex = makeCortex();
    const govDir = path.join(cortex, ".governance");
    fs.mkdirSync(govDir, { recursive: true });
    fs.writeFileSync(
      path.join(govDir, "workflow-policy.json"),
      JSON.stringify({ riskySections: ["Review", "BadSection", "Stale"] }, null, 2) + "\n"
    );
    const wp = getWorkflowPolicy(cortex);
    expect(wp.riskySections).toEqual(["Review", "Stale"]);
  });

  it("admin can update workflow policy", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const result = updateWorkflowPolicy(cortex, { lowConfidenceThreshold: 0.5, taskMode: "auto" });
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
    const cortex = makeCortex();
    const ip = getIndexPolicy(cortex);
    expect(ip.includeGlobs).toContain("**/*.md");
    expect(ip.includeHidden).toBe(false);
  });

  it("filters empty globs and falls back to defaults", () => {
    const cortex = makeCortex();
    const govDir = path.join(cortex, ".governance");
    fs.mkdirSync(govDir, { recursive: true });
    fs.writeFileSync(
      path.join(govDir, "index-policy.json"),
      JSON.stringify({ includeGlobs: ["", "  "], excludeGlobs: [] }, null, 2) + "\n"
    );
    const ip = getIndexPolicy(cortex);
    expect(ip.includeGlobs.length).toBeGreaterThan(0);
    expect(ip.includeGlobs.every(g => g.trim().length > 0)).toBe(true);
  });

  it("admin can update index policy", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const result = updateIndexPolicy(cortex, { includeHidden: true });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.includeHidden).toBe(true);
  });
});

// --- getRuntimeHealth / updateRuntimeHealth ---

describe("getRuntimeHealth and updateRuntimeHealth", () => {
  it("returns default health when no file exists", () => {
    const cortex = makeCortex();
    const h = getRuntimeHealth(cortex);
    expect(h.schemaVersion).toBe(1);
    expect(h.lastPromptAt).toBeUndefined();
  });

  it("updates and persists runtime health", () => {
    const cortex = makeCortex();
    const now = new Date().toISOString();
    updateRuntimeHealth(cortex, { lastPromptAt: now });
    const h = getRuntimeHealth(cortex);
    expect(h.lastPromptAt).toBe(now);
  });

  it("handles lastAutoSave updates", () => {
    const cortex = makeCortex();
    const now = new Date().toISOString();
    updateRuntimeHealth(cortex, {
      lastAutoSave: { at: now, status: "saved-pushed", detail: "ok" },
    });
    const h = getRuntimeHealth(cortex);
    expect(h.lastAutoSave?.status).toBe("saved-pushed");
  });

  it("handles sync metadata updates", () => {
    const cortex = makeCortex();
    const now = new Date().toISOString();
    updateRuntimeHealth(cortex, {
      lastSync: {
        lastPullAt: now,
        lastPullStatus: "ok",
        lastPushAt: now,
        lastPushStatus: "saved-local",
        unsyncedCommits: 2,
      },
    });
    const h = getRuntimeHealth(cortex);
    expect(h.lastSync?.lastPullStatus).toBe("ok");
    expect(h.lastSync?.lastPushStatus).toBe("saved-local");
    expect(h.lastSync?.unsyncedCommits).toBe(2);
  });
});

// --- appendReviewQueue ---

describe("appendReviewQueue", () => {
  it("creates MEMORY_QUEUE.md if it does not exist", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    makeProject(cortex, "queueproj", { "summary.md": "# queueproj\n" });

    const result = appendReviewQueue(cortex, "queueproj", "Stale", ["Old memory"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBe(1);
    const content = fs.readFileSync(path.join(cortex, "queueproj", "MEMORY_QUEUE.md"), "utf8");
    expect(content).toContain("## Stale");
    expect(content).toContain("Old memory");
  });

  it("does not duplicate existing entries", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    makeProject(cortex, "dupqueue", { "summary.md": "# dupqueue\n" });

    appendReviewQueue(cortex, "dupqueue", "Review", ["Check this"]);
    const result = appendReviewQueue(cortex, "dupqueue", "Review", ["Check this"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBe(0);
  });

  it("returns 0 for empty entries", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    makeProject(cortex, "emptyq", { "summary.md": "# emptyq\n" });
    const emptyResult = appendReviewQueue(cortex, "emptyq", "Stale", []);
    expect(emptyResult.ok).toBe(true);
    if (emptyResult.ok) expect(emptyResult.data).toBe(0);
  });

  it("returns 0 for invalid project", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const badResult = appendReviewQueue(cortex, "../bad", "Stale", ["entry"]);
    expect(badResult.ok).toBe(false);
  });

  it("normalizes multiline and comment-heavy queue entries into a safe single line", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    makeProject(cortex, "sanitizequeue", { "summary.md": "# sanitizequeue\n" });

    const result = appendReviewQueue(cortex, "sanitizequeue", "Review", [
      "Line one\\nLine two <!-- source: injected --> \"quoted\" \0 text",
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const content = fs.readFileSync(path.join(cortex, "sanitizequeue", "MEMORY_QUEUE.md"), "utf8");
    expect(content).toContain('Line one Line two "quoted" text');
    expect(content).not.toContain("<!-- source: injected -->");
    expect(content).not.toContain("\0");
  });
});

// --- getProjectDirs ---

describe("getProjectDirs", () => {
  it("lists directories excluding hidden dirs, profiles, and templates", () => {
    const cortex = makeCortex();
    fs.mkdirSync(path.join(cortex, "proj-a"), { recursive: true });
    fs.mkdirSync(path.join(cortex, "proj-b"), { recursive: true });
    fs.mkdirSync(path.join(cortex, ".governance"), { recursive: true });
    fs.mkdirSync(path.join(cortex, "profiles"), { recursive: true });
    fs.mkdirSync(path.join(cortex, "templates"), { recursive: true });

    const dirs = getProjectDirs(cortex);
    const names = dirs.map(d => path.basename(d));
    expect(names).toContain("proj-a");
    expect(names).toContain("proj-b");
    expect(names).not.toContain(".governance");
    expect(names).not.toContain("profiles");
    expect(names).not.toContain("templates");
  });

  it("excludes global directory from project listing", () => {
    const cortex = makeCortex();
    fs.mkdirSync(path.join(cortex, "proj-a"), { recursive: true });
    fs.mkdirSync(path.join(cortex, "global"), { recursive: true });

    const dirs = getProjectDirs(cortex);
    const names = dirs.map(d => path.basename(d));
    expect(names).toContain("proj-a");
    expect(names).not.toContain("global");
  });

  it("uses profile to filter projects", () => {
    const cortex = makeCortex();
    fs.mkdirSync(path.join(cortex, "proj-a"), { recursive: true });
    fs.mkdirSync(path.join(cortex, "proj-b"), { recursive: true });
    fs.mkdirSync(path.join(cortex, "profiles"), { recursive: true });
    fs.writeFileSync(
      path.join(cortex, "profiles", "test.yaml"),
      yaml.dump({ name: "test", projects: ["proj-a"] })
    );

    const dirs = getProjectDirs(cortex, "test");
    const names = dirs.map(d => path.basename(d));
    expect(names).toContain("proj-a");
    expect(names).not.toContain("proj-b");
  });

  it("includes shared/org dirs alongside profile projects", () => {
    const cortex = makeCortex();
    fs.mkdirSync(path.join(cortex, "proj-a"), { recursive: true });
    fs.mkdirSync(path.join(cortex, "shared"), { recursive: true });
    fs.mkdirSync(path.join(cortex, "org"), { recursive: true });
    fs.mkdirSync(path.join(cortex, "profiles"), { recursive: true });
    fs.writeFileSync(
      path.join(cortex, "profiles", "myprof.yaml"),
      yaml.dump({ name: "myprof", projects: ["proj-a"] })
    );

    const dirs = getProjectDirs(cortex, "myprof");
    const names = dirs.map(d => path.basename(d));
    expect(names).toContain("proj-a");
    expect(names).toContain("shared");
    expect(names).toContain("org");
  });

  it("rejects invalid profile names", async () => {
    const cortex = makeCortex();
    const dirs = await suppressOutput(() => Promise.resolve(getProjectDirs(cortex, "../bad")));
    expect(dirs).toEqual([]);
  });
});

// --- consolidateProjectFindings additional ---

describe("consolidateProjectFindings additional", () => {
  it("supports dry-run mode", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    makeProject(cortex, "drycons", {
      "FINDINGS.md": "# drycons FINDINGS\n\n## 2025-01-01\n\n- A\n- A\n- B\n",
    });
    const result = consolidateProjectFindings(cortex, "drycons", true);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toContain("[dry-run]");
      expect(result.data).toContain("1 duplicate");
    }
    // File unchanged
    const content = fs.readFileSync(path.join(cortex, "drycons", "FINDINGS.md"), "utf8");
    expect(content.split("\n").filter(l => l.startsWith("- ")).length).toBe(3);
  });

  it("rejects invalid project name", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const result = consolidateProjectFindings(cortex, "../bad");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Invalid project name");
  });

  it("returns message when no FINDINGS.md exists", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    makeProject(cortex, "emptycons", { "summary.md": "# emptycons\n" });
    const result = consolidateProjectFindings(cortex, "emptycons");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("No FINDINGS.md");
  });

  it("deduplicates entries that differ only by trailing whitespace", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    makeProject(cortex, "trailws", {
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
    consolidateProjectFindings(cortex, "trailws");
    const content = fs.readFileSync(path.join(cortex, "trailws", "FINDINGS.md"), "utf8");
    const bullets = content.split("\n").filter(l => l.startsWith("- "));
    expect(bullets.length).toBe(2);
  });

  it("preserves citation comments during dedup", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    makeProject(cortex, "citecons", {
      "FINDINGS.md": [
        "# citecons FINDINGS",
        "",
        "## 2025-01-01",
        "",
        "- Some insight",
        '  <!-- cortex:cite {"created_at":"2025-01-01T00:00:00.000Z"} -->',
        "- Some insight",
        "",
      ].join("\n"),
    });
    consolidateProjectFindings(cortex, "citecons");
    const content = fs.readFileSync(path.join(cortex, "citecons", "FINDINGS.md"), "utf8");
    const bullets = content.split("\n").filter(l => l.startsWith("- "));
    expect(bullets.length).toBe(1);
    expect(content).toContain("cortex:cite");
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
      '  <!-- cortex:cite {"created_at":"2025-01-01T00:00:00.000Z","repo":"/nonexistent/path"} -->',
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
    const cortex = makeCortex();
    const f = path.join(cortex, "test.json");
    fs.writeFileSync(f, "[1,2,3]");
    expect(validateGovernanceJson(f, "access-control")).toBe(false);
  });

  it("validates retention-policy with bad decay", () => {
    const cortex = makeCortex();
    const f = path.join(cortex, "test.json");
    fs.writeFileSync(f, JSON.stringify({ decay: "not an object" }));
    expect(validateGovernanceJson(f, "retention-policy")).toBe(false);
  });

  it("validates workflow-policy", () => {
    const cortex = makeCortex();
    const f = path.join(cortex, "test.json");
    fs.writeFileSync(f, JSON.stringify({ requireMaintainerApproval: "not-bool" }));
    expect(validateGovernanceJson(f, "workflow-policy")).toBe(false);
  });

  it("validates index-policy", () => {
    const cortex = makeCortex();
    const f = path.join(cortex, "test.json");
    fs.writeFileSync(f, JSON.stringify({ includeHidden: "not-bool" }));
    expect(validateGovernanceJson(f, "index-policy")).toBe(false);
  });

});

// --- flushEntryScores ---

describe("flushEntryScores", () => {
  it("writes cached scores to disk", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const key = "proj/file:flush-test";
    recordInjection(cortex, key);
    // Scores are already on disk from recordInjection, but flushEntryScores re-writes
    flushEntryScores(cortex);
    const scoresPath = path.join(cortex, ".runtime", "memory-scores.json");
    const raw = JSON.parse(fs.readFileSync(scoresPath, "utf8"));
    expect(raw.entries[key]).toBeDefined();
  });
});

// --- findCortexPathWithArg ---

describe("findCortexPathWithArg", () => {
  it("resolves an explicit argument path", () => {
    const cortex = makeCortex();
    const result = findCortexPathWithArg(cortex);
    expect(result).toBe(cortex);
  });

  it("throws for non-existent explicit path", () => {
    expect(() => findCortexPathWithArg("/nonexistent/path")).toThrow();
  });

  it("falls back to ensureCortexPath when no arg given", async () => {
    const tmp = makeTempDir("fakehome-");
    const origHome = process.env.HOME;
    process.env.HOME = tmp.path;
    try {
      const result = await suppressOutput(() => Promise.resolve(findCortexPathWithArg()));
      expect(result).toBe(path.join(tmp.path, ".cortex"));
      expect(fs.existsSync(result)).toBe(true);
    } finally {
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

// --- parseCortexErrorCode ---

describe("parseCortexErrorCode", () => {
  it("extracts known error codes from prefixed strings", () => {
    expect(parseCortexErrorCode('PROJECT_NOT_FOUND: "myproj"')).toBe(CortexError.PROJECT_NOT_FOUND);
    expect(parseCortexErrorCode('NOT_FOUND: No item matching "foo"')).toBe(CortexError.NOT_FOUND);
    expect(parseCortexErrorCode("PERMISSION_DENIED: write denied")).toBe(CortexError.PERMISSION_DENIED);
    expect(parseCortexErrorCode("LOCK_TIMEOUT: could not acquire lock")).toBe(CortexError.LOCK_TIMEOUT);
    expect(parseCortexErrorCode("EMPTY_INPUT: field required")).toBe(CortexError.EMPTY_INPUT);
    expect(parseCortexErrorCode("AMBIGUOUS_MATCH: 3 matches")).toBe(CortexError.AMBIGUOUS_MATCH);
    expect(parseCortexErrorCode("MALFORMED_YAML: machines.yaml")).toBe(CortexError.MALFORMED_YAML);
  });

  it("returns undefined for non-error strings", () => {
    expect(parseCortexErrorCode("Added to project task: task")).toBeUndefined();
    expect(parseCortexErrorCode("Marked done in project: item")).toBeUndefined();
    expect(parseCortexErrorCode("")).toBeUndefined();
  });

  it("returns undefined for unknown error codes", () => {
    expect(parseCortexErrorCode("UNKNOWN_CODE: something")).toBeUndefined();
  });
});

// --- CortexResult helpers ---

describe("CortexResult helpers", () => {
  it("cortexOk wraps data", () => {
    const result = cortexOk({ items: [1, 2, 3] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ items: [1, 2, 3] });
  });

  it("cortexErr wraps error with optional code", () => {
    const result = cortexErr("something failed", CortexError.FILE_NOT_FOUND);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("something failed");
      expect(result.code).toBe("FILE_NOT_FOUND");
    }
  });

  it("cortexErr works without code", () => {
    const result = cortexErr("generic error");
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
    ({ path: tmpRoot, cleanup: nativeMemCleanup } = makeTempDir("cortex-native-mem-"));
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

  it("skips MEMORY.md (root memory managed by cortex)", () => {
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
  let cortexDir: string;
  let importCleanup: () => void;

  beforeEach(() => {
    const tmp = makeTempDir("cortex-import-test-");
    cortexDir = tmp.path;
    const sharedDir = path.join(cortexDir, "global", "shared");
    fs.mkdirSync(sharedDir, { recursive: true });
    importCleanup = tmp.cleanup;
  });

  afterEach(() => importCleanup());

  it("returns content unchanged when no imports present", () => {
    const content = "# Hello\n\nNo imports here.";
    expect(resolveImports(content, cortexDir)).toBe(content);
  });

  it("resolves a single @import directive", () => {
    fs.writeFileSync(
      path.join(cortexDir, "global", "shared", "conventions.md"),
      "Always use snake_case."
    );
    const content = "# Project\n\n@import shared/conventions.md\n\nMore text.";
    const result = resolveImports(content, cortexDir);
    expect(result).toContain("Always use snake_case.");
    expect(result).not.toContain("@import");
  });

  it("resolves multiple @import directives", () => {
    fs.writeFileSync(
      path.join(cortexDir, "global", "shared", "a.md"),
      "Content A"
    );
    fs.writeFileSync(
      path.join(cortexDir, "global", "shared", "b.md"),
      "Content B"
    );
    const content = "@import shared/a.md\n@import shared/b.md";
    const result = resolveImports(content, cortexDir);
    expect(result).toContain("Content A");
    expect(result).toContain("Content B");
  });

  it("handles nested imports recursively", () => {
    fs.writeFileSync(
      path.join(cortexDir, "global", "shared", "outer.md"),
      "Outer start\n@import shared/inner.md\nOuter end"
    );
    fs.writeFileSync(
      path.join(cortexDir, "global", "shared", "inner.md"),
      "Inner content"
    );
    const content = "@import shared/outer.md";
    const result = resolveImports(content, cortexDir);
    expect(result).toContain("Outer start");
    expect(result).toContain("Inner content");
    expect(result).toContain("Outer end");
  });

  it("detects circular imports and inserts comment", () => {
    fs.writeFileSync(
      path.join(cortexDir, "global", "shared", "loop-a.md"),
      "@import shared/loop-b.md"
    );
    fs.writeFileSync(
      path.join(cortexDir, "global", "shared", "loop-b.md"),
      "@import shared/loop-a.md"
    );
    const content = "@import shared/loop-a.md";
    const result = resolveImports(content, cortexDir);
    expect(result).toContain("@import cycle:");
  });

  it("handles missing import file gracefully", () => {
    const content = "@import shared/nonexistent.md";
    const result = resolveImports(content, cortexDir);
    expect(result).toContain("@import not found: shared/nonexistent.md");
  });

  it("blocks path traversal attempts", () => {
    const content = "@import ../../etc/passwd";
    const result = resolveImports(content, cortexDir);
    expect(result).toContain("@import blocked: path traversal");
  });

  it("caps recursion depth", () => {
    // Create a chain: d0 -> d1 -> d2 -> d3 -> d4 -> d5 (d5 should not resolve)
    for (let i = 0; i < 6; i++) {
      const next = i < 5 ? `@import shared/d${i + 1}.md` : "deepest";
      fs.writeFileSync(
        path.join(cortexDir, "global", "shared", `d${i}.md`),
        `level-${i}\n${next}`
      );
    }
    const result = resolveImports("@import shared/d0.md", cortexDir);
    expect(result).toContain("level-0");
    expect(result).toContain("level-4");
    // depth 5 should not be resolved (MAX_IMPORT_DEPTH = 5)
    expect(result).toContain("@import shared/d5.md");
  });
});

// --- New error codes (VALIDATION_ERROR, INDEX_ERROR, NETWORK_ERROR) ---

describe("CortexError new codes", () => {
  it("VALIDATION_ERROR exists and is a string", () => {
    expect(CortexError.VALIDATION_ERROR).toBe("VALIDATION_ERROR");
    expect(typeof CortexError.VALIDATION_ERROR).toBe("string");
  });

  it("INDEX_ERROR exists and is a string", () => {
    expect(CortexError.INDEX_ERROR).toBe("INDEX_ERROR");
    expect(typeof CortexError.INDEX_ERROR).toBe("string");
  });

  it("NETWORK_ERROR exists and is a string", () => {
    expect(CortexError.NETWORK_ERROR).toBe("NETWORK_ERROR");
    expect(typeof CortexError.NETWORK_ERROR).toBe("string");
  });

  it("parseCortexErrorCode extracts new codes from prefixed messages", () => {
    expect(parseCortexErrorCode("VALIDATION_ERROR: invalid input")).toBe(CortexError.VALIDATION_ERROR);
    expect(parseCortexErrorCode("INDEX_ERROR: index rebuild failed")).toBe(CortexError.INDEX_ERROR);
    expect(parseCortexErrorCode("NETWORK_ERROR: connection refused")).toBe(CortexError.NETWORK_ERROR);
  });

  it("all 13 CortexError codes are present", () => {
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
    const actualKeys = Object.keys(CortexError);
    expect(actualKeys).toEqual(expect.arrayContaining(expectedKeys));
    expect(actualKeys.length).toBe(expectedKeys.length);
  });
});
