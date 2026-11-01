import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { initTestPhrenRoot, makeTempDir } from "../test-helpers.js";

const originalEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  PHREN_PATH: process.env.PHREN_PATH,
  PHREN_PROFILE: process.env.PHREN_PROFILE,
  PHREN_HOOK_TOOL: process.env.PHREN_HOOK_TOOL,
};

let tmp: { path: string; cleanup: () => void };
let phrenDir: string;
let homeDir: string;
let originalCwd: string;
let stdinTTY: PropertyDescriptor | undefined;

function restoreEnv(name: keyof typeof originalEnv): void {
  const value = originalEnv[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function writePreferences(patch: Record<string, unknown>): void {
  const file = path.join(phrenDir, ".runtime", "install-preferences.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(patch, null, 2) + "\n");
}

function readJSON(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

function sessionFiles(): string[] {
  const dir = path.join(phrenDir, ".runtime", "sessions");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.startsWith("session-") && name.endsWith(".json"));
}

function readActiveSessionId(): string {
  return fs.readFileSync(path.join(phrenDir, ".runtime", "active-hook-session"), "utf8").trim();
}

async function importSessionStart() {
  vi.resetModules();
  return await import("./session-start.js");
}

beforeEach(() => {
  tmp = makeTempDir("phren-session-start-");
  phrenDir = path.join(tmp.path, ".phren");
  homeDir = path.join(tmp.path, "home");
  fs.mkdirSync(phrenDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  initTestPhrenRoot(phrenDir);
  // Keep the handler out of home wiring and background maintenance.
  writePreferences({ managementPreset: "manual" });

  originalCwd = process.cwd();
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  process.env.PHREN_PATH = phrenDir;
  delete process.env.PHREN_PROFILE;
  delete process.env.PHREN_HOOK_TOOL;

  stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
});

afterEach(() => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
  if (stdinTTY) Object.defineProperty(process.stdin, "isTTY", stdinTTY);
  else delete (process.stdin as { isTTY?: boolean }).isTTY;
  restoreEnv("HOME");
  restoreEnv("USERPROFILE");
  restoreEnv("PHREN_PATH");
  restoreEnv("PHREN_PROFILE");
  restoreEnv("PHREN_HOOK_TOOL");
  tmp.cleanup();
});

describe("handleHookSessionStart", () => {
  it("records a hook session for the active project and closes the previous one", async () => {
    const repo = path.join(tmp.path, "repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(path.join(phrenDir, "repo"));
    fs.writeFileSync(path.join(phrenDir, "repo", "FINDINGS.md"), "# repo\n\n- captured a first finding\n");

    const previousId = "previous-session";
    const sessionsDir = path.join(phrenDir, ".runtime", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, `session-${previousId}.json`),
      JSON.stringify({
        sessionId: previousId,
        project: "repo",
        startedAt: "2026-01-01T00:00:00.000Z",
        findingsAdded: 0,
        tasksCompleted: 0,
        hookCreated: true,
      }),
    );
    fs.writeFileSync(path.join(phrenDir, ".runtime", "active-hook-session"), `${previousId}\n`);

    process.chdir(repo);
    const { handleHookSessionStart } = await importSessionStart();
    await handleHookSessionStart();

    const activeId = readActiveSessionId();
    expect(activeId).not.toBe(previousId);
    const current = readJSON(path.join(sessionsDir, `session-${activeId}.json`));
    expect(current.project).toBe("repo");
    expect(current.hookCreated).toBe(true);
    expect(current.endedAt).toBeUndefined();

    const previous = readJSON(path.join(sessionsDir, `session-${previousId}.json`));
    expect(previous.endedAt).toBe(current.startedAt);
  });

  it("prints first-run onboarding and records a project-less session when the store has no projects", async () => {
    const outside = path.join(tmp.path, "outside");
    fs.mkdirSync(outside);
    process.chdir(outside);

    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });

    const { handleHookSessionStart } = await importSessionStart();
    await handleHookSessionStart();

    expect(written.join("")).toContain("no tracked projects are active for this workspace yet");
    const current = readJSON(
      path.join(phrenDir, ".runtime", "sessions", `session-${readActiveSessionId()}.json`),
    );
    expect(current.project).toBeUndefined();
  });

  it("skips a project-local install without creating a hook session", async () => {
    initTestPhrenRoot(phrenDir, {
      installMode: "project-local",
      syncMode: "workspace-git",
      workspaceRoot: tmp.path,
      primaryProject: "repo",
    });

    const { handleHookSessionStart } = await importSessionStart();
    await handleHookSessionStart();

    expect(fs.existsSync(path.join(phrenDir, ".runtime", "active-hook-session"))).toBe(false);
    expect(sessionFiles()).toEqual([]);
    const health = readJSON(path.join(phrenDir, ".runtime", "runtime-health.json"));
    expect((health.lastSync as Record<string, unknown>).lastPullStatus).toBe("ok");
    expect((health.lastSync as Record<string, unknown>).lastPullDetail).toContain("project-local mode does not manage git sync");
    const audit = fs.readFileSync(path.join(phrenDir, ".runtime", "audit.log"), "utf8");
    expect(audit).toContain("hook_session_start status=skipped-local");
  });

  it("records the guard skip and creates no session when hooks are disabled", async () => {
    writePreferences({ managementPreset: "manual", hooksEnabled: false });

    const { handleHookSessionStart } = await importSessionStart();
    await handleHookSessionStart();

    expect(fs.existsSync(path.join(phrenDir, ".runtime", "active-hook-session"))).toBe(false);
    expect(sessionFiles()).toEqual([]);
    const health = readJSON(path.join(phrenDir, ".runtime", "runtime-health.json"));
    expect(typeof health.lastSessionStartAt).toBe("string");
    const audit = fs.readFileSync(path.join(phrenDir, ".runtime", "audit.log"), "utf8");
    expect(audit).toContain("hook_session_start status=disabled");
  });
});
