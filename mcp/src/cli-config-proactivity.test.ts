import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir } from "./test-helpers.js";

const originalEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CORTEX_PATH: process.env.CORTEX_PATH,
  CORTEX_PROACTIVITY: process.env.CORTEX_PROACTIVITY,
  CORTEX_PROACTIVITY_FINDINGS: process.env.CORTEX_PROACTIVITY_FINDINGS,
  CORTEX_PROACTIVITY_TASKS: process.env.CORTEX_PROACTIVITY_TASKS,
};

let tmpCleanup: (() => void) | undefined;
let cortexDir: string;
let homeDir: string;

function restoreEnv(name: keyof typeof originalEnv): void {
  const value = originalEnv[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function governancePrefsPath(): string {
  return path.join(cortexDir, ".governance", "install-preferences.json");
}

function installPrefsPath(): string {
  return path.join(cortexDir, ".runtime", "install-preferences.json");
}

async function importCliConfig() {
  vi.resetModules();
  return await import("./cli-config.js");
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

describe("handleConfig proactivity", () => {
  beforeEach(() => {
    const tmp = makeTempDir("cortex-config-proactivity-");
    tmpCleanup = tmp.cleanup;
    cortexDir = path.join(tmp.path, ".cortex");
    homeDir = path.join(tmp.path, "home");
    fs.mkdirSync(cortexDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });

    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.env.CORTEX_PATH = cortexDir;
    delete process.env.CORTEX_PROACTIVITY;
    delete process.env.CORTEX_PROACTIVITY_FINDINGS;
    delete process.env.CORTEX_PROACTIVITY_TASKS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreEnv("HOME");
    restoreEnv("USERPROFILE");
    restoreEnv("CORTEX_PATH");
    restoreEnv("CORTEX_PROACTIVITY");
    restoreEnv("CORTEX_PROACTIVITY_FINDINGS");
    restoreEnv("CORTEX_PROACTIVITY_TASKS");
    tmpCleanup?.();
  });

  it("shows configured and effective proactivity settings", async () => {
    const { handleConfig } = await importCliConfig();
    const output = captureConsole();

    await handleConfig(["proactivity"]);

    expect(output.logs).toHaveLength(1);
    const data = JSON.parse(output.logs[0]);
    expect(data.path).toBe(governancePrefsPath());
    expect(data.configured.proactivity).toBeNull();
    expect(data.configured.proactivityFindings).toBeNull();
    expect(data.configured.proactivityTask).toBeNull();
    expect(data.effective.proactivity).toBe("high");
    expect(data.effective.proactivityFindings).toBe("high");
    expect(data.effective.proactivityTask).toBe("high");
  });

  it("persists base proactivity in governance install preferences", async () => {
    const { handleConfig } = await importCliConfig();
    const output = captureConsole();

    await handleConfig(["proactivity", "medium"]);

    expect(output.logs).toHaveLength(1);
    const data = JSON.parse(output.logs[0]);
    expect(data.configured.proactivity).toBe("medium");
    expect(data.effective.proactivity).toBe("medium");
    expect(data.effective.proactivityFindings).toBe("medium");
    expect(data.effective.proactivityTask).toBe("medium");

    const stored = JSON.parse(fs.readFileSync(governancePrefsPath(), "utf8"));
    expect(stored.proactivity).toBe("medium");
  });

  it("persists findings and task overrides independently", async () => {
    const { handleConfig } = await importCliConfig();
    const output = captureConsole();

    await handleConfig(["proactivity", "low"]);
    await handleConfig(["proactivity.findings", "high"]);
    await handleConfig(["proactivity.tasks", "medium"]);

    expect(output.logs).toHaveLength(3);
    const data = JSON.parse(output.logs[2]);
    expect(data.configured.proactivity).toBe("low");
    expect(data.configured.proactivityFindings).toBe("high");
    expect(data.configured.proactivityTask).toBe("medium");
    expect(data.effective.proactivity).toBe("low");
    expect(data.effective.proactivityFindings).toBe("high");
    expect(data.effective.proactivityTask).toBe("medium");

    const stored = JSON.parse(fs.readFileSync(governancePrefsPath(), "utf8"));
    expect(stored.proactivity).toBe("low");
    expect(stored.proactivityFindings).toBe("high");
    expect(stored.proactivityTask).toBe("medium");
  });

  it("rejects invalid proactivity values", async () => {
    const { handleConfig } = await importCliConfig();
    const output = captureConsole();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    await expect(handleConfig(["proactivity.findings", "urgent"])).rejects.toThrow("process.exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(output.errors).toContain("Usage: cortex config proactivity.findings [high|medium|low]");
    expect(fs.existsSync(governancePrefsPath())).toBe(false);
  });
});

describe("handleConfig project ownership", () => {
  beforeEach(() => {
    const tmp = makeTempDir("cortex-config-project-ownership-");
    tmpCleanup = tmp.cleanup;
    cortexDir = path.join(tmp.path, ".cortex");
    homeDir = path.join(tmp.path, "home");
    fs.mkdirSync(cortexDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });

    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.env.CORTEX_PATH = cortexDir;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreEnv("HOME");
    restoreEnv("USERPROFILE");
    restoreEnv("CORTEX_PATH");
    tmpCleanup?.();
  });

  it("shows and updates the default ownership mode", async () => {
    const { handleConfig } = await importCliConfig();
    const output = captureConsole();

    await handleConfig(["project-ownership"]);
    await handleConfig(["project-ownership", "detached"]);

    const initial = JSON.parse(output.logs[0]);
    const updated = JSON.parse(output.logs[1]);
    expect(initial.effective.projectOwnershipDefault).toBe("cortex-managed");
    expect(updated.configured.projectOwnershipDefault).toBe("detached");
    expect(updated.effective.projectOwnershipDefault).toBe("detached");

    const stored = JSON.parse(fs.readFileSync(installPrefsPath(), "utf8"));
    expect(stored.projectOwnershipDefault).toBe("detached");
  });
});
