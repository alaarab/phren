import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { grantAdmin, makeTempDir } from "./test-helpers.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const CLI_PATH = path.resolve(__dirname, "../dist/index.js");

function runCli(args: string[], env: Record<string, string> = {}): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15000,
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout?.toString() || "",
      stderr: err.stderr?.toString() || "",
      exitCode: err.status ?? 1,
    };
  }
}

function setupCortexDir(): { cortexDir: string; cleanup: () => void } {
  const tmp = makeTempDir("cortex-cli-test-");
  const cortexDir = path.join(tmp.path, ".cortex");
  fs.mkdirSync(cortexDir, { recursive: true });
  grantAdmin(cortexDir, "cli-test");

  return {
    cortexDir,
    cleanup: tmp.cleanup,
  };
}

describe("CLI integration: search", () => {
  let cortexDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ cortexDir, cleanup } = setupCortexDir());
    // Create a project with searchable content
    const projDir = path.join(cortexDir, "test-proj");
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(
      path.join(projDir, "LEARNINGS.md"),
      "# test-proj LEARNINGS\n\n## 2025-01-01\n\n- Always restart the server after config changes\n"
    );
    fs.writeFileSync(
      path.join(projDir, "summary.md"),
      "# test-proj\n\nA test project for CLI integration tests.\n"
    );
    fs.writeFileSync(
      path.join(projDir, "SEARCH_STRONG.md"),
      "# Strong\n\nrestart server restart server cache invalidation details\n"
    );
    fs.writeFileSync(
      path.join(projDir, "SEARCH_WEAK.md"),
      "# Weak\n\nrestart notes only\n"
    );
  });

  afterEach(() => cleanup());

  it("returns matching results for a known query", () => {
    const { stdout, exitCode } = runCli(
      ["search", "restart", "server"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("restart");
  });

  it("exits with error when no query is provided", () => {
    const { stderr, exitCode } = runCli(
      ["search"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("query");
  });

  it("filters by project with --project flag", () => {
    const { stdout, exitCode } = runCli(
      ["search", "--project", "test-proj"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("test-proj");
  });

  it("search pipeline sanitizes query operators and still matches expected docs", () => {
    const { stdout, exitCode } = runCli(
      ["search", 'content:restart AND server OR "^cache"', "--project", "test-proj"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("[test-proj/SEARCH_STRONG.md]");
  });

  it("search pipeline ranks stronger match ahead of weaker match", () => {
    const { stdout, exitCode } = runCli(
      ["search", "restart server", "--project", "test-proj"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    const strongIdx = stdout.indexOf("[test-proj/SEARCH_STRONG.md]");
    const weakIdx = stdout.indexOf("[test-proj/SEARCH_WEAK.md]");
    expect(strongIdx).toBeGreaterThanOrEqual(0);
    expect(weakIdx).toBeGreaterThanOrEqual(0);
    expect(strongIdx).toBeLessThan(weakIdx);
  });
});

describe("CLI integration: doctor", () => {
  let cortexDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ cortexDir, cleanup } = setupCortexDir());
  });

  afterEach(() => cleanup());

  it("outputs health check results", () => {
    const { stdout, stderr, exitCode } = runCli(
      ["doctor"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    const output = stdout + stderr;
    expect(output).toContain("cortex doctor:");
    // Should contain check lines with ok or fail
    expect(output).toMatch(/- (ok|fail) /);
  });

  it("--fix flag runs without crashing", () => {
    const { stdout, stderr } = runCli(
      ["doctor", "--fix"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    const output = stdout + stderr;
    expect(output).toContain("cortex doctor:");
  });
});

describe("CLI integration: add-learning", () => {
  let cortexDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ cortexDir, cleanup } = setupCortexDir());
    const projDir = path.join(cortexDir, "test-proj");
    fs.mkdirSync(projDir, { recursive: true });
  });

  afterEach(() => cleanup());

  it("writes a learning to LEARNINGS.md", () => {
    const { stdout, exitCode } = runCli(
      ["add-learning", "test-proj", "cache invalidation matters"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("added insight");

    const learningsPath = path.join(cortexDir, "test-proj", "LEARNINGS.md");
    expect(fs.existsSync(learningsPath)).toBe(true);
    const content = fs.readFileSync(learningsPath, "utf8");
    expect(content).toContain("cache invalidation matters");
  });

  it("exits with error when project or learning is missing", () => {
    const { stderr, exitCode } = runCli(
      ["add-learning"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Usage");
  });
});

describe("CLI integration: pin-memory", () => {
  let cortexDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ cortexDir, cleanup } = setupCortexDir());
    const projDir = path.join(cortexDir, "test-proj");
    fs.mkdirSync(projDir, { recursive: true });
  });

  afterEach(() => cleanup());

  it("writes a pinned memory to CANONICAL_MEMORIES.md", () => {
    const { stdout, exitCode } = runCli(
      ["pin-memory", "test-proj", "always use UTC timestamps"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);

    const canonicalPath = path.join(cortexDir, "test-proj", "CANONICAL_MEMORIES.md");
    expect(fs.existsSync(canonicalPath)).toBe(true);
    const content = fs.readFileSync(canonicalPath, "utf8");
    expect(content).toContain("always use UTC timestamps");
    expect(content).toContain("pinned");
  });

  it("exits with error when project or memory is missing", () => {
    const { stderr, exitCode } = runCli(
      ["pin-memory"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Usage");
  });
});

describe("CLI integration: maintain migrate", () => {
  let cortexDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ cortexDir, cleanup } = setupCortexDir());
    const projectDir = path.join(cortexDir, "test-proj");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "FINDINGS.md"),
      "# Findings\n\n- Use explicit timezone handling\n- Retry transient failures\n"
    );
  });

  afterEach(() => cleanup());

  it("supports governance migration dry-run with readable output", () => {
    const accessPath = path.join(cortexDir, ".governance", "access-control.json");
    const before = JSON.parse(fs.readFileSync(accessPath, "utf8")) as Record<string, unknown>;
    expect(before.schemaVersion).toBeUndefined();

    const { stdout, exitCode } = runCli(
      ["maintain", "migrate", "governance", "--dry-run"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Governance migration:");
    expect(stdout).toContain("[dry-run]");

    const after = JSON.parse(fs.readFileSync(accessPath, "utf8")) as Record<string, unknown>;
    expect(after.schemaVersion).toBeUndefined();
  });

  it("supports explicit data migration command path", () => {
    const { stdout, exitCode } = runCli(
      ["maintain", "migrate", "data", "test-proj", "--dry-run"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Data migration (test-proj):");
    expect(stdout).toContain("Found");
    expect(stdout).toContain("migratable findings");
  });
});

describe("CLI integration: destructive backup reporting", () => {
  let cortexDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ cortexDir, cleanup } = setupCortexDir());
    const projectDir = path.join(cortexDir, "test-proj");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "LEARNINGS.md"),
      "# test-proj LEARNINGS\n\n## 2020-01-01\n\n- old memory to prune\n\n## 2026-01-01\n\n- fresh memory\n"
    );
  });

  afterEach(() => cleanup());

  it("prune --dry-run does not create backups", () => {
    const backupPath = path.join(cortexDir, "test-proj", "LEARNINGS.md.bak");
    const { stdout, exitCode } = runCli(
      ["maintain", "prune", "test-proj", "--dry-run"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("[dry-run]");
    expect(fs.existsSync(backupPath)).toBe(false);
  });

  it("prune reports updated backup paths on write", () => {
    const backupPath = path.join(cortexDir, "test-proj", "LEARNINGS.md.bak");
    const { stdout, exitCode } = runCli(
      ["maintain", "prune", "test-proj"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Pruned");
    expect(stdout).toContain("Updated backups (1): test-proj/LEARNINGS.md.bak");
    expect(fs.existsSync(backupPath)).toBe(true);
  });

  it("consolidate reports updated backup paths on write", () => {
    const backupPath = path.join(cortexDir, "test-proj", "LEARNINGS.md.bak");
    const { stdout, exitCode } = runCli(
      ["maintain", "consolidate", "test-proj"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Consolidated learnings for test-proj.");
    expect(stdout).toContain("Updated backups (1): test-proj/LEARNINGS.md.bak");
    expect(fs.existsSync(backupPath)).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// NEW TESTS: search edge cases
// ────────────────────────────────────────────────────────────────────────────

describe("CLI integration: search edge cases", () => {
  let cortexDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ cortexDir, cleanup } = setupCortexDir());
    const projDir = path.join(cortexDir, "alpha");
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, "LEARNINGS.md"), "# alpha LEARNINGS\n\n## 2025-06-01\n\n- caching layer timeout fix\n- database connection pool sizing\n");
    fs.writeFileSync(path.join(projDir, "summary.md"), "# alpha\n\n**What:** A caching project\n");
    fs.writeFileSync(path.join(projDir, "backlog.md"), "# alpha Backlog\n\n## Active\n\n- Implement retry logic\n\n## Queue\n\n- Refactor config loader\n\n## Done\n\n- Initial setup\n");
    fs.writeFileSync(path.join(projDir, "CANONICAL_MEMORIES.md"), "# Canonical\n\n- Always use UTC timestamps (pinned)\n");
    fs.writeFileSync(path.join(projDir, "CLAUDE.md"), "# alpha\n\nProject-level instructions for alpha.\n");
  });

  afterEach(() => cleanup());

  it("--type learnings filters to learnings docs only", () => {
    const { stdout, exitCode } = runCli(
      ["search", "caching", "--project", "alpha", "--type", "learnings"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("LEARNINGS");
  });

  it("--type skills is aliased to skill", () => {
    const { stdout, exitCode } = runCli(
      ["search", "deploy", "--type", "skills"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    // Should not error about invalid type
    expect(exitCode).toBe(0);
  });

  it("invalid --type exits with error", () => {
    const { stderr, exitCode } = runCli(
      ["search", "caching", "--type", "nonsense"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('Invalid --type value: "nonsense"');
  });

  it("--all sets limit to 100 and returns results", () => {
    const { stdout, exitCode } = runCli(
      ["search", "caching", "--project", "alpha", "--all"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("caching");
  });

  it("--limit flag restricts result count", () => {
    const { stdout, exitCode } = runCli(
      ["search", "caching", "--project", "alpha", "--limit", "1"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
  });

  it("invalid --limit value exits with error", () => {
    const { stderr, exitCode } = runCli(
      ["search", "caching", "--limit", "abc"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Invalid --limit value");
  });

  it("--limit 0 exits with error", () => {
    const { stderr, exitCode } = runCli(
      ["search", "caching", "--limit", "0"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Invalid --limit value");
  });

  it("--limit 201 exits with error", () => {
    const { stderr, exitCode } = runCli(
      ["search", "caching", "--limit", "201"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Invalid --limit value");
  });

  it("unknown search flag exits with error", () => {
    const { stderr, exitCode } = runCli(
      ["search", "caching", "--verbose"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Unknown search flag");
  });

  it("--help flag prints usage without error", () => {
    const { stderr, exitCode } = runCli(
      ["search", "--help"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    // --help causes early return (null), which exits 0
    expect(exitCode).toBe(0);
  });

  it("search with inline --project=alpha format works", () => {
    const { stdout, exitCode } = runCli(
      ["search", "caching", "--project=alpha"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("alpha");
  });

  it("search with --project alone (browse mode) returns results", () => {
    const { stdout, exitCode } = runCli(
      ["search", "--project", "alpha"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("alpha");
  });

  it("invalid project name exits with error", () => {
    const { stderr, exitCode } = runCli(
      ["search", "test", "--project", "../escape"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Invalid project name");
  });

  it("search with --type canonical filters correctly", () => {
    const { stdout, exitCode } = runCli(
      ["search", "UTC", "--project", "alpha", "--type", "canonical"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
  });

  it("search for nonexistent term returns zero results gracefully", () => {
    const { stdout, exitCode } = runCli(
      ["search", "xyznonexistent123"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("No results found");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// NEW TESTS: config subcommands
// ────────────────────────────────────────────────────────────────────────────

describe("CLI integration: config subcommands", () => {
  let cortexDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ cortexDir, cleanup } = setupCortexDir());
  });

  afterEach(() => cleanup());

  it("config with no subcommand prints help", () => {
    const { stdout, exitCode } = runCli(
      ["config"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("cortex config");
    expect(stdout).toContain("Subcommands:");
  });

  it("config with unknown subcommand exits with error", () => {
    const { stderr, exitCode } = runCli(
      ["config", "bogus"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('Unknown config subcommand: "bogus"');
  });

  it("config policy get returns JSON", () => {
    const { stdout, exitCode } = runCli(
      ["config", "policy", "get"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("ttlDays");
    expect(parsed).toHaveProperty("retentionDays");
    expect(parsed).toHaveProperty("decay");
  });

  it("config policy with no args defaults to get", () => {
    const { stdout, exitCode } = runCli(
      ["config", "policy"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("ttlDays");
  });

  it("config policy set updates values", () => {
    const { stdout, exitCode } = runCli(
      ["config", "policy", "set", "--ttlDays=200", "--decay.d30=0.95"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ttlDays).toBe(200);
    expect(parsed.decay.d30).toBe(0.95);
  });

  it("config policy set with invalid action prints usage", () => {
    const { stderr, exitCode } = runCli(
      ["config", "policy", "delete"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Usage:");
  });

  it("config workflow get returns JSON", () => {
    const { stdout, exitCode } = runCli(
      ["config", "workflow", "get"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("requireMaintainerApproval");
  });

  it("config workflow set updates values", () => {
    const { stdout, exitCode } = runCli(
      ["config", "workflow", "set", "--requireMaintainerApproval=true", "--lowConfidenceThreshold=0.5"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.requireMaintainerApproval).toBe(true);
    expect(parsed.lowConfidenceThreshold).toBe(0.5);
  });

  it("config workflow set with riskySections", () => {
    const { stdout, exitCode } = runCli(
      ["config", "workflow", "set", "--riskySections=Stale,Conflicts,Review"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.riskySections).toEqual(["Stale", "Conflicts", "Review"]);
  });

  it("config access get returns JSON", () => {
    const { stdout, exitCode } = runCli(
      ["config", "access", "get"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("admins");
    expect(parsed.admins).toContain("cli-test");
  });

  it("config access set updates roles", () => {
    const { stdout, exitCode } = runCli(
      ["config", "access", "set", "--admins=cli-test,admin2", "--viewers=guest1"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.admins).toContain("admin2");
    expect(parsed.viewers).toContain("guest1");
  });

  it("config access set with invalid action prints usage", () => {
    const { stderr, exitCode } = runCli(
      ["config", "access", "reset"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Usage:");
  });

  it("config index get returns JSON", () => {
    const { stdout, exitCode } = runCli(
      ["config", "index", "get"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("includeGlobs");
    expect(parsed).toHaveProperty("excludeGlobs");
  });

  it("config index set updates globs", () => {
    const { stdout, exitCode } = runCli(
      ["config", "index", "set", "--include=**/*.md,**/*.txt", "--exclude=**/node_modules/**"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.includeGlobs).toContain("**/*.md");
    expect(parsed.excludeGlobs).toContain("**/node_modules/**");
  });

  it("config index set includeHidden flag", () => {
    const { stdout, exitCode } = runCli(
      ["config", "index", "set", "--includeHidden=true"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.includeHidden).toBe(true);
  });

  it("config index with invalid action prints usage", () => {
    const { stderr, exitCode } = runCli(
      ["config", "index", "remove"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Usage:");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// NEW TESTS: maintain subcommands
// ────────────────────────────────────────────────────────────────────────────

describe("CLI integration: maintain subcommands", () => {
  let cortexDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ cortexDir, cleanup } = setupCortexDir());
  });

  afterEach(() => cleanup());

  it("maintain with no subcommand prints help", () => {
    const { stdout, exitCode } = runCli(
      ["maintain"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("cortex maintain");
    expect(stdout).toContain("Subcommands:");
  });

  it("maintain with unknown subcommand exits with error", () => {
    const { stderr, exitCode } = runCli(
      ["maintain", "bogus"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('Unknown maintain subcommand: "bogus"');
  });

  it("maintain govern with no project governs all projects", () => {
    const projDir = path.join(cortexDir, "gov-proj");
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, "LEARNINGS.md"), "# gov-proj LEARNINGS\n\n## 2025-01-01\n\n- a useful insight\n");

    const { stdout, exitCode } = runCli(
      ["maintain", "govern"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Governed memories:");
  });

  it("maintain govern with specific project", () => {
    const projDir = path.join(cortexDir, "gov-proj");
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, "LEARNINGS.md"), "# gov-proj LEARNINGS\n\n## 2025-01-01\n\n- a useful insight\n");

    const { stdout, exitCode } = runCli(
      ["maintain", "govern", "gov-proj"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Governed memories:");
  });

  it("maintain consolidate --dry-run does not modify files", () => {
    const projDir = path.join(cortexDir, "cons-proj");
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, "LEARNINGS.md"), "# cons-proj LEARNINGS\n\n## 2025-01-01\n\n- insight one\n- insight two\n");
    const before = fs.readFileSync(path.join(projDir, "LEARNINGS.md"), "utf8");

    const { stdout, exitCode } = runCli(
      ["maintain", "consolidate", "cons-proj", "--dry-run"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    const after = fs.readFileSync(path.join(projDir, "LEARNINGS.md"), "utf8");
    expect(after).toBe(before);
  });

  it("maintain migrate governance applies schema migration", () => {
    const { stdout, exitCode } = runCli(
      ["maintain", "migrate", "governance"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Governance migration:");
  });

  it("maintain migrate all runs both governance and data", () => {
    const projDir = path.join(cortexDir, "migrate-proj");
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, "FINDINGS.md"), "# Findings\n\n- Legacy finding one\n");

    const { stdout, exitCode } = runCli(
      ["maintain", "migrate", "all", "migrate-proj"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Governance migration:");
    expect(stdout).toContain("Data migration (migrate-proj):");
  });

  it("maintain migrate legacy alias (just project name)", () => {
    const projDir = path.join(cortexDir, "legacy-proj");
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, "FINDINGS.md"), "# Findings\n\n- Legacy finding\n");

    const { stdout, exitCode } = runCli(
      ["maintain", "migrate", "legacy-proj", "--dry-run"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Data migration");
  });

  it("maintain prune with unknown flag exits with error", () => {
    const { stderr, exitCode } = runCli(
      ["maintain", "prune", "--unknown"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Unknown prune-memories flag");
  });

  it("maintain consolidate with no project consolidates all", () => {
    const projDir = path.join(cortexDir, "multi-proj");
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, "LEARNINGS.md"), "# multi-proj LEARNINGS\n\n## 2025-01-01\n\n- fact\n");

    const { stdout, exitCode } = runCli(
      ["maintain", "consolidate"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Consolidated");
  });

  it("maintain migrate governance --dry-run does not modify files", () => {
    const accessPath = path.join(cortexDir, ".governance", "access-control.json");
    const before = fs.readFileSync(accessPath, "utf8");

    const { stdout, exitCode } = runCli(
      ["maintain", "migrate", "governance", "--dry-run"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("[dry-run]");
    const after = fs.readFileSync(accessPath, "utf8");
    expect(after).toBe(before);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// NEW TESTS: quality-feedback command
// ────────────────────────────────────────────────────────────────────────────

describe("CLI integration: quality-feedback", () => {
  let cortexDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ cortexDir, cleanup } = setupCortexDir());
  });

  afterEach(() => cleanup());

  it("records helpful feedback", () => {
    const { stdout, exitCode } = runCli(
      ["quality-feedback", "--key=test-proj/LEARNINGS.md:insight1", "--type=helpful"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Recorded feedback: helpful");
  });

  it("records reprompt feedback", () => {
    const { stdout, exitCode } = runCli(
      ["quality-feedback", "--key=test-proj/LEARNINGS.md:insight2", "--type=reprompt"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Recorded feedback: reprompt");
  });

  it("records regression feedback", () => {
    const { stdout, exitCode } = runCli(
      ["quality-feedback", "--key=test-proj/LEARNINGS.md:insight3", "--type=regression"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Recorded feedback: regression");
  });

  it("exits with error on missing key", () => {
    const { stderr, exitCode } = runCli(
      ["quality-feedback", "--type=helpful"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Usage:");
  });

  it("exits with error on missing type", () => {
    const { stderr, exitCode } = runCli(
      ["quality-feedback", "--key=test-proj/LEARNINGS.md:insight"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Usage:");
  });

  it("exits with error on invalid type", () => {
    const { stderr, exitCode } = runCli(
      ["quality-feedback", "--key=test-proj/LEARNINGS.md:insight", "--type=invalid"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Usage:");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// NEW TESTS: skill-list command
// ────────────────────────────────────────────────────────────────────────────

describe("CLI integration: skill-list", () => {
  let cortexDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ cortexDir, cleanup } = setupCortexDir());
  });

  afterEach(() => cleanup());

  it("prints no skills found when none exist", () => {
    const { stdout, exitCode } = runCli(
      ["skill-list"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("No skills found");
  });

  it("lists global flat skill files", () => {
    const skillsDir = path.join(cortexDir, "global", "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(skillsDir, "deploy.md"), "# Deploy\nDeploy to production");
    fs.writeFileSync(path.join(skillsDir, "test-runner.md"), "# Test Runner\nRun tests");

    const { stdout, exitCode } = runCli(
      ["skill-list"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("deploy");
    expect(stdout).toContain("test-runner");
    expect(stdout).toContain("global");
    expect(stdout).toContain("2 skill(s) found");
  });

  it("lists subfolder SKILL.md format skills", () => {
    const skillDir = path.join(cortexDir, "global", "skills", "my-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# My Skill\nDo stuff");

    const { stdout, exitCode } = runCli(
      ["skill-list"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("my-skill");
    expect(stdout).toContain("folder");
    expect(stdout).toContain("1 skill(s) found");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// NEW TESTS: backlog command
// ────────────────────────────────────────────────────────────────────────────

describe("CLI integration: backlog", () => {
  let cortexDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ cortexDir, cleanup } = setupCortexDir());
  });

  afterEach(() => cleanup());

  it("prints no backlogs found when none exist", () => {
    const { stdout, exitCode } = runCli(
      ["backlog"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    // Either "No backlogs found" or "All backlogs are empty"
    expect(stdout).toMatch(/(No backlogs found|All backlogs are empty)/);
  });

  it("lists active and queued items", () => {
    const projDir = path.join(cortexDir, "backlog-proj");
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(
      path.join(projDir, "backlog.md"),
      "# backlog-proj Backlog\n\n## Active\n\n- Fix login bug\n- Update dependencies\n\n## Queue\n\n- Add dark mode\n\n## Done\n\n- Setup project\n"
    );

    const { stdout, exitCode } = runCli(
      ["backlog"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("backlog-proj");
    expect(stdout).toContain("Fix login bug");
    expect(stdout).toContain("Add dark mode");
    expect(stdout).toContain("2 active, 1 queued");
  });

  it("handles multiple projects", () => {
    for (const name of ["proj-a", "proj-b"]) {
      const projDir = path.join(cortexDir, name);
      fs.mkdirSync(projDir, { recursive: true });
      fs.writeFileSync(
        path.join(projDir, "backlog.md"),
        `# ${name} Backlog\n\n## Active\n\n- Task for ${name}\n\n## Queue\n\n## Done\n\n`
      );
    }

    const { stdout, exitCode } = runCli(
      ["backlog"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("proj-a");
    expect(stdout).toContain("proj-b");
    expect(stdout).toContain("2 active, 0 queued");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// NEW TESTS: unknown command
// ────────────────────────────────────────────────────────────────────────────

describe("CLI integration: unknown command", () => {
  let cortexDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ cortexDir, cleanup } = setupCortexDir());
  });

  afterEach(() => cleanup());

  it("exits with error for unknown command", () => {
    // Unknown commands fall through CLI_COMMANDS check and hit the MCP server path
    const { exitCode } = runCli(
      ["nonexistent-command"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).not.toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// NEW TESTS: add-learning edge cases
// ────────────────────────────────────────────────────────────────────────────

describe("CLI integration: add-learning edge cases", () => {
  let cortexDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ cortexDir, cleanup } = setupCortexDir());
    const projDir = path.join(cortexDir, "learn-proj");
    fs.mkdirSync(projDir, { recursive: true });
  });

  afterEach(() => cleanup());

  it("adds learning with spaces in the text", () => {
    const { stdout, exitCode } = runCli(
      ["add-learning", "learn-proj", "auth middleware runs before rate limiting, order matters"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("added insight");
    const content = fs.readFileSync(path.join(cortexDir, "learn-proj", "LEARNINGS.md"), "utf8");
    expect(content).toContain("auth middleware runs before rate limiting");
  });

  it("creates LEARNINGS.md when it does not exist", () => {
    const learningsPath = path.join(cortexDir, "learn-proj", "LEARNINGS.md");
    expect(fs.existsSync(learningsPath)).toBe(false);

    runCli(
      ["add-learning", "learn-proj", "new insight"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );

    expect(fs.existsSync(learningsPath)).toBe(true);
    const content = fs.readFileSync(learningsPath, "utf8");
    expect(content).toContain("new insight");
  });

  it("appends to existing LEARNINGS.md", () => {
    const learningsPath = path.join(cortexDir, "learn-proj", "LEARNINGS.md");
    fs.writeFileSync(learningsPath, "# learn-proj LEARNINGS\n\n## 2025-01-01\n\n- existing insight\n");

    runCli(
      ["add-learning", "learn-proj", "second insight"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );

    const content = fs.readFileSync(learningsPath, "utf8");
    expect(content).toContain("existing insight");
    expect(content).toContain("second insight");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// NEW TESTS: pin-memory edge cases
// ────────────────────────────────────────────────────────────────────────────

describe("CLI integration: pin-memory edge cases", () => {
  let cortexDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ cortexDir, cleanup } = setupCortexDir());
    const projDir = path.join(cortexDir, "pin-proj");
    fs.mkdirSync(projDir, { recursive: true });
  });

  afterEach(() => cleanup());

  it("creates CANONICAL_MEMORIES.md with pinned content", () => {
    const { exitCode } = runCli(
      ["pin-memory", "pin-proj", "never commit secrets to version control"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);

    const canonical = path.join(cortexDir, "pin-proj", "CANONICAL_MEMORIES.md");
    expect(fs.existsSync(canonical)).toBe(true);
    const content = fs.readFileSync(canonical, "utf8");
    expect(content).toContain("never commit secrets to version control");
  });

  it("pinning same memory twice is idempotent", () => {
    runCli(
      ["pin-memory", "pin-proj", "always validate input at boundaries"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    runCli(
      ["pin-memory", "pin-proj", "always validate input at boundaries"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );

    const canonical = path.join(cortexDir, "pin-proj", "CANONICAL_MEMORIES.md");
    const content = fs.readFileSync(canonical, "utf8");
    // Should appear exactly once in the file
    const matches = content.match(/always validate input at boundaries/g);
    expect(matches?.length).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// NEW TESTS: migrate-findings standalone
// ────────────────────────────────────────────────────────────────────────────

describe("CLI integration: migrate-findings", () => {
  let cortexDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ cortexDir, cleanup } = setupCortexDir());
  });

  afterEach(() => cleanup());

  it("exits with error when no project specified", () => {
    const { stderr, exitCode } = runCli(
      ["migrate-findings"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Usage:");
  });

  it("migrates FINDINGS.md into LEARNINGS.md", () => {
    const projDir = path.join(cortexDir, "mig-proj");
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, "FINDINGS.md"), "# Findings\n\n- Use explicit timezone handling\n- Retry transient failures\n");

    const { stdout, exitCode } = runCli(
      ["migrate-findings", "mig-proj"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Migrated");
  });

  it("--dry-run does not write files", () => {
    const projDir = path.join(cortexDir, "mig-proj2");
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, "FINDINGS.md"), "# Findings\n\n- A finding\n");

    const { stdout, exitCode } = runCli(
      ["migrate-findings", "mig-proj2", "--dry-run"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Found");
    expect(fs.existsSync(path.join(projDir, "LEARNINGS.md"))).toBe(false);
  });

  it("--pin flag runs without error", () => {
    const projDir = path.join(cortexDir, "mig-proj3");
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, "FINDINGS.md"), "# Findings\n\n- Important pattern\n");

    const { stdout, exitCode } = runCli(
      ["migrate-findings", "mig-proj3", "--pin"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Migrated");
    // LEARNINGS.md should be created from the findings
    expect(fs.existsSync(path.join(projDir, "LEARNINGS.md"))).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// NEW TESTS: doctor edge cases
// ────────────────────────────────────────────────────────────────────────────

describe("CLI integration: doctor edge cases", () => {
  let cortexDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ cortexDir, cleanup } = setupCortexDir());
  });

  afterEach(() => cleanup());

  it("--check-data validates governance files", () => {
    const { stdout, stderr } = runCli(
      ["doctor", "--check-data"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    const output = stdout + stderr;
    expect(output).toContain("cortex doctor:");
    expect(output).toContain("data:governance:");
  });

  it("reports fts-index check", () => {
    const { stdout, stderr } = runCli(
      ["doctor"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    const output = stdout + stderr;
    expect(output).toContain("fts-index");
  });

  it("reports machine-registered check", () => {
    const { stdout, stderr } = runCli(
      ["doctor"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    const output = stdout + stderr;
    expect(output).toContain("machine-registered");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// NEW TESTS: status / inspect-index / debug-injection
// ────────────────────────────────────────────────────────────────────────────

describe("CLI integration: inspect-index and debug-injection", () => {
  let cortexDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ cortexDir, cleanup } = setupCortexDir());
    const projDir = path.join(cortexDir, "idx-proj");
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, "LEARNINGS.md"), "# idx-proj LEARNINGS\n\n## 2025-01-01\n\n- indexed content here\n");
  });

  afterEach(() => cleanup());

  it("inspect-index returns index contents", () => {
    const { stdout, exitCode } = runCli(
      ["inspect-index"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    // Should list docs in the index
    expect(stdout.length).toBeGreaterThan(0);
  });

  it("inspect-index with --project filters", () => {
    const { stdout, exitCode } = runCli(
      ["inspect-index", "--project", "idx-proj"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("idx-proj");
  });

  it("debug-injection runs without crashing", () => {
    const { exitCode } = runCli(
      ["debug-injection", "test query"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// NEW TESTS: maintain migrate argument parsing
// ────────────────────────────────────────────────────────────────────────────

describe("CLI integration: maintain migrate argument edge cases", () => {
  let cortexDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ cortexDir, cleanup } = setupCortexDir());
  });

  afterEach(() => cleanup());

  it("migrate with no args prints usage", () => {
    const { stderr, exitCode } = runCli(
      ["maintain", "migrate"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Usage:");
  });

  it("migrate governance with --pin exits with error", () => {
    const { stderr, exitCode } = runCli(
      ["maintain", "migrate", "governance", "--pin"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--pin is only valid for data/all migrations");
  });

  it("migrate data without project prints usage", () => {
    const { stderr, exitCode } = runCli(
      ["maintain", "migrate", "data"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Usage:");
  });

  it("migrate with unknown flag exits with error", () => {
    const { stderr, exitCode } = runCli(
      ["maintain", "migrate", "governance", "--unknown"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "cli-test" }
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Unknown migrate flag");
  });
});

// --- Unit tests for exported cli functions ---

import { scoreMemoryCandidate, detectTaskIntent, selectSnippets } from "./cli.js";
import type { DocRow } from "./shared.js";

describe("scoreMemoryCandidate", () => {
  it("returns null for low-signal commits", () => {
    expect(scoreMemoryCandidate("update readme", "")).toBeNull();
  });

  it("scores fix commits above threshold", () => {
    const result = scoreMemoryCandidate("fix: timeout on api calls causing retries", "root cause was missing keepalive");
    expect(result).not.toBeNull();
    expect(result!.score).toBeGreaterThanOrEqual(0.5);
    expect(result!.text).toBeTruthy();
  });

  it("scores merged PRs higher than plain commits", () => {
    const merged = scoreMemoryCandidate("Merge pull request #42 from user/fix-timeout", "fix retry logic");
    const plain = scoreMemoryCandidate("fix retry logic", "");
    expect(merged).not.toBeNull();
    expect(plain).not.toBeNull();
    expect(merged!.score).toBeGreaterThan(plain!.score);
  });

  it("caps score at 0.99", () => {
    const result = scoreMemoryCandidate(
      "Merge pull request #1 from user/fix-ci-timeout-regression",
      "CI pipeline flake fix: root cause was timeout regression in build step"
    );
    expect(result).not.toBeNull();
    expect(result!.score).toBeLessThanOrEqual(0.99);
  });

  it("cleans merge PR prefix from text", () => {
    const result = scoreMemoryCandidate("Merge pull request #42 from user/branch Fix timeout issue", "workaround applied");
    expect(result).not.toBeNull();
    expect(result!.text).not.toMatch(/^Merge pull request/);
  });

  it("capitalizes first letter of cleaned text", () => {
    const result = scoreMemoryCandidate("fix: handle edge case in retry", "regression found");
    expect(result).not.toBeNull();
    expect(result!.text[0]).toBe(result!.text[0].toUpperCase());
  });
});

describe("detectTaskIntent", () => {
  it("detects debug intent from error-related prompts", () => {
    expect(detectTaskIntent("why is this failing with a TypeError")).toBe("debug");
  });

  it("detects review intent from review-related prompts", () => {
    expect(detectTaskIntent("review this PR and check for issues")).toBe("review");
  });

  it("detects build intent from CI/deploy prompts", () => {
    expect(detectTaskIntent("set up the CI pipeline for deploy")).toBe("build");
  });

  it("detects docs intent from documentation prompts", () => {
    expect(detectTaskIntent("update the README with the new API")).toBe("docs");
  });

  it("returns general for ambiguous prompts", () => {
    expect(detectTaskIntent("hello")).toBe("general");
  });
});

describe("selectSnippets", () => {
  function doc(overrides: Partial<DocRow> = {}): DocRow {
    return { project: "project", filename: "file.md", type: "learnings", content: "", path: "/file.md", ...overrides };
  }

  it("selects snippets within token budget", () => {
    const rows: DocRow[] = [
      doc({ content: "Line one\nLine two\nLine three\nLine four\nLine five" }),
      doc({ filename: "file2.md", content: "Other content here\nMore stuff\nAnother line", path: "/file2.md" }),
    ];
    const { selected, usedTokens } = selectSnippets(rows, "content", 550, 6, 520);
    expect(selected.length).toBeGreaterThan(0);
    expect(usedTokens).toBeLessThanOrEqual(550);
  });

  it("limits to 3 snippets max", () => {
    const rows: DocRow[] = Array.from({ length: 10 }, (_, i) =>
      doc({ filename: `file${i}.md`, content: `Content number ${i} with keywords here\nLine two\nLine three`, path: `/file${i}.md` })
    );
    const { selected } = selectSnippets(rows, "keywords", 2000, 6, 520);
    expect(selected.length).toBeLessThanOrEqual(3);
  });

  it("returns empty when no rows match", () => {
    const { selected } = selectSnippets([], "query", 550, 6, 520);
    expect(selected).toHaveLength(0);
  });

  it("truncates first snippet when it exceeds budget", () => {
    const longContent = Array.from({ length: 100 }, (_, i) => `Line ${i} with lots of words and content`).join("\n");
    const rows: DocRow[] = [doc({ content: longContent })];
    const { selected, usedTokens } = selectSnippets(rows, "content", 100, 6, 520);
    expect(selected.length).toBe(1);
    expect(usedTokens).toBeLessThanOrEqual(200); // first snippet is always included, possibly truncated
  });
});
