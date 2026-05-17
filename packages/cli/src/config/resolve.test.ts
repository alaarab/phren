import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, initTestPhrenRoot } from "../test-helpers.js";
import { writeProjectConfig } from "../project-config.js";
import { writeGovernanceInstallPreferences } from "../init/preferences.js";
import { buildConfigView, resolveConfigField } from "./resolve.js";
import { allConfigFields } from "./schema.js";

function writeGlobal(phrenPath: string, file: string, data: Record<string, unknown>): void {
  const dir = path.join(phrenPath, ".config");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), JSON.stringify(data, null, 2) + "\n");
}

describe("resolveConfigField", () => {
  it("returns the default when nothing is set", () => {
    const r = resolveConfigField("x", 120, []);
    expect(r).toEqual({ key: "x", value: 120, source: "default", inheritedValue: 120 });
  });

  it("reports global as the source when only a global level is set", () => {
    const r = resolveConfigField("x", 120, [{ tier: "global", value: 90, path: "/g.json" }]);
    expect(r.value).toBe(90);
    expect(r.source).toBe("global");
    expect(r.inheritedValue).toBe(120);
    expect(r.sourcePath).toBe("/g.json");
  });

  it("reports project as the source and global as the inherited value", () => {
    const r = resolveConfigField("x", 120, [
      { tier: "project", value: 30, path: "/p.yaml" },
      { tier: "global", value: 90 },
    ]);
    expect(r.value).toBe(30);
    expect(r.source).toBe("project");
    expect(r.inheritedValue).toBe(90);
  });
});

describe("buildConfigView", () => {
  let tmp: { path: string; cleanup: () => void };
  let phrenPath: string;

  beforeEach(() => {
    tmp = makeTempDir("config-view-");
    phrenPath = tmp.path;
    initTestPhrenRoot(phrenPath);
    fs.mkdirSync(path.join(phrenPath, "proj"), { recursive: true });
  });

  afterEach(() => tmp.cleanup());

  it("resolves every field to its default when nothing is configured", () => {
    const view = buildConfigView(phrenPath);
    expect(view.scope).toBe("global");
    expect(view.fields["retention.ttlDays"].value).toBe(120);
    expect(view.fields["retention.ttlDays"].source).toBe("default");
    expect(view.fields.taskMode.value).toBe("auto");
    expect(view.fields.taskMode.source).toBe("default");
    expect(view.fields["proactivity.base"].value).toBe("high");
    expect(view.fields["proactivity.base"].source).toBe("default");
  });

  it("marks fields set in a global policy file as global-sourced", () => {
    writeGlobal(phrenPath, "workflow-policy.json", { taskMode: "suggest", findingSensitivity: "minimal" });
    const view = buildConfigView(phrenPath);
    expect(view.fields.taskMode.value).toBe("suggest");
    expect(view.fields.taskMode.source).toBe("global");
    expect(view.fields.taskMode.sourcePath).toContain("workflow-policy.json");
    expect(view.fields.findingSensitivity.value).toBe("minimal");
    expect(view.fields.findingSensitivity.source).toBe("global");
  });

  it("marks project overrides as project-sourced with the global inherited value", () => {
    writeGlobal(phrenPath, "workflow-policy.json", { taskMode: "suggest" });
    writeProjectConfig(phrenPath, "proj", { config: { taskMode: "off" } });
    const view = buildConfigView(phrenPath, "proj");
    expect(view.scope).toBe("project");
    expect(view.project).toBe("proj");
    expect(view.fields.taskMode.value).toBe("off");
    expect(view.fields.taskMode.source).toBe("project");
    expect(view.fields.taskMode.inheritedValue).toBe("suggest");
    expect(view.fields.taskMode.sourcePath).toContain("phren.project.yaml");
  });

  it("inherits proactivity findings/tasks from the resolved base", () => {
    writeGovernanceInstallPreferences(phrenPath, { proactivity: "low" });
    const view = buildConfigView(phrenPath);
    expect(view.fields["proactivity.base"].value).toBe("low");
    expect(view.fields["proactivity.base"].source).toBe("global");
    // findings has no own override — inherits base
    expect(view.fields["proactivity.findings"].value).toBe("low");
    expect(view.fields["proactivity.findings"].source).toBe("global");
  });

  it("lets a project override proactivity findings independently of base", () => {
    writeGovernanceInstallPreferences(phrenPath, { proactivity: "low" });
    writeProjectConfig(phrenPath, "proj", { config: { proactivityFindings: "high" } });
    const view = buildConfigView(phrenPath, "proj");
    expect(view.fields["proactivity.findings"].value).toBe("high");
    expect(view.fields["proactivity.findings"].source).toBe("project");
    expect(view.fields["proactivity.base"].value).toBe("low");
  });

  it("resolves decay milestones individually with partial project overrides", () => {
    // d60 is customised away from its default (0.85); d30 stays at the default.
    writeGlobal(phrenPath, "retention-policy.json", {
      decay: { d30: 1.0, d60: 0.8, d90: 0.65, d120: 0.45 },
    });
    writeProjectConfig(phrenPath, "proj", {
      config: { retentionPolicy: { decay: { d30: 0.5 } } },
    });
    const view = buildConfigView(phrenPath, "proj");
    expect(view.fields["retention.decay.d30"].value).toBe(0.5);
    expect(view.fields["retention.decay.d30"].source).toBe("project");
    expect(view.fields["retention.decay.d60"].value).toBe(0.8);
    expect(view.fields["retention.decay.d60"].source).toBe("global");
  });

  it("treats a global file that merely mirrors defaults as still default", () => {
    // repairPreexistingInstall writes policy files containing the defaults —
    // those must not masquerade as a deliberate global customisation.
    writeGlobal(phrenPath, "retention-policy.json", {
      ttlDays: 120,
      decay: { d30: 1.0, d60: 0.85, d90: 0.65, d120: 0.45 },
    });
    const view = buildConfigView(phrenPath);
    expect(view.fields["retention.ttlDays"].source).toBe("default");
    expect(view.fields["retention.decay.d60"].source).toBe("default");
  });

  it("resolves a field for every non-topic schema field", () => {
    // Anti-drift: a new schema field must also be wired into buildConfigView.
    const view = buildConfigView(phrenPath);
    for (const field of allConfigFields()) {
      if (field.domain === "topic") continue; // topic is stored separately
      expect(view.fields[field.key], `missing resolved field: ${field.key}`).toBeTruthy();
    }
  });

  it("unions access role lists across global and project scope", () => {
    writeGlobal(phrenPath, "access-control.json", { admins: ["alice"] });
    writeProjectConfig(phrenPath, "proj", { access: { admins: ["bob"] } });
    const view = buildConfigView(phrenPath, "proj");
    expect(view.fields["access.admins"].value).toEqual(["alice", "bob"]);
    expect(view.fields["access.admins"].source).toBe("project");
  });
});
