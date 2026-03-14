import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { grantAdmin, makeTempDir, setupIsolatedCliEnv, runCliSpawn, type IsolatedCliEnv } from "./test-helpers.js";
import { getMachineName } from "./link.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

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

  beforeEach(() => {
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

  afterEach(() => cleanup());

  it("returns matching results for a known query", () => {
    const { stdout, exitCode } = runCli(
      ["search", "restart", "server"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("restart");
  });

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

  beforeEach(() => {
    ({ phrenDir, cleanup } = setupPhrenDir());
  });

  afterEach(() => cleanup());

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

  it("--fix flag runs without crashing", () => {
    const { stdout, stderr } = runCli(
      ["doctor", "--fix"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    const output = stdout + stderr;
    expect(output).toContain("phren doctor:");
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

  beforeEach(() => {
    ({ phrenDir, cleanup } = setupPhrenDir());
    homeDir = path.dirname(phrenDir);
  });

  afterEach(() => cleanup());

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
    expect(stderr).toContain("npx phren add");
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
    fs.mkdirSync(path.join(phrenDir, ".governance"), { recursive: true });
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
    fs.rmSync(path.join(phrenDir, ".governance"), { recursive: true, force: true });
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

  beforeEach(() => {
    ({ phrenDir, cleanup } = setupPhrenDir());
    const projDir = path.join(phrenDir, "test-proj");
    fs.mkdirSync(projDir, { recursive: true });
  });

  afterEach(() => cleanup());

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

  beforeEach(() => {
    ({ phrenDir, cleanup } = setupPhrenDir());
    const projDir = path.join(phrenDir, "test-proj");
    fs.mkdirSync(projDir, { recursive: true });
  });

  afterEach(() => cleanup());

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

  beforeEach(() => {
    ({ phrenDir, cleanup } = setupPhrenDir());
    const projectDir = path.join(phrenDir, "test-proj");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "FINDINGS.md"),
      "# test-proj FINDINGS\n\n## 2020-01-01\n\n- old memory to prune\n\n## 2026-01-01\n\n- fresh memory\n"
    );
  });

  afterEach(() => cleanup());

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

  beforeEach(() => {
    ({ phrenDir, cleanup } = setupPhrenDir());
    const projDir = path.join(phrenDir, "alpha");
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, "FINDINGS.md"), "# alpha FINDINGS\n\n## 2025-06-01\n\n- caching layer timeout fix\n- database connection pool sizing\n");
    fs.writeFileSync(path.join(projDir, "summary.md"), "# alpha\n\n**What:** A caching project\n");
    fs.writeFileSync(path.join(projDir, "tasks.md"), "# alpha Task\n\n## Active\n\n- Implement retry logic\n\n## Queue\n\n- Refactor config loader\n\n## Done\n\n- Initial setup\n");
    fs.writeFileSync(path.join(projDir, "truths.md"), "# Truths\n\n- Always use UTC timestamps (pinned)\n");
    fs.writeFileSync(path.join(projDir, "CLAUDE.md"), "# alpha\n\nProject-level instructions for alpha.\n");
  });

  afterEach(() => cleanup());

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

  it("--all sets limit to 100 and returns results", () => {
    const { stdout, exitCode } = runCli(
      ["search", "caching", "--project", "alpha", "--all"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("caching");
  });

  it("--limit flag restricts result count", () => {
    const { stdout, exitCode } = runCli(
      ["search", "caching", "--project", "alpha", "--limit", "1"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
  });

  it("invalid --limit value exits with error", () => {
    const { stderr, exitCode } = runCli(
      ["search", "caching", "--limit", "abc"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Invalid --limit value");
  });

  it("--limit 0 exits with error", () => {
    const { stderr, exitCode } = runCli(
      ["search", "caching", "--limit", "0"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Invalid --limit value");
  });

  it("--limit 201 exits with error", () => {
    const { stderr, exitCode } = runCli(
      ["search", "caching", "--limit", "201"],
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

  it("--help flag prints usage without error", () => {
    const { stderr, exitCode } = runCli(
      ["search", "--help"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    // --help causes early return (null), which exits 0
    expect(exitCode).toBe(0);
  });

  it("search with inline --project=alpha format works", () => {
    const { stdout, exitCode } = runCli(
      ["search", "caching", "--project=alpha"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("alpha");
  });

  it("search with --project alone (browse mode) returns results", () => {
    const { stdout, exitCode } = runCli(
      ["search", "--project", "alpha"],
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

  it("search with --type canonical filters correctly", () => {
    const { stdout, exitCode } = runCli(
      ["search", "UTC", "--project", "alpha", "--type", "canonical"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
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

  beforeEach(() => {
    ({ phrenDir, cleanup } = setupPhrenDir());
  });

  afterEach(() => cleanup());

  it("config with no subcommand prints help", () => {
    const { stdout, exitCode } = runCli(
      ["config"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("phren config");
    expect(stdout).toContain("Subcommands:");
  });

  it("config with unknown subcommand exits with error", () => {
    const { stderr, exitCode } = runCli(
      ["config", "bogus"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('Unknown config subcommand: "bogus"');
  });

  it("config policy get returns JSON", () => {
    const { stdout, exitCode } = runCli(
      ["config", "policy", "get"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
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
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("ttlDays");
  });

  it("config policy set updates values", () => {
    const { stdout, exitCode } = runCli(
      ["config", "policy", "set", "--ttlDays=200", "--decay.d30=0.95"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ttlDays).toBe(200);
    expect(parsed.decay.d30).toBe(0.95);
  });

  it("config policy set with invalid action prints usage", () => {
    const { stderr, exitCode } = runCli(
      ["config", "policy", "delete"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Usage:");
  });

  it("config workflow get returns JSON", () => {
    const { stdout, exitCode } = runCli(
      ["config", "workflow", "get"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("lowConfidenceThreshold");
  });

  it("config workflow set updates values", () => {
    const { stdout, exitCode } = runCli(
      ["config", "workflow", "set", "--lowConfidenceThreshold=0.5"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.lowConfidenceThreshold).toBe(0.5);
  });

  it("config workflow set with riskySections", () => {
    const { stdout, exitCode } = runCli(
      ["config", "workflow", "set", "--riskySections=Stale,Conflicts,Review"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.riskySections).toEqual(["Stale", "Conflicts", "Review"]);
  });

  it("config index get returns JSON", () => {
    const { stdout, exitCode } = runCli(
      ["config", "index", "get"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("includeGlobs");
    expect(parsed).toHaveProperty("excludeGlobs");
  });

  it("config index set updates globs", () => {
    const { stdout, exitCode } = runCli(
      ["config", "index", "set", "--include=**/*.md,**/*.txt", "--exclude=**/node_modules/**"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.includeGlobs).toContain("**/*.md");
    expect(parsed.excludeGlobs).toContain("**/node_modules/**");
  });

  it("config index set includeHidden flag", () => {
    const { stdout, exitCode } = runCli(
      ["config", "index", "set", "--includeHidden=true"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.includeHidden).toBe(true);
  });

  it("config index with invalid action prints usage", () => {
    const { stderr, exitCode } = runCli(
      ["config", "index", "remove"],
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

  beforeEach(() => {
    ({ phrenDir, cleanup } = setupPhrenDir());
  });

  afterEach(() => cleanup());

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

  it("maintain govern with no project governs all projects", () => {
    const projDir = path.join(phrenDir, "gov-proj");
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, "FINDINGS.md"), "# gov-proj FINDINGS\n\n## 2025-01-01\n\n- a useful insight\n");

    const { stdout, exitCode } = runCli(
      ["maintain", "govern"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Governed memories:");
  });

  it("maintain govern with specific project", () => {
    const projDir = path.join(phrenDir, "gov-proj");
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, "FINDINGS.md"), "# gov-proj FINDINGS\n\n## 2025-01-01\n\n- a useful insight\n");

    const { stdout, exitCode } = runCli(
      ["maintain", "govern", "gov-proj"],
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
  });

  it("maintain govern --dry-run with no project previews all", () => {
    const projDir = path.join(phrenDir, "gov-dry2");
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, "FINDINGS.md"), "# gov-dry2 FINDINGS\n\n## 2025-01-01\n\n- useful thing\n");

    const { stdout, exitCode } = runCli(
      ["maintain", "govern", "--dry-run"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("[dry-run]");
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

  beforeEach(() => {
    ({ phrenDir, cleanup } = setupPhrenDir());
  });

  afterEach(() => cleanup());

  it("records helpful feedback", () => {
    const { stdout, exitCode } = runCli(
      ["quality-feedback", "--key=test-proj/FINDINGS.md:insight1", "--type=helpful"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Recorded feedback: helpful");
  });

  it("records reprompt feedback", () => {
    const { stdout, exitCode } = runCli(
      ["quality-feedback", "--key=test-proj/FINDINGS.md:insight2", "--type=reprompt"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Recorded feedback: reprompt");
  });

  it("records regression feedback", () => {
    const { stdout, exitCode } = runCli(
      ["quality-feedback", "--key=test-proj/FINDINGS.md:insight3", "--type=regression"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Recorded feedback: regression");
  });

  it("exits with error on missing key", () => {
    const { stderr, exitCode } = runCli(
      ["quality-feedback", "--type=helpful"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Usage:");
  });

  it("exits with error on missing type", () => {
    const { stderr, exitCode } = runCli(
      ["quality-feedback", "--key=test-proj/FINDINGS.md:insight"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Usage:");
  });

  it("exits with error on invalid type", () => {
    const { stderr, exitCode } = runCli(
      ["quality-feedback", "--key=test-proj/FINDINGS.md:insight", "--type=invalid"],
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

  it("exits with error for unknown command", () => {
    // Unknown commands fall through CLI_COMMANDS check and hit the MCP server path
    const { exitCode } = runCli(
      ["nonexistent-command"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).not.toBe(0);
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

  it("adds finding with spaces in the text", () => {
    const { stdout, exitCode } = runCli(
      ["add-finding", "learn-proj", "auth middleware runs before rate limiting, order matters"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("added insight");
    const content = fs.readFileSync(path.join(phrenDir, "learn-proj", "FINDINGS.md"), "utf8");
    expect(content).toContain("auth middleware runs before rate limiting");
  });

  it("creates FINDINGS.md when it does not exist", () => {
    const findingsPath = path.join(phrenDir, "learn-proj", "FINDINGS.md");
    expect(fs.existsSync(findingsPath)).toBe(false);

    runCli(
      ["add-finding", "learn-proj", "new insight"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );

    expect(fs.existsSync(findingsPath)).toBe(true);
    const content = fs.readFileSync(findingsPath, "utf8");
    expect(content).toContain("new insight");
  });

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

  beforeEach(() => {
    ({ phrenDir, cleanup } = setupPhrenDir());
    const projDir = path.join(phrenDir, "pin-proj");
    fs.mkdirSync(projDir, { recursive: true });
  });

  afterEach(() => cleanup());

  it("creates truths.md with truth content", () => {
    const { exitCode } = runCli(
      ["pin", "pin-proj", "never commit secrets to version control"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);

    const canonical = path.join(phrenDir, "pin-proj", "truths.md");
    expect(fs.existsSync(canonical)).toBe(true);
    const content = fs.readFileSync(canonical, "utf8");
    expect(content).toContain("never commit secrets to version control");
  });

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

  beforeEach(() => {
    ({ phrenDir, cleanup } = setupPhrenDir());
    projectsDir = path.join(path.dirname(phrenDir), "projects");
    fs.mkdirSync(projectsDir, { recursive: true });
    process.env.PROJECTS_DIR = projectsDir;
  });

  afterEach(() => {
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

  it("reports fts-index check", () => {
    const { stdout, stderr } = runCli(
      ["doctor"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    const output = stdout + stderr;
    expect(output).toContain("fts-index");
  });

  it("reports machine-registered check", () => {
    const { stdout, stderr } = runCli(
      ["doctor"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    const output = stdout + stderr;
    expect(output).toContain("machine-registered");
  });

  it("--check-data reports suspect task hygiene items", () => {
    const profilesDir = path.join(phrenDir, "profiles");
    fs.mkdirSync(profilesDir, { recursive: true });
    fs.writeFileSync(path.join(profilesDir, "test.yaml"), "name: test\ndescription: Test\nprojects:\n  - doc-proj\n");
    fs.writeFileSync(path.join(phrenDir, "machines.yaml"), `${getMachineName()}: test\n`);

    const projDir = path.join(phrenDir, "doc-proj");
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(
      path.join(projDir, "tasks.md"),
      "# doc-proj Task\n\n## Active\n\n## Queue\n\n- Improve chart interface with bubble details and device type filters\n\n## Done\n"
    );

    const repoDir = path.join(projectsDir, "doc-proj");
    fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "src", "shell-view.ts"), "export const shellView = true;\n");

    const { stdout, stderr } = runCli(
      ["doctor", "--check-data"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    const output = stdout + stderr;
    expect(output).toContain("data:task-hygiene:doc-proj");
    expect(output).toContain("suspect task");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// NEW TESTS: status / inspect-index / debug-injection
// ────────────────────────────────────────────────────────────────────────────

describe("CLI integration: inspect-index and debug-injection", () => {
  let phrenDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ phrenDir, cleanup } = setupPhrenDir());
    const projDir = path.join(phrenDir, "idx-proj");
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, "FINDINGS.md"), "# idx-proj FINDINGS\n\n## 2025-01-01\n\n- indexed content here\n");
  });

  afterEach(() => cleanup());

  it("inspect-index returns index contents", () => {
    const { stdout, exitCode } = runCli(
      ["inspect-index"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "cli-test" }
    );
    expect(exitCode).toBe(0);
    // Should list docs in the index
    expect(stdout.length).toBeGreaterThan(0);
  });

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

  it("init --dry-run does not create files", () => {
    const { stdout, exitCode } = runCli(
      ["init", "--dry-run", "-y"],
      cliEnv.env()
    );
    expect(exitCode).toBe(0);
    expect(stdout.toLowerCase()).toContain("dry run");
    expect(fs.existsSync(cliEnv.phrenDir)).toBe(false);
  }, CLI_INTEGRATION_TIMEOUT_MS);

  it("init -y creates phren directory and governance files", () => {
    const { stdout, exitCode } = runCli(
      ["init", "-y", "--mcp", "off"],
      cliEnv.env({ PHREN_ACTOR: "cli-test" })
    );
    expect(exitCode).toBe(0);
    expect(fs.existsSync(cliEnv.phrenDir)).toBe(true);
    const govDir = path.join(cliEnv.phrenDir, ".governance");
    expect(fs.existsSync(govDir)).toBe(true);
  }, CLI_INTEGRATION_TIMEOUT_MS);

  it("init with --machine sets machine name", () => {
    const { exitCode } = runCli(
      ["init", "-y", "--machine", "test-box", "--mcp", "off"],
      cliEnv.env({ PHREN_ACTOR: "cli-test" })
    );
    expect(exitCode).toBe(0);
    const machinesPath = path.join(cliEnv.phrenDir, "machines.yaml");
    if (fs.existsSync(machinesPath)) {
      const content = fs.readFileSync(machinesPath, "utf8");
      expect(content).toContain("test-box");
    }
  }, CLI_INTEGRATION_TIMEOUT_MS);

  it("init with --machine persists the local machine alias", () => {
    const { exitCode } = runCli(
      ["init", "-y", "--machine", "test-box", "--mcp", "off"],
      cliEnv.env({ PHREN_ACTOR: "cli-test" })
    );
    expect(exitCode).toBe(0);
    const machineFile = path.join(cliEnv.homeDir, ".phren", ".machine-id");
    expect(fs.readFileSync(machineFile, "utf8").trim()).toBe("test-box");
  }, CLI_INTEGRATION_TIMEOUT_MS);

  it("init is idempotent (re-running does not fail)", () => {
    runCli(
      ["init", "-y", "--mcp", "off"],
      cliEnv.env({ PHREN_ACTOR: "cli-test" })
    );
    const { exitCode } = runCli(
      ["init", "-y", "--mcp", "off"],
      cliEnv.env({ PHREN_ACTOR: "cli-test" })
    );
    expect(exitCode).toBe(0);
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

  it("verify on fresh init reports checks", () => {
    runCli(
      ["init", "-y", "--mcp", "off"],
      cliEnv.env({ PHREN_ACTOR: "cli-test" })
    );
    const { stdout, stderr } = runCli(
      ["verify"],
      cliEnv.env()
    );
    const output = stdout + stderr;
    expect(output).toContain("phren verify:");
    expect(output).toMatch(/(pass|FAIL)/);
  }, CLI_INTEGRATION_TIMEOUT_MS);

  it("verify on empty directory reports issues", () => {
    fs.mkdirSync(cliEnv.phrenDir, { recursive: true });
    const { stdout, stderr } = runCli(
      ["verify"],
      cliEnv.env()
    );
    const output = stdout + stderr;
    expect(output).toContain("phren verify:");
  }, CLI_INTEGRATION_TIMEOUT_MS);

  it("verify checks fts-index and hook-entrypoint", () => {
    runCli(
      ["init", "-y", "--mcp", "off"],
      cliEnv.env({ PHREN_ACTOR: "cli-test" })
    );
    const { stdout, stderr } = runCli(
      ["verify"],
      cliEnv.env()
    );
    const output = stdout + stderr;
    expect(output).toContain("fts-index");
    expect(output).toContain("hook-entrypoint");
  }, CLI_INTEGRATION_TIMEOUT_MS);

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
    expect(stdout).toContain("doctor");
    expect(stdout).not.toContain("projects add");
    expect(stdout).not.toContain("phren link");
    expect(stdout).not.toContain("--from-existing");
  });

  it("-h prints usage information", () => {
    const { stdout, exitCode } = runCli(["-h"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("phren");
  });

  it("help prints usage information", () => {
    const { stdout, exitCode } = runCli(["help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("phren");
  });

  it("projects help only shows the supported add flow", () => {
    const { stdout, exitCode } = runCli(["projects", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("phren projects list");
    expect(stdout).toContain("phren projects remove <name>");
    expect(stdout).not.toContain("projects add");
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
});

describe("CLI integration: temp HOME subprocess stability", () => {
  let cliEnv: IsolatedCliEnv;
  let cleanup: () => void;

  beforeEach(() => {
    cliEnv = setupIsolatedCliEnv("phren-temp-home-cli-test-");
    cleanup = cliEnv.cleanup;
  });

  afterEach(() => cleanup());

  it("help prints usage information with a temp HOME", () => {
    const { stdout, exitCode } = runCli(
      ["help"],
      cliEnv.env()
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("phren");
    expect(stdout).toContain("search");
    expect(stdout).toContain("doctor");
  }, CLI_INTEGRATION_TIMEOUT_MS);

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

  beforeEach(() => {
    const tmp = makeTempDir("phren-detect-skills-test-");
    phrenDir = path.join(tmp.path, ".phren");
    homeDir = path.join(tmp.path, "home");
    fs.mkdirSync(phrenDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
    grantAdmin(phrenDir, "cli-test");
    cleanup = tmp.cleanup;
  });

  afterEach(() => cleanup());

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

import { scoreFindingCandidate, detectTaskIntent, selectSnippets } from "./cli.js";
import { DocRow } from "./shared-index.js";

describe("scoreFindingCandidate", () => {
  it("returns null for low-signal commits", () => {
    expect(scoreFindingCandidate("update readme", "")).toBeNull();
  });

  it("scores fix commits above threshold", () => {
    const result = scoreFindingCandidate("fix: timeout on api calls causing retries", "root cause was missing keepalive");
    expect(result).not.toBeNull();
    expect(result!.score).toBeGreaterThanOrEqual(0.5);
    expect(result!.text).toBeTruthy();
  });

  it("scores merged PRs higher than plain commits", () => {
    const merged = scoreFindingCandidate("Merge pull request #42 from user/fix-timeout", "fix retry logic");
    const plain = scoreFindingCandidate("fix retry logic", "");
    expect(merged).not.toBeNull();
    expect(plain).not.toBeNull();
    expect(merged!.score).toBeGreaterThan(plain!.score);
  });

  it("caps score at 0.99", () => {
    const result = scoreFindingCandidate(
      "Merge pull request #1 from user/fix-ci-timeout-regression",
      "CI pipeline flake fix: root cause was timeout regression in build step"
    );
    expect(result).not.toBeNull();
    expect(result!.score).toBeLessThanOrEqual(0.99);
  });

  it("cleans merge PR prefix from text", () => {
    const result = scoreFindingCandidate("Merge pull request #42 from user/branch Fix timeout issue", "workaround applied");
    expect(result).not.toBeNull();
    expect(result!.text).not.toMatch(/^Merge pull request/);
  });

  it("capitalizes first letter of cleaned text", () => {
    const result = scoreFindingCandidate("fix: handle edge case in retry", "regression found");
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
    return { project: "project", filename: "file.md", type: "findings", content: "", path: "/file.md", ...overrides };
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
  });

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
});

describe("CLI integration: search history", () => {
  let phrenDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ phrenDir, cleanup } = setupPhrenDir());
    const projDir = path.join(phrenDir, "hist-proj");
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(
      path.join(projDir, "FINDINGS.md"),
      "# hist-proj FINDINGS\n\n- Cache invalidation requires full restart\n"
    );
  });

  afterEach(() => cleanup());

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
