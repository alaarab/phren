import { describe, expect, it } from "vitest";
import {
  FINDING_TYPE_DECAY,
  extractFindingType,
} from "../finding/lifecycle.js";

describe("finding type decay", () => {
  it("observations decay faster than patterns", () => {
    const observation = '- [observation] Login page shows error <!-- phren:created "2025-01-01" -->';
    const pattern = '- [pattern] Always clear dist before tsconfig change <!-- phren:created "2025-01-01" -->';

    // Both are old, but pattern should survive longer
    const obsType = extractFindingType(observation);
    const patType = extractFindingType(pattern);

    expect(obsType).toBe("observation");
    expect(patType).toBe("pattern");
    expect(FINDING_TYPE_DECAY["observation"].maxAgeDays).toBe(14);
    expect(FINDING_TYPE_DECAY["pattern"].maxAgeDays).toBe(365);
  });

  it("decisions never decay", () => {
    expect(FINDING_TYPE_DECAY["decision"].maxAgeDays).toBe(Infinity);
    expect(FINDING_TYPE_DECAY["anti-pattern"].maxAgeDays).toBe(Infinity);
  });

  it("extractFindingType returns null for untagged findings", () => {
    expect(extractFindingType("- Some random finding")).toBeNull();
  });

  it("extractFindingType handles context tag", () => {
    expect(extractFindingType("- [context] Deployed v2.3.1 to staging")).toBe("context");
  });

  it("extractFindingType returns null for unknown tags", () => {
    expect(extractFindingType("- [foobar] Some finding")).toBeNull();
  });

  it("extractFindingType is case-insensitive", () => {
    expect(extractFindingType("- [PATTERN] Upper case tag")).toBe("pattern");
    expect(extractFindingType("- [Decision] Mixed case tag")).toBe("decision");
  });

  it("all defined types have valid config", () => {
    for (const [type, config] of Object.entries(FINDING_TYPE_DECAY)) {
      expect(config.maxAgeDays).toBeGreaterThan(0);
      expect(config.decayMultiplier).toBeGreaterThan(0);
      expect(config.decayMultiplier).toBeLessThanOrEqual(1);
      expect(typeof type).toBe("string");
    }
  });
});
