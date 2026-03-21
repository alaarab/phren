/**
 * Dry-run output for init.
 */
import * as path from "path";
import { getMachineName } from "./machine-identity.js";
import { getPendingBootstrapTarget } from "./init-detect.js";
import { listTemplates } from "./init-setup.js";
import { log } from "./init-shared.js";
import type { InitOptions } from "./init-types.js";

export function printDryRun(
  phrenPath: string,
  opts: InitOptions,
  params: {
    hasExistingInstall: boolean;
    mcpLabel: string;
    hooksLabel: string;
    hooksEnabled: boolean;
    storageChoice?: string;
    storageRepoRoot?: string;
  },
): void {
  const { hasExistingInstall, mcpLabel, hooksLabel, hooksEnabled, storageChoice, storageRepoRoot } = params;
  const pendingBootstrap = getPendingBootstrapTarget(phrenPath, opts);

  log("\nInit dry run. No files will be written.\n");
  if (storageChoice) {
    log(`Storage location: ${storageChoice} (${phrenPath})`);
    if (storageChoice === "project" && storageRepoRoot) {
      log(`  Would update ${path.join(storageRepoRoot, ".gitignore")} with .phren/`);
      log(`  Would set PHREN_PATH in ${path.join(storageRepoRoot, ".env")}`);
    }
  }
  if (hasExistingInstall) {
    log(`phren install detected at ${phrenPath}`);
    log(`Would update configuration for the existing install:\n`);
    log(`  MCP mode: ${mcpLabel}`);
    log(`  Hooks mode: ${hooksLabel}`);
    log(`  Reconfigure Claude Code MCP/hooks`);
    log(`  Reconfigure VS Code, Cursor, Copilot CLI, and Codex MCP targets`);
    if (hooksEnabled) {
      log(`  Reconfigure lifecycle hooks for detected tools`);
    }
    if (pendingBootstrap?.mode === "detected") {
      log(`  Would offer to add current project directory (${pendingBootstrap.path})`);
    }
    if (opts.applyStarterUpdate) {
      log(`  Apply starter template updates to global/CLAUDE.md and global skills`);
    }
    log(`  Run post-init verification checks`);
    log(`\nDry run complete.\n`);
    return;
  }

  log(`No existing phren install found at ${phrenPath}`);
  log(`Would create a new phren install:\n`);
  log(`  Copy starter files to ${phrenPath} (or create minimal structure)`);
  log(`  Update machines.yaml for machine "${opts.machine || getMachineName()}"`);
  log(`  Create/update config files`);
  log(`  MCP mode: ${mcpLabel}`);
  log(`  Hooks mode: ${hooksLabel}`);
  log(`  Configure Claude Code plus detected MCP targets (VS Code/Cursor/Copilot/Codex)`);
  if (hooksEnabled) {
    log(`  Configure lifecycle hooks for detected tools`);
  }
  if (pendingBootstrap?.mode === "detected") {
    log(`  Would offer to add current project directory (${pendingBootstrap.path})`);
  }
  log(`  Write install preferences and run post-init verification checks`);
  log(`\nDry run complete.\n`);
}
