import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { makeTempDir, initTestPhrenRoot } from "./test-helpers.js";
import {
  mergeConfig,
  getRetentionPolicy,
  getWorkflowPolicy,
} from "./governance/governance-policy.js";
import { writeProjectConfig, readProjectConfig, projectConfigPath } from "./project-config.js";
import { writeGovernanceInstallPreferences } from "./init/init-preferences.js";

function writeGlobalRetentionPolicy(phrenPath: string, policy: Record<string, unknown>): void {
  const dir = path.join(phrenPath, ".config");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "retention-policy.json"), JSON.stringify(policy, null, 2) + "\n");
}

function writeGlobalWorkflowPolicy(phrenPath: string, policy: Record<string, unknown>): void {
  const dir = path.join(phrenPath, ".config");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "workflow-policy.json"), JSON.stringify(policy, null, 2) + "\n");
}

describe("mergeConfig", () => {
  let tmp: { path: string; cleanup: () => void };
  let phrenPath: string;

  beforeEach(() => {
    tmp = makeTempDir("merge-config-");
    phrenPath = tmp.path;
    initTestPhrenRoot(phrenPath);
    fs.mkdirSync(path.join(phrenPath, "myproject"), { recursive: true });
  });

  afterEach(() => {
    tmp.cleanup();
  });

  // Test 1: no project override returns global defaults
  it("returns global defaults when no project override exists", () => {
    const resolved = mergeConfig(phrenPath, "myproject");

    expect(resolved.findingSensitivity).toBe("balanced");
    expect(resolved.taskMode).toBe("auto");
    expect(resolved.retentionPolicy.ttlDays).toBe(120);
    expect(resolved.retentionPolicy.retentionDays).toBe(365);
    expect(resolved.retentionPolicy.autoAcceptThreshold).toBe(0.75);
    expect(resolved.retentionPolicy.minInjectConfidence).toBe(0.35);
    expect(resolved.retentionPolicy.decay.d30).toBe(1.0);
    expect(resolved.retentionPolicy.decay.d120).toBe(0.45);
    expect(resolved.workflowPolicy.lowConfidenceThreshold).toBe(0.7);
    expect(resolved.proactivity).toEqual({});
  });

  // Test 2: project override returns project values for overridden fields
  it("returns project values for explicitly overridden fields", () => {
    writeProjectConfig(phrenPath, "myproject", {
      config: {
        findingSensitivity: "aggressive",
        taskMode: "manual",
        proactivity: "low",
        proactivityFindings: "medium",
        proactivityTask: "high",
        retentionPolicy: {
          ttlDays: 30,
          decay: { d30: 0.9, d60: 0.7 },
        },
        workflowPolicy: {
          lowConfidenceThreshold: 0.5,
        },
      },
    });

    const resolved = mergeConfig(phrenPath, "myproject");

    expect(resolved.findingSensitivity).toBe("aggressive");
    expect(resolved.taskMode).toBe("manual");
    expect(resolved.proactivity.base).toBe("low");
    expect(resolved.proactivity.findings).toBe("medium");
    expect(resolved.proactivity.tasks).toBe("high");
    expect(resolved.retentionPolicy.ttlDays).toBe(30);
    expect(resolved.retentionPolicy.decay.d30).toBe(0.9);
    expect(resolved.retentionPolicy.decay.d60).toBe(0.7);
    expect(resolved.workflowPolicy.lowConfidenceThreshold).toBe(0.5);
  });

  // Test 3: project override returns global values for non-overridden fields
  it("falls through to global for fields not set in project override", () => {
    writeProjectConfig(phrenPath, "myproject", {
      config: {
        findingSensitivity: "minimal",
        // taskMode, retentionPolicy, workflowPolicy not set
      },
    });

    writeGlobalWorkflowPolicy(phrenPath, { taskMode: "suggest", findingSensitivity: "balanced" });
    writeGlobalRetentionPolicy(phrenPath, { ttlDays: 90, retentionDays: 200, autoAcceptThreshold: 0.6, minInjectConfidence: 0.3, decay: { d30: 1.0, d60: 0.8, d90: 0.6, d120: 0.4 } });

    const resolved = mergeConfig(phrenPath, "myproject");

    // Project override wins for findingSensitivity
    expect(resolved.findingSensitivity).toBe("minimal");
    // Falls through to global for taskMode
    expect(resolved.taskMode).toBe("suggest");
    // Falls through to global for retention fields
    expect(resolved.retentionPolicy.ttlDays).toBe(90);
    expect(resolved.retentionPolicy.retentionDays).toBe(200);
    expect(resolved.retentionPolicy.decay.d30).toBe(1.0);
    expect(resolved.retentionPolicy.decay.d120).toBe(0.4);
    // proactivity fields are undefined when not set in project
    expect(resolved.proactivity.base).toBeUndefined();
  });

  // Test 4: no project arg returns global defaults directly
  it("returns global defaults when called with no project", () => {
    writeGlobalWorkflowPolicy(phrenPath, { taskMode: "off", findingSensitivity: "conservative" });

    const resolved = mergeConfig(phrenPath);

    expect(resolved.findingSensitivity).toBe("conservative");
    expect(resolved.taskMode).toBe("off");
    expect(resolved.proactivity).toEqual({});
    expect(resolved.retentionPolicy.ttlDays).toBe(120); // default
  });

  // Test 5: mergeConfig correctly handles partial decay overrides
  it("merges partial decay object, leaving unset decay fields as global", () => {
    writeGlobalRetentionPolicy(phrenPath, {
      ttlDays: 120,
      retentionDays: 365,
      autoAcceptThreshold: 0.75,
      minInjectConfidence: 0.35,
      decay: { d30: 1.0, d60: 0.85, d90: 0.65, d120: 0.45 },
    });

    writeProjectConfig(phrenPath, "myproject", {
      config: {
        retentionPolicy: {
          decay: { d30: 0.5 }, // only d30 overridden
        },
      },
    });

    const resolved = mergeConfig(phrenPath, "myproject");

    expect(resolved.retentionPolicy.decay.d30).toBe(0.5);   // project override
    expect(resolved.retentionPolicy.decay.d60).toBe(0.85);  // global fallthrough
    expect(resolved.retentionPolicy.decay.d90).toBe(0.65);  // global fallthrough
    expect(resolved.retentionPolicy.decay.d120).toBe(0.45); // global fallthrough
  });

  // Test 6: empty riskySections in project override falls back to global
  it("falls back to global riskySections when project override has empty array", () => {
    writeGlobalWorkflowPolicy(phrenPath, {
      taskMode: "auto",
      findingSensitivity: "balanced",
      lowConfidenceThreshold: 0.7,
      riskySections: ["Review", "Stale", "Conflicts"],
    });

    writeProjectConfig(phrenPath, "myproject", {
      config: {
        workflowPolicy: {
          riskySections: [], // empty — should fall back to global
        },
      },
    });

    const resolved = mergeConfig(phrenPath, "myproject");

    // Empty override should use global riskySections
    expect(resolved.workflowPolicy.riskySections).toContain("Stale");
    expect(resolved.workflowPolicy.riskySections).toContain("Conflicts");
  });

  // Test 7: full resolution chain — project wins over global
  it("project config wins over global in full resolution chain", () => {
    writeGlobalWorkflowPolicy(phrenPath, {
      taskMode: "auto",
      findingSensitivity: "balanced",
      lowConfidenceThreshold: 0.7,
      riskySections: ["Stale"],
    });
    writeGlobalRetentionPolicy(phrenPath, {
      ttlDays: 120,
      retentionDays: 365,
      autoAcceptThreshold: 0.75,
      minInjectConfidence: 0.35,
      decay: { d30: 1.0, d60: 0.85, d90: 0.65, d120: 0.45 },
    });

    writeProjectConfig(phrenPath, "myproject", {
      config: {
        findingSensitivity: "conservative",
        taskMode: "off",
        proactivity: "low",
        retentionPolicy: {
          ttlDays: 60,
          minInjectConfidence: 0.5,
        },
        workflowPolicy: {
          riskySections: ["Review", "Conflicts"],
          lowConfidenceThreshold: 0.4,
        },
      },
    });

    const resolved = mergeConfig(phrenPath, "myproject");

    // Project values win
    expect(resolved.findingSensitivity).toBe("conservative");
    expect(resolved.taskMode).toBe("off");
    expect(resolved.proactivity.base).toBe("low");
    expect(resolved.retentionPolicy.ttlDays).toBe(60);
    expect(resolved.retentionPolicy.minInjectConfidence).toBe(0.5);
    expect(resolved.workflowPolicy.riskySections).toEqual(["Review", "Conflicts"]);
    expect(resolved.workflowPolicy.lowConfidenceThreshold).toBe(0.4);

    // Non-overridden fields fall back to global
    expect(resolved.retentionPolicy.retentionDays).toBe(365);
    expect(resolved.retentionPolicy.autoAcceptThreshold).toBe(0.75);
    expect(resolved.retentionPolicy.decay.d30).toBe(1.0);
  });

  it("ignores invalid override types and falls back to global values", () => {
    writeGlobalWorkflowPolicy(phrenPath, {
      taskMode: "suggest",
      findingSensitivity: "balanced",
      lowConfidenceThreshold: 0.6,
      riskySections: ["Stale"],
    });
    writeGlobalRetentionPolicy(phrenPath, {
      ttlDays: 120,
      retentionDays: 365,
      autoAcceptThreshold: 0.75,
      minInjectConfidence: 0.35,
      decay: { d30: 1.0, d60: 0.85, d90: 0.65, d120: 0.45 },
    });

    writeProjectConfig(phrenPath, "myproject", {
      config: {
        // Intentionally invalid at runtime; mergeConfig should ignore these.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        taskMode: "invalid-mode" as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        findingSensitivity: "invalid-sensitivity" as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        retentionPolicy: { ttlDays: -5, decay: { d30: 2 } } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        workflowPolicy: { lowConfidenceThreshold: 2, riskySections: ["Bogus"] } as any,
      },
    });

    const resolved = mergeConfig(phrenPath, "myproject");
    expect(resolved.taskMode).toBe("suggest");
    expect(resolved.findingSensitivity).toBe("balanced");
    expect(resolved.retentionPolicy.ttlDays).toBe(120);
    expect(resolved.retentionPolicy.decay.d30).toBe(1.0);
    expect(resolved.workflowPolicy.lowConfidenceThreshold).toBe(0.6);
    expect(resolved.workflowPolicy.riskySections).toEqual(["Stale"]);
  });

  it("falls back to global config when project name is invalid", () => {
    writeGlobalWorkflowPolicy(phrenPath, { taskMode: "manual", findingSensitivity: "minimal" });
    const resolved = mergeConfig(phrenPath, "../escape");
    expect(resolved.taskMode).toBe("manual");
    expect(resolved.findingSensitivity).toBe("minimal");
    expect(resolved.proactivity).toEqual({});
  });
});

describe("getWorkflowPolicy with project", () => {
  let tmp: { path: string; cleanup: () => void };
  let phrenPath: string;

  beforeEach(() => {
    tmp = makeTempDir("gwp-project-");
    phrenPath = tmp.path;
    initTestPhrenRoot(phrenPath);
    fs.mkdirSync(path.join(phrenPath, "proj"), { recursive: true });
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it("returns global policy when no project arg given", () => {
    writeGlobalWorkflowPolicy(phrenPath, { taskMode: "suggest", findingSensitivity: "minimal" });

    const policy = getWorkflowPolicy(phrenPath);
    expect(policy.taskMode).toBe("suggest");
    expect(policy.findingSensitivity).toBe("minimal");
  });

  it("returns merged project policy when project arg given", () => {
    writeGlobalWorkflowPolicy(phrenPath, { taskMode: "auto", findingSensitivity: "balanced" });
    writeProjectConfig(phrenPath, "proj", {
      config: { taskMode: "off" },
    });

    const policy = getWorkflowPolicy(phrenPath, "proj");
    expect(policy.taskMode).toBe("off");
    expect(policy.findingSensitivity).toBe("balanced"); // global fallthrough
  });
});

describe("getRetentionPolicy with project", () => {
  let tmp: { path: string; cleanup: () => void };
  let phrenPath: string;

  beforeEach(() => {
    tmp = makeTempDir("grp-project-");
    phrenPath = tmp.path;
    initTestPhrenRoot(phrenPath);
    fs.mkdirSync(path.join(phrenPath, "proj"), { recursive: true });
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it("returns global retention when no project arg given", () => {
    writeGlobalRetentionPolicy(phrenPath, { ttlDays: 90, retentionDays: 180, autoAcceptThreshold: 0.6, minInjectConfidence: 0.4, decay: { d30: 1.0, d60: 0.8, d90: 0.6, d120: 0.4 } });

    const policy = getRetentionPolicy(phrenPath);
    expect(policy.ttlDays).toBe(90);
    expect(policy.retentionDays).toBe(180);
  });

  it("returns merged retention when project arg given", () => {
    writeGlobalRetentionPolicy(phrenPath, { ttlDays: 120, retentionDays: 365, autoAcceptThreshold: 0.75, minInjectConfidence: 0.35, decay: { d30: 1.0, d60: 0.85, d90: 0.65, d120: 0.45 } });
    writeProjectConfig(phrenPath, "proj", {
      config: {
        retentionPolicy: { ttlDays: 30 },
      },
    });

    const policy = getRetentionPolicy(phrenPath, "proj");
    expect(policy.ttlDays).toBe(30);          // project override
    expect(policy.retentionDays).toBe(365);   // global fallthrough
  });
});

// Tests for set_* tools writing to the correct location
describe("set_* tools write to phren.project.yaml when project given", () => {
  let tmp: { path: string; cleanup: () => void };
  let phrenPath: string;

  beforeEach(() => {
    tmp = makeTempDir("set-tools-");
    phrenPath = tmp.path;
    initTestPhrenRoot(phrenPath);
  });

  afterEach(() => {
    tmp.cleanup();
  });

  // Test 4: set_proactivity with project writes to phren.project.yaml
  it("set_proactivity with project writes to phren.project.yaml, not .config/", () => {
    // Simulate what set_proactivity does when project is given
    const project = "alpha";
    const level = "low" as const;
    const scope = "base";
    const key = "proactivity";

    const current = readProjectConfig(phrenPath, project);
    writeProjectConfig(phrenPath, project, {
      ...current,
      config: { ...(current.config ?? {}), [key]: level },
    });

    // Check phren.project.yaml was written
    const configPath = projectConfigPath(phrenPath, project);
    expect(fs.existsSync(configPath)).toBe(true);

    const stored = readProjectConfig(phrenPath, project);
    expect(stored.config?.proactivity).toBe("low");

    // Check .config/ was NOT written
    const govDir = path.join(phrenPath, ".config");
    const govFiles = fs.existsSync(govDir) ? fs.readdirSync(govDir) : [];
    // install-preferences.json should not be written by project-scoped set_proactivity
    expect(govFiles).not.toContain("install-preferences.json");
  });

  // Test 5: set_proactivity without project writes to .config/
  it("set_proactivity without project writes to .config/ install-preferences.json", () => {
    writeGovernanceInstallPreferences(phrenPath, { proactivity: "medium" });

    const govPrefsPath = path.join(phrenPath, ".config", "install-preferences.json");
    expect(fs.existsSync(govPrefsPath)).toBe(true);

    const stored = JSON.parse(fs.readFileSync(govPrefsPath, "utf8"));
    expect(stored.proactivity).toBe("medium");
  });

  // Test 6: get_config with project returns merged view
  it("get_config with project returns merged values from project and global", () => {
    writeGlobalWorkflowPolicy(phrenPath, { taskMode: "auto", findingSensitivity: "balanced", lowConfidenceThreshold: 0.7, riskySections: ["Stale"] });

    writeProjectConfig(phrenPath, "beta", {
      config: {
        findingSensitivity: "aggressive",
        taskMode: "off",
      },
    });

    const resolved = mergeConfig(phrenPath, "beta");

    // Returns project values
    expect(resolved.findingSensitivity).toBe("aggressive");
    expect(resolved.taskMode).toBe("off");
    // Returns global for non-overridden fields
    expect(resolved.workflowPolicy.lowConfidenceThreshold).toBe(0.7);
    expect(resolved.workflowPolicy.riskySections).toContain("Stale");
  });
});
