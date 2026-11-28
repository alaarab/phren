import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { initTestPhrenRoot, makeTempDir } from "./test-helpers.js";
import {
  getProactivityLevel,
  getProactivityLevelForFindings,
  hasExplicitFindingSignal,
  shouldAutoCaptureFindingsForLevel,
} from "./proactivity.js";

describe("proactivity config", () => {
  const originalEnv = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    PHREN_PATH: process.env.PHREN_PATH,
    PHREN_PROACTIVITY: process.env.PHREN_PROACTIVITY,
    PHREN_PROACTIVITY_FINDINGS: process.env.PHREN_PROACTIVITY_FINDINGS,
  };

  let tmpCleanup: (() => void) | undefined;
  let homeDir: string;

  function restoreEnv(name: keyof typeof originalEnv): void {
    const value = originalEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  function writeGovernanceInstallPreferences(content: Record<string, unknown>): void {
    const filePath = path.join(homeDir, ".phren", ".config", "install-preferences.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(content, null, 2) + "\n");
  }

  beforeEach(() => {
    const tmp = makeTempDir("phren-proactivity-test-");
    tmpCleanup = tmp.cleanup;
    homeDir = path.join(tmp.path, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    initTestPhrenRoot(path.join(homeDir, ".phren"));

    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.env.PHREN_PATH = path.join(homeDir, ".phren");
    delete process.env.PHREN_PROACTIVITY;
    delete process.env.PHREN_PROACTIVITY_FINDINGS;
  });

  afterEach(() => {
    restoreEnv("HOME");
    restoreEnv("USERPROFILE");
    restoreEnv("PHREN_PATH");
    restoreEnv("PHREN_PROACTIVITY");
    restoreEnv("PHREN_PROACTIVITY_FINDINGS");
    tmpCleanup?.();
  });

  it("defaults to high when no env var or preference is set", () => {
    expect(getProactivityLevel()).toBe("high");
    expect(getProactivityLevelForFindings()).toBe("high");
  });

  it("uses PHREN_PROACTIVITY as the shared override", () => {
    process.env.PHREN_PROACTIVITY = "medium";

    expect(getProactivityLevel()).toBe("medium");
    expect(getProactivityLevelForFindings()).toBe("medium");
  });

  it("lets the findings env var override the shared level", () => {
    process.env.PHREN_PROACTIVITY = "low";
    process.env.PHREN_PROACTIVITY_FINDINGS = "high";

    expect(getProactivityLevel()).toBe("low");
    expect(getProactivityLevelForFindings()).toBe("high");
  });

  it("falls back to governance install preferences when env vars are unset", () => {
    writeGovernanceInstallPreferences({ proactivity: "low" });

    expect(getProactivityLevel()).toBe("low");
    expect(getProactivityLevelForFindings()).toBe("low");
  });

  it("uses split governance install preferences for findings and base defaults", () => {
    writeGovernanceInstallPreferences({
      proactivity: "low",
      proactivityFindings: "high",
    });

    expect(getProactivityLevel()).toBe("low");
    expect(getProactivityLevelForFindings()).toBe("high");
  });

  it("keeps env vars higher priority than governance defaults", () => {
    writeGovernanceInstallPreferences({ proactivity: "low" });
    process.env.PHREN_PROACTIVITY = "medium";
    process.env.PHREN_PROACTIVITY_FINDINGS = "high";

    expect(getProactivityLevel()).toBe("medium");
    expect(getProactivityLevelForFindings()).toBe("high");
  });

  it("detects explicit finding signal phrases and tags", () => {
    expect(hasExplicitFindingSignal("This is worth remembering for the next migration.")).toBe(true);
    expect(hasExplicitFindingSignal('Please add finding: retry the socket once before reconnecting.')).toBe(true);
    expect(hasExplicitFindingSignal("[decision] Use WAL mode for concurrent readers.")).toBe(true);
    expect(hasExplicitFindingSignal("This line has no explicit capture signal.")).toBe(false);
  });

  it("keeps current auto-capture behavior at high", () => {
    expect(shouldAutoCaptureFindingsForLevel("high", "A heuristic-only signal without explicit phrasing")).toBe(true);
  });

  it('requires explicit signals at medium', () => {
    expect(shouldAutoCaptureFindingsForLevel("medium", "This is worth remembering when rotating credentials.")).toBe(true);
    expect(shouldAutoCaptureFindingsForLevel("medium", "[pitfall] Close the connection before forking workers.")).toBe(true);
    expect(shouldAutoCaptureFindingsForLevel("medium", "Heuristic signal only: must avoid the race.")).toBe(false);
  });

  it("disables findings auto-capture at low", () => {
    expect(shouldAutoCaptureFindingsForLevel("low", 'Please add finding about the migration order.')).toBe(false);
  });
});
