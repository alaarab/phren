export interface SkillEntry {
    name: string;
    source: string;
    scopeType: "global" | "project";
    sourceKind: "canonical";
    format: "flat" | "folder";
    path: string;
    root: string;
    description?: string;
    enabled: boolean;
    command: string;
    aliases: string[];
}
interface ResolvedSkill extends Pick<SkillEntry, "path" | "format" | "root" | "name" | "source" | "enabled" | "description" | "command" | "aliases" | "scopeType" | "sourceKind"> {
    visibleToAgents: boolean;
    commandRegistered: boolean;
    overrides: Array<{
        source: string;
        path: string;
        sourceKind: "canonical";
    }>;
    mirrorTargets: string[];
}
interface SkillCommandRegistration {
    command: string;
    type: "skill";
    skillId: string;
    source: string;
    path: string;
    kind: "primary" | "alias";
    registered: boolean;
}
interface SkillManifestProblem {
    code: string;
    message: string;
    command?: string;
    skillIds?: string[];
}
export interface SkillManifest {
    scope: string;
    project?: string;
    generatedAt: string;
    skills: ResolvedSkill[];
    commands: SkillCommandRegistration[];
    problems: SkillManifestProblem[];
}
export declare function getAllSkills(phrenPath: string, profile: string): SkillEntry[];
export declare function buildSkillManifest(phrenPath: string, profile: string, scope: string, mirrorDir?: string): SkillManifest;
export declare function getScopedSkills(phrenPath: string, profile: string, project?: string): ResolvedSkill[];
export declare function findLocalSkill(phrenPath: string, scope: string, name: string): ResolvedSkill | null;
export declare function findSkill(phrenPath: string, profile: string, project: string | undefined, name: string): ResolvedSkill | {
    error: string;
} | null;
export declare function renderSkillInstructionsSection(manifest: SkillManifest): string;
export {};
