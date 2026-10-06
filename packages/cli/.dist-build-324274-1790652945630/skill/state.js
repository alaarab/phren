import * as fs from "fs";
import * as path from "path";
import { readInstallPreferences } from "../init/preferences.js";
import { atomicWriteText, debugLog } from "../phren-paths.js";
import { withFileLock } from "../governance/locks.js";
export const SKILL_PREFERENCES_PATH = ".config/skill-preferences.json";
export function skillStateKey(scope, name) {
    return `${scope}:${name.replace(/\.md$/i, "").trim().toLowerCase()}`;
}
/** Strict on writes: never replace malformed or future settings with defaults. */
export function readSkillPreferences(phrenPath) {
    const file = path.join(phrenPath, SKILL_PREFERENCES_PATH);
    if (!fs.existsSync(file))
        return { schemaVersion: 1, enabledSkills: {} };
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid skill preferences.");
    const prefs = value;
    const settings = prefs.enabledSkills;
    if (prefs.schemaVersion !== 1 || !settings || typeof settings !== "object" || Array.isArray(settings)
        || !Object.values(settings).every((entry) => typeof entry === "boolean")) {
        throw new Error("Invalid or unsupported skill preferences. Update phren or repair .config/skill-preferences.json.");
    }
    return prefs;
}
/** Read one snapshot per discovery pass; the next pass observes fresh settings. */
export function readSkillEnabledState(phrenPath) {
    let shared;
    try {
        shared = readSkillPreferences(phrenPath).enabledSkills;
    }
    catch (error) {
        // A broken settings file must not accidentally re-enable disabled skills.
        debugLog(`skill preferences: ${String(error)}`);
        return () => false;
    }
    // Older machine-local choices remain effective until a synced choice exists.
    const disabled = readInstallPreferences(phrenPath).disabledSkills;
    return (scope, name) => {
        const key = skillStateKey(scope, name);
        return Object.hasOwn(shared, key) ? shared[key] : disabled?.[key] !== true;
    };
}
export function isSkillEnabled(phrenPath, scope, name) {
    return readSkillEnabledState(phrenPath)(scope, name);
}
export function setSkillEnabled(phrenPath, scope, name, enabled) {
    const file = path.join(phrenPath, SKILL_PREFERENCES_PATH);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    withFileLock(file, () => {
        const prefs = readSkillPreferences(phrenPath);
        const enabledSkills = { ...prefs.enabledSkills, [skillStateKey(scope, name)]: enabled };
        atomicWriteText(file, `${JSON.stringify({ ...prefs, enabledSkills }, null, 2)}\n`);
    });
}
