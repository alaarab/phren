import { readInstallPreferences, writeInstallPreferences } from "../init/preferences.js";

export type SkillScope = string;

function skillStateKey(scope: SkillScope, name: string): string {
  return `${scope}:${name.replace(/\.md$/i, "").trim().toLowerCase()}`;
}

function readDisabledSkillMap(phrenPath: string): Record<string, boolean> {
  const prefs = readInstallPreferences(phrenPath);
  return prefs.disabledSkills && typeof prefs.disabledSkills === "object"
    ? { ...prefs.disabledSkills }
    : {};
}

export function isSkillEnabled(phrenPath: string, scope: SkillScope, name: string): boolean {
  const disabled = readDisabledSkillMap(phrenPath);
  return disabled[skillStateKey(scope, name)] !== true;
}

export function setSkillEnabled(phrenPath: string, scope: SkillScope, name: string, enabled: boolean): void {
  const disabled = readDisabledSkillMap(phrenPath);
  const key = skillStateKey(scope, name);
  if (enabled) delete disabled[key];
  else disabled[key] = true;
  writeInstallPreferences(phrenPath, {
    disabledSkills: Object.keys(disabled).length ? disabled : undefined,
  });
}

