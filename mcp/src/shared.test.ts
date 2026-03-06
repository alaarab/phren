import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  buildIndex,
  queryRows,
  addLearningToFile,
  checkConsolidationNeeded,
  findCortexPath,
  ensureCortexPath,
  detectProject,
  appendAuditLog,
  consolidateProjectLearnings,
  extractSnippet,
  extractConflictVersions,
  mergeLearnings,
  mergeBacklog,
  autoMergeConflicts,
  filterTrustedLearningsDetailed,
  recordMemoryInjection,
  recordMemoryFeedback,
  getMemoryQualityMultiplier,
  memoryScoreKey,
  checkMemoryPermission,
  getAccessControl,
  updateAccessControl,
  enforceCanonicalLocks,
  upsertCanonicalMemory,
} from "./shared.js";
import { isValidProjectName } from "./utils.js";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

let tmpDir: string;

function makeCortex(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-test-"));
  return tmpDir;
}

function grantAdmin(cortexDir: string, actor = "vitest-admin"): void {
  const govDir = path.join(cortexDir, ".governance");
  fs.mkdirSync(govDir, { recursive: true });
  fs.writeFileSync(
    path.join(govDir, "access-control.json"),
    JSON.stringify({ admins: [actor], maintainers: [], contributors: [], viewers: [] }, null, 2) + "\n"
  );
  process.env.CORTEX_ACTOR = actor;
}

function makeProject(cortexDir: string, name: string, files: Record<string, string>): void {
  const dir = path.join(cortexDir, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, file), content);
  }
}

beforeEach(() => {
  delete process.env.CORTEX_PATH;
});

afterEach(() => {
  delete process.env.CORTEX_PATH;
  delete process.env.CORTEX_ACTOR;
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
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

// --- findCortexPath / ensureCortexPath ---

describe("findCortexPath", () => {
  it("returns CORTEX_PATH env var when set", () => {
    const cortex = makeCortex();
    process.env.CORTEX_PATH = cortex;
    expect(findCortexPath()).toBe(cortex);
  });

  it("returns null when no cortex directory exists and no env var", () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "fakehome-"));
    const origHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      expect(findCortexPath()).toBeNull();
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("finds ~/.cortex when it exists", () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "fakehome-"));
    const dotCortex = path.join(fakeHome, ".cortex");
    fs.mkdirSync(dotCortex);
    const origHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      expect(findCortexPath()).toBe(dotCortex);
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

describe("ensureCortexPath", () => {
  it("creates ~/.cortex if nothing exists", () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "fakehome-"));
    const origHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const result = ensureCortexPath();
      expect(result).toBe(path.join(fakeHome, ".cortex"));
      expect(fs.existsSync(result)).toBe(true);
      expect(fs.existsSync(path.join(result, "README.md"))).toBe(true);
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

// --- buildIndex + queryRows ---

describe("buildIndex and queryRows", () => {
  it("indexes markdown files and supports FTS5 search", async () => {
    const cortex = makeCortex();
    makeProject(cortex, "testproj", {
      "LEARNINGS.md": "# testproj LEARNINGS\n\n## 2025-01-01\n\n- Always validate user input before processing\n",
      "summary.md": "# testproj\n\nA test project for vitest.\n",
    });

    const db = await buildIndex(cortex);
    const rows = queryRows(db, "SELECT project, filename FROM docs WHERE docs MATCH ? ORDER BY rank", ["validate"]);
    expect(rows).not.toBeNull();
    expect(rows!.length).toBeGreaterThanOrEqual(1);
    expect(rows![0][0]).toBe("testproj");
    expect(rows![0][1]).toBe("LEARNINGS.md");
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

// --- addLearningToFile ---

describe("addLearningToFile", () => {
  it("creates LEARNINGS.md if it does not exist", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    makeProject(cortex, "newproj", { "summary.md": "# newproj\n" });

    const result = addLearningToFile(cortex, "newproj", "Always use parameterized queries");
    expect(result).toContain("Created LEARNINGS.md");
    const content = fs.readFileSync(path.join(cortex, "newproj", "LEARNINGS.md"), "utf8");
    expect(content).toContain("- Always use parameterized queries");
    expect(content).toContain("cortex:cite");
  });

  it("appends to existing date section", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const today = new Date().toISOString().slice(0, 10);
    makeProject(cortex, "myproj", {
      "LEARNINGS.md": `# myproj LEARNINGS\n\n## ${today}\n\n- Existing learning\n`,
    });

    addLearningToFile(cortex, "myproj", "Second insight");
    const content = fs.readFileSync(path.join(cortex, "myproj", "LEARNINGS.md"), "utf8");
    expect(content).toContain("- Second insight");
    expect(content).toContain("- Existing learning");
    // Should still have only one date heading for today
    const headingCount = (content.match(new RegExp(`## ${today}`, "g")) || []).length;
    expect(headingCount).toBe(1);
  });

  it("rejects invalid project names", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const result = addLearningToFile(cortex, "../etc", "bad");
    expect(result).toContain("Invalid project name");
  });
});

// --- checkConsolidationNeeded ---

describe("checkConsolidationNeeded", () => {
  it("flags projects with 25+ entries since last consolidation", () => {
    const cortex = makeCortex();
    const bullets = Array.from({ length: 26 }, (_, i) => `- Learning number ${i + 1}`).join("\n");
    makeProject(cortex, "bigproj", {
      "LEARNINGS.md": `# bigproj LEARNINGS\n\n## 2025-01-01\n\n${bullets}\n`,
    });

    const results = checkConsolidationNeeded(cortex);
    expect(results.length).toBe(1);
    expect(results[0].project).toBe("bigproj");
    expect(results[0].entriesSince).toBe(26);
  });

  it("does not flag projects under threshold", () => {
    const cortex = makeCortex();
    makeProject(cortex, "smallproj", {
      "LEARNINGS.md": "# smallproj LEARNINGS\n\n## 2025-01-01\n\n- One learning\n- Two learning\n",
    });

    const results = checkConsolidationNeeded(cortex);
    expect(results.length).toBe(0);
  });

  it("counts only entries after the consolidation marker", () => {
    const cortex = makeCortex();
    const oldBullets = Array.from({ length: 30 }, (_, i) => `- Old learning ${i}`).join("\n");
    const newBullets = Array.from({ length: 5 }, (_, i) => `- New learning ${i}`).join("\n");
    makeProject(cortex, "markedproj", {
      "LEARNINGS.md": `# markedproj LEARNINGS\n\n## 2024-01-01\n\n${oldBullets}\n\n<!-- consolidated: 2025-01-01 -->\n\n## 2025-02-01\n\n${newBullets}\n`,
    });

    const results = checkConsolidationNeeded(cortex);
    expect(results.length).toBe(0);
  });

  it("flags time-based consolidation (60+ days, 10+ entries)", () => {
    const cortex = makeCortex();
    const bullets = Array.from({ length: 12 }, (_, i) => `- Learning ${i}`).join("\n");
    makeProject(cortex, "oldproj", {
      "LEARNINGS.md": `# oldproj LEARNINGS\n\n## 2024-06-01\n\n${bullets}\n\n<!-- consolidated: 2024-01-01 -->\n\n## 2024-06-15\n\n${bullets}\n`,
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

    const result = detectProject(cortex, "/home/user/cortex/mcp/src");
    expect(result).toBe("cortex");
  });
});

// --- appendAuditLog rotation ---

describe("appendAuditLog", () => {
  it("appends log entries", () => {
    const cortex = makeCortex();
    appendAuditLog(cortex, "test_event", "details=foo");
    const logPath = path.join(cortex, ".cortex-audit.log");
    expect(fs.existsSync(logPath)).toBe(true);
    const content = fs.readFileSync(logPath, "utf8");
    expect(content).toContain("test_event");
    expect(content).toContain("details=foo");
  });

  it("rotates log when over 1MB", () => {
    const cortex = makeCortex();
    const logPath = path.join(cortex, ".cortex-audit.log");
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

// --- consolidateProjectLearnings dedup ---

describe("consolidateProjectLearnings", () => {
  it("deduplicates entries with normalized whitespace", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    makeProject(cortex, "dedupproj", {
      "LEARNINGS.md": [
        "# dedupproj LEARNINGS",
        "",
        "## 2025-01-01",
        "",
        "- Always  use   parameterized queries",
        "- Always use parameterized queries",
        "- A different learning",
        "",
      ].join("\n"),
    });

    consolidateProjectLearnings(cortex, "dedupproj");
    const content = fs.readFileSync(path.join(cortex, "dedupproj", "LEARNINGS.md"), "utf8");
    const bullets = content.split("\n").filter(l => l.startsWith("- "));
    expect(bullets.length).toBe(2);
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

  beforeEach(() => {
    cortex = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-rbac-"));
  });

  afterEach(() => {
    process.env.CORTEX_ACTOR = origActor;
    fs.rmSync(cortex, { recursive: true, force: true });
  });

  describe("checkMemoryPermission", () => {
    it("admin can perform any action", () => {
      setupAccess({ admins: ["alice"] });
      for (const action of ["read", "write", "queue", "pin", "policy", "delete"] as const) {
        expect(checkMemoryPermission(cortex, action, "alice")).toBeNull();
      }
    });

    it("maintainer can do everything except policy", () => {
      setupAccess({ maintainers: ["bob"] });
      expect(checkMemoryPermission(cortex, "read", "bob")).toBeNull();
      expect(checkMemoryPermission(cortex, "write", "bob")).toBeNull();
      expect(checkMemoryPermission(cortex, "pin", "bob")).toBeNull();
      expect(checkMemoryPermission(cortex, "delete", "bob")).toBeNull();
      expect(checkMemoryPermission(cortex, "policy", "bob")).toContain("Permission denied");
    });

    it("contributor can read, write, and queue but not pin, delete, or policy", () => {
      setupAccess({ contributors: ["carol"] });
      expect(checkMemoryPermission(cortex, "read", "carol")).toBeNull();
      expect(checkMemoryPermission(cortex, "write", "carol")).toBeNull();
      expect(checkMemoryPermission(cortex, "queue", "carol")).toBeNull();
      expect(checkMemoryPermission(cortex, "pin", "carol")).toContain("Permission denied");
      expect(checkMemoryPermission(cortex, "delete", "carol")).toContain("Permission denied");
      expect(checkMemoryPermission(cortex, "policy", "carol")).toContain("Permission denied");
    });

    it("viewer can only read", () => {
      setupAccess({ viewers: ["dave"] });
      expect(checkMemoryPermission(cortex, "read", "dave")).toBeNull();
      expect(checkMemoryPermission(cortex, "write", "dave")).toContain("Permission denied");
      expect(checkMemoryPermission(cortex, "pin", "dave")).toContain("Permission denied");
      expect(checkMemoryPermission(cortex, "policy", "dave")).toContain("Permission denied");
    });

    it("unknown actor gets viewer role (least privilege)", () => {
      setupAccess({ admins: ["alice"] });
      expect(checkMemoryPermission(cortex, "read", "stranger")).toBeNull();
      expect(checkMemoryPermission(cortex, "write", "stranger")).toContain("Permission denied");
    });

    it("denial message includes actor name and role", () => {
      setupAccess({ viewers: ["eve"] });
      const denial = checkMemoryPermission(cortex, "write", "eve");
      expect(denial).toContain("eve");
      expect(denial).toContain("viewer");
      expect(denial).toContain("write");
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

  describe("upsertCanonicalMemory", () => {
    it("creates CANONICAL_MEMORIES.md and locks the entry", () => {
      setupAccess({ admins: ["test-admin"] });
      process.env.CORTEX_ACTOR = "test-admin";
      makeProject(cortex, "pinproj", { "summary.md": "# pinproj" });

      const result = upsertCanonicalMemory(cortex, "pinproj", "Always run tests before pushing");
      expect(result).toContain("Pinned");

      const canonical = fs.readFileSync(
        path.join(cortex, "pinproj", "CANONICAL_MEMORIES.md"),
        "utf8"
      );
      expect(canonical).toContain("Always run tests before pushing");
      expect(canonical).toContain("## Pinned");

      // Lock file should exist
      const lockData = JSON.parse(
        fs.readFileSync(path.join(cortex, ".governance", "canonical-locks.json"), "utf8")
      );
      expect(lockData["pinproj/CANONICAL_MEMORIES.md"]).toBeDefined();
      expect(lockData["pinproj/CANONICAL_MEMORIES.md"].hash).toBeTruthy();
    });

    it("does not duplicate an existing pinned memory", () => {
      setupAccess({ admins: ["test-admin"] });
      process.env.CORTEX_ACTOR = "test-admin";
      makeProject(cortex, "dupproj", { "summary.md": "# dupproj" });

      upsertCanonicalMemory(cortex, "dupproj", "Unique insight");
      upsertCanonicalMemory(cortex, "dupproj", "Unique insight");

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

      const result = upsertCanonicalMemory(cortex, "nopinproj", "Should be denied");
      expect(result).toContain("Permission denied");
      expect(fs.existsSync(path.join(cortex, "nopinproj", "CANONICAL_MEMORIES.md"))).toBe(false);
    });
  });

  describe("updateAccessControl", () => {
    it("admin can update access control", () => {
      setupAccess({ admins: ["boss"] });
      process.env.CORTEX_ACTOR = "boss";

      const result = updateAccessControl(cortex, { contributors: ["newdev"] });
      expect(typeof result).toBe("object");
      expect((result as any).contributors).toContain("newdev");

      const acl = getAccessControl(cortex);
      expect(acl.contributors).toContain("newdev");
    });

    it("non-admin cannot update access control", () => {
      setupAccess({ contributors: ["dev"] });
      process.env.CORTEX_ACTOR = "dev";

      const result = updateAccessControl(cortex, { admins: ["dev"] });
      expect(typeof result).toBe("string");
      expect(result as string).toContain("Permission denied");
    });
  });
});

// --- filterTrustedLearningsDetailed ---

describe("filterTrustedLearningsDetailed", () => {
  it("keeps fresh entries", () => {
    const today = new Date().toISOString().slice(0, 10);
    const content = `# proj LEARNINGS\n\n## ${today}\n\n- Fresh learning\n`;
    const result = filterTrustedLearningsDetailed(content, { ttlDays: 120 });
    expect(result.content).toContain("- Fresh learning");
    expect(result.issues.length).toBe(0);
  });

  it("filters out entries older than ttlDays", () => {
    const content = `# proj LEARNINGS\n\n## 2020-01-01\n\n- Ancient learning\n`;
    const result = filterTrustedLearningsDetailed(content, { ttlDays: 120 });
    expect(result.content).not.toContain("- Ancient learning");
    expect(result.issues.length).toBe(1);
    expect(result.issues[0].reason).toBe("stale");
  });

  it("decays confidence for aging entries without citation", () => {
    const d = new Date();
    d.setDate(d.getDate() - 100);
    const dateStr = d.toISOString().slice(0, 10);
    const content = `# proj LEARNINGS\n\n## ${dateStr}\n\n- Aging learning without citation\n`;
    const result = filterTrustedLearningsDetailed(content, { ttlDays: 200, minConfidence: 0.9 });
    expect(result.issues.length).toBe(1);
    expect(result.issues[0].reason).toBe("stale");
  });

  it("keeps entries with valid citations at higher confidence", () => {
    const d = new Date();
    d.setDate(d.getDate() - 50);
    const dateStr = d.toISOString().slice(0, 10);
    const content = [
      "# proj LEARNINGS",
      "",
      `## ${dateStr}`,
      "",
      "- Learning with citation",
      `  <!-- cortex:cite {"created_at":"${d.toISOString()}"} -->`,
      "",
    ].join("\n");
    const result = filterTrustedLearningsDetailed(content, { ttlDays: 200, minConfidence: 0.3 });
    expect(result.content).toContain("- Learning with citation");
  });

  it("accepts numeric ttlDays shorthand", () => {
    const content = `# proj LEARNINGS\n\n## 2020-01-01\n\n- Old entry\n`;
    const result = filterTrustedLearningsDetailed(content, 30);
    expect(result.content).not.toContain("- Old entry");
    expect(result.issues.length).toBe(1);
  });
});

// --- recordMemoryInjection ---

describe("recordMemoryInjection", () => {
  it("creates and updates score entries", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const key = "testproj/LEARNINGS.md:abc123";

    recordMemoryInjection(cortex, key, "session-1");

    const scoresPath = path.join(cortex, ".governance", "memory-scores.json");
    expect(fs.existsSync(scoresPath)).toBe(true);
    const scores = JSON.parse(fs.readFileSync(scoresPath, "utf8"));
    expect(scores[key]).toBeDefined();
    expect(scores[key].impressions).toBe(1);

    recordMemoryInjection(cortex, key, "session-2");
    const scores2 = JSON.parse(fs.readFileSync(scoresPath, "utf8"));
    expect(scores2[key].impressions).toBe(2);
  });

  it("appends to usage log", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const key = "testproj/LEARNINGS.md:def456";

    recordMemoryInjection(cortex, key, "sess-42");

    const logPath = path.join(cortex, ".governance", "memory-usage.log");
    expect(fs.existsSync(logPath)).toBe(true);
    const logContent = fs.readFileSync(logPath, "utf8");
    expect(logContent).toContain("inject");
    expect(logContent).toContain("sess-42");
    expect(logContent).toContain(key);
  });
});

// --- recordMemoryFeedback ---

describe("recordMemoryFeedback", () => {
  it("records helpful feedback", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const key = "proj/file:aaa";

    recordMemoryInjection(cortex, key);
    recordMemoryFeedback(cortex, key, "helpful");

    const scores = JSON.parse(
      fs.readFileSync(path.join(cortex, ".governance", "memory-scores.json"), "utf8")
    );
    expect(scores[key].helpful).toBe(1);
    expect(scores[key].repromptPenalty).toBe(0);
  });

  it("records reprompt penalty", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const key = "proj/file:bbb";

    recordMemoryInjection(cortex, key);
    recordMemoryFeedback(cortex, key, "reprompt");

    const scores = JSON.parse(
      fs.readFileSync(path.join(cortex, ".governance", "memory-scores.json"), "utf8")
    );
    expect(scores[key].repromptPenalty).toBe(1);
  });

  it("records regression penalty", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const key = "proj/file:ccc";

    recordMemoryInjection(cortex, key);
    recordMemoryFeedback(cortex, key, "regression");

    const scores = JSON.parse(
      fs.readFileSync(path.join(cortex, ".governance", "memory-scores.json"), "utf8")
    );
    expect(scores[key].regressionPenalty).toBe(1);
  });
});

// --- getMemoryQualityMultiplier ---

describe("getMemoryQualityMultiplier", () => {
  it("returns 1 for unknown keys", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    expect(getMemoryQualityMultiplier(cortex, "unknown/key:xyz")).toBe(1);
  });

  it("returns > 1 for helpful memories", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const key = "proj/file:helpful";

    recordMemoryInjection(cortex, key);
    recordMemoryFeedback(cortex, key, "helpful");
    recordMemoryFeedback(cortex, key, "helpful");
    recordMemoryFeedback(cortex, key, "helpful");

    const mult = getMemoryQualityMultiplier(cortex, key);
    expect(mult).toBeGreaterThan(1);
  });

  it("returns < 1 for penalized memories", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);
    const key = "proj/file:bad";

    recordMemoryInjection(cortex, key);
    recordMemoryFeedback(cortex, key, "regression");
    recordMemoryFeedback(cortex, key, "reprompt");

    const mult = getMemoryQualityMultiplier(cortex, key);
    expect(mult).toBeLessThan(1);
  });

  it("clamps between 0.2 and 1.5", () => {
    const cortex = makeCortex();
    grantAdmin(cortex);

    const goodKey = "proj/file:great";
    recordMemoryInjection(cortex, goodKey);
    for (let i = 0; i < 20; i++) recordMemoryFeedback(cortex, goodKey, "helpful");
    expect(getMemoryQualityMultiplier(cortex, goodKey)).toBeLessThanOrEqual(1.5);

    const badKey = "proj/file:terrible";
    recordMemoryInjection(cortex, badKey);
    for (let i = 0; i < 20; i++) recordMemoryFeedback(cortex, badKey, "regression");
    expect(getMemoryQualityMultiplier(cortex, badKey)).toBeGreaterThanOrEqual(0.2);
  });
});

// --- memoryScoreKey ---

describe("memoryScoreKey", () => {
  it("generates a deterministic key", () => {
    const k1 = memoryScoreKey("proj", "LEARNINGS.md", "some snippet");
    const k2 = memoryScoreKey("proj", "LEARNINGS.md", "some snippet");
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^proj\/LEARNINGS\.md:[a-f0-9]{12}$/);
  });

  it("produces different keys for different snippets", () => {
    const k1 = memoryScoreKey("proj", "LEARNINGS.md", "snippet one");
    const k2 = memoryScoreKey("proj", "LEARNINGS.md", "snippet two");
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

// --- mergeLearnings ---

describe("mergeLearnings (shared.test)", () => {
  it("combines entries from both sides under the same date", () => {
    const ours = "# LEARNINGS\n\n## 2025-01-15\n\n- Our insight\n";
    const theirs = "# LEARNINGS\n\n## 2025-01-15\n\n- Their insight\n";
    const merged = mergeLearnings(ours, theirs);
    expect(merged).toContain("- Our insight");
    expect(merged).toContain("- Their insight");
  });

  it("deduplicates identical entries", () => {
    const content = "# LEARNINGS\n\n## 2025-03-01\n\n- Same entry\n";
    const merged = mergeLearnings(content, content);
    const count = (merged.match(/- Same entry/g) || []).length;
    expect(count).toBe(1);
  });

  it("sorts dates newest first", () => {
    const ours = "# LEARNINGS\n\n## 2024-01-01\n\n- Old\n";
    const theirs = "# LEARNINGS\n\n## 2025-06-15\n\n- New\n";
    const merged = mergeLearnings(ours, theirs);
    expect(merged.indexOf("2025-06-15")).toBeLessThan(merged.indexOf("2024-01-01"));
  });

  it("preserves the title from ours", () => {
    const ours = "# My Project LEARNINGS\n\n## 2025-01-01\n\n- A\n";
    const theirs = "# Other Title\n\n## 2025-01-01\n\n- B\n";
    const merged = mergeLearnings(ours, theirs);
    expect(merged.startsWith("# My Project LEARNINGS")).toBe(true);
  });

  it("merges dates that only exist on one side", () => {
    const ours = "# LEARNINGS\n\n## 2025-01-01\n\n- Ours only\n";
    const theirs = "# LEARNINGS\n\n## 2025-02-01\n\n- Theirs only\n";
    const merged = mergeLearnings(ours, theirs);
    expect(merged).toContain("- Ours only");
    expect(merged).toContain("- Theirs only");
    expect(merged).toContain("## 2025-01-01");
    expect(merged).toContain("## 2025-02-01");
  });
});

// --- mergeBacklog ---

describe("mergeBacklog (shared.test)", () => {
  it("combines items from both sides", () => {
    const ours = "# backlog\n\n## Active\n\n- Our task\n\n## Queue\n\n## Done\n";
    const theirs = "# backlog\n\n## Active\n\n- Their task\n\n## Queue\n\n## Done\n";
    const merged = mergeBacklog(ours, theirs);
    expect(merged).toContain("- Our task");
    expect(merged).toContain("- Their task");
  });

  it("deduplicates identical items across sides", () => {
    const content = "# backlog\n\n## Active\n\n- Same task\n\n## Queue\n\n## Done\n";
    const merged = mergeBacklog(content, content);
    const count = (merged.match(/- Same task/g) || []).length;
    expect(count).toBe(1);
  });

  it("orders sections Active, Queue, Done first", () => {
    const content = "# backlog\n\n## Done\n\n- D\n\n## Active\n\n- A\n\n## Queue\n\n- Q\n";
    const merged = mergeBacklog(content, content);
    const activeIdx = merged.indexOf("## Active");
    const queueIdx = merged.indexOf("## Queue");
    const doneIdx = merged.indexOf("## Done");
    expect(activeIdx).toBeLessThan(queueIdx);
    expect(queueIdx).toBeLessThan(doneIdx);
  });

  it("preserves title from ours", () => {
    const ours = "# My Backlog\n\n## Active\n\n## Queue\n\n## Done\n";
    const theirs = "# Other\n\n## Active\n\n## Queue\n\n## Done\n";
    const merged = mergeBacklog(ours, theirs);
    expect(merged.startsWith("# My Backlog")).toBe(true);
  });

  it("merges items from different sections", () => {
    const ours = "# backlog\n\n## Active\n\n- Active task\n\n## Queue\n\n## Done\n";
    const theirs = "# backlog\n\n## Active\n\n## Queue\n\n- Queued task\n\n## Done\n";
    const merged = mergeBacklog(ours, theirs);
    expect(merged).toContain("- Active task");
    expect(merged).toContain("- Queued task");
  });
});

// --- autoMergeConflicts ---

describe("autoMergeConflicts", () => {
  let gitDir: string;

  function initGitRepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-automerge-"));
    const { execFileSync } = require("child_process");
    execFileSync("git", ["init", dir], { stdio: "ignore" });
    execFileSync("git", ["-C", dir, "config", "user.email", "test@test.com"], { stdio: "ignore" });
    execFileSync("git", ["-C", dir, "config", "user.name", "test"], { stdio: "ignore" });
    return dir;
  }

  function commitFile(dir: string, filename: string, content: string, message: string) {
    const { execFileSync } = require("child_process");
    const fullPath = path.join(dir, filename);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
    execFileSync("git", ["-C", dir, "add", "-f", filename], { stdio: "ignore" });
    execFileSync("git", ["-C", dir, "commit", "-m", message], { stdio: "ignore" });
  }

  beforeEach(() => {
    gitDir = initGitRepo();
  });

  afterEach(() => {
    if (gitDir && fs.existsSync(gitDir)) {
      fs.rmSync(gitDir, { recursive: true, force: true });
    }
  });

  it("returns true when there are no conflicted files", () => {
    // Just an empty repo with one commit
    commitFile(gitDir, "README.md", "hello", "init");
    expect(autoMergeConflicts(gitDir)).toBe(true);
  });

  it("auto-merges a conflicted LEARNINGS.md", () => {
    const { execFileSync } = require("child_process");

    // Create base commit with a shared file
    commitFile(gitDir, "proj/LEARNINGS.md", "# proj LEARNINGS\n\n## 2025-01-01\n\n- Base entry\n", "base");

    // Create a branch with a different entry
    execFileSync("git", ["-C", gitDir, "checkout", "-b", "branch-a"], { stdio: "pipe" });
    fs.writeFileSync(
      path.join(gitDir, "proj", "LEARNINGS.md"),
      "# proj LEARNINGS\n\n## 2025-01-01\n\n- Branch A entry\n"
    );
    execFileSync("git", ["-C", gitDir, "add", "-f", "proj/LEARNINGS.md"], { stdio: "ignore" });
    execFileSync("git", ["-C", gitDir, "commit", "-m", "branch-a change"], { stdio: "ignore" });

    // Go back to master and create a conflicting entry
    execFileSync("git", ["-C", gitDir, "checkout", "master"], { stdio: "pipe" });
    fs.writeFileSync(
      path.join(gitDir, "proj", "LEARNINGS.md"),
      "# proj LEARNINGS\n\n## 2025-01-01\n\n- Master entry\n"
    );
    execFileSync("git", ["-C", gitDir, "add", "-f", "proj/LEARNINGS.md"], { stdio: "ignore" });
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

    if (!status.includes("LEARNINGS.md")) {
      return;
    }

    const resolved = autoMergeConflicts(gitDir);
    expect(resolved).toBe(true);

    const content = fs.readFileSync(path.join(gitDir, "proj", "LEARNINGS.md"), "utf8");
    expect(content).toContain("Branch A entry");
    expect(content).toContain("Master entry");
    expect(content).not.toContain("<<<<<<<");
  });

  it("auto-merges a conflicted backlog.md", () => {
    const { execFileSync } = require("child_process");

    commitFile(gitDir, "proj/backlog.md", "# backlog\n\n## Active\n\n- Base task\n\n## Queue\n\n## Done\n", "base");

    execFileSync("git", ["-C", gitDir, "checkout", "-b", "branch-b"], { stdio: "pipe" });
    fs.writeFileSync(
      path.join(gitDir, "proj", "backlog.md"),
      "# backlog\n\n## Active\n\n- Branch task\n\n## Queue\n\n## Done\n"
    );
    execFileSync("git", ["-C", gitDir, "add", "-f", "proj/backlog.md"], { stdio: "ignore" });
    execFileSync("git", ["-C", gitDir, "commit", "-m", "branch change"], { stdio: "ignore" });

    execFileSync("git", ["-C", gitDir, "checkout", "master"], { stdio: "pipe" });
    fs.writeFileSync(
      path.join(gitDir, "proj", "backlog.md"),
      "# backlog\n\n## Active\n\n- Master task\n\n## Queue\n\n## Done\n"
    );
    execFileSync("git", ["-C", gitDir, "add", "-f", "proj/backlog.md"], { stdio: "ignore" });
    execFileSync("git", ["-C", gitDir, "commit", "-m", "master change"], { stdio: "ignore" });

    try {
      execFileSync("git", ["-C", gitDir, "merge", "branch-b"], { stdio: "ignore" });
    } catch {
      // Expected conflict
    }

    const status = execFileSync("git", ["-C", gitDir, "diff", "--name-only", "--diff-filter=U"], {
      encoding: "utf8",
    }).trim();

    if (!status.includes("backlog.md")) {
      return;
    }

    const resolved = autoMergeConflicts(gitDir);
    expect(resolved).toBe(true);

    const content = fs.readFileSync(path.join(gitDir, "proj", "backlog.md"), "utf8");
    expect(content).toContain("Branch task");
    expect(content).toContain("Master task");
    expect(content).not.toContain("<<<<<<<");
  });

  it("returns false for non-mergeable conflicted files", () => {
    const { execFileSync } = require("child_process");

    commitFile(gitDir, "config.json", '{"key": "base"}', "base");

    execFileSync("git", ["-C", gitDir, "checkout", "-b", "branch-c"], { stdio: "pipe" });
    fs.writeFileSync(path.join(gitDir, "config.json"), '{"key": "branch"}');
    execFileSync("git", ["-C", gitDir, "add", "-f", "config.json"], { stdio: "ignore" });
    execFileSync("git", ["-C", gitDir, "commit", "-m", "branch change"], { stdio: "ignore" });

    execFileSync("git", ["-C", gitDir, "checkout", "master"], { stdio: "pipe" });
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
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-nongit-"));
    try {
      expect(autoMergeConflicts(nonGit)).toBe(false);
    } finally {
      fs.rmSync(nonGit, { recursive: true, force: true });
    }
  });
});
