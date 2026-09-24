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
  ensurePhrenPath,
  normalizeProjectNameForCreate,
  parsePhrenErrorCode,
  expandHomePath,
  homePath,
  hookConfigPath,
} from "./shared.js";
import {
  consolidateProjectFindings,
  validateGovernanceJson,
  getRuntimeHealth,
  updateRuntimeHealth,
  appendReviewQueue,
  pruneDeadMemories,
} from "./shared/governance.js";
import {
  buildIndex,
  queryRows,
  detectProject,
  resolveImports,
  extractSnippet,
} from "./shared/index.js";
import {
  addFindingToFile,
  checkConsolidationNeeded,
  mergeTask,
  isAutoMergeableStorePath,
  autoMergeConflicts,
  filterTrustedFindingsDetailed,
  upsertCanonical,
  stripTaskDoneSection,
  isDuplicateFinding,
  extractConflictVersions,
} from "./shared/content.js";
import { isValidProjectName } from "./utils.js";
import { grantAdmin, initTestPhrenRoot, makeTempDir, resetTestPhrenPath, suppressOutput } from "./test-helpers.js";
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

beforeEach(() => {
  resetTestPhrenPath();
});

afterEach(() => {
  resetTestPhrenPath();
  delete process.env.PHREN_ACTOR;
  if (tmpCleanup) {
    tmpCleanup();
    tmpCleanup = undefined;
  }
});

// --- isValidProjectName ---

describe("isValidProjectName", () => {
  it("accepts simple names and rejects traversal, empty and slashed ones", () => {
    for (const name of ["my-project", "phren", "foo_bar"]) expect(isValidProjectName(name)).toBe(true);
    for (const name of ["../etc", "foo/../../bar", "..", "", "foo/bar", "foo\\bar"]) {
      expect(isValidProjectName(name), name).toBe(false);
    }
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
    // Resolved without PHREN_PATH, from a temp cwd.
    delete process.env.PHREN_PATH;
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
    // Resolved without PHREN_PATH, from a temp cwd.
    delete process.env.PHREN_PATH;
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
    // Resolved without PHREN_PATH, from a temp cwd.
    delete process.env.PHREN_PATH;
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
    // Resolved without PHREN_PATH, from a temp cwd.
    delete process.env.PHREN_PATH;
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

// --- addFindingToFile ---

describe("addFindingToFile", () => {
  it("creates FINDINGS.md if it does not exist", () => {
    const phren = makePhren();
    grantAdmin(phren);
    makeProject(phren, "newproj", { "summary.md": "# newproj\n" });

    const result = addFindingToFile(phren, "newproj", "Always use parameterized queries");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.status).toBe("created");
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
    expect(addFindingToFile(phren, "", "bad").ok).toBe(false);
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
    if (result.ok) expect(result.data.status).toBe("skipped");
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
    if (result.ok) expect(result.data.status).toBe("added");
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
    expect(lines.length).toBeLessThanOrEqual(1000);
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

  it("accepts numeric ttlDays shorthand", () => {
    const content = `# proj FINDINGS\n\n## 2020-01-01\n\n- Old entry\n`;
    const result = filterTrustedFindingsDetailed(content, 30);
    expect(result.content).not.toContain("- Old entry");
    expect(result.issues.length).toBe(1);
  });
});

// --- recordInjection ---

// --- recordFeedback ---

// --- getQualityMultiplier ---

// --- entryScoreKey ---

// --- extractConflictVersions ---

describe("extractConflictVersions", () => {
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

// --- mergeTask ---

describe("mergeTask (shared.test)", () => {
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

  it("limits union merges to findings, tasks, and root task archives", () => {
    expect(isAutoMergeableStorePath("demo/FINDINGS.md")).toBe(true);
    expect(isAutoMergeableStorePath("demo/tasks.md")).toBe(true);
    expect(isAutoMergeableStorePath(".config/task-archive/demo.md")).toBe(true);
    expect(isAutoMergeableStorePath("demo/archive.md")).toBe(false);
    expect(isAutoMergeableStorePath("demo/.config/task-archive/other.md")).toBe(false);
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
  it("replaces arrays entirely (no deep merge on arrays)", () => {
    const result = withDefaults(
      { items: ["new"] } as any,
      { items: ["old1", "old2"] } as any
    );
    expect(result).toEqual({ items: ["new"] });
  });
});

// --- validateFindingsFormat ---

// --- validateTaskFormat ---

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
    const govDir = path.join(phren, ".config");
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
      expect(result.data.message).toContain("[dry-run]");
      expect(result.data.message).toContain("1");
      expect(result.data.pruned).toBe(1);
    }
    // File should be unchanged in dry-run
    const content = fs.readFileSync(path.join(phren, "pruneproj", "FINDINGS.md"), "utf8");
    expect(content).toContain("Very old entry");
  });
});

// --- getRetentionPolicy / updateRetentionPolicy ---

// --- getWorkflowPolicy / updateWorkflowPolicy ---

// --- getIndexPolicy / updateIndexPolicy ---

// --- getRuntimeHealth / updateRuntimeHealth ---

describe("getRuntimeHealth and updateRuntimeHealth", () => {
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
  it("returns 0 for empty entries", () => {
    const phren = makePhren();
    grantAdmin(phren);
    makeProject(phren, "emptyq", { "summary.md": "# emptyq\n" });
    const emptyResult = appendReviewQueue(phren, "emptyq", "Stale", []);
    expect(emptyResult.ok).toBe(true);
    if (emptyResult.ok) expect(emptyResult.data).toBe(0);
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
    fs.mkdirSync(path.join(phren, ".config"), { recursive: true });
    fs.mkdirSync(path.join(phren, "profiles"), { recursive: true });
    fs.mkdirSync(path.join(phren, "templates"), { recursive: true });
    fs.mkdirSync(path.join(phren, "global"), { recursive: true });

    const dirs = getProjectDirs(phren);
    const names = dirs.map(d => path.basename(d));
    expect(names).toContain("proj-a");
    expect(names).toContain("proj-b");
    expect(names).not.toContain(".config");
    expect(names).not.toContain("profiles");
    expect(names).not.toContain("templates");
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
});

// --- filterTrustedFindingsDetailed (extended) ---

describe("filterTrustedFindingsDetailed (extended)", () => {
  it("strips <details> blocks from input", () => {
    // Use a recent date for the active finding so it stays within the TTL
    // regardless of when the suite runs (avoids a date-bomb failure).
    const recent = new Date();
    recent.setDate(recent.getDate() - 30);
    const recentStr = recent.toISOString().slice(0, 10);
    const content = [
      "# proj FINDINGS",
      "",
      "<details>",
      "## 2025-01-01",
      "- Archived finding",
      "</details>",
      "",
      `## ${recentStr}`,
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

    // Positive control: generous decay keeps the same uncited entry.
    const kept = filterTrustedFindingsDetailed(content, {
      ttlDays: 365,
      minConfidence: 0.3,
      decay: { d30: 1.0, d60: 1.0, d90: 0.9, d120: 0.8 },
    });
    expect(kept.content).toContain("Decaying uncited finding");
    expect(kept.issues.length).toBe(0);
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
    // Resolved without PHREN_PATH, from a temp cwd.
    delete process.env.PHREN_PATH;
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
});

// --- PhrenResult helpers ---

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
    // A second project-key directory is collected too.
    const otherDir = path.join(tmpRoot, ".claude", "projects", "other-key", "memory");
    fs.mkdirSync(otherDir, { recursive: true });
    fs.writeFileSync(path.join(otherDir, "MEMORY-docs.md"), "# Docs Notes");
    const result = collectNativeMemoryFiles();
    expect(result).toHaveLength(3);
    const projects = result.map(r => r.project).sort();
    expect(projects).toEqual(["backend", "docs", "myapp"]);
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
  it("parsePhrenErrorCode extracts new codes from prefixed messages", () => {
    expect(parsePhrenErrorCode("VALIDATION_ERROR: invalid input")).toBe(PhrenError.VALIDATION_ERROR);
    expect(parsePhrenErrorCode("INDEX_ERROR: index rebuild failed")).toBe(PhrenError.INDEX_ERROR);
    expect(parsePhrenErrorCode("NETWORK_ERROR: connection refused")).toBe(PhrenError.NETWORK_ERROR);
  });
});

describe("nativeMemoryEnabled", () => {
  it("is off unless PHREN_FEATURE_NATIVE_MEMORY asks for it", async () => {
    const { nativeMemoryEnabled } = await import("./phren-paths.js");
    expect(nativeMemoryEnabled({})).toBe(false);
    expect(nativeMemoryEnabled({ PHREN_FEATURE_NATIVE_MEMORY: "0" })).toBe(false);
    expect(nativeMemoryEnabled({ PHREN_FEATURE_NATIVE_MEMORY: "1" })).toBe(true);
    expect(nativeMemoryEnabled({ PHREN_FEATURE_NATIVE_MEMORY: "true" })).toBe(true);
  });
});
