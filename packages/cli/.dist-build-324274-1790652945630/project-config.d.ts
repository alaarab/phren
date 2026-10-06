import type { RetentionPolicyPatch } from "./governance/policy.js";
export declare const PROJECT_OWNERSHIP_MODES: readonly ["phren-managed", "detached", "repo-managed"];
export type ProjectOwnershipMode = typeof PROJECT_OWNERSHIP_MODES[number];
export interface ProjectMcpServerEntry {
    command: string;
    args?: string[];
    env?: Record<string, string>;
}
export interface ProjectConfigOverrides {
    findingSensitivity?: "minimal" | "conservative" | "balanced" | "aggressive";
    proactivity?: "high" | "medium" | "low";
    proactivityFindings?: "high" | "medium" | "low";
    proactivityTask?: "high" | "medium" | "low";
    taskMode?: "off" | "manual" | "suggest" | "auto";
    retentionPolicy?: RetentionPolicyPatch;
    workflowPolicy?: {
        lowConfidenceThreshold?: number;
        riskySections?: Array<"Review" | "Stale" | "Conflicts">;
    };
}
export interface ProjectAccessControl {
    admins?: string[];
    contributors?: string[];
    readers?: string[];
}
export interface ProjectConfig {
    ownership?: ProjectOwnershipMode;
    /**
     * The folder the project was last added from, on whichever machine that was.
     * Kept for older CLIs; a synced store shares it across every computer, so
     * it is only authoritative on the machine that wrote it.
     */
    sourcePath?: string;
    /** Per-machine source folders, keyed by `getMachineName()`. Wins over `sourcePath`. */
    sourcePaths?: Record<string, string>;
    skills?: boolean;
    hooks?: {
        enabled?: boolean;
        UserPromptSubmit?: boolean;
        Stop?: boolean;
        SessionStart?: boolean;
        PostToolUse?: boolean;
    };
    mcpServers?: Record<string, ProjectMcpServerEntry>;
    config?: ProjectConfigOverrides;
    access?: ProjectAccessControl;
}
export declare const PROJECT_HOOK_EVENTS: readonly ["UserPromptSubmit", "Stop", "SessionStart", "PostToolUse"];
export type ProjectHookEvent = typeof PROJECT_HOOK_EVENTS[number];
type ProjectHookConfig = NonNullable<ProjectConfig["hooks"]>;
export declare function parseProjectOwnershipMode(raw: string | undefined | null): ProjectOwnershipMode | undefined;
export declare function projectConfigPath(phrenPath: string, project: string): string;
export declare function clearProjectConfigCache(): void;
export declare function readProjectConfig(phrenPath: string, project: string): ProjectConfig;
export declare function writeProjectConfig(phrenPath: string, project: string, patch: Partial<ProjectConfig>): ProjectConfig;
export declare function updateProjectConfigOverrides(phrenPath: string, project: string, updater: (current: ProjectConfigOverrides) => ProjectConfigOverrides): ProjectConfig;
/**
 * Where this project's source lives on this machine. The store syncs between
 * computers, so the shared `sourcePath` is often another machine's folder:
 * this machine's `sourcePaths` entry wins, and the shared value is only used
 * when nothing more specific was recorded.
 */
export declare function getProjectSourcePath(phrenPath: string, project: string, config?: ProjectConfig, machine?: string): string | undefined;
/**
 * Record `sourceRoot` as this machine's folder for the project, alongside the
 * legacy shared `sourcePath` older CLIs read.
 */
export declare function recordProjectSourcePath(phrenPath: string, project: string, sourceRoot: string, patch?: Partial<ProjectConfig>, machine?: string): ProjectConfig;
export declare function getProjectOwnershipDefault(phrenPath: string): ProjectOwnershipMode;
export declare function getProjectOwnershipMode(phrenPath: string, project: string, config?: ProjectConfig): ProjectOwnershipMode;
export declare function isProjectHookEnabled(phrenPath: string, project: string | null | undefined, event: ProjectHookEvent, config?: ProjectConfig): boolean;
/**
 * Remove a per-project hook override, restoring inheritance from global config.
 * Pass event to clear a specific event override; omit to clear the whole hooks block.
 */
export declare function clearProjectHookOverride(phrenPath: string, project: string, event?: string): ProjectConfig;
export declare function writeProjectHookConfig(phrenPath: string, project: string, patch: Partial<ProjectHookConfig>): ProjectConfig;
export {};
