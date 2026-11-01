import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import * as yaml from "js-yaml";
import { writeFile, resetTestPhrenPath } from "../test-helpers.js";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "phren-hook-context-")));
const phrenPath = path.join(root, "store");
const repo = path.join(root, "repo");
const repoSub = path.join(repo, "src");
fs.mkdirSync(repoSub, { recursive: true });
execFileSync("git", ["init", "-q"], { cwd: repo });
process.env.PHREN_PATH = phrenPath;

import {
  buildHookContext,
  checkHookGuard,
  handleGuardSkip,
  type HookContext,
} from "./hooks-context.js";

function writeManifest(manifest: Record<string, unknown>): void {
  writeFile(path.join(phrenPath, "phren.root.yaml"), yaml.dump({ version: 1, syncMode: "managed-git", ...manifest }, { lineWidth: 1000 }));
}

function writeProjectConfig(config: Record<string, unknown> = {}): void {
  writeFile(
    path.join(phrenPath, "demo", "phren.project.yaml"),
    yaml.dump({ sourcePath: repo, ...config }, { lineWidth: 1000 }),
  );
}

function writePreferences(prefs: Record<string, unknown>): void {
  writeFile(path.join(phrenPath, ".runtime", "install-preferences.json"), JSON.stringify(prefs));
}

let previousCwd = process.cwd();

beforeEach(() => {
  previousCwd = process.cwd();
  delete process.env.PHREN_HOOK_TOOL;
  delete process.env.PHREN_PROFILE;
  fs.rmSync(path.join(phrenPath, ".runtime"), { recursive: true, force: true });
  fs.rmSync(path.join(phrenPath, "profiles"), { recursive: true, force: true });
  writeManifest({ installMode: "shared" });
  writeProjectConfig();
});

afterEach(() => {
  process.chdir(previousCwd);
  delete process.env.PHREN_HOOK_TOOL;
  delete process.env.PHREN_PROFILE;
});

afterAll(() => {
  process.chdir(previousCwd);
  resetTestPhrenPath();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("buildHookContext", () => {
  it("resolves the store, profile, cwd, default hook tool and manifest", () => {
    process.chdir(repoSub);

    const ctx = buildHookContext();

    expect(ctx.phrenPath).toBe(phrenPath);
    expect(ctx.profile).toBe("");
    expect(ctx.cwd).toBe(repoSub);
    expect(ctx.hookTool).toBe("claude");
    expect(ctx.hooksEnabled).toBe(true);
    expect(ctx.toolHookEnabled).toBe(true);
    expect(ctx.activeProject).toBe("demo");
    expect(ctx.manifest).toMatchObject({ installMode: "shared", syncMode: "managed-git" });
  });

  it("uses PHREN_HOOK_TOOL and respects a per-tool hook preference", () => {
    process.env.PHREN_HOOK_TOOL = "codex";
    writePreferences({ hookTools: { codex: false } });
    process.chdir(repoSub);

    const ctx = buildHookContext();

    expect(ctx.hookTool).toBe("codex");
    expect(ctx.hooksEnabled).toBe(true);
    expect(ctx.toolHookEnabled).toBe(false);
  });

  it("turns every tool hook off when hooks are globally disabled", () => {
    process.env.PHREN_HOOK_TOOL = "codex";
    writePreferences({ hooksEnabled: false });
    process.chdir(repoSub);

    const ctx = buildHookContext();

    expect(ctx.hooksEnabled).toBe(false);
    expect(ctx.toolHookEnabled).toBe(false);
  });

  it("takes the manifest's primary project in a project-local install", () => {
    writeManifest({ installMode: "project-local", workspaceRoot: root, primaryProject: "demo" });
    process.chdir(root);

    const ctx = buildHookContext();

    expect(ctx.activeProject).toBe("demo");
  });

  it("detects the active project through the selected profile", () => {
    writeFile(path.join(phrenPath, "profiles", "work.yaml"), yaml.dump({ projects: ["demo"] }, { lineWidth: 1000 }));
    process.env.PHREN_PROFILE = "work";
    process.chdir(repoSub);

    const ctx = buildHookContext();

    expect(ctx.profile).toBe("work");
    expect(ctx.activeProject).toBe("demo");
  });
});

describe("checkHookGuard", () => {
  const base = (overrides: Partial<HookContext> = {}): HookContext => ({
    phrenPath,
    profile: "",
    cwd: repoSub,
    hookTool: "claude",
    activeProject: "demo",
    hooksEnabled: true,
    toolHookEnabled: true,
    manifest: null,
    ...overrides,
  });

  it("checks hooks, then the tool, then the project and reports the first blocker", () => {
    writeProjectConfig({ hooks: { SessionStart: false } });

    expect(checkHookGuard(base({ hooksEnabled: false, toolHookEnabled: false }), "SessionStart")).toBe("disabled");
    expect(checkHookGuard(base({ toolHookEnabled: false }), "SessionStart")).toBe("tool_disabled tool=claude");
    expect(checkHookGuard(base(), "SessionStart")).toBe("project_disabled project=demo");
    expect(checkHookGuard(base({ activeProject: null }), "SessionStart")).toBeNull();
  });

  it("returns null when the project event is enabled", () => {
    process.chdir(repoSub);

    expect(checkHookGuard(buildHookContext(), "UserPromptSubmit")).toBeNull();
  });
});

describe("handleGuardSkip", () => {
  it("writes the skip to the audit log and updates runtime health when given a patch", () => {
    const ctx: HookContext = {
      phrenPath,
      profile: "",
      cwd: repoSub,
      hookTool: "claude",
      activeProject: "demo",
      hooksEnabled: false,
      toolHookEnabled: false,
      manifest: null,
    };

    handleGuardSkip(ctx, "hook_session_start", "disabled", {
      lastSessionStartAt: "2026-01-02T03:04:05.000Z",
    });

    const audit = fs.readFileSync(path.join(phrenPath, ".runtime", "audit.log"), "utf8");
    expect(audit).toContain("hook_session_start status=disabled");
    const health = JSON.parse(fs.readFileSync(path.join(phrenPath, ".runtime", "runtime-health.json"), "utf8"));
    expect(health.lastSessionStartAt).toBe("2026-01-02T03:04:05.000Z");
  });
});
