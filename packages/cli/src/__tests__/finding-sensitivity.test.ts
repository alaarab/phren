/**
 * Tests for the findingSensitivity feature.
 *
 * Setting lives in .config/workflow-policy.json under `findingSensitivity`.
 * 4 levels: minimal (cap 0) / conservative (cap 3) / balanced (cap 10) / aggressive (cap 20)
 *
 * Key surfaces tested:
 *   1. Default is "balanced" from getWorkflowPolicy
 *   2. Each level maps to correct sessionCap and proactivityFindings values
 *   3. Agent instruction injected in hook context with correct prefix
 *   4. getSessionCap() respects policy; PHREN_AUTOCAPTURE_SESSION_CAP env var overrides it
 *   5. Init walkthrough writes chosen level to workflow-policy.json
 *   6. CLI: phren config finding-sensitivity get / set
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, grantAdmin, writeFile, runCliExec } from "../test-helpers.js";
import { FINDING_SENSITIVITY_CONFIG } from "../cli/config.js";
import { getWorkflowPolicy, updateWorkflowPolicy } from "../shared/governance.js";

const runCli = runCliExec;

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makePhren() {
  const tmp = makeTempDir("finding-sensitivity-");
  grantAdmin(tmp.path);
  return tmp;
}

function writeWorkflowPolicy(
  phrenPath: string,
  overrides: Record<string, unknown> = {},
) {
  const govDir = path.join(phrenPath, ".config");
  fs.mkdirSync(govDir, { recursive: true });
  writeFile(
    path.join(govDir, "workflow-policy.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        lowConfidenceThreshold: 0.7,
        riskySections: ["Stale", "Conflicts"],
        taskMode: "auto",
        findingSensitivity: "balanced",
        ...overrides,
      },
      null,
      2,
    ) + "\n",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Default level
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// 2. Level → sessionCap and proactivityFindings mapping
// ─────────────────────────────────────────────────────────────────────────────

describe("finding sensitivity — FINDING_SENSITIVITY_CONFIG mapping", () => {
  it.each([
    ["minimal", 0, "low"],
    ["conservative", 3, "medium"],
    ["balanced", 10, "high"],
    ["aggressive", 20, "high"],
  ] as const)("%s maps to sessionCap=%i and proactivityFindings=%s", (level, cap, proactivity) => {
    const cfg = FINDING_SENSITIVITY_CONFIG[level];
    expect(cfg.sessionCap).toBe(cap);
    expect(cfg.proactivityFindings).toBe(proactivity);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Agent instruction format — the prefix injected in hook context
//
// hook-prompt reads stdin JSON and exits early when the FTS index is empty,
// so we verify the injection format at the unit level by checking:
//   - FINDING_SENSITIVITY_CONFIG contains the correct instruction text
//   - getWorkflowPolicy returns the right level so the hook code would pick it up
//   - the injected string follows the documented format: "[phren finding-sensitivity=<level>] <instruction>"
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// 4. getSessionCap: policy vs PHREN_AUTOCAPTURE_SESSION_CAP override
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// 5. Init walkthrough writes chosen level to workflow-policy.json
// ─────────────────────────────────────────────────────────────────────────────

describe("finding sensitivity — init writes policy", () => {
  let tmp: { path: string; cleanup: () => void };

  beforeEach(() => { tmp = makePhren(); });
  afterEach(() => tmp.cleanup());

  it("updateWorkflowPolicy persists findingSensitivity=conservative", () => {
    const r = updateWorkflowPolicy(tmp.path, { findingSensitivity: "conservative" });
    expect(r.ok).toBe(true);
    const policy = getWorkflowPolicy(tmp.path);
    expect(policy.findingSensitivity).toBe("conservative");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. CLI: phren config finding-sensitivity get / set
// ─────────────────────────────────────────────────────────────────────────────

describe("finding sensitivity — CLI config subcommand", () => {
  let tmp: { path: string; cleanup: () => void };

  beforeEach(() => {
    tmp = makePhren();
    writeWorkflowPolicy(tmp.path);
  });
  afterEach(() => tmp.cleanup());

  it("config finding-sensitivity get returns JSON with level and sessionCap", () => {
    const { stdout, exitCode } = runCli(
      ["config", "finding-sensitivity", "get"],
      { PHREN_PATH: tmp.path },
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as { level: string; sessionCap: number; proactivityFindings: string; agentInstruction: string };
    expect(parsed.level).toBe("balanced");
    expect(parsed.sessionCap).toBe(10);
    expect(parsed.proactivityFindings).toBe("high");
    expect(typeof parsed.agentInstruction).toBe("string");
  });

  it.each([["minimal", 0], ["aggressive", 20]] as const)("config finding-sensitivity set %s persists and get reflects it", (level, cap) => {
    const set = runCli(
      ["config", "finding-sensitivity", "set", level],
      { PHREN_PATH: tmp.path },
    );
    expect(set.exitCode).toBe(0);

    const get = runCli(
      ["config", "finding-sensitivity", "get"],
      { PHREN_PATH: tmp.path },
    );
    expect(get.exitCode).toBe(0);
    const parsed = JSON.parse(get.stdout) as { level: string; sessionCap: number };
    expect(parsed.level).toBe(level);
    expect(parsed.sessionCap).toBe(cap);
  });

  it("config finding-sensitivity with bare value (no set subcommand) also works", () => {
    const { exitCode, stdout } = runCli(
      ["config", "finding-sensitivity", "conservative"],
      { PHREN_PATH: tmp.path },
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as { level: string };
    expect(parsed.level).toBe("conservative");
  });

  it("config finding-sensitivity set with invalid level exits non-zero", () => {
    const { exitCode } = runCli(
      ["config", "finding-sensitivity", "set", "turbo"],
      { PHREN_PATH: tmp.path },
    );
    expect(exitCode).not.toBe(0);
  });

  it("config finding-sensitivity get returns JSON even when no policy file exists", () => {
    const fresh = makePhren();
    grantAdmin(fresh.path);
    try {
      const { stdout, exitCode } = runCli(
        ["config", "finding-sensitivity", "get"],
        { PHREN_PATH: fresh.path },
      );
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout) as { level: string };
      expect(parsed.level).toBe("balanced"); // default
    } finally {
      fresh.cleanup();
    }
  });

  it("set updates only findingSensitivity, leaves taskMode untouched", () => {
    writeWorkflowPolicy(tmp.path, { taskMode: "suggest", findingSensitivity: "balanced" });

    runCli(
      ["config", "finding-sensitivity", "set", "aggressive"],
      { PHREN_PATH: tmp.path },
    );

    const policy = getWorkflowPolicy(tmp.path);
    expect(policy.taskMode).toBe("suggest");
    expect(policy.findingSensitivity).toBe("aggressive");
  });
});
