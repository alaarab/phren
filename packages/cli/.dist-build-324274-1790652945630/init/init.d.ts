import { type InstallMode } from "../shared.js";
export type { McpConfigStatus, McpRootKey, ToolStatus, HookEntry, HookMap } from "./config.js";
export { configureClaude, configureVSCode, configureCursorMcp, configureCopilotMcp, configureCodexMcp, logMcpTargetStatus, resetVSCodeProbeCache, patchJsonFile, } from "./config.js";
export type { InstallPreferences } from "./preferences.js";
export { getMcpEnabledPreference, setMcpEnabledPreference, getHooksEnabledPreference, setHooksEnabledPreference, } from "./preferences.js";
export { PROJECT_OWNERSHIP_MODES, type ProjectOwnershipMode, parseProjectOwnershipMode, getProjectOwnershipDefault, } from "../project-config.js";
export { PROACTIVITY_LEVELS, type ProactivityLevel, getProactivityLevel, getProactivityLevelForFindings, getProactivityLevelForTask, } from "../proactivity.js";
export type { PostInitCheck, InitProjectDomain, InferredInitScaffold } from "./setup.js";
export { ensureGovernanceFiles, repairPreexistingInstall, runPostInitVerify, getVerifyOutcomeNote, listTemplates, detectProjectDir, isProjectTracked, ensureLocalGitRepo, resolvePreferredHomeDir, inferInitScaffoldFromRepo, } from "./setup.js";
export { configureMcpTargets, warmSemanticSearch, runProjectLocalInit } from "./init-configure.js";
export { runMcpMode } from "./init-mcp-mode.js";
export { runHooksMode } from "./init-hooks-mode.js";
export { runPreset } from "./init-preset.js";
export { printSelfWiringSnippet } from "./self-wiring.js";
export { runUninstall } from "./init-uninstall.js";
import { type InitProjectDomain, type InferredInitScaffold } from "./setup.js";
import { type McpMode } from "./shared.js";
import { type ProjectOwnershipMode } from "../project-config.js";
import { type ProactivityLevel } from "../proactivity.js";
import { type ManagementPreset } from "./management-preset.js";
export { type McpMode, parseMcpMode } from "./shared.js";
type StorageLocationChoice = "global" | "project" | "custom";
type SkillsScope = "global" | "project";
/**
 * Compare two semver strings. Returns true when `current` is strictly newer
 * than `previous`. Pre-release versions (e.g. 1.2.3-rc.1) sort before the
 * corresponding release (1.2.3). Among pre-release tags, comparison is
 * lexicographic.
 */
export declare function isVersionNewer(current: string, previous?: string): boolean;
export interface InitOptions {
    mode?: InstallMode;
    machine?: string;
    profile?: string;
    mcp?: McpMode;
    hooks?: McpMode;
    projectOwnershipDefault?: ProjectOwnershipMode;
    /** Management preset controlling phren's machine footprint (managed | assisted | manual). */
    managementPreset?: ManagementPreset;
    findingsProactivity?: ProactivityLevel;
    taskProactivity?: ProactivityLevel;
    lowConfidenceThreshold?: number;
    riskySections?: ("Review" | "Stale" | "Conflicts")[];
    taskMode?: "off" | "manual" | "suggest" | "auto";
    findingSensitivity?: "minimal" | "conservative" | "balanced" | "aggressive";
    skillsScope?: SkillsScope;
    applyStarterUpdate?: boolean;
    dryRun?: boolean;
    yes?: boolean;
    /** Skip walkthrough entirely with recommended defaults (express mode) */
    express?: boolean;
    /** Ask about every setting instead of offering recommended defaults */
    advanced?: boolean;
    /**
     * Allow init to repoint global wiring (~/.local/bin/phren wrapper and
     * Claude settings.json hooks/mcpServers.phren) at a different phren root
     * than the one currently in use. Without this, init refuses when an
     * existing global file references a different valid phren root — protects
     * against tests/smoke runs that forget to sandbox $HOME.
     */
    force?: boolean;
    template?: "python-project" | "monorepo" | "library" | "frontend" | string;
    /** Set by walkthrough to pass project name to init logic */
    _walkthroughProject?: string;
    /** Set by walkthrough for personalized GitHub next-steps output */
    _walkthroughGithub?: {
        username?: string;
        repo: string;
        create?: boolean;
    };
    /** Set by walkthrough when the user wants the phone connected right away */
    _walkthroughPair?: boolean;
    /** Set by walkthrough to seed project docs/topics by domain */
    _walkthroughDomain?: InitProjectDomain;
    /** Set by walkthrough to seed adaptive project scaffold from current repo content */
    _walkthroughInferredScaffold?: InferredInitScaffold;
    /** Set by walkthrough when user enables auto-capture; triggers writing ~/.phren/.env */
    _walkthroughAutoCapture?: boolean;
    /** Set by walkthrough when user opts into local semantic search */
    _walkthroughSemanticSearch?: boolean;
    /** Set by walkthrough when user enables LLM semantic dedup */
    _walkthroughSemanticDedup?: boolean;
    /** Set by walkthrough when user enables LLM conflict detection */
    _walkthroughSemanticConflict?: boolean;
    /** Set by walkthrough when user provides a git clone URL for existing phren */
    _walkthroughCloneUrl?: string;
    /** Set by walkthrough when the user wants the current repo enrolled immediately */
    _walkthroughBootstrapCurrentProject?: boolean;
    /** Set by walkthrough for the ownership mode selected for the current repo */
    _walkthroughBootstrapOwnership?: ProjectOwnershipMode;
    /** Set by walkthrough to select where phren data is stored */
    _walkthroughStorageChoice?: StorageLocationChoice;
    /** Set by walkthrough to pass resolved storage path to init logic */
    _walkthroughStoragePath?: string;
    /** Set by walkthrough when project-local storage is chosen */
    _walkthroughStorageRepoRoot?: string;
}
export declare function getPendingBootstrapTarget(phrenPath: string, _opts: InitOptions): {
    path: string;
    mode: "explicit" | "detected";
} | null;
export declare function runInit(opts?: InitOptions): Promise<void>;
