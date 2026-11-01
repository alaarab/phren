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

describe("config task-mode", () => {
  it("reads the default mode and writes a normalised valid mode", async () => {
    const { handleConfigTaskMode } = await importPolicy();
    const output = captureConsole();

    handleConfigTaskMode([]);
    expect(JSON.parse(output.logs[0])).toEqual({ taskMode: "auto" });

    handleConfigTaskMode(["set", "SUGGEST"]);
    expect(JSON.parse(output.logs[1])).toEqual({ taskMode: "suggest" });

    handleConfigTaskMode(["Manual"]);
    expect(JSON.parse(output.logs[2])).toEqual({ taskMode: "manual" });
    expect(getWorkflowPolicy(phrenDir).taskMode).toBe("manual");
  });

  it("rejects an unknown mode and an unknown action with their usage lines", async () => {
    const { handleConfigTaskMode } = await importPolicy();
    const output = captureConsole();
    mockExit();

    expect((await expectExit(() => handleConfigTaskMode(["set", "sometimes"]))).code).toBe(1);
    expect(output.errors.join("\n")).toContain("Usage: phren config task-mode set [off|manual|suggest|auto]");
    expect(getWorkflowPolicy(phrenDir).taskMode).toBe("auto");

    expect((await expectExit(() => handleConfigTaskMode(["sometimes"]))).code).toBe(1);
    expect(output.errors.join("\n")).toContain("values: off|manual|suggest|auto");
  });

  it("writes a project override without changing the global mode", async () => {
    const { handleConfigTaskMode } = await importPolicy();
    const output = captureConsole();
    fs.mkdirSync(path.join(phrenDir, "demo"));

    handleConfigTaskMode(["--project", "demo", "set", "off"]);

    expect(JSON.parse(output.logs[0])).toEqual({ _project: "demo", taskMode: "off" });
    expect(getWorkflowPolicy(phrenDir).taskMode).toBe("auto");
    expect(readProjectConfig(phrenDir, "demo").config?.taskMode).toBe("off");
  });
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
