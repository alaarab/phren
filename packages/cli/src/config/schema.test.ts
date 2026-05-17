import { describe, it, expect } from "vitest";
import {
  CONFIG_DOMAINS,
  allConfigFields,
  getConfigDomain,
  getConfigField,
  resolveConfigDomainAlias,
} from "./schema.js";
import { FINDING_SENSITIVITY_CONFIG } from "../cli/config.js";
import {
  DEFAULT_POLICY,
  DEFAULT_WORKFLOW_POLICY,
  DEFAULT_INDEX_POLICY,
} from "../governance/policy.js";

describe("config schema", () => {
  it("defines all eight domains", () => {
    expect(CONFIG_DOMAINS.map((d) => d.id).sort()).toEqual(
      ["access", "findingSensitivity", "index", "proactivity", "retention", "taskMode", "topic", "workflow"],
    );
  });

  it("has unique field keys", () => {
    const keys = allConfigFields().map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps every field's domain consistent with its containing domain", () => {
    for (const domain of CONFIG_DOMAINS) {
      for (const field of domain.fields) {
        expect(field.domain).toBe(domain.id);
      }
    }
  });

  it("gives enum fields options and number fields a range", () => {
    for (const field of allConfigFields()) {
      if (field.control === "enum") {
        expect(field.options, `${field.key} should have options`).toBeTruthy();
        expect(field.options!.length).toBeGreaterThan(1);
      }
      if (field.control === "number") {
        expect(field.range, `${field.key} should have a range`).toBeTruthy();
        expect(field.range!.min).toBeLessThan(field.range!.max);
      }
    }
  });

  it("marks exactly one recommended option per enum field that has one", () => {
    for (const field of allConfigFields()) {
      if (field.control !== "enum" || !field.options) continue;
      const recommended = field.options.filter((o) => o.recommended);
      expect(recommended.length, `${field.key} recommended count`).toBeLessThanOrEqual(1);
    }
  });

  it("derives defaults from the canonical policy constants", () => {
    expect(getConfigField("retention.ttlDays")?.default).toBe(DEFAULT_POLICY.ttlDays);
    expect(getConfigField("retention.decay.d90")?.default).toBe(DEFAULT_POLICY.decay.d90);
    expect(getConfigField("taskMode")?.default).toBe(DEFAULT_WORKFLOW_POLICY.taskMode);
    expect(getConfigField("findingSensitivity")?.default).toBe(DEFAULT_WORKFLOW_POLICY.findingSensitivity);
    expect(getConfigField("workflow.lowConfidenceThreshold")?.default)
      .toBe(DEFAULT_WORKFLOW_POLICY.lowConfidenceThreshold);
    expect(getConfigField("index.includeHidden")?.default).toBe(DEFAULT_INDEX_POLICY.includeHidden);
  });

  it("keeps findingSensitivity option blurbs in sync with FINDING_SENSITIVITY_CONFIG", () => {
    const field = getConfigField("findingSensitivity")!;
    for (const option of field.options!) {
      const runtime = FINDING_SENSITIVITY_CONFIG[option.value as keyof typeof FINDING_SENSITIVITY_CONFIG];
      expect(runtime, `runtime config for ${option.value}`).toBeTruthy();
      expect(option.blurb).toBe(runtime.agentInstruction);
    }
  });

  it("resolves historical CLI subcommand aliases to canonical domains", () => {
    expect(resolveConfigDomainAlias("task-mode")).toBe("taskMode");
    expect(resolveConfigDomainAlias("finding-sensitivity")).toBe("findingSensitivity");
    expect(resolveConfigDomainAlias("policy")).toBe("retention");
    expect(resolveConfigDomainAlias("PROACTIVITY")).toBe("proactivity");
    expect(resolveConfigDomainAlias("nonsense")).toBeUndefined();
  });

  it("looks up domains and fields by id/key", () => {
    expect(getConfigDomain("retention")?.label).toBe("Retention");
    expect(getConfigField("retention.ttlDays")?.label).toBe("TTL (days)");
    expect(getConfigField("missing.key")).toBeUndefined();
  });
});
