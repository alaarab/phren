import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, grantAdmin, runCliExec } from "./test-helpers.js";

const runCli = runCliExec;

function setupPhrenDir(): { phrenDir: string; cleanup: () => void } {
  const tmp = makeTempDir("phren-config-test-");
  const phrenDir = path.join(tmp.path, ".phren");
  fs.mkdirSync(phrenDir, { recursive: true });
  grantAdmin(phrenDir, "config-test");
  return { phrenDir, cleanup: tmp.cleanup };
}

describe("CLI config: help", () => {
  let phrenDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ phrenDir, cleanup } = setupPhrenDir());
  });
  afterEach(() => cleanup());

  it("prints help when no subcommand given", () => {
    const { stdout, exitCode } = runCli(
      ["config"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "config-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("phren config");
    expect(stdout).toContain("policy");
    expect(stdout).toContain("workflow");
    expect(stdout).toContain("synonyms");
  });

  it("exits with error for unknown subcommand", () => {
    const { stderr, exitCode } = runCli(
      ["config", "nonexistent"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "config-test" }
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown config subcommand");
  });
});

describe("CLI config: pull interval", () => {
  it("persists a machine-local interval, reports overrides, and rejects invalid values", () => {
    const { phrenDir, cleanup } = setupPhrenDir();
    const env = { PHREN_PATH: phrenDir, PHREN_PULL_INTERVAL_SECONDS: "" };
    try {
      expect(runCli(["config", "pull-interval"], env).stdout).toContain("off (default)");
      expect(runCli(["config", "pull-interval", "600"], env).exitCode).toBe(0);
      expect(runCli(["config", "pull-interval"], env).stdout).toContain("600 seconds (install preferences)");
      expect(runCli(["config", "pull-interval", "10"], env).exitCode).toBe(1);
      expect(runCli(["config", "pull-interval"], env).stdout).toContain("600 seconds");
      expect(runCli(["config", "pull-interval"], { ...env, PHREN_PULL_INTERVAL_SECONDS: "120" }).stdout).toContain("120 seconds (PHREN_PULL_INTERVAL_SECONDS)");
      expect(runCli(["config", "pull-interval", "off"], env).stdout).toContain("Pull interval: off");
    } finally { cleanup(); }
  });
});

describe("CLI config: policy", () => {
  let phrenDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ phrenDir, cleanup } = setupPhrenDir());
  });
  afterEach(() => cleanup());

  it("sets and reads back policy values", () => {
    const setResult = runCli(
      ["config", "policy", "set", "--ttlDays=90", "--autoAcceptThreshold=0.9", "--decay.d30=0.95", "--decay.d60=0.8"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "config-test" }
    );
    expect(setResult.exitCode).toBe(0);

    const getResult = runCli(
      ["config", "policy", "get"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "config-test" }
    );
    const policy = JSON.parse(getResult.stdout);
    expect(policy.ttlDays).toBe(90);
    expect(policy.autoAcceptThreshold).toBe(0.9);
    expect(policy.decay.d30).toBe(0.95);
    expect(policy.decay.d60).toBe(0.8);
  });
});

describe("CLI config: workflow", () => {
  let phrenDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ phrenDir, cleanup } = setupPhrenDir());
  });
  afterEach(() => cleanup());

  it("sets workflow values", () => {
    const setResult = runCli(
      ["config", "workflow", "set", "--lowConfidenceThreshold=0.6", "--riskySections=Stale,Conflicts,Deprecated"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "config-test" }
    );
    expect(setResult.exitCode).toBe(0);

    const getResult = runCli(
      ["config", "workflow", "get"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "config-test" }
    );
    const workflow = JSON.parse(getResult.stdout);
    expect(workflow.lowConfidenceThreshold).toBe(0.6);
    // Comma-separated sections; unknown ones are dropped.
    expect(workflow.riskySections).toEqual(["Stale", "Conflicts"]);
  });
});

describe("CLI config: index", () => {
  let phrenDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ phrenDir, cleanup } = setupPhrenDir());
  });
  afterEach(() => cleanup());

  it("sets include and exclude globs", () => {
    runCli(
      ["config", "index", "set", "--include=**/*.md,**/*.txt", "--exclude=**/node_modules/**", "--includeHidden=true"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "config-test" }
    );
    const { stdout } = runCli(
      ["config", "index", "get"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "config-test" }
    );
    const index = JSON.parse(stdout);
    expect(index.includeGlobs).toContain("**/*.md");
    expect(index.includeGlobs).toContain("**/*.txt");
    expect(index.excludeGlobs).toContain("**/node_modules/**");
    expect(index.includeHidden).toBe(true);
  });
});

describe("CLI config: telemetry", () => {
  let phrenDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ phrenDir, cleanup } = setupPhrenDir());
  });
  afterEach(() => cleanup());

  it("enables telemetry", () => {
    const { stdout, exitCode } = runCli(
      ["config", "telemetry", "on"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "config-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("enabled");

    const off = runCli(["config", "telemetry", "off"], { PHREN_PATH: phrenDir, PHREN_ACTOR: "config-test" });
    expect(off.exitCode).toBe(0);
    expect(off.stdout).toContain("disabled");

    const reset = runCli(["config", "telemetry", "reset"], { PHREN_PATH: phrenDir, PHREN_ACTOR: "config-test" });
    expect(reset.stdout).toContain("reset");
  });
});

describe("CLI config: machines and profiles", () => {
  let phrenDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ phrenDir, cleanup } = setupPhrenDir());
  });
  afterEach(() => cleanup());

  it.each(["machines", "profiles"])("lists %s (empty or with data)", (what) => {
    const { stdout, exitCode } = runCli(
      ["config", what],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "config-test" }
    );
    expect(exitCode).toBe(0);
    // Either shows entries or a message about none
    expect(stdout.length).toBeGreaterThan(0);
  });
});

describe("CLI config: synonyms", () => {
  let phrenDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ phrenDir, cleanup } = setupPhrenDir());
    fs.mkdirSync(path.join(phrenDir, "demo"), { recursive: true });
  });
  afterEach(() => cleanup());

  it("lists, adds and removes learned synonyms", () => {
    const empty = runCli(["config", "synonyms", "list", "demo"], { PHREN_PATH: phrenDir, PHREN_ACTOR: "config-test" });
    expect(empty.exitCode).toBe(0);
    expect(JSON.parse(empty.stdout)).toMatchObject({ project: "demo", synonyms: {} });

    const add = runCli(
      ["config", "synonyms", "add", "demo", "latency", "slow,lag"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "config-test" }
    );
    expect(add.exitCode).toBe(0);

    const listed = runCli(
      ["config", "synonyms", "demo"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "config-test" }
    );
    const payload = JSON.parse(listed.stdout);
    expect(payload.synonyms.latency).toContain("slow");
    expect(payload.synonyms.latency).toContain("lag");

    const removeOne = runCli(
      ["config", "synonyms", "remove", "demo", "latency", "lag"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "config-test" }
    );
    expect(removeOne.exitCode).toBe(0);

    const removeAll = runCli(
      ["config", "synonyms", "remove", "demo", "latency"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "config-test" }
    );
    expect(removeAll.exitCode).toBe(0);
  });
});

describe("CLI config: show", () => {
  let phrenDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ phrenDir, cleanup } = setupPhrenDir());
    fs.mkdirSync(path.join(phrenDir, "demo"), { recursive: true });
  });
  afterEach(() => cleanup());

  it("renders config grouped by domain with a source column", () => {
    const { stdout, exitCode } = runCli(
      ["config", "show"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "config-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("phren config — global");
    expect(stdout).toContain("Retention");
    expect(stdout).toContain("TTL (days)");
    expect(stdout).toContain("default");
  });

  it("shows the source as global after a value is set, and surfaces it in --diff", () => {
    runCli(
      ["config", "task-mode", "set", "suggest"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "config-test" }
    );
    const json = runCli(
      ["config", "show", "--json"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "config-test" }
    );
    const view = JSON.parse(json.stdout);
    expect(view.fields.taskMode.value).toBe("suggest");
    expect(view.fields.taskMode.source).toBe("global");

    const diff = runCli(
      ["config", "show", "--diff"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "config-test" }
    );
    expect(diff.stdout).toContain("suggest");
    expect(diff.stdout).toContain("global");
  });

  it("reports everything as default in --diff before any change", () => {
    const { stdout } = runCli(
      ["config", "show", "--diff"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "config-test" }
    );
    expect(stdout).toContain("Everything is at its default value");
  });

  it("renders a project-scoped view", () => {
    const { stdout, exitCode } = runCli(
      ["config", "show", "--project", "demo"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "config-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("project: demo");
  });
});

describe("CLI config: access", () => {
  let phrenDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ phrenDir, cleanup } = setupPhrenDir());
    fs.mkdirSync(path.join(phrenDir, "demo"), { recursive: true });
  });
  afterEach(() => cleanup());

  it("sets a global admin and reads it back", () => {
    const set = runCli(
      ["config", "access", "set", "--admins=alice,bob"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "config-test" }
    );
    expect(set.exitCode).toBe(0);
    const payload = JSON.parse(set.stdout);
    expect(payload.admins).toEqual(["alice", "bob"]);
  });

  it("unions global and per-project role lists", () => {
    runCli(
      ["config", "access", "set", "--admins=alice"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "config-test" }
    );
    // Once the ACL names an admin, further edits require that admin — the
    // same rule every other RBAC action already followed.
    runCli(
      ["config", "access", "--project", "demo", "set", "--contributors=carol"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "alice" }
    );
    const { stdout } = runCli(
      ["config", "access", "--project", "demo", "get"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "config-test" }
    );
    const payload = JSON.parse(stdout);
    expect(payload.admins).toEqual(["alice"]);
    expect(payload.contributors).toEqual(["carol"]);
  });
});
