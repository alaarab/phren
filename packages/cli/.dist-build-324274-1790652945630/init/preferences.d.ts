import type { CustomHookEntry } from "../hooks.js";
export interface InstallPreferences {
    mcpEnabled?: boolean;
    /**
     * Which MCP tool surface clients get. "core" (default) is ten tools with
     * everything else behind phren_admin; "full" is every tool by name.
     * PHREN_MCP_PROFILE overrides it. See mcp/profile.ts.
     */
    mcpProfile?: "core" | "full";
    hooksEnabled?: boolean;
    skillsScope?: "global" | "project";
    projectOwnershipDefault?: "phren-managed" | "detached" | "repo-managed";
    /**
     * Management preset controlling how much of the machine phren wires up.
     * Absent → treated as "managed" (the historical, fully-managed behavior).
     * See init/management-preset.ts for the capability expansion.
     */
    managementPreset?: "managed" | "assisted" | "manual";
    /**
     * Per-capability overrides. When set they win over the preset bundle
     * (power-user escape hatch); when absent the preset default applies.
     */
    linkGlobalClaudeMd?: boolean;
    installSkillLinks?: boolean;
    installWrappers?: boolean;
    selfHeal?: boolean;
    repoMirroring?: boolean;
    lifecycleAutomations?: boolean;
    proactivity?: "high" | "medium" | "low";
    proactivityFindings?: "high" | "medium" | "low";
    proactivityTask?: "high" | "medium" | "low";
    hookTools?: Record<string, boolean>;
    disabledSkills?: Record<string, boolean>;
    installedVersion?: string;
    updatedAt?: string;
    customHooks?: CustomHookEntry[];
    /**
     * Pre-prompt custom hook commands that have been mirrored into Claude
     * Code's settings.json as sibling UserPromptSubmit entries. Used to detect
     * stale siblings on resync so we can remove commands that were deleted
     * from `customHooks`. Internal bookkeeping — managed by
     * `syncPrePromptSiblingsToClaudeSettings`. Do not edit by hand.
     */
    managedPrePromptSiblingCommands?: string[];
    /** Whether the user intended cross-machine sync ("sync") or local-only ("local"). */
    syncIntent?: "sync" | "local";
    /** Seconds between MCP remote checks. 0 disables periodic pulls (the default). */
    pullIntervalSeconds?: number;
}
export declare function governanceInstallPreferencesFile(phrenPath: string): string;
export declare function readInstallPreferences(phrenPath: string): InstallPreferences;
export declare function readGovernanceInstallPreferences(phrenPath: string): InstallPreferences;
export declare function writeInstallPreferences(phrenPath: string, patch: Partial<InstallPreferences>): void;
export declare function writeGovernanceInstallPreferences(phrenPath: string, patch: Partial<InstallPreferences>): void;
/** Atomically read-modify-write install preferences using a patcher function. */
export declare function updateInstallPreferences(phrenPath: string, patcher: (current: InstallPreferences) => Partial<InstallPreferences>): void;
export declare function getMcpEnabledPreference(phrenPath: string): boolean;
export declare function setMcpEnabledPreference(phrenPath: string, enabled: boolean): void;
export declare function getHooksEnabledPreference(phrenPath: string): boolean;
export declare function setHooksEnabledPreference(phrenPath: string, enabled: boolean): void;
export declare function setManagementPresetPreference(phrenPath: string, preset: "managed" | "assisted" | "manual"): void;
