import { readInstallPreferences, writeInstallPreferences } from "./init-preferences.js";

export type SkillScope = string;

function skillStateKey(scope: SkillScope, name: string): string {
  return `${scope}:${name.replace(/\.md$/i, "").trim().toLowerCase()}`;
}

function readDisabledSkillMap(cortexPath: string): Record<string, boolean> {
  const prefs = readInstallPreferences(cortexPath);
  return prefs.disabledSkills && typeof prefs.disabledSkills === "object"
    ? { ...prefs.disabledSkills }
    : {};
}

export function isSkillEnabled(cortexPath: string, scope: SkillScope, name: string): boolean {
  const disabled = readDisabledSkillMap(cortexPath);
  return disabled[skillStateKey(scope, name)] !== true;
}

export function setSkillEnabled(cortexPath: string, scope: SkillScope, name: string, enabled: boolean): void {
  const disabled = readDisabledSkillMap(cortexPath);
  const key = skillStateKey(scope, name);
  if (enabled) delete disabled[key];
  else disabled[key] = true;
  writeInstallPreferences(cortexPath, {
    disabledSkills: Object.keys(disabled).length ? disabled : undefined,
  });
}

export function getSkillStateKey(scope: SkillScope, name: string): string {
  return skillStateKey(scope, name);
}
