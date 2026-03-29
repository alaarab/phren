import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
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

describe("CLI config: policy", () => {
  let phrenDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ phrenDir, cleanup } = setupPhrenDir());
  });
  afterEach(() => cleanup());

  it("gets default policy", () => {
    const { stdout, exitCode } = runCli(
      ["config", "policy", "get"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "config-test" }
    );
    expect(exitCode).toBe(0);
    const policy = JSON.parse(stdout);
    expect(policy).toHaveProperty("ttlDays");
    expect(policy).toHaveProperty("autoAcceptThreshold");
  });

  it("sets and reads back policy values", () => {
    const setResult = runCli(
      ["config", "policy", "set", "--ttlDays=90", "--autoAcceptThreshold=0.9"],
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
  });

  it("sets nested decay values", () => {
    const setResult = runCli(
      ["config", "policy", "set", "--decay.d30=0.95", "--decay.d60=0.8"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "config-test" }
    );
    expect(setResult.exitCode).toBe(0);

    const getResult = runCli(
      ["config", "policy", "get"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "config-test" }
    );
    const policy = JSON.parse(getResult.stdout);
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

  it("gets default workflow policy", () => {
    const { stdout, exitCode } = runCli(
      ["config", "workflow", "get"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "config-test" }
    );
    expect(exitCode).toBe(0);
    const workflow = JSON.parse(stdout);
    expect(workflow).toHaveProperty("lowConfidenceThreshold");
  });

  it("sets workflow values", () => {
    const setResult = runCli(
      ["config", "workflow", "set", "--lowConfidenceThreshold=0.6"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "config-test" }
    );
    expect(setResult.exitCode).toBe(0);

    const getResult = runCli(
      ["config", "workflow", "get"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "config-test" }
    );
    const workflow = JSON.parse(getResult.stdout);
    expect(workflow.lowConfidenceThreshold).toBe(0.6);
  });

  it("sets riskySections as comma-separated list", () => {
    runCli(
      ["config", "workflow", "set", "--riskySections=Stale,Conflicts,Deprecated"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "config-test" }
    );
    const { stdout } = runCli(
      ["config", "workflow", "get"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "config-test" }
    );
    const workflow = JSON.parse(stdout);
    expect(workflow.riskySections).toContain("Stale");
    expect(workflow.riskySections).toContain("Conflicts");
  });
});

describe("CLI config: index", () => {
  let phrenDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ phrenDir, cleanup } = setupPhrenDir());
  });
  afterEach(() => cleanup());

  it("gets default index policy", () => {
    const { stdout, exitCode } = runCli(
      ["config", "index", "get"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "config-test" }
    );
    expect(exitCode).toBe(0);
    const index = JSON.parse(stdout);
    expect(index).toHaveProperty("includeGlobs");
    expect(index).toHaveProperty("excludeGlobs");
  });

  it("sets include and exclude globs", () => {
    runCli(
      ["config", "index", "set", "--include=**/*.md,**/*.txt", "--exclude=**/node_modules/**"],
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
  });

  it("sets includeHidden flag", () => {
    runCli(
      ["config", "index", "set", "--includeHidden=true"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "config-test" }
    );
    const { stdout } = runCli(
      ["config", "index", "get"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "config-test" }
    );
    const index = JSON.parse(stdout);
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
  });

  it("disables telemetry", () => {
    runCli(["config", "telemetry", "on"], { PHREN_PATH: phrenDir, PHREN_ACTOR: "config-test" });
    const { stdout, exitCode } = runCli(
      ["config", "telemetry", "off"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "config-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("disabled");
  });

  it("resets telemetry", () => {
    runCli(["config", "telemetry", "on"], { PHREN_PATH: phrenDir, PHREN_ACTOR: "config-test" });
    const { stdout } = runCli(
      ["config", "telemetry", "reset"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "config-test" }
    );
    expect(stdout).toContain("reset");
  });

  it("shows summary when no action given", () => {
    const { stdout, exitCode } = runCli(
      ["config", "telemetry"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "config-test" }
    );
    expect(exitCode).toBe(0);
    // Summary should contain some telemetry info
    expect(stdout.length).toBeGreaterThan(0);
  });
});

describe("CLI config: machines and profiles", () => {
  let phrenDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ phrenDir, cleanup } = setupPhrenDir());
  });
  afterEach(() => cleanup());

  it("lists machines (empty or with data)", () => {
    const { stdout, exitCode } = runCli(
      ["config", "machines"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "config-test" }
    );
    expect(exitCode).toBe(0);
    // Either shows machines or a message about no machines
    expect(stdout.length).toBeGreaterThan(0);
  });

  it("lists profiles (empty or with data)", () => {
    const { stdout, exitCode } = runCli(
      ["config", "profiles"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "config-test" }
    );
    expect(exitCode).toBe(0);
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

  it("lists learned synonyms for a project", () => {
    const { stdout, exitCode } = runCli(
      ["config", "synonyms", "list", "demo"],
      { PHREN_PATH: phrenDir, PHREN_ACTOR: "config-test" }
    );
    expect(exitCode).toBe(0);
    const payload = JSON.parse(stdout);
    expect(payload.project).toBe("demo");
    expect(payload.synonyms).toEqual({});
  });

  it("adds and removes learned synonyms", () => {
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
