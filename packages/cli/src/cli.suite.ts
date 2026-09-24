import { it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { shard } from "./test-shard.js";
import { grantAdmin, makeTempDir, setupIsolatedCliEnv, runCliSpawn, type IsolatedCliEnv } from "./test-helpers.js";
import { REGISTRY } from "./cli-registry.js";
import * as fs from "fs";
import * as path from "path";

// Run through cli.test.ts and cli.2.test.ts, each one shard of the top-level groups.
const { describe } = shard();
const runCli = runCliSpawn;

function setupPhrenDir(): { phrenDir: string; cleanup: () => void } {
  const tmp = makeTempDir("phren-cli-test-");
  const phrenDir = path.join(tmp.path, ".phren");
  fs.mkdirSync(phrenDir, { recursive: true });
  grantAdmin(phrenDir, "cli-test");

  return {
    phrenDir,
    cleanup: tmp.cleanup,
  };
}

describe("CLI integration: search", () => {
  let phrenDir: string;
  let cleanup: () => void;

  beforeAll(() => {
    ({ phrenDir, cleanup } = setupPhrenDir());
    // Create a project with searchable content
    const projDir = path.join(phrenDir, "test-proj");
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(
      path.join(projDir, "FINDINGS.md"),
      "# test-proj FINDINGS\n\n## 2025-01-01\n\n- Always restart the server after config changes\n"
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
      "# Weak\n\nrestart server notes\n"
    );
  });

  afterAll(() => cleanup());

  it("exits with error when no query is provided", () => {
    const { stderr, exitCode } = runCli(
      ["search"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("query");
  });

  it("filters by project with --project flag", () => {
    const { stdout, exitCode } = runCli(
      ["search", "--project", "test-proj"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("test-proj");
  });

  it("search pipeline sanitizes query operators and still matches expected docs", () => {
    const { stdout, exitCode } = runCli(
      ["search", 'content:restart AND server OR "^cache"', "--project", "test-proj"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("[test-proj/SEARCH_STRONG.md]");
  });

  it("search pipeline ranks stronger match ahead of weaker match", () => {
    const { stdout, exitCode } = runCli(
      ["search", "restart server", "--project", "test-proj"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
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
  let phrenDir: string;
  let cleanup: () => void;

  beforeAll(() => {
    ({ phrenDir, cleanup } = setupPhrenDir());
  });

  afterAll(() => cleanup());

  it("outputs health check results", () => {
    const { stdout, stderr, exitCode } = runCli(
      ["doctor"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    const output = stdout + stderr;
    expect(output).toContain("phren doctor:");
    // Should contain check lines with ok or fail
    expect(output).toMatch(/- (ok|fail) /);
  });
});

describe("CLI integration: status", () => {
  let phrenDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ phrenDir, cleanup } = setupPhrenDir());
    fs.mkdirSync(path.join(phrenDir, ".runtime"), { recursive: true });
    fs.writeFileSync(
      path.join(phrenDir, ".runtime", "runtime-health.json"),
      JSON.stringify({
        schemaVersion: 1,
        lastAutoSave: { at: "2026-03-08T00:00:00.000Z", status: "saved-local" },
        lastSync: {
          lastPullAt: "2026-03-08T00:01:00.000Z",
          lastPullStatus: "ok",
          lastPushAt: "2026-03-08T00:02:00.000Z",
          lastPushStatus: "saved-local",
          unsyncedCommits: 2,
        },
      }, null, 2)
    );
  });

  afterEach(() => cleanup());

  it("prints sync state from runtime health", () => {
    const { stdout, exitCode } = runCli(
      ["status"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test", PHREN_OLLAMA_URL: "off" }
    );
    const plain = stdout.replace(/\x1b\[[0-9;]*m/g, "");
    expect(exitCode).toBe(0);
    expect(plain).toContain("phren");
    expect(plain).toContain("sync");
    expect(plain).toContain("semantic");
    expect(plain).toContain("last pull ok");
    expect(plain).toContain("unsynced commits 2");
  });
});

describe("CLI integration: hooks", () => {
  let phrenDir: string;
  let cleanup: () => void;
  let homeDir: string;

  beforeAll(() => {
    ({ phrenDir, cleanup } = setupPhrenDir());
    homeDir = path.dirname(phrenDir);
  });

  afterAll(() => cleanup());

  it("shows Claude hook config from ~/.claude/settings.json", () => {
    const claudeDir = path.join(homeDir, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, "settings.json"),
      JSON.stringify({ hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "echo stop" }] }] } }, null, 2)
    );

    const { stdout, exitCode } = runCli(
      ["hooks", "show", "claude"],
      { PHREN_PATH: phrenDir, HOME: homeDir, USERPROFILE: homeDir, PHREN_ACTOR: "cli-test" }
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("\"Stop\"");
    expect(stdout).not.toContain("phren.SKILL.md");
  });

  it("shows Codex hook config from the active phren path", () => {
    fs.writeFileSync(
      path.join(phrenDir, "codex.json"),
      JSON.stringify({ hooks: { UserPromptSubmit: [{ type: "command", command: "echo prompt" }] } }, null, 2)
    );

    const { stdout, exitCode } = runCli(
      ["hooks", "show", "codex"],
      { PHREN_PATH: phrenDir, HOME: homeDir, USERPROFILE: homeDir, PHREN_ACTOR: "cli-test" }
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("\"UserPromptSubmit\"");
    expect(stdout).toContain("echo prompt");
  });

  it("lists project-level hook overrides when --project is provided", () => {
    const projectDir = path.join(phrenDir, "demo");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "phren.project.yaml"),
      ["hooks:", "  enabled: false", "  UserPromptSubmit: true", ""].join("\n"),
    );

    const { stdout, exitCode } = runCli(
      ["hooks", "list", "--project", "demo"],
      { PHREN_PATH: phrenDir, HOME: homeDir, USERPROFILE: homeDir, PHREN_ACTOR: "cli-test" }
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Project demo");
    expect(stdout).toContain("base: disabled");
    expect(stdout).toContain("UserPromptSubmit: enabled");
    expect(stdout).toContain("Stop: disabled");
  });
});

describe("CLI integration: projects add", () => {
  let phrenDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ phrenDir, cleanup } = setupPhrenDir());
  });

  afterEach(() => cleanup());

  it("fails with a deprecation error instead of mutating state", () => {
    const { stderr, exitCode } = runCli(
      ["projects", "add", "Phren"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("removed from the supported workflow");
    expect(stderr).toContain("phren add");
    expect(fs.existsSync(path.join(phrenDir, "phren"))).toBe(false);
  });
});

describe("CLI integration: add project", () => {
  let phrenDir: string;
  let cleanup: () => void;
  let projectDir: string;

  beforeEach(() => {
    ({ phrenDir, cleanup } = setupPhrenDir());
    projectDir = path.join(path.dirname(phrenDir), "repo");
    fs.mkdirSync(path.join(phrenDir, ".config"), { recursive: true });
    fs.mkdirSync(path.join(phrenDir, "profiles"), { recursive: true });
    fs.writeFileSync(path.join(phrenDir, "profiles", "personal.yaml"), "name: personal\nprojects:\n  - global\n");
    fs.writeFileSync(path.join(phrenDir, "profiles", "work.yaml"), "name: work\nprojects:\n  - global\n");
    fs.mkdirSync(path.join(projectDir, ".git"), { recursive: true });
  });

  afterEach(() => cleanup());

  it("adds a project to the active profile", () => {
    const { stdout, exitCode } = runCli(
      ["add", projectDir],
      { PHREN_PATH: phrenDir, PHREN_PROFILE: "work", PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Added project "repo"');
    expect(fs.readFileSync(path.join(phrenDir, "profiles", "work.yaml"), "utf8")).toContain("- repo");
    expect(fs.readFileSync(path.join(phrenDir, "profiles", "personal.yaml"), "utf8")).not.toContain("- repo");
  });

  it("uses the machine-mapped profile when PHREN_PROFILE is unset", () => {
    const homeDir = path.join(path.dirname(phrenDir), "home");
    const machineFile = path.join(homeDir, ".phren", ".machine-id");
    fs.mkdirSync(path.dirname(machineFile), { recursive: true });
    fs.writeFileSync(machineFile, "work-box\n");
    fs.writeFileSync(path.join(phrenDir, "machines.yaml"), "work-box: work\n");
    const { exitCode } = runCli(
      ["add", projectDir],
      { PHREN_PATH: phrenDir, HOME: homeDir, USERPROFILE: homeDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(fs.readFileSync(path.join(phrenDir, "profiles", "work.yaml"), "utf8")).toContain("- repo");
    expect(fs.readFileSync(path.join(phrenDir, "profiles", "personal.yaml"), "utf8")).not.toContain("- repo");
  });

  it("fails clearly when phren is not initialized yet", () => {
    fs.rmSync(path.join(phrenDir, ".config"), { recursive: true, force: true });
    const { stdout, exitCode } = runCli(
      ["add", projectDir],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(1);
    expect(stdout).toContain("phren is not set up yet");
  });
});

describe("CLI integration: projects configure", () => {
  let phrenDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ phrenDir, cleanup } = setupPhrenDir());
    fs.mkdirSync(path.join(phrenDir, "demo"), { recursive: true });
  });

  afterEach(() => cleanup());

  it("can persist a project-level hook toggle", () => {
    const { stdout, exitCode } = runCli(
      ["projects", "configure", "demo", "--hooks=off"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("hooks=off");
    const config = fs.readFileSync(path.join(phrenDir, "demo", "phren.project.yaml"), "utf8");
    expect(config).toContain("enabled: false");
  });
});

describe("CLI integration: add-finding", () => {
  let phrenDir: string;
  let cleanup: () => void;

  beforeAll(() => {
    ({ phrenDir, cleanup } = setupPhrenDir());
    const projDir = path.join(phrenDir, "test-proj");
    fs.mkdirSync(projDir, { recursive: true });
  });

  afterAll(() => cleanup());

  it("writes a finding to FINDINGS.md", () => {
    const { stdout, exitCode } = runCli(
      ["add-finding", "test-proj", "cache invalidation matters"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("added insight");

    const findingsPath = path.join(phrenDir, "test-proj", "FINDINGS.md");
    expect(fs.existsSync(findingsPath)).toBe(true);
    const content = fs.readFileSync(findingsPath, "utf8");
    expect(content).toContain("cache invalidation matters");
  });

  it("exits with error when project or finding is missing", () => {
    const { stderr, exitCode } = runCli(
      ["add-finding"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Usage");
  });
});

describe("CLI integration: pin", () => {
  let phrenDir: string;
  let cleanup: () => void;

  beforeAll(() => {
    ({ phrenDir, cleanup } = setupPhrenDir());
    const projDir = path.join(phrenDir, "test-proj");
    fs.mkdirSync(projDir, { recursive: true });
  });

  afterAll(() => cleanup());

  it("writes a truth to truths.md", () => {
    const { stdout, exitCode } = runCli(
      ["pin", "test-proj", "always use UTC timestamps"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);

    const canonicalPath = path.join(phrenDir, "test-proj", "truths.md");
    expect(fs.existsSync(canonicalPath)).toBe(true);
    const content = fs.readFileSync(canonicalPath, "utf8");
    expect(content).toContain("always use UTC timestamps");
    expect(content).toContain("added");
  });

  it("exits with error when project or memory is missing", () => {
    const { stderr, exitCode } = runCli(
      ["pin"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Usage");
  });
});

describe("CLI integration: prune and consolidate atomic writes", () => {
  let phrenDir: string;
  let cleanup: () => void;

  beforeAll(() => {
    ({ phrenDir, cleanup } = setupPhrenDir());
    const projectDir = path.join(phrenDir, "test-proj");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "FINDINGS.md"),
      "# test-proj FINDINGS\n\n## 2020-01-01\n\n- old memory to prune\n\n## 2026-01-01\n\n- fresh memory\n"
    );
  });

  afterAll(() => cleanup());

  it("prune --dry-run does not create backups", () => {
    const backupPath = path.join(phrenDir, "test-proj", "FINDINGS.md.bak");
    const { stdout, exitCode } = runCli(
      ["maintain", "prune", "test-proj", "--dry-run"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("[dry-run]");
    expect(fs.existsSync(backupPath)).toBe(false);
  });

  it("prune writes atomically (no .bak file created)", () => {
    const backupPath = path.join(phrenDir, "test-proj", "FINDINGS.md.bak");
    const { stdout, exitCode } = runCli(
      ["maintain", "prune", "test-proj"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Pruned");
    // atomic write (tmp + rename) — no .bak file is created
    expect(fs.existsSync(backupPath)).toBe(false);
  });

  it("consolidate creates .bak and reports updated backup paths", () => {
    const backupPath = path.join(phrenDir, "test-proj", "FINDINGS.md.bak");
    const { stdout, exitCode } = runCli(
      ["maintain", "consolidate", "test-proj"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Consolidated findings for test-proj.");
    expect(stdout).toContain("Updated backups (1): test-proj/FINDINGS.md.bak");
    expect(fs.existsSync(backupPath)).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// NEW TESTS: search edge cases
// ────────────────────────────────────────────────────────────────────────────

describe("CLI integration: search edge cases", () => {
  let phrenDir: string;
  let cleanup: () => void;

  beforeAll(() => {
    ({ phrenDir, cleanup } = setupPhrenDir());
    const projDir = path.join(phrenDir, "alpha");
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, "FINDINGS.md"), "# alpha FINDINGS\n\n## 2025-06-01\n\n- caching layer timeout fix\n- database connection pool sizing\n");
    fs.writeFileSync(path.join(projDir, "summary.md"), "# alpha\n\n**What:** A caching project\n");
    fs.writeFileSync(path.join(projDir, "tasks.md"), "# alpha Task\n\n## Active\n\n- Implement retry logic\n\n## Queue\n\n- Refactor config loader\n\n## Done\n\n- Initial setup\n");
    fs.writeFileSync(path.join(projDir, "truths.md"), "# Truths\n\n- Always use UTC timestamps (pinned)\n");
    fs.writeFileSync(path.join(projDir, "AGENTS.md"), "# alpha\n\nProject-level instructions for alpha.\n");
  });

  afterAll(() => cleanup());

  it("--type findings filters to findings docs only", () => {
    const { stdout, exitCode } = runCli(
      ["search", "caching", "--project", "alpha", "--type", "findings"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("FINDINGS");
  });

  it("--type skills is aliased to skill", () => {
    const { stdout, exitCode } = runCli(
      ["search", "deploy", "--type", "skills"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    // Should not error about invalid type
    expect(exitCode).toBe(0);
  });

  it("invalid --type exits with error", () => {
    const { stderr, exitCode } = runCli(
      ["search", "caching", "--type", "nonsense"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('Invalid --type value: "nonsense"');
  });

  it("--limit flag restricts result count", () => {
    const { stdout, exitCode } = runCli(
      ["search", "caching", "--project", "alpha", "--limit", "1"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
  });

  it.each(["abc", "0", "201"])("invalid --limit value %s exits with error", (limit) => {
    const { stderr, exitCode } = runCli(
      ["search", "caching", "--limit", limit],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Invalid --limit value");
  });

  it("unknown search flag exits with error", () => {
    const { stderr, exitCode } = runCli(
      ["search", "caching", "--verbose"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Unknown search flag");
  });

  it("search with inline --project=alpha format works", () => {
    const { stdout, exitCode } = runCli(
      ["search", "caching", "--project=alpha"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("alpha");
  });

  it("invalid project name exits with error", () => {
    const { stderr, exitCode } = runCli(
      ["search", "test", "--project", "../escape"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Invalid project name");
  });

  it("search for nonexistent term returns zero results gracefully", () => {
    const { stdout, exitCode } = runCli(
      ["search", "xyznonexistent123"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("No results found");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// NEW TESTS: config subcommands
// ────────────────────────────────────────────────────────────────────────────

describe("CLI integration: config subcommands", () => {
  let phrenDir: string;
  let cleanup: () => void;

  beforeAll(() => {
    ({ phrenDir, cleanup } = setupPhrenDir());
  });

  afterAll(() => cleanup());

  it("config policy with no args defaults to get", () => {
    const { stdout, exitCode } = runCli(
      ["config", "policy"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("ttlDays");
  });

  it.each([["policy", "delete"], ["index", "remove"]])("config %s with invalid action %s prints usage", (domain, action) => {
    const { stderr, exitCode } = runCli(
      ["config", domain, action],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Usage:");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// NEW TESTS: maintain subcommands
// ────────────────────────────────────────────────────────────────────────────

describe("CLI integration: maintain subcommands", () => {
  let phrenDir: string;
  let cleanup: () => void;

  beforeAll(() => {
    ({ phrenDir, cleanup } = setupPhrenDir());
  });

  afterAll(() => cleanup());

  it("maintain with no subcommand prints help", () => {
    const { stdout, exitCode } = runCli(
      ["maintain"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("phren maintain");
    expect(stdout).toContain("Subcommands:");
  });

  it("maintain with unknown subcommand exits with error", () => {
    const { stderr, exitCode } = runCli(
      ["maintain", "bogus"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('Unknown maintain subcommand: "bogus"');
  });

  it.each([[[]], [["gov-proj"]]])("maintain govern %j governs the named project or all of them", (target) => {
    const projDir = path.join(phrenDir, "gov-proj");
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, "FINDINGS.md"), "# gov-proj FINDINGS\n\n## 2025-01-01\n\n- a useful insight\n");

    const { stdout, exitCode } = runCli(
      ["maintain", "govern", ...target],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Governed memories:");
  });

  it("maintain govern --dry-run does not write queue files", () => {
    const projDir = path.join(phrenDir, "gov-dry");
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, "FINDINGS.md"), "# gov-dry FINDINGS\n\n## 2020-01-01\n\n- wip\n- temp note\n");

    const queuePath = path.join(projDir, "review.md");
    expect(fs.existsSync(queuePath)).toBe(false);

    const { stdout, exitCode } = runCli(
      ["maintain", "govern", "gov-dry", "--dry-run"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("[dry-run]");
    expect(stdout).toContain("Would govern");
    // Queue file should not have been created
    expect(fs.existsSync(queuePath)).toBe(false);

    // Without a project, the dry run previews every project.
    const all = runCli(["maintain", "govern", "--dry-run"], { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" });
    expect(all.exitCode).toBe(0);
    expect(all.stdout).toContain("[dry-run]");
  });

  it("maintain consolidate --dry-run does not modify files", () => {
    const projDir = path.join(phrenDir, "cons-proj");
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, "FINDINGS.md"), "# cons-proj FINDINGS\n\n## 2025-01-01\n\n- insight one\n- insight two\n");
    const before = fs.readFileSync(path.join(projDir, "FINDINGS.md"), "utf8");

    const { stdout, exitCode } = runCli(
      ["maintain", "consolidate", "cons-proj", "--dry-run"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    const after = fs.readFileSync(path.join(projDir, "FINDINGS.md"), "utf8");
    expect(after).toBe(before);
  });

  it("maintain prune with unknown flag exits with error", () => {
    const { stderr, exitCode } = runCli(
      ["maintain", "prune", "--unknown"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Unknown prune-memories flag");
  });

  it("maintain consolidate with no project consolidates all", () => {
    const projDir = path.join(phrenDir, "multi-proj");
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, "FINDINGS.md"), "# multi-proj FINDINGS\n\n## 2025-01-01\n\n- fact\n");

    const { stdout, exitCode } = runCli(
      ["maintain", "consolidate"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Consolidated");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// NEW TESTS: quality-feedback command
// ────────────────────────────────────────────────────────────────────────────

describe("CLI integration: quality-feedback", () => {
  let phrenDir: string;
  let cleanup: () => void;

  beforeAll(() => {
    ({ phrenDir, cleanup } = setupPhrenDir());
  });

  afterAll(() => cleanup());

  it.each(["helpful", "reprompt", "regression"])("records %s feedback", (type) => {
    const { stdout, exitCode } = runCli(
      ["quality-feedback", `--key=test-proj/FINDINGS.md:${type}`, `--type=${type}`],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain(`Recorded feedback: ${type}`);
  });

  it.each([
    ["missing key", ["--type=helpful"]],
    ["missing type", ["--key=test-proj/FINDINGS.md:insight"]],
    ["invalid type", ["--key=test-proj/FINDINGS.md:insight", "--type=invalid"]],
  ])("exits with error on %s", (_label, args) => {
    const { stderr, exitCode } = runCli(
      ["quality-feedback", ...args],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Usage:");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// NEW TESTS: skill-list command
// ────────────────────────────────────────────────────────────────────────────

describe("CLI integration: skill-list", () => {
  let phrenDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ phrenDir, cleanup } = setupPhrenDir());
  });

  afterEach(() => cleanup());

  it("prints no skills found when none exist", () => {
    const { stdout, exitCode } = runCli(
      ["skill-list"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("No skills found");
  });

  it("lists global flat skill files", () => {
    const skillsDir = path.join(phrenDir, "global", "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(skillsDir, "deploy.md"), "# Deploy\nDeploy to production");
    fs.writeFileSync(path.join(skillsDir, "test-runner.md"), "# Test Runner\nRun tests");

    const { stdout, exitCode } = runCli(
      ["skill-list"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("deploy");
    expect(stdout).toContain("test-runner");
    expect(stdout).toContain("global");
    expect(stdout).toContain("2 skill(s) found");
  });

  it("lists subfolder SKILL.md format skills", () => {
    const skillDir = path.join(phrenDir, "global", "skills", "my-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# My Skill\nDo stuff");

    const { stdout, exitCode } = runCli(
      ["skill-list"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("my-skill");
    expect(stdout).toContain("folder");
    expect(stdout).toContain("1 skill(s) found");
  });

  it("removes folder-format project skills without leaving broken folders behind", () => {
    const skillDir = path.join(phrenDir, "demo", "skills", "ss");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# ss\ncontent");

    const { stdout, exitCode } = runCli(
      ["skills", "remove", "demo", "ss"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Removed skill ss from demo");
    expect(fs.existsSync(skillDir)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// NEW TESTS: tasks command
// ────────────────────────────────────────────────────────────────────────────

describe("CLI integration: tasks", () => {
  let phrenDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ phrenDir, cleanup } = setupPhrenDir());
  });

  afterEach(() => cleanup());

  it("prints no tasks found when none exist", () => {
    const { stdout, exitCode } = runCli(
      ["tasks"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/(No tasks found|All tasks are empty)/);
  });

  it("lists active and queued items", () => {
    const projDir = path.join(phrenDir, "task-proj");
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(
      path.join(projDir, "tasks.md"),
      "# task-proj Task\n\n## Active\n\n- Fix login bug\n- Update dependencies\n\n## Queue\n\n- Add dark mode\n\n## Done\n\n- Setup project\n"
    );

    const { stdout, exitCode } = runCli(
      ["tasks"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("task-proj");
    expect(stdout).toContain("Fix login bug");
    expect(stdout).toContain("Add dark mode");
    expect(stdout).toContain("2 active, 1 queued");
  });

  it("handles multiple projects", () => {
    for (const name of ["proj-a", "proj-b"]) {
      const projDir = path.join(phrenDir, name);
      fs.mkdirSync(projDir, { recursive: true });
      fs.writeFileSync(
        path.join(projDir, "tasks.md"),
        `# ${name} Task\n\n## Active\n\n- Task for ${name}\n\n## Queue\n\n## Done\n\n`
      );
    }

    const { stdout, exitCode } = runCli(
      ["tasks"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
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
  let phrenDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ phrenDir, cleanup } = setupPhrenDir());
  });

  afterEach(() => cleanup());

  it("exits with an error for unknown manage command", () => {
    const { exitCode, stderr } = runCli(
      ["manage", "nonexistent-command"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown command");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// NEW TESTS: add-finding edge cases
// ────────────────────────────────────────────────────────────────────────────

describe("CLI integration: add-finding edge cases", () => {
  let phrenDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ phrenDir, cleanup } = setupPhrenDir());
    const projDir = path.join(phrenDir, "learn-proj");
    fs.mkdirSync(projDir, { recursive: true });
  });

  afterEach(() => cleanup());

  it("appends to existing FINDINGS.md", () => {
    const findingsPath = path.join(phrenDir, "learn-proj", "FINDINGS.md");
    fs.writeFileSync(findingsPath, "# learn-proj FINDINGS\n\n## 2025-01-01\n\n- existing insight\n");

    runCli(
      ["add-finding", "learn-proj", "second insight"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );

    const content = fs.readFileSync(findingsPath, "utf8");
    expect(content).toContain("existing insight");
    expect(content).toContain("second insight");
  });

  it("exits cleanly with error message when finding contains a secret", () => {
    const { stderr, stdout, exitCode } = runCli(
      ["add-finding", "test-proj", "sk-ant-api03-fakesecretkey1234567890ABCDEFGHIJKLMN"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).not.toBe(0);
    const output = stderr + stdout;
    expect(output).toContain("secret");
    expect(output).not.toMatch(/^\s+at /m);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// NEW TESTS: pin edge cases
// ────────────────────────────────────────────────────────────────────────────

describe("CLI integration: pin edge cases", () => {
  let phrenDir: string;
  let cleanup: () => void;

  beforeAll(() => {
    ({ phrenDir, cleanup } = setupPhrenDir());
    const projDir = path.join(phrenDir, "pin-proj");
    fs.mkdirSync(projDir, { recursive: true });
  });

  afterAll(() => cleanup());

  it("saving same truth twice is idempotent", () => {
    runCli(
      ["pin", "pin-proj", "always validate input at boundaries"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    runCli(
      ["pin", "pin-proj", "always validate input at boundaries"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );

    const canonical = path.join(phrenDir, "pin-proj", "truths.md");
    const content = fs.readFileSync(canonical, "utf8");
    // Should appear exactly once in the file
    const matches = content.match(/always validate input at boundaries/g);
    expect(matches?.length).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// NEW TESTS: doctor edge cases
// ────────────────────────────────────────────────────────────────────────────

describe("CLI integration: doctor edge cases", () => {
  let phrenDir: string;
  let cleanup: () => void;
  let projectsDir: string;
  const origProjectsDir = process.env.PROJECTS_DIR;

  beforeAll(() => {
    ({ phrenDir, cleanup } = setupPhrenDir());
    projectsDir = path.join(path.dirname(phrenDir), "projects");
    fs.mkdirSync(projectsDir, { recursive: true });
    process.env.PROJECTS_DIR = projectsDir;
  });

  afterAll(() => {
    process.env.PROJECTS_DIR = origProjectsDir;
    cleanup();
  });

  it("--check-data validates governance files", () => {
    const { stdout, stderr } = runCli(
      ["doctor", "--check-data"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    const output = stdout + stderr;
    expect(output).toContain("phren doctor:");
    expect(output).toContain("data:governance:");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// NEW TESTS: status / inspect-index / debug-injection
// ────────────────────────────────────────────────────────────────────────────

describe("CLI integration: inspect-index and debug-injection", () => {
  let phrenDir: string;
  let cleanup: () => void;

  beforeAll(() => {
    ({ phrenDir, cleanup } = setupPhrenDir());
    const projDir = path.join(phrenDir, "idx-proj");
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, "FINDINGS.md"), "# idx-proj FINDINGS\n\n## 2025-01-01\n\n- indexed content here\n");
  });

  afterAll(() => cleanup());

  it("inspect-index with --project filters", () => {
    const { stdout, exitCode } = runCli(
      ["inspect-index", "--project", "idx-proj"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("idx-proj");
  });

  it("debug-injection runs without crashing", () => {
    const { exitCode } = runCli(
      ["debug-injection", "test query"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// CLI integration: init (subprocess-based, #96)
// ────────────────────────────────────────────────────────────────────────────

const CLI_INTEGRATION_TIMEOUT_MS = process.platform === "win32" ? 20000 : 15000;

describe("CLI integration: init", () => {
  let cliEnv: IsolatedCliEnv;
  let cleanup: () => void;

  beforeEach(() => {
    cliEnv = setupIsolatedCliEnv("phren-init-cli-test-");
    cleanup = cliEnv.cleanup;
  });

  afterEach(() => cleanup());

  it("init with --machine persists the local machine alias", () => {
    const { exitCode } = runCli(
      ["init", "-y", "--machine", "test-box", "--mcp", "off"],
      cliEnv.env({ PHREN_ACTOR: "cli-test" })
    );
    expect(exitCode).toBe(0);
    const machineFile = path.join(cliEnv.homeDir, ".phren", ".machine-id");
    expect(fs.readFileSync(machineFile, "utf8").trim()).toBe("test-box");
  }, CLI_INTEGRATION_TIMEOUT_MS);

  it("init --mcp with invalid value exits with error", () => {
    const { stderr, exitCode } = runCli(
      ["init", "--mcp", "banana"],
      cliEnv.env()
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Invalid --mcp value");
  }, CLI_INTEGRATION_TIMEOUT_MS);

  it("init --dry-run on existing install describes update plan", () => {
    runCli(
      ["init", "-y", "--mcp", "off"],
      cliEnv.env({ PHREN_ACTOR: "cli-test" })
    );
    // Re-running init on an existing install succeeds (idempotent).
    expect(runCli(["init", "-y", "--mcp", "off"], cliEnv.env({ PHREN_ACTOR: "cli-test" })).exitCode).toBe(0);
    const { stdout, exitCode } = runCli(
      ["init", "--dry-run", "-y"],
      cliEnv.env()
    );
    expect(exitCode).toBe(0);
    expect(stdout.toLowerCase()).toContain("dry run");
    expect(stdout).toContain("install detected");
  }, CLI_INTEGRATION_TIMEOUT_MS);
});

// ────────────────────────────────────────────────────────────────────────────
// CLI integration: verify
// ────────────────────────────────────────────────────────────────────────────

describe("CLI integration: verify", () => {
  let cliEnv: IsolatedCliEnv;
  let cleanup: () => void;

  beforeEach(() => {
    cliEnv = setupIsolatedCliEnv("phren-verify-cli-test-");
    cleanup = cliEnv.cleanup;
  });

  afterEach(() => cleanup());

  it("verify shows fix suggestions for failures", () => {
    fs.mkdirSync(cliEnv.phrenDir, { recursive: true });
    const { stdout, stderr } = runCli(
      ["verify"],
      cliEnv.env()
    );
    const output = stdout + stderr;
    expect(output).toContain("issues found");
    expect(output).toContain("fix:");
  }, CLI_INTEGRATION_TIMEOUT_MS);
});

// ────────────────────────────────────────────────────────────────────────────
// CLI integration: help and health
// ────────────────────────────────────────────────────────────────────────────

describe("CLI integration: help and health", () => {
  it("--help prints usage information", () => {
    const { stdout, exitCode } = runCli(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("phren");
    expect(stdout).toContain("search");
    expect(stdout).toContain("manage");
    expect(stdout).not.toContain("projects add");
    expect(stdout).not.toContain("phren link");
    expect(stdout).not.toContain("--from-existing");
    for (const alias of ["-h", "help"]) {
      const other = runCli([alias]);
      expect(other.exitCode).toBe(0);
      expect(other.stdout).toContain("phren");
    }
  });

  it("--health exits with code 0", () => {
    const { exitCode } = runCli(["--health"]);
    expect(exitCode).toBe(0);
  });

  it("link command prints removal notice", () => {
    const { stderr, exitCode } = runCli(["link", "--mcp", "bogus"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("has been removed");
  });

  // Parametric: every namespace command (those with subcommands) must surface
  // its subcommand list under `--help`. Catches the regression where the
  // dispatcher's short-circuit was bypassed for namespace commands.
  describe("namespace --help shows subcommand list", () => {
    const namespaces = REGISTRY.filter((c) => c.subcommands?.length && !c.hidden);
    // Module-gated namespaces (bridge, dispatch, schedule, code...) answer
    // --help only from a store that enables them; give the CLI its own such
    // store rather than whatever store the machine running the tests has.
    let store: IsolatedCliEnv;
    beforeAll(() => {
      store = setupIsolatedCliEnv("phren-help-");
      grantAdmin(store.phrenDir);
      fs.writeFileSync(path.join(store.phrenDir, ".config", "modules.yaml"), "version: 1\nenabled:\n"
        + ["memory", "tasks", "hook", "git", "schedules", "conductor", "fanout", "code"].map(name => `  ${name}: true\n`).join(""));
    });
    afterAll(() => store.cleanup());
    for (const cmd of namespaces) {
      const firstSub = cmd.subcommands![0];
      it(`${cmd.name} --help renders ${cmd.subcommands!.length} subcommand line(s)`, () => {
        const { stdout, exitCode } = runCli([cmd.name, "--help"], store.env());
        expect(exitCode).toBe(0);
        expect(stdout).toContain(`phren ${cmd.name}`);
        expect(stdout).toContain(firstSub.usage);
      });
    }
  });

  it("add --help short-circuits before runAddCommand", () => {
    // If the dispatcher's --help intercept broke, runAddCommand would run,
    // print "phren is not set up yet" (no PHREN_PATH set in test env), and
    // exit 1. The exitCode 0 + stdout shape assertions below catch that.
    const { stdout, exitCode } = runCli(["add", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("phren add");
    expect(stdout).toContain("Register a project");
    expect(stdout).not.toContain("not set up");
    expect(stdout).not.toContain("Added project");
    // init --help short-circuits before runInit the same way.
    const init = runCli(["init", "--help"]);
    expect(init.exitCode).toBe(0);
    expect(init.stdout).toContain("phren init");
    expect(init.stdout).toContain("Set up phren");
  });

  it("mem add --help works through the alias unwrap", () => {
    const { stdout, exitCode } = runCli(["mem", "add", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("phren add");
    expect(stdout).toContain("Register a project");
  });

  it("search-fragments is reachable as a top-level command (legacy CLI_COMMANDS allowlist bug)", () => {
    // Pre-refactor, search-fragments was handled in cli/cli.ts switch but
    // missing from CLI_COMMANDS, so `phren search-fragments` printed "Unknown
    // command:". The registry routes by lookup, not by allowlist.
    const { stdout, stderr, exitCode } = runCli(["search-fragments", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("phren search-fragments");
    expect(stderr).not.toContain("Unknown command");
  });
});

describe("CLI integration: temp HOME subprocess stability", () => {
  let cliEnv: IsolatedCliEnv;
  let cleanup: () => void;

  beforeEach(() => {
    cliEnv = setupIsolatedCliEnv("phren-temp-home-cli-test-");
    cleanup = cliEnv.cleanup;
  });

  afterEach(() => cleanup());

  it("verify reports hook and index checks after init with a temp HOME", () => {
    runCli(
      ["init", "-y", "--mcp", "off"],
      cliEnv.env({ PHREN_ACTOR: "cli-test" })
    );
    const { stdout, stderr, exitCode } = runCli(
      ["verify"],
      cliEnv.env()
    );
    const output = stdout + stderr;
    expect(exitCode).toBe(1);
    expect(output).toContain("phren verify:");
    expect(output).toContain("local-only / hooks-only mode");
    expect(output).toContain("installed-version");
    expect(output).toContain("fts-index");
    expect(output).toContain("hook-entrypoint");
  }, CLI_INTEGRATION_TIMEOUT_MS);
});

// ────────────────────────────────────────────────────────────────────────────
// CLI integration: detect-skills
// ────────────────────────────────────────────────────────────────────────────

describe("CLI integration: detect-skills", () => {
  let phrenDir: string;
  let homeDir: string;
  let cleanup: () => void;

  beforeAll(() => {
    const tmp = makeTempDir("phren-detect-skills-test-");
    phrenDir = path.join(tmp.path, ".phren");
    homeDir = path.join(tmp.path, "home");
    fs.mkdirSync(phrenDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
    grantAdmin(phrenDir, "cli-test");
    cleanup = tmp.cleanup;
  });

  afterAll(() => cleanup());

  it("reports no skills directory when ~/.claude/skills/ missing", () => {
    const { stdout, exitCode } = runCli(
      ["detect-skills"],
      { PHREN_PATH: phrenDir, HOME: homeDir, USERPROFILE: homeDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("No native skills directory");
  });

  it("reports all tracked when skills dir exists but all are tracked", () => {
    const nativeSkills = path.join(homeDir, ".claude", "skills");
    fs.mkdirSync(nativeSkills, { recursive: true });
    fs.writeFileSync(path.join(nativeSkills, "my-skill.md"), "# My Skill\nDoes things.");

    const globalSkills = path.join(phrenDir, "global", "skills");
    fs.mkdirSync(globalSkills, { recursive: true });
    fs.writeFileSync(path.join(globalSkills, "my-skill.md"), "# My Skill\nDoes things.");

    const { stdout, exitCode } = runCli(
      ["detect-skills"],
      { PHREN_PATH: phrenDir, HOME: homeDir, USERPROFILE: homeDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("already tracked");
  });

  it("detects untracked skills", () => {
    const nativeSkills = path.join(homeDir, ".claude", "skills");
    fs.mkdirSync(nativeSkills, { recursive: true });
    fs.writeFileSync(path.join(nativeSkills, "untracked.md"), "# Untracked\nNew skill.");

    const { stdout, exitCode } = runCli(
      ["detect-skills"],
      { PHREN_PATH: phrenDir, HOME: homeDir, USERPROFILE: homeDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("untracked");
    expect(stdout).toContain("--import");
  });
});

// --- Unit tests for exported cli functions ---

import { detectTaskIntent, selectSnippets } from "./cli/hooks.js";
import { DocRow } from "./shared/index.js";

describe("detectTaskIntent", () => {
  it.each([
    ["why is this failing with a TypeError", "debug"],
    ["review this PR and check for issues", "review"],
    ["set up the CI pipeline for deploy", "build"],
    ["update the README with the new API", "docs"],
    ["hello", "general"],
  ])("detects the intent of %j as %s", (prompt, intent) => {
    expect(detectTaskIntent(prompt)).toBe(intent);
  });

  it("detects explicit slash-command and skill phrasing as skill intent", () => {
    expect(detectTaskIntent("use /swarm to coordinate agents")).toBe("skill");
    expect(detectTaskIntent("open the lineup skill")).toBe("skill");
  });

  it("does not treat filesystem or URL paths as skill intent", () => {
    expect(detectTaskIntent("inspect /home/alaarab/phren/mcp/src/shared-retrieval.ts")).toBe("general");
    expect(detectTaskIntent("call /api/health and inspect the response")).toBe("general");
  });
});

describe("selectSnippets", () => {
  function doc(overrides: Partial<DocRow> = {}): DocRow {
    return { project: "project", filename: "file.md", type: "findings", content: "", path: "/file.md", ...overrides };
  }

  it("truncates first snippet when it exceeds budget", () => {
    const longContent = Array.from({ length: 100 }, (_, i) => `Line ${i} with lots of words and content`).join("\n");
    const rows: DocRow[] = [doc({ content: longContent })];
    const { selected, usedTokens } = selectSnippets(rows, "content", 100, 6, 520);
    expect(selected.length).toBe(1);
    expect(usedTokens).toBeLessThanOrEqual(200); // first snippet is always included, possibly truncated
  });
});

// ────────────────────────────────────────────────────────────────────────────
// CLI integration: uninstall
// ────────────────────────────────────────────────────────────────────────────

describe("CLI integration: uninstall", () => {
  let phrenDir: string;
  let homeDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    const tmp = makeTempDir("phren-uninstall-test-");
    phrenDir = path.join(tmp.path, ".phren");
    homeDir = path.join(tmp.path, "home");
    fs.mkdirSync(phrenDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
    grantAdmin(phrenDir, "cli-test");
    cleanup = tmp.cleanup;
  });

  afterEach(() => cleanup());

  // Regression: `npm uninstall -g` resolves against the machine's real npm
  // prefix, which PHREN_PATH and HOME cannot sandbox — so this very test
  // deleted the developer's actual global @phren/cli install (twice, before
  // the guard existed). The test helpers set PHREN_SKIP_GLOBAL_NPM_UNINSTALL
  // for every spawned CLI; this asserts the uninstaller honors it, so the
  // escape cannot come back unnoticed.
  it("does not touch the machine's global npm package", () => {
    const { stdout, exitCode } = runCli(
      ["uninstall"],
      { PHREN_PATH: phrenDir, HOME: homeDir, USERPROFILE: homeDir }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("PHREN_SKIP_GLOBAL_NPM_UNINSTALL=1");
    expect(stdout).not.toContain("Removed global npm package");
  });

  it("removes MCP server and hooks from Claude settings", () => {
    runCli(
      ["init", "-y", "--mcp", "on"],
      { PHREN_PATH: phrenDir, HOME: homeDir, USERPROFILE: homeDir, PHREN_ACTOR: "cli-test" }
    );

    const settingsPath = path.join(homeDir, ".claude", "settings.json");
    expect(fs.existsSync(settingsPath)).toBe(true);

    const before = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(before.mcpServers?.phren).toBeDefined();

    const { stdout, exitCode } = runCli(
      ["uninstall"],
      { PHREN_PATH: phrenDir, HOME: homeDir, USERPROFILE: homeDir }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Uninstalling phren");

    const after = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(after.mcpServers?.phren).toBeUndefined();

    for (const event of ["UserPromptSubmit", "Stop", "SessionStart"]) {
      const hooks = after.hooks?.[event] || [];
      const hasPhren = hooks.some(
        (h: any) => JSON.stringify(h).includes("phren")
      );
      expect(hasPhren).toBe(false);
    }
  }, 30_000);

  it("removes the shared phren root and machine alias", () => {
    const projDir = path.join(phrenDir, "test-proj");
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, "FINDINGS.md"), "# Findings\n- test insight");
    const machineFile = path.join(homeDir, ".phren", ".machine-id");

    runCli(
      ["init", "-y", "--machine", "uninstall-box"],
      { PHREN_PATH: phrenDir, HOME: homeDir, USERPROFILE: homeDir, PHREN_ACTOR: "cli-test" }
    );
    fs.mkdirSync(path.dirname(machineFile), { recursive: true });
    fs.writeFileSync(machineFile, "uninstall-box\n");

    const { exitCode, stdout } = runCli(
      ["uninstall"],
      { PHREN_PATH: phrenDir, HOME: homeDir, USERPROFILE: homeDir }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("installed data removed");
    expect(fs.existsSync(phrenDir)).toBe(false);
    expect(fs.existsSync(machineFile)).toBe(false);
  });

  it("handles missing settings file gracefully", () => {
    const { stdout, exitCode } = runCli(
      ["uninstall"],
      { PHREN_PATH: phrenDir, HOME: homeDir, USERPROFILE: homeDir }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("settings not found");
  });

  it("removes phren from VS Code MCP config", () => {
    const vscodeDir = path.join(homeDir, ".config", "Code", "User");
    fs.mkdirSync(vscodeDir, { recursive: true });
    fs.writeFileSync(
      path.join(vscodeDir, "mcp.json"),
      JSON.stringify({ mcpServers: { phren: { command: "npx", args: ["-y", "phren"] } } }, null, 2)
    );

    const { stdout, exitCode } = runCli(
      ["uninstall"],
      { PHREN_PATH: phrenDir, HOME: homeDir, USERPROFILE: homeDir }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Removed phren from VS Code");

    const after = JSON.parse(fs.readFileSync(path.join(vscodeDir, "mcp.json"), "utf8"));
    expect(after.mcpServers?.phren).toBeUndefined();
  });

  it("removes phren from Cursor MCP config", () => {
    const cursorDir = path.join(homeDir, ".cursor");
    fs.mkdirSync(cursorDir, { recursive: true });
    fs.writeFileSync(
      path.join(cursorDir, "mcp.json"),
      JSON.stringify({ mcpServers: { phren: { command: "npx", args: ["-y", "phren"] } } }, null, 2)
    );

    const { stdout, exitCode } = runCli(
      ["uninstall"],
      { PHREN_PATH: phrenDir, HOME: homeDir, USERPROFILE: homeDir }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Removed phren from Cursor");

    const after = JSON.parse(fs.readFileSync(path.join(cursorDir, "mcp.json"), "utf8"));
    expect(after.mcpServers?.phren).toBeUndefined();
  });

  it("removes global AGENTS.md and copilot-instructions.md symlinks", () => {
    // Create the global AGENTS.md source that init would have created
    const globalDir = path.join(phrenDir, "global");
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(path.join(globalDir, "AGENTS.md"), "# Global instructions");

    // Create the symlinks that linkGlobal creates
    const claudeDir = path.join(homeDir, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.symlinkSync(path.join(globalDir, "AGENTS.md"), path.join(claudeDir, "CLAUDE.md"));

    const githubDir = path.join(homeDir, ".github");
    fs.mkdirSync(githubDir, { recursive: true });
    fs.symlinkSync(path.join(globalDir, "AGENTS.md"), path.join(githubDir, "copilot-instructions.md"));

    const { exitCode, stdout } = runCli(
      ["uninstall"],
      { PHREN_PATH: phrenDir, HOME: homeDir, USERPROFILE: homeDir }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Removed global AGENTS.md symlink");
    expect(stdout).toContain("Removed copilot-instructions.md symlink");
    expect(fs.existsSync(path.join(claudeDir, "CLAUDE.md"))).toBe(false);
    expect(fs.existsSync(path.join(githubDir, "copilot-instructions.md"))).toBe(false);
  });
});

describe("CLI integration: search history", () => {
  let phrenDir: string;
  let cleanup: () => void;

  beforeAll(() => {
    ({ phrenDir, cleanup } = setupPhrenDir());
    const projDir = path.join(phrenDir, "hist-proj");
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(
      path.join(projDir, "FINDINGS.md"),
      "# hist-proj FINDINGS\n\n- Cache invalidation requires full restart\n"
    );
  });

  afterAll(() => cleanup());

  it("--history shows empty history when no searches have been made", () => {
    const { stdout, exitCode } = runCli(
      ["search", "--history"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("No search history");
  });

  it("records search queries and --history shows them", () => {
    // Run a search first
    runCli(
      ["search", "cache"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    // Check history
    const { stdout, exitCode } = runCli(
      ["search", "--history"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("cache");
    expect(stdout).toContain("Recent searches");
  });

  it("--from-history re-runs a previous search", () => {
    // Run a search
    runCli(
      ["search", "restart"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    // Re-run from history
    const { stdout, exitCode } = runCli(
      ["search", "--from-history", "1"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("restart");
  });

  it("--from-history with out-of-range index exits with error", () => {
    const { stderr, exitCode } = runCli(
      ["search", "--from-history", "99"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("No search at position 99");
  });

  it("history stores project and type metadata", () => {
    runCli(
      ["search", "cache", "--project", "hist-proj", "--type", "findings"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    const historyPath = path.join(phrenDir, ".runtime", "search-history.jsonl");
    expect(fs.existsSync(historyPath)).toBe(true);
    const lines = fs.readFileSync(historyPath, "utf8").trim().split("\n");
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.query).toBe("cache");
    expect(entry.project).toBe("hist-proj");
    expect(entry.type).toBe("findings");
  });
});
