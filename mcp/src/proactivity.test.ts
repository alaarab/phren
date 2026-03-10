import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir } from "./test-helpers.js";
import {
  getProactivityLevel,
  getProactivityLevelForBacklog,
  getProactivityLevelForFindings,
} from "./shared.js";

describe("proactivity config", () => {
  const originalEnv = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    CORTEX_PATH: process.env.CORTEX_PATH,
    CORTEX_PROACTIVITY: process.env.CORTEX_PROACTIVITY,
    CORTEX_PROACTIVITY_FINDINGS: process.env.CORTEX_PROACTIVITY_FINDINGS,
    CORTEX_PROACTIVITY_BACKLOG: process.env.CORTEX_PROACTIVITY_BACKLOG,
  };

  let tmpCleanup: (() => void) | undefined;
  let homeDir: string;

  function restoreEnv(name: keyof typeof originalEnv): void {
    const value = originalEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  function writeGovernanceInstallPreferences(content: Record<string, unknown>): void {
    const filePath = path.join(homeDir, ".cortex", ".governance", "install-preferences.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(content, null, 2) + "\n");
  }

  beforeEach(() => {
    const tmp = makeTempDir("cortex-proactivity-test-");
    tmpCleanup = tmp.cleanup;
    homeDir = path.join(tmp.path, "home");
    fs.mkdirSync(homeDir, { recursive: true });

    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    delete process.env.CORTEX_PATH;
    delete process.env.CORTEX_PROACTIVITY;
    delete process.env.CORTEX_PROACTIVITY_FINDINGS;
    delete process.env.CORTEX_PROACTIVITY_BACKLOG;
  });

  afterEach(() => {
    restoreEnv("HOME");
    restoreEnv("USERPROFILE");
    restoreEnv("CORTEX_PATH");
    restoreEnv("CORTEX_PROACTIVITY");
    restoreEnv("CORTEX_PROACTIVITY_FINDINGS");
    restoreEnv("CORTEX_PROACTIVITY_BACKLOG");
    tmpCleanup?.();
  });

  it("defaults to high when no env var or preference is set", () => {
    expect(getProactivityLevel()).toBe("high");
    expect(getProactivityLevelForFindings()).toBe("high");
    expect(getProactivityLevelForBacklog()).toBe("high");
  });

  it("uses CORTEX_PROACTIVITY as the shared override", () => {
    process.env.CORTEX_PROACTIVITY = "medium";

    expect(getProactivityLevel()).toBe("medium");
    expect(getProactivityLevelForFindings()).toBe("medium");
    expect(getProactivityLevelForBacklog()).toBe("medium");
  });

  it("lets findings and backlog env vars override the shared level", () => {
    process.env.CORTEX_PROACTIVITY = "low";
    process.env.CORTEX_PROACTIVITY_FINDINGS = "high";
    process.env.CORTEX_PROACTIVITY_BACKLOG = "medium";

    expect(getProactivityLevel()).toBe("low");
    expect(getProactivityLevelForFindings()).toBe("high");
    expect(getProactivityLevelForBacklog()).toBe("medium");
  });

  it("falls back to governance install preferences when env vars are unset", () => {
    writeGovernanceInstallPreferences({ proactivity: "low" });

    expect(getProactivityLevel()).toBe("low");
    expect(getProactivityLevelForFindings()).toBe("low");
    expect(getProactivityLevelForBacklog()).toBe("low");
  });

  it("keeps env vars higher priority than governance defaults", () => {
    writeGovernanceInstallPreferences({ proactivity: "low" });
    process.env.CORTEX_PROACTIVITY = "medium";
    process.env.CORTEX_PROACTIVITY_FINDINGS = "high";

    expect(getProactivityLevel()).toBe("medium");
    expect(getProactivityLevelForFindings()).toBe("high");
    expect(getProactivityLevelForBacklog()).toBe("medium");
  });
});
