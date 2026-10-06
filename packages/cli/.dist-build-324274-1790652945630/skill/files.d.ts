import { type SkillManifest } from "./registry.js";
export declare function syncScopeSkillsToDir(phrenPath: string, scope: string, destDir: string): SkillManifest;
export declare function syncSkillLinksForScope(phrenPath: string, scope: string): SkillManifest | null;
export declare function setSkillEnabledAndSync(phrenPath: string, scope: string, name: string, enabled: boolean): void;
export declare function removeSkillPath(skillPath: string): string;
