import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir } from "./test-helpers.js";
import { isProjectHookEnabled, readProjectConfig, writeProjectConfig, writeProjectHookConfig } from "./project-config.js";

describe("project-config hook preferences", () => {
  let tmp: { path: string; cleanup: () => void };
  let cortexPath: string;

  beforeEach(() => {
    tmp = makeTempDir("project-config-hooks-");
    cortexPath = tmp.path;
    fs.mkdirSync(path.join(cortexPath, "demo"), { recursive: true });
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it("defaults project hook events to enabled", () => {
    expect(isProjectHookEnabled(cortexPath, "demo", "UserPromptSubmit")).toBe(true);
    expect(isProjectHookEnabled(cortexPath, "demo", "Stop")).toBe(true);
    expect(isProjectHookEnabled(cortexPath, "demo", "SessionStart")).toBe(true);
    expect(isProjectHookEnabled(cortexPath, "demo", "PostToolUse")).toBe(true);
  });

  it("uses the base project hook toggle when an event override is absent", () => {
    writeProjectHookConfig(cortexPath, "demo", { enabled: false });

    expect(isProjectHookEnabled(cortexPath, "demo", "UserPromptSubmit")).toBe(false);
    expect(isProjectHookEnabled(cortexPath, "demo", "Stop")).toBe(false);
  });

  it("lets explicit event overrides win over the base project hook toggle", () => {
    writeProjectHookConfig(cortexPath, "demo", { enabled: false });
    writeProjectHookConfig(cortexPath, "demo", { UserPromptSubmit: true });

    expect(isProjectHookEnabled(cortexPath, "demo", "UserPromptSubmit")).toBe(true);
    expect(isProjectHookEnabled(cortexPath, "demo", "Stop")).toBe(false);
  });

  it("preserves sibling project config when writing hook preferences", () => {
    writeProjectConfig(cortexPath, "demo", { ownership: "repo-managed", hooks: { Stop: false } });

    writeProjectHookConfig(cortexPath, "demo", { enabled: false, UserPromptSubmit: true });

    const config = readProjectConfig(cortexPath, "demo");
    expect(config.ownership).toBe("repo-managed");
    expect(config.hooks?.enabled).toBe(false);
    expect(config.hooks?.UserPromptSubmit).toBe(true);
    expect(config.hooks?.Stop).toBe(false);
  });
});
