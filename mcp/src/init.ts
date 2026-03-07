/**
 * CLI orchestrator for cortex init, mcp-mode, hooks-mode, and uninstall.
 * Delegates to focused helpers in init-config, init-setup, and init-preferences.
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { configureAllHooks } from "./hooks.js";
import { debugLog } from "./shared.js";
import { isValidProjectName, errorMessage } from "./utils.js";

// Re-export everything consumers need from the helper modules
export type { McpConfigStatus, McpRootKey, ToolStatus } from "./init-config.js";
export {
  configureClaude,
  configureVSCode,
  configureCursorMcp,
  configureCopilotMcp,
  configureCodexMcp,
  logMcpTargetStatus,
  resetVSCodeProbeCache,
  isCortexCommand,
  removeMcpServerAtPath,
  removeTomlMcpServer,
  patchJsonFile,
  upsertMcpServer,
} from "./init-config.js";

export type { InstallPreferences } from "./init-preferences.js";
export {
  readInstallPreferences,
  writeInstallPreferences,
  getMcpEnabledPreference,
  setMcpEnabledPreference,
  getHooksEnabledPreference,
  setHooksEnabledPreference,
} from "./init-preferences.js";

export type { PostInitCheck } from "./init-setup.js";
export {
  ensureGovernanceFiles,
  migrateRootFiles,
  runPostInitVerify,
  applyStarterTemplateUpdates,
  listTemplates,
  applyTemplate,
  bootstrapFromExisting,
  updateMachinesYaml,
} from "./init-setup.js";

// Imports from helpers (used internally in this file)
import {
  configureClaude,
  configureVSCode,
  configureCursorMcp,
  configureCopilotMcp,
  configureCodexMcp,
  logMcpTargetStatus,
  removeMcpServerAtPath,
  removeTomlMcpServer,
  isCortexCommand,
  patchJsonFile,
} from "./init-config.js";
import type { ToolStatus } from "./init-config.js";

import {
  getMcpEnabledPreference,
  getHooksEnabledPreference,
  setMcpEnabledPreference,
  setHooksEnabledPreference,
  writeInstallPreferences,
  readInstallPreferences,
} from "./init-preferences.js";

import {
  ensureGovernanceFiles,
  migrateRootFiles,
  runPostInitVerify,
  applyStarterTemplateUpdates,
  listTemplates,
  applyTemplate,
  bootstrapFromExisting,
  updateMachinesYaml,
} from "./init-setup.js";

import { DEFAULT_CORTEX_PATH, STARTER_DIR, VERSION, log, confirmPrompt } from "./init-shared.js";

export type McpMode = "on" | "off";

interface HookEntry {
  matcher?: string;
  hooks?: Array<{ type?: string; command?: string; timeout?: number }>;
}

function parseVersion(version: string): { major: number; minor: number; patch: number; pre: string } {
  const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?/);
  if (!match) return { major: 0, minor: 0, patch: 0, pre: "" };
  return {
    major: Number.parseInt(match[1], 10) || 0,
    minor: Number.parseInt(match[2], 10) || 0,
    patch: Number.parseInt(match[3], 10) || 0,
    pre: match[4] || "",
  };
}

/**
 * Compare two semver strings. Returns true when `current` is strictly newer
 * than `previous`. Pre-release versions (e.g. 1.2.3-rc.1) sort before the
 * corresponding release (1.2.3). Among pre-release tags, comparison is
 * lexicographic.
 */
export function isVersionNewer(current: string, previous?: string): boolean {
  if (!previous) return false;
  const c = parseVersion(current);
  const p = parseVersion(previous);
  if (c.major !== p.major) return c.major > p.major;
  if (c.minor !== p.minor) return c.minor > p.minor;
  if (c.patch !== p.patch) return c.patch > p.patch;
  if (c.pre && !p.pre) return false;
  if (!c.pre && p.pre) return true;
  return c.pre > p.pre;
}

export function parseMcpMode(raw?: string): McpMode | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "on" || normalized === "off") return normalized;
  return undefined;
}

export interface InitOptions {
  machine?: string;
  profile?: string;
  mcp?: McpMode;
  applyStarterUpdate?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  fromExisting?: string;
  template?: string;
  /** Set by walkthrough to pass project name to init logic */
  _walkthroughProject?: string;
}

// Interactive walkthrough for first-time init
async function runWalkthrough(): Promise<{ machine: string; profile: string; mcp: McpMode; projectName?: string }> {
  const readline = await import("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> => new Promise(r => rl.question(q, r));

  log("\nWelcome to cortex. Let's set up persistent memory for your AI agents.\n");

  const defaultMachine = os.hostname();
  const machineAnswer = (await ask(`Machine name [${defaultMachine}]: `)).trim();
  const machine = machineAnswer || defaultMachine;

  const profileAnswer = (await ask(`Profile name [personal]: `)).trim();
  const profile = profileAnswer || "personal";

  log("\nMCP mode lets your AI agent call cortex tools directly (search, backlog, findings).");
  log("This is the recommended setup and works with Claude Code, Cursor, Copilot CLI, and Codex.");
  log("Hooks-only mode injects context into prompts instead (works with any agent, but read-only).");
  const mcpAnswer = (await ask(`Enable MCP? [Y/n]: `)).trim().toLowerCase();
  const mcp: McpMode = (mcpAnswer === "n" || mcpAnswer === "no") ? "off" : "on";

  const projectAnswer = (await ask(`\nFirst project name (or press Enter to use "my-first-project"): `)).trim();
  if (projectAnswer && !isValidProjectName(projectAnswer)) {
    log(`Invalid project name "${projectAnswer}". Avoid path separators, "..", and null bytes.`);
    rl.close();
    process.exit(1);
  }
  const projectName = projectAnswer || undefined;

  rl.close();

  log("");
  return { machine, profile, mcp, projectName };
}

export async function runInit(opts: InitOptions = {}) {
  const cortexPath = process.env.CORTEX_PATH || DEFAULT_CORTEX_PATH;
  const dryRun = Boolean(opts.dryRun);
  const existing = fs.existsSync(cortexPath);
  const existingEntries = existing ? fs.readdirSync(cortexPath) : [];
  const hasExistingInstall = existing && existingEntries.length > 0;

  // Interactive walkthrough for first-time installs (skip with --yes or non-TTY)
  if (!hasExistingInstall && !dryRun && !opts.yes && process.stdin.isTTY && process.stdout.isTTY) {
    const answers = await runWalkthrough();
    opts.machine = opts.machine || answers.machine;
    opts.profile = opts.profile || answers.profile;
    opts.mcp = opts.mcp || answers.mcp;
    if (answers.projectName) {
      opts._walkthroughProject = answers.projectName;
    }
  }

  const mcpEnabled = opts.mcp ? opts.mcp === "on" : getMcpEnabledPreference(cortexPath);
  const hooksEnabled = getHooksEnabledPreference(cortexPath);
  const mcpLabel = mcpEnabled ? "ON (recommended)" : "OFF (hooks-only fallback)";
  const hooksLabel = hooksEnabled ? "ON (active)" : "OFF (disabled)";

  if (dryRun) {
    log("\nInit dry run. No files will be written.\n");
    if (hasExistingInstall) {
      log(`cortex install detected at ${cortexPath}`);
      log(`Would update configuration for the existing install:\n`);
      log(`  MCP mode: ${mcpLabel}`);
      log(`  Hooks mode: ${hooksLabel}`);
      log(`  Reconfigure Claude Code MCP/hooks`);
      log(`  Reconfigure VS Code, Cursor, Copilot CLI, and Codex MCP targets`);
      if (hooksEnabled) {
        log(`  Reconfigure lifecycle hooks for detected tools`);
      }
      if (opts.applyStarterUpdate) {
        log(`  Apply starter template updates to global/CLAUDE.md and global skills`);
      }
      log(`  Run post-init verification checks`);
      log(`\nDry run complete.\n`);
      return;
    }

    log(`No existing cortex install found at ${cortexPath}`);
    log(`Would create a new cortex install:\n`);
    log(`  Copy starter files to ${cortexPath} (or create minimal structure)`);
    log(`  Update machines.yaml for machine "${opts.machine || os.hostname()}"`);
    log(`  Create/update config files`);
    log(`  MCP mode: ${mcpLabel}`);
    log(`  Hooks mode: ${hooksLabel}`);
    log(`  Configure Claude Code plus detected MCP targets (VS Code/Cursor/Copilot/Codex)`);
    if (hooksEnabled) {
      log(`  Configure lifecycle hooks for detected tools`);
    }
    log(`  Write install preferences and run post-init verification checks`);
    log(`\nDry run complete.\n`);
    return;
  }

  if (hasExistingInstall) {
      ensureGovernanceFiles(cortexPath);
      const migrated = migrateRootFiles(cortexPath);
      log(`\ncortex already exists at ${cortexPath}`);
      log(`Updating configuration...\n`);
      if (migrated.length) {
        log(`  Cleaned up root directory (${migrated.length} file${migrated.length === 1 ? "" : "s"} moved)`);
      }
      log(`  MCP mode: ${mcpLabel}`);
      log(`  Hooks mode: ${hooksLabel}`);

      // Confirmation prompt before writing config
      if (!opts.yes) {
        const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
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
      try {
        const status = configureClaude(cortexPath, { mcpEnabled, hooksEnabled });
        if (status === "disabled" || status === "already_disabled") {
          log(`  Updated Claude Code hooks (MCP disabled)`);
        } else {
          log(`  Updated Claude Code MCP + hooks`);
        }
      } catch (e) {
        log(`  Could not configure Claude Code settings (${e}), add manually`);
      }

      try {
        const vscodeResult = configureVSCode(cortexPath, { mcpEnabled });
        logMcpTargetStatus("VS Code", vscodeResult, "Updated");
      } catch (err: unknown) {
        debugLog(`configureVSCode failed: ${errorMessage(err)}`);
      }

      try {
        logMcpTargetStatus("Cursor", configureCursorMcp(cortexPath, { mcpEnabled }), "Updated");
      } catch (err: unknown) {
        debugLog(`configureCursorMcp failed: ${errorMessage(err)}`);
      }

      try {
        logMcpTargetStatus("Copilot CLI", configureCopilotMcp(cortexPath, { mcpEnabled }), "Updated");
      } catch (err: unknown) {
        debugLog(`configureCopilotMcp failed: ${errorMessage(err)}`);
      }

      try {
        logMcpTargetStatus("Codex", configureCodexMcp(cortexPath, { mcpEnabled }), "Updated");
      } catch (err: unknown) {
        debugLog(`configureCodexMcp failed: ${errorMessage(err)}`);
      }

      if (hooksEnabled) {
        try {
          const hooked = configureAllHooks(cortexPath);
          if (hooked.length) log(`  Updated hooks: ${hooked.join(", ")}`);
        } catch (err: unknown) { debugLog(`configureAllHooks failed: ${errorMessage(err)}`); }
      } else {
        log(`  Hooks are disabled by preference (run: npx @alaarab/cortex hooks-mode on)`);
      }

      const prefs = readInstallPreferences(cortexPath);
      const previousVersion = prefs.installedVersion;
      if (isVersionNewer(VERSION, previousVersion)) {
        log(`\n  Starter template update available: v${previousVersion} -> v${VERSION}`);
        log(`  Run \`npx @alaarab/cortex init --apply-starter-update\` to refresh global/CLAUDE.md and global skills.`);
      }
      if (opts.applyStarterUpdate) {
        const updated = applyStarterTemplateUpdates(cortexPath);
        if (updated.length) {
          log(`  Applied starter template updates (${updated.length} file${updated.length === 1 ? "" : "s"}).`);
        } else {
          log(`  No starter template updates were applied (starter files not found).`);
        }
      }
      writeInstallPreferences(cortexPath, { mcpEnabled, hooksEnabled, installedVersion: VERSION });

      // Post-update verification
      log(`\nVerifying setup...`);
      const verify = runPostInitVerify(cortexPath);
      for (const check of verify.checks) {
        log(`  ${check.ok ? "pass" : "FAIL"} ${check.name}: ${check.detail}`);
      }

      if (opts.fromExisting) {
        try {
          const projectName = bootstrapFromExisting(cortexPath, opts.fromExisting);
          log(`\nBootstrapped project "${projectName}" from ${opts.fromExisting}`);
        } catch (e: any) {
          log(`\nCould not bootstrap from existing: ${e.message}`);
        }
      }

      log(`\ncortex updated successfully`);
      log(`\nNext steps:`);
      log(`  1. Start a new Claude session -- hooks are now active`);
      log(`  2. Run \`cortex doctor\` to verify everything is wired correctly`);
      log(``);
      return;
  }

  log("\nSetting up cortex...\n");

  const walkthroughProject = opts._walkthroughProject;
  if (walkthroughProject) {
    if (!walkthroughProject.trim()) {
      console.error("Error: project name cannot be empty.");
      process.exit(1);
    }
    if (walkthroughProject.length > 100) {
      console.error("Error: project name must be 100 characters or fewer.");
      process.exit(1);
    }
    if (!isValidProjectName(walkthroughProject)) {
      console.error(`Error: invalid project name "${walkthroughProject}". Use lowercase letters, numbers, and hyphens.`);
      process.exit(1);
    }
  }
  const firstProjectName = walkthroughProject || "my-first-project";

  // Copy bundled starter to ~/.cortex
  function copyDir(src: string, dest: string) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        copyDir(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  if (fs.existsSync(STARTER_DIR)) {
    copyDir(STARTER_DIR, cortexPath);
    // Rename the default project dir if the user chose a custom name via walkthrough
    if (walkthroughProject && walkthroughProject !== "my-first-project") {
      const defaultDir = path.join(cortexPath, "my-first-project");
      const customDir = path.join(cortexPath, walkthroughProject);
      if (fs.existsSync(defaultDir) && !fs.existsSync(customDir)) {
        fs.renameSync(defaultDir, customDir);
        // Update profile to reference the new project name
        const profilesDir = path.join(cortexPath, "profiles");
        if (fs.existsSync(profilesDir)) {
          for (const pf of fs.readdirSync(profilesDir)) {
            const pfPath = path.join(profilesDir, pf);
            if (!pf.endsWith(".yaml")) continue;
            const content = fs.readFileSync(pfPath, "utf8");
            if (content.includes("my-first-project")) {
              fs.writeFileSync(pfPath, content.replace(/my-first-project/g, walkthroughProject));
            }
          }
        }
      }
    }
    if (opts.template) {
      const targetProject = walkthroughProject || firstProjectName;
      const projectDir = path.join(cortexPath, targetProject);
      if (applyTemplate(projectDir, opts.template, targetProject)) {
        log(`  Applied "${opts.template}" template to ${targetProject}`);
      } else {
        log(`  Template "${opts.template}" not found. Available: ${listTemplates().join(", ") || "none"}`);
      }
    }
    log(`  Created cortex v${VERSION} \u2192 ${cortexPath}`);
  } else {
    log(`  Starter not found in package, creating minimal structure...`);
    fs.mkdirSync(path.join(cortexPath, "global", "skills"), { recursive: true });
    fs.mkdirSync(path.join(cortexPath, "profiles"), { recursive: true });
    fs.mkdirSync(path.join(cortexPath, firstProjectName), { recursive: true });
    fs.writeFileSync(
      path.join(cortexPath, "global", "CLAUDE.md"),
      `# Global Context\n\nThis file is loaded in every project.\n\n## General preferences\n\n<!-- Your coding style, preferred tools, things Claude should always know -->\n`
    );
    fs.writeFileSync(
      path.join(cortexPath, firstProjectName, "summary.md"),
      `# ${firstProjectName}\n\n**What:** Replace this with one sentence about what the project does\n**Stack:** The key tech\n**Status:** active\n**Run:** the command you use most\n**Watch out:** the one thing that will bite you if you forget\n`
    );
    fs.writeFileSync(
      path.join(cortexPath, firstProjectName, "CLAUDE.md"),
      `# ${firstProjectName}\n\nOne paragraph about what this project is.\n\n## Commands\n\n\`\`\`bash\n# Install:\n# Run:\n# Test:\n\`\`\`\n`
    );
    fs.writeFileSync(
      path.join(cortexPath, firstProjectName, "FINDINGS.md"),
      `# ${firstProjectName} FINDINGS\n\n<!-- Findings are captured automatically during sessions and committed on exit -->\n`
    );
    fs.writeFileSync(
      path.join(cortexPath, firstProjectName, "backlog.md"),
      `# ${firstProjectName} backlog\n\n## Active\n\n## Queue\n\n## Done\n`
    );
    const profileName = opts.profile || "personal";
    fs.writeFileSync(
      path.join(cortexPath, "profiles", `${profileName}.yaml`),
      `name: ${profileName}\ndescription: Default profile\nprojects:\n  - global\n  - ${firstProjectName}\n`
    );
  }

  // Update machines.yaml with hostname (--machine overrides auto-detected hostname)
  const effectiveMachine = opts.machine || os.hostname();
  updateMachinesYaml(cortexPath, opts.machine, opts.profile);
  ensureGovernanceFiles(cortexPath);
  log(`  Updated machines.yaml with hostname "${effectiveMachine}"`);
  log(`  MCP mode: ${mcpLabel}`);
  log(`  Hooks mode: ${hooksLabel}`);

  // Confirmation prompt before writing agent config
  if (!opts.yes) {
    const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
    log(`\nWill modify:`);
    log(`  ${settingsPath}  (add MCP server + hooks)`);

    const confirmed = await confirmPrompt("\nProceed?");
    if (!confirmed) {
      log("Aborted.");
      return;
    }
  }

  // Configure Claude Code
  try {
    const status = configureClaude(cortexPath, { mcpEnabled, hooksEnabled });
    if (status === "disabled" || status === "already_disabled") {
      log(`  Configured Claude Code hooks (MCP disabled)`);
    } else {
      log(`  Configured Claude Code MCP + hooks`);
    }
  } catch (e) {
    log(`  Could not configure Claude Code settings (${e}), add manually`);
  }

  // Configure VS Code
  try {
    const vscodeResult = configureVSCode(cortexPath, { mcpEnabled });
    logMcpTargetStatus("VS Code", vscodeResult, "Configured");
  } catch (err: unknown) {
    debugLog(`configureVSCode failed: ${errorMessage(err)}`);
  }

  try {
    logMcpTargetStatus("Cursor", configureCursorMcp(cortexPath, { mcpEnabled }), "Configured");
  } catch (err: unknown) {
    debugLog(`configureCursorMcp failed: ${errorMessage(err)}`);
  }

  try {
    logMcpTargetStatus("Copilot CLI", configureCopilotMcp(cortexPath, { mcpEnabled }), "Configured");
  } catch (err: unknown) {
    debugLog(`configureCopilotMcp failed: ${errorMessage(err)}`);
  }

  try {
    logMcpTargetStatus("Codex", configureCodexMcp(cortexPath, { mcpEnabled }), "Configured");
  } catch (err: unknown) {
    debugLog(`configureCodexMcp failed: ${errorMessage(err)}`);
  }

  // Configure hooks for other detected AI coding tools (Copilot CLI, Cursor, Codex)
  if (hooksEnabled) {
    try {
      const hooked = configureAllHooks(cortexPath);
      if (hooked.length) log(`  Configured hooks: ${hooked.join(", ")}`);
    } catch (err: unknown) { debugLog(`configureAllHooks failed: ${errorMessage(err)}`); }
  } else {
    log(`  Hooks are disabled by preference (run: npx @alaarab/cortex hooks-mode on)`);
  }

  writeInstallPreferences(cortexPath, { mcpEnabled, hooksEnabled, installedVersion: VERSION });

  // Post-init verification
  log(`\nVerifying setup...`);
  const verify = runPostInitVerify(cortexPath);
  for (const check of verify.checks) {
    log(`  ${check.ok ? "pass" : "FAIL"} ${check.name}: ${check.detail}`);
  }

  log(`\nWhat was created:`);
  log(`  ${cortexPath}/global/CLAUDE.md    Global instructions loaded in every session`);
  log(`  ${cortexPath}/global/skills/      Cortex slash commands`);
  log(`  ${cortexPath}/profiles/           Machine-to-project mappings`);
  log(`  ${cortexPath}/.governance/        Memory quality settings and config`);

  log(`\ncortex initialized`);
  log(`\nNext steps:`);
  log(`  1. Create your first project:`);
  log(`     mkdir ${cortexPath}/my-project && touch ${cortexPath}/my-project/FINDINGS.md`);
  log(`  2. Start a new Claude session -- hooks are now active`);
  log(`  3. Run \`cortex doctor\` to verify everything is wired correctly`);
  log(`  4. Create a private GitHub repo and push your cortex:`);
  log(`     cd ${cortexPath}`);
  log(`     git init && git add . && git commit -m "Initial cortex setup"`);
  log(`     git remote add origin git@github.com:YOUR_USERNAME/cortex.git`);
  log(`     git push -u origin main`);
  if (!mcpEnabled) {
    log(`  5. Turn MCP on later: npx @alaarab/cortex mcp-mode on`);
  }
  log(`\n  Read ${cortexPath}/README.md for a guided tour of each file.`);

  if (opts.fromExisting) {
    try {
      const projectName = bootstrapFromExisting(cortexPath, opts.fromExisting);
      log(`\nBootstrapped project "${projectName}" from ${opts.fromExisting}`);
      log(`  ${cortexPath}/${projectName}/CLAUDE.md`);
      log(`  ${cortexPath}/${projectName}/FINDINGS.md`);
      log(`  ${cortexPath}/${projectName}/backlog.md`);
      log(`  ${cortexPath}/${projectName}/summary.md`);
    } catch (e: any) {
      log(`\nCould not bootstrap from existing: ${e.message}`);
    }
  }

  log(``);
}

export async function runMcpMode(modeArg?: string) {
  const cortexPath = process.env.CORTEX_PATH || DEFAULT_CORTEX_PATH;
  const normalizedArg = modeArg?.trim().toLowerCase();
  if (!normalizedArg || normalizedArg === "status") {
    const current = getMcpEnabledPreference(cortexPath);
    const hooks = getHooksEnabledPreference(cortexPath);
    log(`MCP mode: ${current ? "on (recommended)" : "off (hooks-only fallback)"}`);
    log(`Hooks mode: ${hooks ? "on (active)" : "off (disabled)"}`);
    log(`Change mode: npx @alaarab/cortex mcp-mode on|off`);
    log(`Hooks toggle: npx @alaarab/cortex hooks-mode on|off`);
    return;
  }
  const mode = parseMcpMode(normalizedArg);
  if (!mode) {
    throw new Error(`Invalid mode "${modeArg}". Use: on | off | status`);
  }
  const enabled = mode === "on";
  setMcpEnabledPreference(cortexPath, enabled);

  let claudeStatus: ToolStatus = "no_settings";
  let vscodeStatus: ToolStatus = "no_vscode";
  let cursorStatus: ToolStatus = "no_cursor";
  let copilotStatus: ToolStatus = "no_copilot";
  let codexStatus: ToolStatus = "no_codex";
  try { claudeStatus = configureClaude(cortexPath, { mcpEnabled: enabled }) ?? claudeStatus; } catch (err: unknown) { debugLog(`mcp-mode: configureClaude failed: ${errorMessage(err)}`); }
  try { vscodeStatus = configureVSCode(cortexPath, { mcpEnabled: enabled }) ?? vscodeStatus; } catch (err: unknown) { debugLog(`mcp-mode: configureVSCode failed: ${errorMessage(err)}`); }
  try { cursorStatus = configureCursorMcp(cortexPath, { mcpEnabled: enabled }) ?? cursorStatus; } catch (err: unknown) { debugLog(`mcp-mode: configureCursorMcp failed: ${errorMessage(err)}`); }
  try { copilotStatus = configureCopilotMcp(cortexPath, { mcpEnabled: enabled }) ?? copilotStatus; } catch (err: unknown) { debugLog(`mcp-mode: configureCopilotMcp failed: ${errorMessage(err)}`); }
  try { codexStatus = configureCodexMcp(cortexPath, { mcpEnabled: enabled }) ?? codexStatus; } catch (err: unknown) { debugLog(`mcp-mode: configureCodexMcp failed: ${errorMessage(err)}`); }

  log(`MCP mode set to ${mode}.`);
  log(`Claude status: ${claudeStatus}`);
  log(`VS Code status: ${vscodeStatus}`);
  log(`Cursor status: ${cursorStatus}`);
  log(`Copilot CLI status: ${copilotStatus}`);
  log(`Codex status: ${codexStatus}`);
  log(`Restart your agent to apply changes.`);
}

export async function runHooksMode(modeArg?: string) {
  const cortexPath = process.env.CORTEX_PATH || DEFAULT_CORTEX_PATH;
  const normalizedArg = modeArg?.trim().toLowerCase();
  if (!normalizedArg || normalizedArg === "status") {
    const current = getHooksEnabledPreference(cortexPath);
    log(`Hooks mode: ${current ? "on (active)" : "off (disabled)"}`);
    log(`Change mode: npx @alaarab/cortex hooks-mode on|off`);
    return;
  }
  const mode = parseMcpMode(normalizedArg);
  if (!mode) {
    throw new Error(`Invalid mode "${modeArg}". Use: on | off | status`);
  }

  const enabled = mode === "on";
  setHooksEnabledPreference(cortexPath, enabled);

  let claudeStatus: ToolStatus = "no_settings";
  try {
    claudeStatus = configureClaude(cortexPath, {
      mcpEnabled: getMcpEnabledPreference(cortexPath),
      hooksEnabled: enabled,
    }) ?? claudeStatus;
  } catch (err: unknown) { debugLog(`hooks-mode: configureClaude failed: ${errorMessage(err)}`); }

  if (enabled) {
    try {
      const hooked = configureAllHooks(cortexPath);
      if (hooked.length) log(`Updated hooks: ${hooked.join(", ")}`);
    } catch (err: unknown) { debugLog(`hooks-mode: configureAllHooks failed: ${errorMessage(err)}`); }
  } else {
    log("Hooks will no-op immediately via preference and Claude hooks are removed.");
  }

  log(`Hooks mode set to ${mode}.`);
  log(`Claude status: ${claudeStatus}`);
  log(`Restart your agent to apply changes.`);
}

export async function runUninstall() {
  log("\nUninstalling cortex...\n");

  const home = os.homedir();
  const settingsPath = path.join(home, ".claude", "settings.json");

  // Remove from Claude Code ~/.claude.json (where MCP servers are actually read)
  const claudeJsonPath = path.join(home, ".claude.json");
  if (fs.existsSync(claudeJsonPath)) {
    try {
      if (removeMcpServerAtPath(claudeJsonPath)) {
        log(`  Removed cortex MCP server from ~/.claude.json`);
      }
    } catch (e) {
      log(`  Warning: could not update ~/.claude.json (${e})`);
    }
  }

  // Remove from Claude Code settings.json
  if (fs.existsSync(settingsPath)) {
    try {
      patchJsonFile(settingsPath, (data) => {
        // Remove MCP server
        if (data.mcpServers?.cortex) {
          delete data.mcpServers.cortex;
          log(`  Removed cortex MCP server from Claude Code settings`);
        }

        // Remove hooks containing cortex references
        for (const hookEvent of ["UserPromptSubmit", "Stop", "SessionStart"] as const) {
          const hooks = data.hooks?.[hookEvent] as HookEntry[] | undefined;
          if (!Array.isArray(hooks)) continue;
          const before = hooks.length;
          data.hooks[hookEvent] = hooks.filter(
            (h: HookEntry) => !h.hooks?.some(
              (hook) => typeof hook.command === "string" && isCortexCommand(hook.command)
            )
          );
          const removed = before - (data.hooks[hookEvent] as HookEntry[]).length;
          if (removed > 0) log(`  Removed ${removed} cortex hook(s) from ${hookEvent}`);
        }
      });
    } catch (e) {
      log(`  Warning: could not update Claude Code settings (${e})`);
    }
  } else {
    log(`  Claude Code settings not found at ${settingsPath} — skipping`);
  }

  // Remove from VS Code mcp.json
  const vsCandidates = [
    path.join(home, ".config", "Code", "User", "mcp.json"),
    path.join(home, "Library", "Application Support", "Code", "User", "mcp.json"),
    path.join(home, "AppData", "Roaming", "Code", "User", "mcp.json"),
  ];
  for (const mcpFile of vsCandidates) {
    try {
      if (removeMcpServerAtPath(mcpFile)) {
        log(`  Removed cortex from VS Code MCP config (${mcpFile})`);
      }
    } catch (err: unknown) { debugLog(`uninstall: cleanup failed for ${mcpFile}: ${errorMessage(err)}`); }
  }

  // Remove from Cursor MCP config
  const cursorCandidates = [
    path.join(home, ".cursor", "mcp.json"),
    path.join(home, ".config", "Cursor", "User", "mcp.json"),
    path.join(home, "Library", "Application Support", "Cursor", "User", "mcp.json"),
    path.join(home, "AppData", "Roaming", "Cursor", "User", "mcp.json"),
  ];
  for (const mcpFile of cursorCandidates) {
    try {
      if (removeMcpServerAtPath(mcpFile)) {
        log(`  Removed cortex from Cursor MCP config (${mcpFile})`);
      }
    } catch (err: unknown) { debugLog(`uninstall: cleanup failed for ${mcpFile}: ${errorMessage(err)}`); }
  }

  // Remove from Copilot CLI MCP config
  const copilotCandidates = [
    path.join(home, ".copilot", "mcp-config.json"),
    path.join(home, ".github", "mcp.json"),
    path.join(home, ".config", "github-copilot", "mcp.json"),
    path.join(home, "Library", "Application Support", "github-copilot", "mcp.json"),
    path.join(home, "AppData", "Roaming", "github-copilot", "mcp.json"),
  ];
  for (const mcpFile of copilotCandidates) {
    try {
      if (removeMcpServerAtPath(mcpFile)) {
        log(`  Removed cortex from Copilot CLI MCP config (${mcpFile})`);
      }
    } catch (err: unknown) { debugLog(`uninstall: cleanup failed for ${mcpFile}: ${errorMessage(err)}`); }
  }

  // Remove from Codex MCP config (TOML + JSON)
  const codexToml = path.join(home, ".codex", "config.toml");
  try {
    if (removeTomlMcpServer(codexToml)) {
      log(`  Removed cortex from Codex MCP config (${codexToml})`);
    }
  } catch (err: unknown) { debugLog(`uninstall: cleanup failed for ${codexToml}: ${errorMessage(err)}`); }

  const codexCandidates = [
    path.join(home, ".codex", "config.json"),
    path.join(home, ".codex", "mcp.json"),
    path.join(process.env.CORTEX_PATH || DEFAULT_CORTEX_PATH, "codex.json"),
  ];
  for (const mcpFile of codexCandidates) {
    try {
      if (removeMcpServerAtPath(mcpFile)) {
        log(`  Removed cortex from Codex MCP config (${mcpFile})`);
      }
    } catch (err: unknown) { debugLog(`uninstall: cleanup failed for ${mcpFile}: ${errorMessage(err)}`); }
  }

  log(`\nCortex hooks and MCP config removed.`);
  log(`\nYour knowledge base at ~/.cortex was NOT deleted.`);
  log(`To fully remove it, run: rm -rf ~/.cortex\n`);
  log(`Restart your agent(s) to apply changes.\n`);
}
