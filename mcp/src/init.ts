/**
 * CLI orchestrator for phren init, mcp-mode, hooks-mode, and uninstall.
 * Delegates to focused helpers in init-* modules.
 */
import * as fs from "fs";
import {
  getMcpEnabledPreference,
  getHooksEnabledPreference,
  readInstallPreferences,
} from "./init-preferences.js";
import {
  getProjectOwnershipDefault,
} from "./project-config.js";
import { resolveInitPhrenPath, hasInstallMarkers } from "./init-detect.js";
import { migrateLegacyStore, migrateLegacySkills } from "./init-migrate.js";
import { mergeWalkthroughAnswers, cloneExistingPhren } from "./init-walkthrough-merge.js";
import { resolveBootstrapDecision } from "./init-bootstrap.js";
import { applyProjectStorageBindings } from "./init-env.js";
import { printDryRun } from "./init-dryrun.js";
import { runExistingInstallUpdate } from "./init-update.js";
import { runFreshInstall } from "./init-fresh.js";
import { runProjectLocalInit } from "./init-project-local.js";
import { log } from "./init-shared.js";

import type { InitOptions, SkillsScope } from "./init-types.js";
export type { InitOptions, SkillsScope } from "./init-types.js";

// ── Re-exports for backward compatibility ────────────────────────────────────
// Many consumers import from "./init.js" so we re-export everything they need.

export type { McpConfigStatus, McpRootKey, ToolStatus, HookEntry, HookMap } from "./init-config.js";
export {
  configureClaude,
  configureVSCode,
  configureCursorMcp,
  configureCopilotMcp,
  configureCodexMcp,
  logMcpTargetStatus,
  resetVSCodeProbeCache,
  patchJsonFile,
} from "./init-config.js";

export type { InstallPreferences } from "./init-preferences.js";
export {
  getMcpEnabledPreference,
  setMcpEnabledPreference,
  getHooksEnabledPreference,
  setHooksEnabledPreference,
} from "./init-preferences.js";

export {
  PROJECT_OWNERSHIP_MODES,
  type ProjectOwnershipMode,
  parseProjectOwnershipMode,
  getProjectOwnershipDefault,
} from "./project-config.js";

export {
  PROACTIVITY_LEVELS,
  type ProactivityLevel,
  getProactivityLevel,
  getProactivityLevelForFindings,
  getProactivityLevelForTask,
} from "./proactivity.js";

export type { PostInitCheck, InitProjectDomain, InferredInitScaffold } from "./init-setup.js";
export {
  ensureGovernanceFiles,
  repairPreexistingInstall,
  runPostInitVerify,
  getVerifyOutcomeNote,
  listTemplates,
  detectProjectDir,
  isProjectTracked,
  ensureLocalGitRepo,
  resolvePreferredHomeDir,
  inferInitScaffoldFromRepo,
} from "./init-setup.js";

export { configureMcpTargets } from "./init-mcp.js";
export { parseMcpMode, runMcpMode, runHooksMode } from "./init-modes.js";
export { isVersionNewer } from "./init-npm.js";
export type { McpMode } from "./init-walkthrough.js";
export { warmSemanticSearch } from "./init-semantic.js";

// Re-export runUninstall from its dedicated module
export { runUninstall } from "./init-uninstall.js";

// ── Main init orchestrator ───────────────────────────────────────────────────

export async function runInit(opts: InitOptions = {}) {
  if ((opts.mode || "shared") === "project-local") {
    await runProjectLocalInit(opts);
    return;
  }

  let phrenPath = resolveInitPhrenPath(opts);
  const dryRun = Boolean(opts.dryRun);

  // Legacy migrations
  if (!opts._walkthroughStoragePath && !fs.existsSync(phrenPath)) {
    migrateLegacyStore(phrenPath, dryRun);
  }
  if (!dryRun) {
    migrateLegacySkills(phrenPath);
  }

  let hasExistingInstall = hasInstallMarkers(phrenPath);

  // Interactive walkthrough for first-time installs
  if (!hasExistingInstall && !dryRun && !opts.yes && process.stdin.isTTY && process.stdout.isTTY) {
    const result = await mergeWalkthroughAnswers(phrenPath, hasExistingInstall, opts);
    phrenPath = result.phrenPath;
    hasExistingInstall = result.hasExistingInstall;
  }

  // Clone from remote if walkthrough provided a URL
  if (opts._walkthroughCloneUrl) {
    if (cloneExistingPhren(phrenPath, opts._walkthroughCloneUrl)) {
      hasExistingInstall = true;
    }
  }

  // Resolve preferences
  const existingSyncIntent = hasExistingInstall ? readInstallPreferences(phrenPath).syncIntent : undefined;
  const syncIntent: "sync" | "local" = opts._walkthroughCloneUrl ? "sync" : (existingSyncIntent ?? "local");
  const mcpEnabled = opts.mcp ? opts.mcp === "on" : getMcpEnabledPreference(phrenPath);
  const hooksEnabled = opts.hooks ? opts.hooks === "on" : getHooksEnabledPreference(phrenPath);
  const skillsScope: SkillsScope = opts.skillsScope ?? "global";
  const storageChoice = opts._walkthroughStorageChoice;
  const storageRepoRoot = opts._walkthroughStorageRepoRoot;
  const ownershipDefault = opts.projectOwnershipDefault
    ?? (hasExistingInstall ? getProjectOwnershipDefault(phrenPath) : "detached");
  if (!hasExistingInstall && !opts.projectOwnershipDefault) {
    opts.projectOwnershipDefault = ownershipDefault;
  }

  // Resolve bootstrap decision (may prompt interactively)
  const bootstrap = await resolveBootstrapDecision(phrenPath, opts, ownershipDefault, dryRun);

  // Dry run: just print what would happen
  const mcpLabel = mcpEnabled ? "ON (recommended)" : "OFF (hooks-only fallback)";
  const hooksLabel = hooksEnabled ? "ON (active)" : "OFF (disabled)";

  if (dryRun) {
    printDryRun(phrenPath, opts, {
      hasExistingInstall,
      mcpLabel,
      hooksLabel,
      hooksEnabled,
      storageChoice,
      storageRepoRoot,
    });
    return;
  }

  // Apply project-local storage bindings
  if (storageChoice === "project") {
    if (!storageRepoRoot) {
      throw new Error("Per-project storage requires a detected repository root.");
    }
    const storageChanges = applyProjectStorageBindings(storageRepoRoot, phrenPath);
    for (const change of storageChanges) {
      log(`  Updated storage binding: ${change}`);
    }
  }

  const sharedParams = {
    mcpEnabled,
    hooksEnabled,
    skillsScope,
    ownershipDefault,
    syncIntent,
    shouldBootstrapCurrentProject: bootstrap.shouldBootstrap,
    bootstrapOwnership: bootstrap.ownership,
  };

  if (hasExistingInstall) {
    await runExistingInstallUpdate(phrenPath, opts, sharedParams);
  } else {
    await runFreshInstall(phrenPath, opts, sharedParams);
  }
}
