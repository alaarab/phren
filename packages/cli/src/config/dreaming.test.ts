import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir } from "../test-helpers.js";
import { clearProjectConfigCache } from "../project-config.js";
import {
  DEFAULT_DREAMING_CONFIG,
  getDreamingConfig,
  insideDreamWindow,
  parseDreamingPatch,
  parseDreamWindow,
  updateDreamingConfig,
} from "./dreaming.js";
import { buildConfigView } from "./resolve.js";
import { CONFIG_DOMAINS, getConfigField, resolveConfigDomainAlias } from "./schema.js";

let store: { path: string; cleanup: () => void };

beforeEach(() => {
  store = makeTempDir("phren-dreaming-config-");
  fs.mkdirSync(path.join(store.path, "demo"), { recursive: true });
  clearProjectConfigCache();
});
afterEach(() => store.cleanup());

describe("dreaming config", () => {
  it("is off by default, with the contract's defaults", () => {
    expect(getDreamingConfig(store.path, "demo")).toEqual({
      enabled: false, mode: "propose", cadence: "nightly", window: "02:00-05:00", idleMinutes: 45,
      lookbackHours: 24, maxChanges: 25, injectBudgetKB: 8, phases: ["capture", "correct", "organize", "prune"], model: "",
    });
  });

  it("lets a project override the global value and inherit the rest", () => {
    updateDreamingConfig(store.path, { enabled: true, cadence: "weekly", maxChanges: 10 });
    updateDreamingConfig(store.path, { cadence: "idle", mode: "apply" }, "demo");
    clearProjectConfigCache();
    expect(getDreamingConfig(store.path)).toMatchObject({ enabled: true, cadence: "weekly", mode: "propose", maxChanges: 10 });
    expect(getDreamingConfig(store.path, "demo")).toMatchObject({ enabled: true, cadence: "idle", mode: "apply", maxChanges: 10 });

    // Clearing the project's override makes it inherit the global value again.
    updateDreamingConfig(store.path, {}, "demo", ["cadence"]);
    clearProjectConfigCache();
    expect(getDreamingConfig(store.path, "demo")).toMatchObject({ cadence: "weekly", mode: "apply" });
  });

  it("reports where each dreaming value came from", () => {
    updateDreamingConfig(store.path, { enabled: true });
    updateDreamingConfig(store.path, { window: "23:00-04:00" }, "demo");
    clearProjectConfigCache();
    const view = buildConfigView(store.path, "demo");
    expect(view.fields["dreaming.enabled"]).toMatchObject({ value: true, source: "global", inheritedValue: false });
    expect(view.fields["dreaming.window"]).toMatchObject({ value: "23:00-04:00", source: "project", inheritedValue: "02:00-05:00" });
    expect(view.fields["dreaming.cadence"]).toMatchObject({ value: "nightly", source: "default" });
  });

  it("ignores stored values it cannot use, so the level below shows through", () => {
    fs.mkdirSync(path.join(store.path, ".config"), { recursive: true });
    fs.writeFileSync(path.join(store.path, ".config", "dreaming.json"),
      JSON.stringify({ enabled: "maybe", cadence: "hourly", window: "25:00-26:00", maxChanges: 0, phases: ["capture", "dream-harder"] }));
    expect(getDreamingConfig(store.path)).toMatchObject({
      enabled: false, cadence: "nightly", window: "02:00-05:00", maxChanges: 25, phases: ["capture"],
    });
  });

  it("validates a patch and says why each value was refused", () => {
    const parsed = parseDreamingPatch({ enabled: "true", idleMinutes: "60", mode: "yolo", window: "5-6", colour: "blue", phases: "prune,organize,nope" });
    expect(parsed.patch).toEqual({ enabled: true, idleMinutes: 60, phases: ["prune", "organize"] });
    expect(parsed.unknown).toEqual(["colour"]);
    expect(parsed.errors).toHaveLength(2);
    expect(parsed.errors.join(" ")).toMatch(/mode must be one of: propose, apply/);
    expect(parsed.errors.join(" ")).toMatch(/window must be HH:MM-HH:MM/);
  });

  it("reads windows, including ones that wrap midnight", () => {
    expect(parseDreamWindow("02:00-05:00")).toEqual({ start: 120, end: 300 });
    expect(parseDreamWindow("05:00-05:00")).toBeNull();
    const at = (h: number, m = 0) => new Date(2026, 10, 6, h, m);
    expect(insideDreamWindow("02:00-05:00", at(2))).toBe(true);
    expect(insideDreamWindow("02:00-05:00", at(5))).toBe(false);
    expect(insideDreamWindow("23:00-04:00", at(23, 30))).toBe(true);
    expect(insideDreamWindow("23:00-04:00", at(3, 59))).toBe(true);
    expect(insideDreamWindow("23:00-04:00", at(12))).toBe(false);
  });

  it("is the ninth schema domain, reachable by alias, with defaults from the config module", () => {
    expect(CONFIG_DOMAINS.map((d) => d.id)).toContain("dreaming");
    expect(resolveConfigDomainAlias("dream")).toBe("dreaming");
    expect(getConfigField("dreaming.enabled")?.default).toBe(DEFAULT_DREAMING_CONFIG.enabled);
    expect(getConfigField("dreaming.phases")?.default).toEqual(DEFAULT_DREAMING_CONFIG.phases);
    expect(getConfigField("dreaming.window")?.control).toBe("string");
  });
});
