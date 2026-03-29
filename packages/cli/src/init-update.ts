/**
 * Update logic for existing phren installs.
 */
import {
  hookConfigPath,
  writeRootManifest,
} from "./shared.js";
import { isVersionNewer } from "./init-npm.js";
import {
  readInstallPreferences,
  writeInstallPreferences,
} from "./init/preferences.js";
import {
  ensureGovernanceFiles,
  repairPreexistingInstall,
  runPostInitVerify,
  applyStarterTemplateUpdates,
  ensureLocalGitRepo,
} from "./init/setup.js";
import { getWorkflowPolicy } from "./shared/governance.js";
import { VERSION, log, confirmPrompt } from "./init/shared.js";
import { configureMcpTargets } from "./init-mcp.js";
import { configureHooksIfEnabled } from "./init-hooks.js";
import {
  applyOnboardingPreferences,
  writeWalkthroughEnvDefaults,
  collectRepairedAssetLabels,
} from "./init-env.js";
import { getPendingBootstrapTarget } from "./init-detect.js";
import { bootstrapProject } from "./init-bootstrap.js";
import type { InitOptions, SkillsScope } from "./init-types.js";
import type { ProjectOwnershipMode } from "./project-config.js";

export async function runExistingInstallUpdate(
  phrenPath: string,
  opts: InitOptions,
  params: {
    mcpEnabled: boolean;
    hooksEnabled: boolean;
    skillsScope: SkillsScope;
    ownershipDefault: string;
    syncIntent: "sync" | "local";
    shouldBootstrapCurrentProject: boolean;
    bootstrapOwnership: string;
  },
): Promise<void> {
  const {
    mcpEnabled,
    hooksEnabled,
    skillsScope,
    ownershipDefault,
    syncIntent,
    shouldBootstrapCurrentProject,
    bootstrapOwnership,
  } = params;
  const mcpLabel = mcpEnabled ? "ON (recommended)" : "OFF (hooks-only fallback)";
  const hooksLabel = hooksEnabled ? "ON (active)" : "OFF (disabled)";

  writeRootManifest(phrenPath, {
    version: 1,
    installMode: "shared",
    syncMode: "managed-git",
  });
  ensureGovernanceFiles(phrenPath);
  const repaired = repairPreexistingInstall(phrenPath);
  applyOnboardingPreferences(phrenPath, opts);
  const existingGitRepo = ensureLocalGitRepo(phrenPath);

  log(`\nphren already exists at ${phrenPath}`);
  log(`Updating configuration...\n`);
  log(`  MCP mode: ${mcpLabel}`);
  log(`  Hooks mode: ${hooksLabel}`);
  log(`  Default project ownership: ${ownershipDefault}`);
  log(`  Task mode: ${getWorkflowPolicy(phrenPath).taskMode}`);
  log(`  Git repo: ${existingGitRepo.detail}`);

  // Confirmation prompt before writing config
  if (!opts.yes) {
    const settingsPath = hookConfigPath("claude");
    const modifications: string[] = [];
    modifications.push(`  ${settingsPath}  (update MCP server + hooks)`);
    log(`\nWill modify:`);
    for (const mod of modifications) log(mod);

    const confirmed = await confirmPrompt("\nProceed?");
    if (!confirmed) {
      log("Aborted.");
      return;
    }
  }

  // Always reconfigure MCP and hooks (picks up new features on upgrade)
  configureMcpTargets(phrenPath, { mcpEnabled, hooksEnabled }, "Updated");
  configureHooksIfEnabled(phrenPath, hooksEnabled, "Updated");

  const prefs = readInstallPreferences(phrenPath);
  const previousVersion = prefs.installedVersion;
  if (isVersionNewer(VERSION, previousVersion)) {
    log(`\n  Starter template update available: v${previousVersion} -> v${VERSION}`);
    log(`  Run \`phren init --apply-starter-update\` to refresh global/CLAUDE.md and global skills.`);
  }
  if (opts.applyStarterUpdate) {
    const updated = applyStarterTemplateUpdates(phrenPath);
    if (updated.length) {
      log(`  Applied starter template updates (${updated.length} file${updated.length === 1 ? "" : "s"}).`);
    } else {
      log(`  No starter template updates were applied (starter files not found).`);
    }
  }
  writeInstallPreferences(phrenPath, { mcpEnabled, hooksEnabled, skillsScope, installedVersion: VERSION, syncIntent });
  if (repaired.removedLegacyProjects > 0) {
    log(`  Removed ${repaired.removedLegacyProjects} legacy starter project entr${repaired.removedLegacyProjects === 1 ? "y" : "ies"} from profiles.`);
  }
  const repairedAssets = collectRepairedAssetLabels(repaired);
  if (repairedAssets.length > 0) {
    log(`  Recreated missing generated assets: ${repairedAssets.join(", ")}`);
  }

  // Post-update verification
  log(`\nVerifying setup...`);
  const verify = runPostInitVerify(phrenPath);
  for (const check of verify.checks) {
    log(`  ${check.ok ? "pass" : "FAIL"} ${check.name}: ${check.detail}`);
  }

  const pendingBootstrap = getPendingBootstrapTarget(phrenPath, opts);
  if (pendingBootstrap && shouldBootstrapCurrentProject) {
    bootstrapProject(phrenPath, pendingBootstrap.path, opts.profile, bootstrapOwnership as ProjectOwnershipMode, "Added current project");
  }

  for (const envLabel of writeWalkthroughEnvDefaults(phrenPath, opts)) {
    log(`  ${envLabel}`);
  }

  log(`\n\x1b[95m◆\x1b[0m phren updated successfully`);
  log(`\nNext steps:`);
  log(`  1. Start a new Claude session in your project directory — phren injects context automatically`);
  log(`  2. Run \`phren doctor\` to verify everything is wired correctly`);
  log(`  3. Change defaults anytime: \`phren config project-ownership\`, \`phren config workflow\`, \`phren config proactivity.findings\`, \`phren config proactivity.tasks\``);
  log(`  4. After your first week, run phren-discover to surface gaps in your project knowledge`);
  log(`  5. After working across projects, run phren-consolidate to find cross-project patterns`);
  log(``);
}
