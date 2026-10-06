export type SkillScope = string;
export type SkillEnabledResolver = (scope: SkillScope, name: string) => boolean;
export declare const SKILL_PREFERENCES_PATH = ".config/skill-preferences.json";
interface SkillPreferences {
    schemaVersion: 1;
    enabledSkills: Record<string, boolean>;
    [key: string]: unknown;
}
export declare function skillStateKey(scope: SkillScope, name: string): string;
/** Strict on writes: never replace malformed or future settings with defaults. */
export declare function readSkillPreferences(phrenPath: string): SkillPreferences;
/** Read one snapshot per discovery pass; the next pass observes fresh settings. */
export declare function readSkillEnabledState(phrenPath: string): SkillEnabledResolver;
export declare function isSkillEnabled(phrenPath: string, scope: SkillScope, name: string): boolean;
export declare function setSkillEnabled(phrenPath: string, scope: SkillScope, name: string, enabled: boolean): void;
export {};
