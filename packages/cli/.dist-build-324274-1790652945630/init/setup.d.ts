/**
 * Governance files, root file migration, verification, starter templates, bootstrap.
 */
import * as fs from "fs";
import { commandVersion } from "./shared.js";
import { type ManagementCapabilities, type ManagementPreset } from "./management-preset.js";
import { bootstrapFromExisting, ensureProjectScaffold, inferInitScaffoldFromRepo, type InferredInitScaffold, type InitProjectDomain } from "../core/project-registry.js";
export { bootstrapFromExisting, ensureProjectScaffold, inferInitScaffoldFromRepo, type InferredInitScaffold, type InitProjectDomain, };
export interface PostInitCheck {
    name: string;
    ok: boolean;
    detail: string;
    fix?: string;
}
interface LocalGitRepoStatus {
    ok: boolean;
    initialized: boolean;
    detail: string;
}
export declare function resolvePreferredHomeDir(phrenPath: string): string;
interface RepairInstallResult {
    profileFilesUpdated: number;
    removedLegacyProjects: number;
    createdContextFile: boolean;
    createdRootMemory: boolean;
    createdGlobalAssets: string[];
    createdRuntimeAssets: string[];
    createdFeatureDefaults: string[];
    createdSkillArtifacts: string[];
    repairedGlobalSymlink: boolean;
}
export declare function ensureGitignoreEntry(repoRoot: string, entry: string): boolean;
export declare function upsertProjectEnvVar(repoRoot: string, key: string, value: string): boolean;
export declare function repairPreexistingInstall(phrenPath: string, opts?: {
    caps?: ManagementCapabilities;
    preset?: ManagementPreset;
}): RepairInstallResult;
export declare function getVerifyOutcomeNote(phrenPath: string, checks: PostInitCheck[]): string | null;
interface HookEntrypointCheckDeps {
    pathExists?: typeof fs.existsSync;
    versionReader?: typeof commandVersion;
}
export declare function getHookEntrypointCheck(deps?: HookEntrypointCheckDeps): PostInitCheck;
export declare function applyStarterTemplateUpdates(phrenPath: string): string[];
export declare function ensureGovernanceFiles(phrenPath: string): string[];
export declare function listTemplates(): string[];
export declare function applyTemplate(projectDir: string, templateName: string, projectName: string): boolean;
export declare function ensureLocalGitRepo(phrenPath: string): LocalGitRepoStatus;
export declare function updateMachinesYaml(phrenPath: string, machine?: string, profile?: string): void;
/**
 * Detect if a directory looks like a project that should be bootstrapped.
 * Returns the path if it qualifies, null otherwise.
 * A directory qualifies if it:
 * - Is not the home directory or phren directory
 * - Has an AGENTS.md, legacy CLAUDE.md, .claude/CLAUDE.md, or .git directory
 *
 * A git worktree resolves to the repository it belongs to. Without this a
 * throwaway agent worktree under `.claude/worktrees/<codename>` looks like its
 * own repo (it has a `.git` entry) and gets offered as a new project.
 */
export declare function detectProjectDir(dir: string, phrenPath: string): string | null;
/**
 * Check if a project name is already tracked in any profile.
 */
export declare function isProjectTracked(phrenPath: string, projectName: string, profile?: string): boolean;
export declare function runPostInitVerify(phrenPath: string): {
    ok: boolean;
    checks: PostInitCheck[];
};
