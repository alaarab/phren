import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { initTestPhrenRoot, makeTempDir } from "../test-helpers.js";
import { getIndexPolicy, getRetentionPolicy, getWorkflowPolicy } from "../governance/policy.js";
import { readProjectConfig } from "../project-config.js";

const originalEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  PHREN_PATH: process.env.PHREN_PATH,
  PHREN_PROFILE: process.env.PHREN_PROFILE,
  PHREN_FEATURE_SEMANTIC_CONFLICT: process.env.PHREN_FEATURE_SEMANTIC_CONFLICT,
};

let tmp: { path: string; cleanup: () => void };
let phrenDir: string;
let homeDir: string;

function restoreEnv(name: keyof typeof originalEnv): void {
  const value = originalEnv[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function importPolicy() {
  vi.resetModules();
  return await import("./config-policy.js");
}

function captureConsole() {
  const logs: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map((arg) => String(arg)).join(" "));
  });
  return { logs, errors };
}

function captureStderr() {
  const chunks: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  return { text: () => chunks.join("") };
}

class ExitError extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

function mockExit() {
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as typeof process.exit);
}

async function expectExit(fn: () => unknown): Promise<ExitError> {
  try {
    await fn();
  } catch (err: unknown) {
    if (err instanceof ExitError) return err;
    throw err;
  }
  throw new Error("expected the handler to exit");
}

beforeEach(() => {
  tmp = makeTempDir("phren-config-policy-");
  phrenDir = path.join(tmp.path, ".phren");
  homeDir = path.join(tmp.path, "home");
  fs.mkdirSync(phrenDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  initTestPhrenRoot(phrenDir);

  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  process.env.PHREN_PATH = phrenDir;
  delete process.env.PHREN_PROFILE;
  delete process.env.PHREN_FEATURE_SEMANTIC_CONFLICT;
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreEnv("HOME");
  restoreEnv("USERPROFILE");
  restoreEnv("PHREN_PATH");
  restoreEnv("PHREN_PROFILE");
  restoreEnv("PHREN_FEATURE_SEMANTIC_CONFLICT");
  tmp.cleanup();
});



describe("config retention policy", () => {
  it("prints the defaults with the dedup and conflict-detection guidance", async () => {
    const { handleRetentionPolicy } = await importPolicy();
    const output = captureConsole();
    const stderr = captureStderr();

    await handleRetentionPolicy([]);

    expect(JSON.parse(output.logs[0])).toMatchObject({
      ttlDays: 120,
      retentionDays: 365,
      autoAcceptThreshold: 0.75,
      minInjectConfidence: 0.35,
      decay: { d30: 1, d60: 0.85, d90: 0.65, d120: 0.45 },
    });
    expect(stderr.text()).toContain("Dedup: free Jaccard similarity scan");
    expect(stderr.text()).toContain("Conflict detection: disabled");
  });

  it("reports conflict detection as active when the feature flag is on", async () => {
    process.env.PHREN_FEATURE_SEMANTIC_CONFLICT = "1";
    const { handleRetentionPolicy } = await importPolicy();
    captureConsole();
    const stderr = captureStderr();

    await handleRetentionPolicy(["get"]);

    expect(stderr.text()).toContain("Conflict detection (PHREN_FEATURE_SEMANTIC_CONFLICT=1): active.");
  });

  it("merges a project override over the global policy without touching the global file", async () => {
    const { handleRetentionPolicy } = await importPolicy();
    const output = captureConsole();
    fs.mkdirSync(path.join(phrenDir, "demo"));

    await handleRetentionPolicy(["--project", "demo", "set", "--ttlDays=60", "--decay.d30=0.5"]);

    expect(JSON.parse(output.logs[0])).toMatchObject({
      _project: "demo",
      ttlDays: 60,
      retentionDays: 365,
      decay: { d30: 0.5, d60: 0.85 },
    });
    expect(getRetentionPolicy(phrenDir).ttlDays).toBe(120);
    const projectConfig = readProjectConfig(phrenDir, "demo").config;
    expect(projectConfig?.retentionPolicy?.ttlDays).toBe(60);
    expect(projectConfig?.retentionPolicy?.decay?.d30).toBe(0.5);
  });

  it("sets budgets globally, including the age-out switch, and a project's review budget on its own", async () => {
    const { handleRetentionPolicy } = await importPolicy();
    const output = captureConsole();
    fs.mkdirSync(path.join(phrenDir, "demo"));

    await handleRetentionPolicy(["set", "--budgets.reviewEntries=200", "--budgets.runtimeAgeOut=true"]);
    expect(getRetentionPolicy(phrenDir).budgets).toMatchObject({ reviewEntries: 200, runtimeAgeOut: true });

    await handleRetentionPolicy(["--project", "demo", "set", "--budgets.reviewEntries=400"]);
    expect(JSON.parse(output.logs.at(-1) ?? "{}").budgets).toMatchObject({ reviewEntries: 400, runtimeAgeOut: true });
    expect(getRetentionPolicy(phrenDir).budgets.reviewEntries).toBe(200);
  });

  it.each([
    [["set", "--budgets.reviewEntries="], "budgets.reviewEntries"],
    [["set", "--budgets.reviewEntries=-1"], "budgets.reviewEntries"],
    [["set", "--budgets.reviewEntries=lots"], "budgets.reviewEntries"],
    [["set", "--budgets.reviewEntries=1.5"], "budgets.reviewEntries"],
    [["set", "--budgets.runtimeAgeOut=yes"], "budgets.runtimeAgeOut"],
    [["set", "--budgets.runtimeAgeOutDays=1"], "budgets.runtimeAgeOutDays"],
    [["set", "--budgets.colour=blue"], "budgets.colour"],
    [["--project", "demo", "set", "--budgets.runtimeMB=10"], "budgets.runtimeMB"],
  ])("refuses %j, exits 1 and leaves the budgets as they were", async (args, named) => {
    const { handleRetentionPolicy } = await importPolicy();
    const output = captureConsole();
    mockExit();
    fs.mkdirSync(path.join(phrenDir, "demo"), { recursive: true });
    await handleRetentionPolicy(["set", "--budgets.reviewEntries=90"]);
    expect((await expectExit(() => handleRetentionPolicy(args))).code).toBe(1);
    expect(output.errors.join("\n")).toContain(named);
    expect(getRetentionPolicy(phrenDir).budgets.reviewEntries).toBe(90);
    expect(readProjectConfig(phrenDir, "demo").config?.retentionPolicy).toBeUndefined();
  });

  it("stores an explicit 0, which turns a budget off", async () => {
    const { handleRetentionPolicy } = await importPolicy();
    captureConsole();
    await handleRetentionPolicy(["set", "--budgets.reviewEntries=0"]);
    expect(getRetentionPolicy(phrenDir).budgets.reviewEntries).toBe(0);
  });
});

describe("config index policy", () => {
  it("rejects an unknown action with its usage line and leaves the policy at its defaults", async () => {
    const { handleIndexPolicy } = await importPolicy();
    const output = captureConsole();
    mockExit();

    expect((await expectExit(() => handleIndexPolicy(["bogus"]))).code).toBe(1);
    expect(output.errors.join("\n")).toContain("Usage: phren index-policy [get|set");
    expect(getIndexPolicy(phrenDir).includeGlobs).toContain("**/*.md");
  });
});
