import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTempDir } from "../test-helpers.js";
import * as fs from "fs";
import * as path from "path";
import { scheduleBackgroundMaintenance } from "./session-background.js";
import { writeInstallPreferences } from "../init/preferences.js";

describe.sequential("manual preset runtime gating", () => {
  let phrenPath: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ path: phrenPath, cleanup } = makeTempDir("phren-gating-test-"));
    fs.mkdirSync(path.join(phrenPath, ".runtime"), { recursive: true });
  });
  afterEach(() => cleanup());

  it("does not schedule daily maintenance under the manual preset", () => {
    writeInstallPreferences(phrenPath, { managementPreset: "manual" });
    // manual disables lifecycle automations, so no background job is scheduled.
    expect(scheduleBackgroundMaintenance(phrenPath)).toBe(false);
  });
});
