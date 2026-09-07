import * as fs from "fs";
import * as path from "path";
import { readInstallPreferences } from "../init/preferences.js";
import { atomicWriteText, debugLog } from "../phren-paths.js";
import { withFileLock } from "../governance/locks.js";

export type SkillScope = string;
export const SKILL_PREFERENCES_PATH = ".config/skill-preferences.json";

interface SkillPreferences {
  schemaVersion: 1;
  enabledSkills: Record<string, boolean>;
  [key: string]: unknown;
}

export function skillStateKey(scope: SkillScope, name: string): string {
  return `${scope}:${name.replace(/\.md$/i, "").trim().toLowerCase()}`;
}

/** Strict on writes: never replace malformed or future settings with defaults. */
export function readSkillPreferences(phrenPath: string): SkillPreferences {
  const file = path.join(phrenPath, SKILL_PREFERENCES_PATH);
  if (!fs.existsSync(file)) return { schemaVersion: 1, enabledSkills: {} };
  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid skill preferences.");
  const prefs = value as Record<string, unknown>;
  const settings = prefs.enabledSkills;
  if (prefs.schemaVersion !== 1 || !settings || typeof settings !== "object" || Array.isArray(settings)
    || !Object.values(settings).every((entry) => typeof entry === "boolean")) {
    throw new Error("Invalid or unsupported skill preferences. Update phren or repair .config/skill-preferences.json.");
  }
  return prefs as SkillPreferences;
}

export function isSkillEnabled(phrenPath: string, scope: SkillScope, name: string): boolean {
  const key = skillStateKey(scope, name);
  try {
    const shared = readSkillPreferences(phrenPath).enabledSkills;
    if (Object.hasOwn(shared, key)) return shared[key];
  } catch (error) {
    // A broken settings file must not accidentally re-enable disabled skills.
    debugLog(`skill preferences: ${String(error)}`);
    return false;
  }
  // Older machine-local choices remain effective until a synced choice exists.
  return readInstallPreferences(phrenPath).disabledSkills?.[key] !== true;
}

export function setSkillEnabled(phrenPath: string, scope: SkillScope, name: string, enabled: boolean): void {
  const file = path.join(phrenPath, SKILL_PREFERENCES_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  withFileLock(file, () => {
    const prefs = readSkillPreferences(phrenPath);
    const enabledSkills = { ...prefs.enabledSkills, [skillStateKey(scope, name)]: enabled };
    atomicWriteText(file, `${JSON.stringify({ ...prefs, enabledSkills }, null, 2)}\n`);
  });
}
