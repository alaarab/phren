import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "js-yaml";
import { initTestPhrenRoot } from "../test-helpers.js";

const originalEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  PHREN_PATH: process.env.PHREN_PATH,
  PHREN_ACTOR: process.env.PHREN_ACTOR,
  PHREN_PROACTIVITY: process.env.PHREN_PROACTIVITY,
  PHREN_PROACTIVITY_FINDINGS: process.env.PHREN_PROACTIVITY_FINDINGS,
  PHREN_PROACTIVITY_TASKS: process.env.PHREN_PROACTIVITY_TASKS,
};

let tmpDir: string;
let phrenDir: string;
let homeDir: string;

function restoreEnv(name: keyof typeof originalEnv): void {
  const value = originalEnv[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function governancePrefsPath(): string {
  return path.join(phrenDir, ".config", "install-preferences.json");
}

function projectConfigPath(project: string): string {
  return path.join(phrenDir, project, "phren.project.yaml");
}

function readProjectConfigFile(project: string): { config?: Record<string, unknown> } {
  return yaml.load(fs.readFileSync(projectConfigPath(project), "utf8")) as { config?: Record<string, unknown> };
}

async function importCliConfig() {
  vi.resetModules();
  return await import("./config.js");
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

describe("handleConfig proactivity project overrides", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "phren-cli-config-proactivity-"));
    phrenDir = path.join(tmpDir, ".phren");
    homeDir = path.join(tmpDir, "home");
    fs.mkdirSync(phrenDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
    initTestPhrenRoot(phrenDir);

    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.env.PHREN_PATH = phrenDir;
    delete process.env.PHREN_ACTOR;
    delete process.env.PHREN_PROACTIVITY;
    delete process.env.PHREN_PROACTIVITY_FINDINGS;
    delete process.env.PHREN_PROACTIVITY_TASKS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreEnv("HOME");
    restoreEnv("USERPROFILE");
    restoreEnv("PHREN_PATH");
    restoreEnv("PHREN_ACTOR");
    restoreEnv("PHREN_PROACTIVITY");
    restoreEnv("PHREN_PROACTIVITY_FINDINGS");
    restoreEnv("PHREN_PROACTIVITY_TASKS");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes a project base override to phren.project.yaml, not the global preferences", async () => {
    const { handleConfig } = await importCliConfig();
    const output = captureConsole();

    await handleConfig(["proactivity", "medium", "--project", "demo"]);

    expect(JSON.parse(output.logs[0])).toEqual({ _project: "demo", base: "medium", findings: null, tasks: null });
    expect(readProjectConfigFile("demo").config).toEqual({ proactivity: "medium" });
    expect(fs.existsSync(governancePrefsPath())).toBe(false);
  });

  it("writes project findings and tasks overrides under their own config keys", async () => {
    const { handleConfig } = await importCliConfig();
    const output = captureConsole();

    await handleConfig(["proactivity", "high", "--project", "demo"]);
    await handleConfig(["proactivity", "low", "--scope=findings", "--project", "demo"]);
    await handleConfig(["proactivity", "medium", "--scope", "task", "--project", "demo"]);

    expect(JSON.parse(output.logs[2])).toEqual({ _project: "demo", base: "high", findings: "low", tasks: "medium" });
    expect(readProjectConfigFile("demo").config).toEqual({
      proactivity: "high",
      proactivityFindings: "low",
      proactivityTask: "medium",
    });
    expect(fs.existsSync(governancePrefsPath())).toBe(false);
  });

  it("shows only the project's own overrides, not the global proactivity preference", async () => {
    const { handleConfig } = await importCliConfig();
    const output = captureConsole();

    await handleConfig(["proactivity", "low"]);
    await handleConfig(["proactivity.findings", "high", "--project", "demo"]);
    await handleConfig(["proactivity", "--project", "demo"]);

    expect(JSON.parse(output.logs[output.logs.length - 1])).toEqual({
      _project: "demo",
      base: null,
      findings: "high",
      tasks: null,
    });
    expect(JSON.parse(fs.readFileSync(governancePrefsPath(), "utf8")).proactivity).toBe("low");
  });

  it("rejects an invalid project name without writing any config", async () => {
    const { handleConfig } = await importCliConfig();
    const output = captureConsole();
    const previousExitCode = process.exitCode;

    try {
      await handleConfig(["proactivity", "medium", "--project", "Bad Name"]);

      expect(process.exitCode).toBe(1);
      expect(output.errors).toContain('Invalid project name: "Bad Name"');
      expect(fs.existsSync(projectConfigPath("Bad Name"))).toBe(false);
      expect(fs.existsSync(governancePrefsPath())).toBe(false);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("rejects more than one level argument with the base usage message", async () => {
    const { handleConfig } = await importCliConfig();
    const output = captureConsole();
    const previousExitCode = process.exitCode;

    try {
      await handleConfig(["proactivity", "high", "low"]);

      expect(process.exitCode).toBe(1);
      expect(output.errors.join("\n")).toContain(
        "Usage: phren config proactivity [high|medium|low] [--scope base|findings|tasks] [--project <name>]",
      );
      expect(fs.existsSync(governancePrefsPath())).toBe(false);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("stores a mixed-case level as its canonical lowercase value", async () => {
    const { handleConfig } = await importCliConfig();
    const output = captureConsole();

    await handleConfig(["proactivity", "  MeDiUm  "]);

    expect(JSON.parse(output.logs[0]).configured.proactivity).toBe("medium");
    expect(JSON.parse(output.logs[0]).effective.proactivity).toBe("medium");
    expect(JSON.parse(fs.readFileSync(governancePrefsPath(), "utf8")).proactivity).toBe("medium");
  });

  it("warns about an unregistered project but still writes its override", async () => {
    const { handleConfig } = await importCliConfig();
    const output = captureConsole();
    fs.mkdirSync(path.join(phrenDir, "profiles"), { recursive: true });
    fs.writeFileSync(path.join(phrenDir, "profiles", "default.yaml"), "name: default\nprojects:\n  - other\n");

    await handleConfig(["proactivity", "medium", "--project", "demo"]);

    expect(process.exitCode).not.toBe(1);
    expect(output.errors.join("\n")).toContain("Warning: Project 'demo' not found in active profile");
    expect(output.errors.join("\n")).toContain(projectConfigPath("demo"));
    expect(readProjectConfigFile("demo").config).toEqual({ proactivity: "medium" });
  });
});
