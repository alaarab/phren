import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
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
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-cli-test-"));
  const cortexDir = path.join(tmpRoot, ".cortex");
  fs.mkdirSync(cortexDir, { recursive: true });

  // Grant admin access for memory operations
  const govDir = path.join(cortexDir, ".governance");
  fs.mkdirSync(govDir, { recursive: true });
  fs.writeFileSync(
    path.join(govDir, "access-control.json"),
    JSON.stringify({
      admins: ["cli-test"],
      maintainers: [],
      contributors: [],
      viewers: [],
    }, null, 2) + "\n"
  );

  return {
    cortexDir,
    cleanup: () => fs.rmSync(tmpRoot, { recursive: true, force: true }),
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
