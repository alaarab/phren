import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir, writeFile } from "../test-helpers.js";
import { writeInstallPreferences } from "../init/preferences.js";
import { buildSkillManifest } from "./registry.js";
import { syncScopeSkillsToDir } from "./files.js";
import { isSkillEnabled, readSkillPreferences, setSkillEnabled, SKILL_PREFERENCES_PATH } from "./state.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function store() {
  const temp = makeTempDir("skill-prefs-");
  cleanups.push(temp.cleanup);
  return temp.path;
}

describe("synced skill preferences", () => {
  it("retains legacy local choices until an explicit synced setting exists", () => {
    const root = store();
    writeInstallPreferences(root, { disabledSkills: { "demo:audit": true, "other:audit": true } });
    expect(isSkillEnabled(root, "demo", "Audit.MD")).toBe(false);
    setSkillEnabled(root, "demo", "Audit.MD", true);
    expect(isSkillEnabled(root, "demo", "audit")).toBe(true);
    expect(isSkillEnabled(root, "other", "audit")).toBe(false);
    expect(readSkillPreferences(root).enabledSkills).toEqual({ "demo:audit": true });
  });

  it("applies phone choices to project mirrors without affecting same-named skills elsewhere", () => {
    const root = store();
    writeFile(path.join(root, "global/skills/shared.md"), "# Shared");
    for (const project of ["demo", "other"]) writeFile(path.join(root, project, "skills/audit.md"), "# Audit");
    const dest = path.join(root, "mirror/skills");
    syncScopeSkillsToDir(root, "demo", dest);
    expect(fs.existsSync(path.join(dest, "audit.md"))).toBe(true);
    writeFile(path.join(root, SKILL_PREFERENCES_PATH), JSON.stringify({ schemaVersion: 1, enabledSkills: { "demo:audit": false, "global:shared": false } }));
    const manifest = syncScopeSkillsToDir(root, "demo", dest);
    expect(manifest.skills.every((s) => !s.visibleToAgents)).toBe(true);
    expect(fs.existsSync(path.join(dest, "audit.md"))).toBe(false);
    expect(fs.existsSync(path.join(dest, "shared.md"))).toBe(false);
    expect(fs.existsSync(path.join(root, "demo/skills/audit.md"))).toBe(true);
    expect(buildSkillManifest(root, "", "other").skills.find((s) => s.name === "audit")?.enabled).toBe(true);
  });

  it("preserves unknown metadata and independent scope choices", () => {
    const root = store();
    writeFile(path.join(root, SKILL_PREFERENCES_PATH), JSON.stringify({ schemaVersion: 1, enabledSkills: { "other:audit": false }, future: { keep: [1, 2] } }));
    setSkillEnabled(root, "demo", "audit", true);
    expect(readSkillPreferences(root)).toEqual({ schemaVersion: 1, enabledSkills: { "other:audit": false, "demo:audit": true }, future: { keep: [1, 2] } });
  });

  it("refuses malformed and future documents without enabling skills or overwriting data", () => {
    const root = store();
    for (const content of ["broken", "[]", '{"schemaVersion":2,"enabledSkills":{}}', '{"schemaVersion":1,"enabledSkills":{"demo:audit":"false"}}']) {
      writeFile(path.join(root, SKILL_PREFERENCES_PATH), content);
      expect(() => setSkillEnabled(root, "demo", "audit", true)).toThrow();
      expect(isSkillEnabled(root, "demo", "audit")).toBe(false);
      expect(fs.readFileSync(path.join(root, SKILL_PREFERENCES_PATH), "utf8")).toBe(content);
    }
  });
});
