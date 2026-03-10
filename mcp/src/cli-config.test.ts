import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { makeTempDir, grantAdmin } from "./test-helpers.js";
import { execFileSync } from "child_process";

const CLI_PATH = path.resolve(__dirname, "../dist/index.js");
const REPO_ROOT = path.resolve(__dirname, "../..");

function ensureCliBuilt(): void {
  if (fs.existsSync(CLI_PATH)) return;
  execFileSync("npm", ["run", "build"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30000,
  });
}

function runCli(args: string[], env: Record<string, string> = {}): { stdout: string; stderr: string; exitCode: number } {
  try {
    ensureCliBuilt();
    const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
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
  const tmp = makeTempDir("cortex-config-test-");
  const cortexDir = path.join(tmp.path, ".cortex");
  fs.mkdirSync(cortexDir, { recursive: true });
  grantAdmin(cortexDir, "config-test");
  return { cortexDir, cleanup: tmp.cleanup };
}

describe("CLI config: help", () => {
  let cortexDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ cortexDir, cleanup } = setupCortexDir());
  });
  afterEach(() => cleanup());

  it("prints help when no subcommand given", () => {
    const { stdout, exitCode } = runCli(
      ["config"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "config-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("cortex config");
    expect(stdout).toContain("policy");
    expect(stdout).toContain("workflow");
    expect(stdout).toContain("access");
  });

  it("exits with error for unknown subcommand", () => {
    const { stderr, exitCode } = runCli(
      ["config", "nonexistent"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "config-test" }
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown config subcommand");
  });
});

describe("CLI config: policy", () => {
  let cortexDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ cortexDir, cleanup } = setupCortexDir());
  });
  afterEach(() => cleanup());

  it("gets default policy", () => {
    const { stdout, exitCode } = runCli(
      ["config", "policy", "get"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "config-test" }
    );
    expect(exitCode).toBe(0);
    const policy = JSON.parse(stdout);
    expect(policy).toHaveProperty("ttlDays");
    expect(policy).toHaveProperty("autoAcceptThreshold");
  });

  it("sets and reads back policy values", () => {
    const setResult = runCli(
      ["config", "policy", "set", "--ttlDays=90", "--autoAcceptThreshold=0.9"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "config-test" }
    );
    expect(setResult.exitCode).toBe(0);

    const getResult = runCli(
      ["config", "policy", "get"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "config-test" }
    );
    const policy = JSON.parse(getResult.stdout);
    expect(policy.ttlDays).toBe(90);
    expect(policy.autoAcceptThreshold).toBe(0.9);
  });

  it("sets nested decay values", () => {
    const setResult = runCli(
      ["config", "policy", "set", "--decay.d30=0.95", "--decay.d60=0.8"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "config-test" }
    );
    expect(setResult.exitCode).toBe(0);

    const getResult = runCli(
      ["config", "policy", "get"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "config-test" }
    );
    const policy = JSON.parse(getResult.stdout);
    expect(policy.decay.d30).toBe(0.95);
    expect(policy.decay.d60).toBe(0.8);
  });
});

describe("CLI config: workflow", () => {
  let cortexDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ cortexDir, cleanup } = setupCortexDir());
  });
  afterEach(() => cleanup());

  it("gets default workflow policy", () => {
    const { stdout, exitCode } = runCli(
      ["config", "workflow", "get"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "config-test" }
    );
    expect(exitCode).toBe(0);
    const workflow = JSON.parse(stdout);
    expect(workflow).toHaveProperty("requireMaintainerApproval");
  });

  it("sets workflow values", () => {
    const setResult = runCli(
      ["config", "workflow", "set", "--requireMaintainerApproval=true", "--lowConfidenceThreshold=0.6"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "config-test" }
    );
    expect(setResult.exitCode).toBe(0);

    const getResult = runCli(
      ["config", "workflow", "get"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "config-test" }
    );
    const workflow = JSON.parse(getResult.stdout);
    expect(workflow.requireMaintainerApproval).toBe(true);
    expect(workflow.lowConfidenceThreshold).toBe(0.6);
  });

  it("sets riskySections as comma-separated list", () => {
    runCli(
      ["config", "workflow", "set", "--riskySections=Stale,Conflicts,Deprecated"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "config-test" }
    );
    const { stdout } = runCli(
      ["config", "workflow", "get"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "config-test" }
    );
    const workflow = JSON.parse(stdout);
    expect(workflow.riskySections).toContain("Stale");
    expect(workflow.riskySections).toContain("Conflicts");
  });
});

describe("CLI config: access", () => {
  let cortexDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ cortexDir, cleanup } = setupCortexDir());
  });
  afterEach(() => cleanup());

  it("gets default access control", () => {
    const { stdout, exitCode } = runCli(
      ["config", "access", "get"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "config-test" }
    );
    expect(exitCode).toBe(0);
    const access = JSON.parse(stdout);
    expect(access).toHaveProperty("admins");
    expect(access.admins).toContain("config-test");
  });

  it("sets access control roles", () => {
    runCli(
      ["config", "access", "set", "--admins=config-test,admin2", "--maintainers=m1,m2", "--contributors=c1"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "config-test" }
    );
    const { stdout } = runCli(
      ["config", "access", "get"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "config-test" }
    );
    const access = JSON.parse(stdout);
    expect(access.admins).toContain("admin2");
    expect(access.maintainers).toEqual(["m1", "m2"]);
    expect(access.contributors).toEqual(["c1"]);
  });
});

describe("CLI config: index", () => {
  let cortexDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ cortexDir, cleanup } = setupCortexDir());
  });
  afterEach(() => cleanup());

  it("gets default index policy", () => {
    const { stdout, exitCode } = runCli(
      ["config", "index", "get"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "config-test" }
    );
    expect(exitCode).toBe(0);
    const index = JSON.parse(stdout);
    expect(index).toHaveProperty("includeGlobs");
    expect(index).toHaveProperty("excludeGlobs");
  });

  it("sets include and exclude globs", () => {
    runCli(
      ["config", "index", "set", "--include=**/*.md,**/*.txt", "--exclude=**/node_modules/**"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "config-test" }
    );
    const { stdout } = runCli(
      ["config", "index", "get"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "config-test" }
    );
    const index = JSON.parse(stdout);
    expect(index.includeGlobs).toContain("**/*.md");
    expect(index.includeGlobs).toContain("**/*.txt");
    expect(index.excludeGlobs).toContain("**/node_modules/**");
  });

  it("sets includeHidden flag", () => {
    runCli(
      ["config", "index", "set", "--includeHidden=true"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "config-test" }
    );
    const { stdout } = runCli(
      ["config", "index", "get"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "config-test" }
    );
    const index = JSON.parse(stdout);
    expect(index.includeHidden).toBe(true);
  });
});

describe("CLI config: telemetry", () => {
  let cortexDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ cortexDir, cleanup } = setupCortexDir());
  });
  afterEach(() => cleanup());

  it("enables telemetry", () => {
    const { stdout, exitCode } = runCli(
      ["config", "telemetry", "on"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "config-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("enabled");
  });

  it("disables telemetry", () => {
    runCli(["config", "telemetry", "on"], { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "config-test" });
    const { stdout, exitCode } = runCli(
      ["config", "telemetry", "off"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "config-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("disabled");
  });

  it("resets telemetry", () => {
    runCli(["config", "telemetry", "on"], { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "config-test" });
    const { stdout } = runCli(
      ["config", "telemetry", "reset"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "config-test" }
    );
    expect(stdout).toContain("reset");
  });

  it("shows summary when no action given", () => {
    const { stdout, exitCode } = runCli(
      ["config", "telemetry"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "config-test" }
    );
    expect(exitCode).toBe(0);
    // Summary should contain some telemetry info
    expect(stdout.length).toBeGreaterThan(0);
  });
});

describe("CLI config: machines and profiles", () => {
  let cortexDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ cortexDir, cleanup } = setupCortexDir());
  });
  afterEach(() => cleanup());

  it("lists machines (empty or with data)", () => {
    const { stdout, exitCode } = runCli(
      ["config", "machines"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "config-test" }
    );
    expect(exitCode).toBe(0);
    // Either shows machines or a message about no machines
    expect(stdout.length).toBeGreaterThan(0);
  });

  it("lists profiles (empty or with data)", () => {
    const { stdout, exitCode } = runCli(
      ["config", "profiles"],
      { CORTEX_PATH: cortexDir, CORTEX_ACTOR: "config-test" }
    );
    expect(exitCode).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
  });
});
