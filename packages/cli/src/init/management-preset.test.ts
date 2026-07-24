import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTempDir } from "../test-helpers.js";
import {
  DEFAULT_MANAGEMENT_PRESET,
  MANAGEMENT_PRESETS,
  capabilitiesForPreset,
  getManagementPreset,
  parseManagementPreset,
  presetCapabilities,
  presetSummaryLines,
  resolveManagementCapabilities,
} from "./management-preset.js";
import { writeInstallPreferences } from "./preferences.js";

describe("management preset model", () => {
  let phrenPath: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ path: phrenPath, cleanup } = makeTempDir("phren-preset-test-"));
  });
  afterEach(() => cleanup());

  it("parses valid presets and rejects junk", () => {
    expect(parseManagementPreset("managed")).toBe("managed");
    expect(parseManagementPreset("  ASSISTED ")).toBe("assisted");
    expect(parseManagementPreset("manual")).toBe("manual");
    expect(parseManagementPreset("bogus")).toBeUndefined();
    expect(parseManagementPreset("")).toBeUndefined();
    expect(parseManagementPreset(undefined)).toBeUndefined();
  });

  it("expands managed to full capabilities", () => {
    const caps = presetCapabilities("managed");
    expect(caps.linkGlobalClaudeMd).toBe(true);
    expect(caps.installSkillLinks).toBe(true);
    expect(caps.installWrappers).toBe(true);
    expect(caps.selfHeal).toBe(true);
    expect(caps.repoMirroring).toBe(true);
    expect(caps.lifecycleAutomations).toBe(true);
    expect(caps.hooksDefault).toBe(true);
    expect(caps.ownershipForcedDetached).toBe(false);
  });

  it("assisted keeps hooks + automations but writes nothing outside the store", () => {
    const caps = presetCapabilities("assisted");
    expect(caps.hooksDefault).toBe(true);
    expect(caps.lifecycleAutomations).toBe(true);
    expect(caps.linkGlobalClaudeMd).toBe(false);
    expect(caps.installSkillLinks).toBe(false);
    expect(caps.installWrappers).toBe(false);
    expect(caps.selfHeal).toBe(false);
    expect(caps.repoMirroring).toBe(false);
    expect(caps.ownershipForcedDetached).toBe(true);
  });

  it("manual disables hooks and automations", () => {
    const caps = presetCapabilities("manual");
    expect(caps.hooksDefault).toBe(false);
    expect(caps.lifecycleAutomations).toBe(false);
    expect(caps.linkGlobalClaudeMd).toBe(false);
    expect(caps.ownershipForcedDetached).toBe(true);
  });

  it("treats an absent preset as the default (managed)", () => {
    expect(getManagementPreset(phrenPath)).toBe(DEFAULT_MANAGEMENT_PRESET);
    expect(DEFAULT_MANAGEMENT_PRESET).toBe("managed");
    const caps = resolveManagementCapabilities(phrenPath);
    expect(caps.linkGlobalClaudeMd).toBe(true);
  });

  it("reads the persisted preset", () => {
    writeInstallPreferences(phrenPath, { managementPreset: "assisted" });
    expect(getManagementPreset(phrenPath)).toBe("assisted");
    expect(resolveManagementCapabilities(phrenPath).installSkillLinks).toBe(false);
  });

  it("lets an explicit per-capability override win over the preset bundle", () => {
    // assisted normally disables selfHeal; an explicit override re-enables it.
    writeInstallPreferences(phrenPath, { managementPreset: "assisted", selfHeal: true });
    const caps = resolveManagementCapabilities(phrenPath);
    expect(caps.selfHeal).toBe(true);
    // Non-overridden fields still follow the preset.
    expect(caps.installSkillLinks).toBe(false);
  });

  it("capabilitiesForPreset overlays overrides onto an arbitrary preset", () => {
    writeInstallPreferences(phrenPath, { managementPreset: "managed", repoMirroring: false });
    // Ask for assisted's bundle but keep the stored repoMirroring override.
    const caps = capabilitiesForPreset(phrenPath, "assisted");
    expect(caps.repoMirroring).toBe(false);
    expect(caps.linkGlobalClaudeMd).toBe(false); // assisted default
  });

  it("provides a summary line for every preset", () => {
    for (const preset of MANAGEMENT_PRESETS) {
      expect(presetSummaryLines(preset).length).toBeGreaterThan(0);
    }
  });
});
