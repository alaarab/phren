import { readInstallPreferences, writeInstallPreferences } from "./init-preferences.js";
function skillStateKey(scope, name) {
    return `${scope}:${name.replace(/\.md$/i, "").trim().toLowerCase()}`;
}
function readDisabledSkillMap(phrenPath) {
    const prefs = readInstallPreferences(phrenPath);
    return prefs.disabledSkills && typeof prefs.disabledSkills === "object"
        ? { ...prefs.disabledSkills }
        : {};
}
export function isSkillEnabled(phrenPath, scope, name) {
    const disabled = readDisabledSkillMap(phrenPath);
    return disabled[skillStateKey(scope, name)] !== true;
}
export function setSkillEnabled(phrenPath, scope, name, enabled) {
    const disabled = readDisabledSkillMap(phrenPath);
    const key = skillStateKey(scope, name);
    if (enabled)
        delete disabled[key];
    else
        disabled[key] = true;
    writeInstallPreferences(phrenPath, {
        disabledSkills: Object.keys(disabled).length ? disabled : undefined,
    });
}
export function getSkillStateKey(scope, name) {
    return skillStateKey(scope, name);
}
