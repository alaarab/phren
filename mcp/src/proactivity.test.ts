import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir } from "./test-helpers.js";
import {
  getProactivityLevel,
  getProactivityLevelForTask,
  getProactivityLevelForFindings,
  hasExplicitFindingSignal,
  hasExecutionIntent,
  hasDiscoveryIntent,
  shouldAutoCaptureFindingsForLevel,
} from "./shared.js";

describe("proactivity config", () => {
  const originalEnv = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    CORTEX_PATH: process.env.CORTEX_PATH,
    CORTEX_PROACTIVITY: process.env.CORTEX_PROACTIVITY,
    CORTEX_PROACTIVITY_FINDINGS: process.env.CORTEX_PROACTIVITY_FINDINGS,
    CORTEX_PROACTIVITY_TASKS: process.env.CORTEX_PROACTIVITY_TASKS,
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
    delete process.env.CORTEX_PROACTIVITY_TASKS;
  });

  afterEach(() => {
    restoreEnv("HOME");
    restoreEnv("USERPROFILE");
    restoreEnv("CORTEX_PATH");
    restoreEnv("CORTEX_PROACTIVITY");
    restoreEnv("CORTEX_PROACTIVITY_FINDINGS");
    restoreEnv("CORTEX_PROACTIVITY_TASKS");
    tmpCleanup?.();
  });

  it("defaults to high when no env var or preference is set", () => {
    expect(getProactivityLevel()).toBe("high");
    expect(getProactivityLevelForFindings()).toBe("high");
    expect(getProactivityLevelForTask()).toBe("high");
  });

  it("uses CORTEX_PROACTIVITY as the shared override", () => {
    process.env.CORTEX_PROACTIVITY = "medium";

    expect(getProactivityLevel()).toBe("medium");
    expect(getProactivityLevelForFindings()).toBe("medium");
    expect(getProactivityLevelForTask()).toBe("medium");
  });

  it("lets findings and task env vars override the shared level", () => {
    process.env.CORTEX_PROACTIVITY = "low";
    process.env.CORTEX_PROACTIVITY_FINDINGS = "high";
    process.env.CORTEX_PROACTIVITY_TASKS = "medium";

    expect(getProactivityLevel()).toBe("low");
    expect(getProactivityLevelForFindings()).toBe("high");
    expect(getProactivityLevelForTask()).toBe("medium");
  });

  it("falls back to governance install preferences when env vars are unset", () => {
    writeGovernanceInstallPreferences({ proactivity: "low" });

    expect(getProactivityLevel()).toBe("low");
    expect(getProactivityLevelForFindings()).toBe("low");
    expect(getProactivityLevelForTask()).toBe("low");
  });

  it("uses split governance install preferences for findings and task defaults", () => {
    writeGovernanceInstallPreferences({
      proactivity: "low",
      proactivityFindings: "high",
      proactivityTask: "medium",
    });

    expect(getProactivityLevel()).toBe("low");
    expect(getProactivityLevelForFindings()).toBe("high");
    expect(getProactivityLevelForTask()).toBe("medium");
  });

  it("keeps env vars higher priority than governance defaults", () => {
    writeGovernanceInstallPreferences({ proactivity: "low" });
    process.env.CORTEX_PROACTIVITY = "medium";
    process.env.CORTEX_PROACTIVITY_FINDINGS = "high";

    expect(getProactivityLevel()).toBe("medium");
    expect(getProactivityLevelForFindings()).toBe("high");
    expect(getProactivityLevelForTask()).toBe("medium");
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

  it("detects execution intent signals", () => {
    expect(hasExecutionIntent("yes do it")).toBe(true);
    expect(hasExecutionIntent("go ahead and implement it")).toBe(true);
    expect(hasExecutionIntent("work on these items")).toBe(true);
    expect(hasExecutionIntent("let's build the API")).toBe(true);
    expect(hasExecutionIntent("approved, ship it")).toBe(true);
    expect(hasExecutionIntent("proceed with the migration")).toBe(true);
    expect(hasExecutionIntent("what if we tried a different approach")).toBe(false);
    expect(hasExecutionIntent("brainstorm some ideas")).toBe(false);
  });

  it("detects discovery intent signals", () => {
    expect(hasDiscoveryIntent("brainstorm some ideas for the API")).toBe(true);
    expect(hasDiscoveryIntent("explore different caching strategies")).toBe(true);
    expect(hasDiscoveryIntent("what if we used Redis instead")).toBe(true);
    expect(hasDiscoveryIntent("review findings from last week")).toBe(true);
    expect(hasDiscoveryIntent("what are the alternatives to SQLite")).toBe(true);
    expect(hasDiscoveryIntent("let's evaluate the pros and cons")).toBe(true);
    expect(hasDiscoveryIntent("implement the caching layer")).toBe(false);
    expect(hasDiscoveryIntent("fix the login bug")).toBe(false);
  });

  it("execution intent takes priority when both signals present", () => {
    const text = "let's build on these ideas and ship it";
    expect(hasExecutionIntent(text)).toBe(true);
    expect(hasDiscoveryIntent(text)).toBe(true);
    // The task lifecycle checks execution first, so both being true means execute
  });
});
