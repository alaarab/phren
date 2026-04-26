/**
 * CLI orchestrator for phren init, mcp-mode, hooks-mode, and uninstall.
 * Delegates to focused helpers in init-config, init-setup, init-preferences,
 * init-walkthrough, init-mcp-mode, init-hooks-mode, and init-uninstall.
 */
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { getMachineName, persistMachineName } from "../machine-identity.js";
import {
  atomicWriteText,
  debugLog,
  expandHomePath,
  writeRootManifest,
  type InstallMode,
} from "../shared.js";
import { isValidProjectName, errorMessage } from "../utils.js";
import { logger } from "../logger.js";

// Re-export everything consumers need from the helper modules
export type { McpConfigStatus, McpRootKey, ToolStatus, HookEntry, HookMap } from "./config.js";
export {
  configureClaude,
  configureVSCode,
  configureCursorMcp,
  configureCopilotMcp,
  configureCodexMcp,
  logMcpTargetStatus,
  resetVSCodeProbeCache,
  patchJsonFile,
} from "./config.js";

export type { InstallPreferences } from "./preferences.js";
export {
  getMcpEnabledPreference,
  setMcpEnabledPreference,
  getHooksEnabledPreference,
  setHooksEnabledPreference,
} from "./preferences.js";
export {
  PROJECT_OWNERSHIP_MODES,
  type ProjectOwnershipMode,
  parseProjectOwnershipMode,
  getProjectOwnershipDefault,
} from "../project-config.js";

export {
  PROACTIVITY_LEVELS,
  type ProactivityLevel,
  getProactivityLevel,
  getProactivityLevelForFindings,
  getProactivityLevelForTask,
} from "../proactivity.js";

export type { PostInitCheck, InitProjectDomain, InferredInitScaffold } from "./setup.js";
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
} from "./setup.js";

// Re-export from extracted modules so consumers can still import from init.js
export { configureMcpTargets, warmSemanticSearch, runProjectLocalInit } from "./init-configure.js";
export { runMcpMode } from "./init-mcp-mode.js";
export { runHooksMode } from "./init-hooks-mode.js";
export { runUninstall } from "./init-uninstall.js";

// Internal imports from extracted modules (used by runInit)
import {
  configureMcpTargets,
  configureHooksIfEnabled,
  applyOnboardingPreferences,
  writeWalkthroughEnvDefaults,
  collectRepairedAssetLabels,
  applyProjectStorageBindings,
  warmSemanticSearch,
  runProjectLocalInit,
} from "./init-configure.js";
import { runWalkthrough, createWalkthroughPrompts, createWalkthroughStyle } from "./init-walkthrough.js";
import { assertNoGlobalWiringConflict } from "./guard-globals.js";


import {
  getMcpEnabledPreference,
  getHooksEnabledPreference,
  writeInstallPreferences,
  readInstallPreferences,
} from "./preferences.js";

import {
  ensureGovernanceFiles,
  repairPreexistingInstall,
  runPostInitVerify,
  applyStarterTemplateUpdates,
  listTemplates,
  applyTemplate,
  ensureProjectScaffold,
  ensureLocalGitRepo,
  bootstrapFromExisting,
  updateMachinesYaml,
  detectProjectDir,
  isProjectTracked,
  type InitProjectDomain,
  type InferredInitScaffold,
} from "./setup.js";

import { DEFAULT_PHREN_PATH, STARTER_DIR, VERSION, log, type McpMode } from "./shared.js";
import {
  PROJECT_OWNERSHIP_MODES,
  type ProjectOwnershipMode,
  getProjectOwnershipDefault,
} from "../project-config.js";
import { type ProactivityLevel } from "../proactivity.js";
import { getWorkflowPolicy } from "../shared/governance.js";
import { addProjectToProfile } from "../profile-store.js";

export { type McpMode, parseMcpMode } from "./shared.js";
type StorageLocationChoice = "global" | "project" | "custom";
type SkillsScope = "global" | "project";

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

export interface InitOptions {
  mode?: InstallMode;
  machine?: string;
  profile?: string;
  mcp?: McpMode;
  hooks?: McpMode;
  projectOwnershipDefault?: ProjectOwnershipMode;
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
  /**
   * Allow init to repoint global wiring (~/.local/bin/phren wrapper and
   * Claude settings.json hooks/mcpServers.phren) at a different phren root
   * than the one currently in use. Without this, init refuses when an
   * existing global file references a different valid phren root — protects
   * against tests/smoke runs that forget to sandbox $HOME.
   */
  force?: boolean;
  // Built-in template names are directory-based under starter/templates/.
  // Keep string-compatible so custom package templates continue to work.
  template?: "python-project" | "monorepo" | "library" | "frontend" | string;
  /** Set by walkthrough to pass project name to init logic */
  _walkthroughProject?: string;
  /** Set by walkthrough for personalized GitHub next-steps output */
  _walkthroughGithub?: { username?: string; repo: string };
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

function normalizedBootstrapProjectName(projectPath: string): string {
  return path.basename(projectPath).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
}

export function getPendingBootstrapTarget(phrenPath: string, _opts: InitOptions): { path: string; mode: "explicit" | "detected" } | null {
  const cwdProject = detectProjectDir(process.cwd(), phrenPath);
  if (!cwdProject) return null;
  const projectName = normalizedBootstrapProjectName(cwdProject);
  if (isProjectTracked(phrenPath, projectName)) return null;
  return { path: cwdProject, mode: "detected" };
}

function hasInstallMarkers(phrenPath: string): boolean {
  // Require at least two markers to consider this a real install.
  // A partial clone or failed init may create one directory but not finish.
  if (!fs.existsSync(phrenPath)) return false;
  let found = 0;
  if (fs.existsSync(path.join(phrenPath, "machines.yaml"))) found++;
  if (fs.existsSync(path.join(phrenPath, ".config"))) found++;
  if (fs.existsSync(path.join(phrenPath, "global"))) found++;
  return found >= 2;
}

function resolveInitPhrenPath(opts: InitOptions): string {
  const raw = opts._walkthroughStoragePath || (process.env.PHREN_PATH) || DEFAULT_PHREN_PATH;
  return path.resolve(expandHomePath(raw));
}

export async function runInit(opts: InitOptions = {}) {
  if ((opts.mode || "shared") === "project-local") {
    await runProjectLocalInit(opts);
    return;
  }
  let phrenPath = resolveInitPhrenPath(opts);
  const dryRun = Boolean(opts.dryRun);

  if (!dryRun) {
    assertNoGlobalWiringConflict(phrenPath, Boolean(opts.force));
  }

  // Migrate the legacy hidden store directory into ~/.phren when upgrading
  // from the previous product name. Only runs when the resolved phrenPath
  // doesn't exist yet but the legacy directory does.
  if (!opts._walkthroughStoragePath && !fs.existsSync(phrenPath)) {
    // Pre-rebrand directory name — kept as literal for migration
    const legacyPath = path.resolve((await import("../shared.js")).homePath(".cortex"));
    if (legacyPath !== phrenPath && fs.existsSync(legacyPath) && hasInstallMarkers(legacyPath)) {
      if (!dryRun) {
        fs.renameSync(legacyPath, phrenPath);
      }
      console.log(`Migrated legacy store → ~/.phren`);
    }
  }

  // Rename stale legacy skill names left over from the rebrand. Runs on every
  // init so users who already migrated the directory still get the fix.
  const skillsMigrateDir = path.join(phrenPath, "global", "skills");
  if (!dryRun && fs.existsSync(skillsMigrateDir)) {
    const legacySkillName = "cortex.md";
    const legacySkillPrefix = "cortex-";
    for (const entry of fs.readdirSync(skillsMigrateDir)) {
      if (!entry.endsWith(".md")) continue;
      if (entry === legacySkillName) {
        const dest = path.join(skillsMigrateDir, "phren.md");
        if (!fs.existsSync(dest)) {
          fs.renameSync(path.join(skillsMigrateDir, entry), dest);
        }
      } else if (entry.startsWith(legacySkillPrefix)) {
        const newName = `phren-${entry.slice(legacySkillPrefix.length)}`;
        const dest = path.join(skillsMigrateDir, newName);
        if (!fs.existsSync(dest)) {
          fs.renameSync(path.join(skillsMigrateDir, entry), dest);
        }
      }
    }
  }

  let hasExistingInstall = hasInstallMarkers(phrenPath);

  // Interactive walkthrough for first-time installs (skip with --yes or non-TTY)
  // --express bypasses the TTY check since it skips all interactive prompts
  const isTTY = process.stdin.isTTY && process.stdout.isTTY;
  if (!hasExistingInstall && !dryRun && !opts.yes && (isTTY || opts.express)) {
    const answers = await runWalkthrough(phrenPath, { express: opts.express });
    opts._walkthroughStorageChoice = answers.storageChoice;
    opts._walkthroughStoragePath = answers.storagePath;
    opts._walkthroughStorageRepoRoot = answers.storageRepoRoot;
    phrenPath = resolveInitPhrenPath(opts);
    hasExistingInstall = hasInstallMarkers(phrenPath);
    opts.machine = opts.machine || answers.machine;
    opts.profile = opts.profile || answers.profile;
    opts.mcp = opts.mcp || answers.mcp;
    opts.hooks = opts.hooks || answers.hooks;
    opts.projectOwnershipDefault = opts.projectOwnershipDefault || answers.projectOwnershipDefault;
    opts.findingsProactivity = opts.findingsProactivity || answers.findingsProactivity;
    opts.taskProactivity = opts.taskProactivity || answers.taskProactivity;
    if (typeof opts.lowConfidenceThreshold !== "number") opts.lowConfidenceThreshold = answers.lowConfidenceThreshold;
    if (!Array.isArray(opts.riskySections)) opts.riskySections = answers.riskySections;
    opts.taskMode = opts.taskMode || answers.taskMode;
    if (answers.cloneUrl) {
      opts._walkthroughCloneUrl = answers.cloneUrl;
    }
    if (answers.githubRepo) {
      opts._walkthroughGithub = { username: answers.githubUsername, repo: answers.githubRepo };
    }
    opts._walkthroughDomain = answers.domain;
    if (answers.inferredScaffold) {
      opts._walkthroughInferredScaffold = answers.inferredScaffold;
    }
    if (!answers.ollamaEnabled) {
      // User explicitly declined Ollama — note it but don't set env (they can set it themselves)
      process.env._PHREN_WALKTHROUGH_OLLAMA_SKIP = "1";
    } else {
      opts._walkthroughSemanticSearch = true;
    }
    // Persist the walkthrough choice so init writes an explicit .env default.
    opts._walkthroughAutoCapture = answers.autoCaptureEnabled;
    if (answers.semanticDedupEnabled) {
      opts._walkthroughSemanticDedup = true;
    }
    if (answers.semanticConflictEnabled) {
      opts._walkthroughSemanticConflict = true;
    }
    if (answers.findingSensitivity && answers.findingSensitivity !== "balanced") {
      opts.findingSensitivity = answers.findingSensitivity;
    }
    opts._walkthroughBootstrapCurrentProject = answers.bootstrapCurrentProject;
    opts._walkthroughBootstrapOwnership = answers.bootstrapOwnership;
  }

  // If the walkthrough provided a clone URL, clone it and treat as existing install
  if (opts._walkthroughCloneUrl) {
    log(`\nCloning existing phren from ${opts._walkthroughCloneUrl}...`);
    try {
      execFileSync("git", ["clone", opts._walkthroughCloneUrl, phrenPath], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
      });
      log(`  Cloned to ${phrenPath}`);
      // Re-check: the cloned repo should now be treated as an existing install
      hasExistingInstall = true;
    } catch (e: unknown) {
      log(`  Clone failed: ${e instanceof Error ? e.message : String(e)}`);
      log("");
      log("  ┌──────────────────────────────────────────────────────────────────┐");
      log("  │  WARNING: Sync is NOT configured. Your phren data is local-only. │");
      log("  │                                                                  │");
      log("  │  To fix later:                                                   │");
      log(`  │    cd ${phrenPath}`);
      log("  │    git remote add origin <YOUR_REPO_URL>                         │");
      log("  │    git push -u origin main                                       │");
      log("  └──────────────────────────────────────────────────────────────────┘");
      log("");
      log(`  Continuing with fresh local-only install.`);
    }
  }

  // Record sync intent: "sync" if a clone URL was provided (regardless of success), "local" otherwise.
  // On re-runs of existing installs, preserve the existing syncIntent unless the user provided a new clone URL.
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
  const mcpLabel = mcpEnabled ? "ON (recommended)" : "OFF (hooks-only fallback)";
  const hooksLabel = hooksEnabled ? "ON (active)" : "OFF (disabled)";
  const pendingBootstrap = getPendingBootstrapTarget(phrenPath, opts);
  let shouldBootstrapCurrentProject = opts._walkthroughBootstrapCurrentProject === true;
  let bootstrapOwnership = opts._walkthroughBootstrapOwnership ?? ownershipDefault;

  if (pendingBootstrap && !dryRun) {
    const walkthroughAlreadyHandled = opts._walkthroughBootstrapCurrentProject !== undefined;
    if (walkthroughAlreadyHandled) {
      shouldBootstrapCurrentProject = opts._walkthroughBootstrapCurrentProject === true;
      bootstrapOwnership = opts._walkthroughBootstrapOwnership ?? ownershipDefault;
    } else if (opts.yes || !process.stdin.isTTY || !process.stdout.isTTY) {
      shouldBootstrapCurrentProject = true;
      bootstrapOwnership = ownershipDefault;
    } else {
      const prompts = await createWalkthroughPrompts();
      const style = await createWalkthroughStyle();
      const detectedProjectName = path.basename(pendingBootstrap.path);
      log("");
      log(style.header("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
      log(style.header("Current Project"));
      log(style.header("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
      log(`Detected project: ${detectedProjectName}`);
      shouldBootstrapCurrentProject = await prompts.confirm("Add this project to phren now?", true);
      if (!shouldBootstrapCurrentProject) {
        shouldBootstrapCurrentProject = false;
        log(style.warning(`  Skipped. Later: cd ${pendingBootstrap.path} && phren add`));
      } else {
        bootstrapOwnership = await prompts.select<ProjectOwnershipMode>(
          "Ownership for detected project",
          [
            { value: ownershipDefault, name: `${ownershipDefault} (default)` },
            ...PROJECT_OWNERSHIP_MODES
              .filter((mode) => mode !== ownershipDefault)
              .map((mode) => ({ value: mode, name: mode })),
          ],
          ownershipDefault
        );
      }
    }
  }

  if (dryRun) {
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
    return;
  }

  if (storageChoice === "project") {
    if (!storageRepoRoot) {
      throw new Error("Per-project storage requires a detected repository root.");
    }
    const storageChanges = applyProjectStorageBindings(storageRepoRoot, phrenPath);
    for (const change of storageChanges) {
      log(`  Updated storage binding: ${change}`);
    }
  }

  if (hasExistingInstall) {
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

      if (pendingBootstrap && shouldBootstrapCurrentProject) {
        try {
          const created = bootstrapFromExisting(phrenPath, pendingBootstrap.path, {
            profile: opts.profile,
            ownership: bootstrapOwnership,
          });
          log(`\nAdded current project "${created.project}" (${created.ownership})`);
        } catch (e: unknown) {
          debugLog(`Bootstrap from CWD failed: ${e instanceof Error ? e.message : String(e)}`);
        }
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
      return;
  }

  log("\nSetting up phren...\n");

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

  // Determine if CWD is a project that should be bootstrapped instead of
  // creating a dummy "my-first-project".
  const cwdProjectPath = !walkthroughProject ? detectProjectDir(process.cwd(), phrenPath) : null;
  const useTemplateProject = Boolean(walkthroughProject) || Boolean(opts.template);
  const firstProjectName = walkthroughProject || "my-first-project";
  const firstProjectDomain: InitProjectDomain = opts._walkthroughDomain ?? "software";

  // Copy bundled starter to ~/.phren
  function copyDir(src: string, dest: string) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (src === STARTER_DIR && entry.isDirectory() && ["my-api", "my-frontend", "my-first-project"].includes(entry.name)) {
        continue;
      }
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
    copyDir(STARTER_DIR, phrenPath);
    writeRootManifest(phrenPath, {
      version: 1,
      installMode: "shared",
      syncMode: "managed-git",
    });
    if (useTemplateProject) {
      const targetProject = walkthroughProject || firstProjectName;
      const projectDir = path.join(phrenPath, targetProject);
      const templateApplied = Boolean(opts.template && applyTemplate(projectDir, opts.template, targetProject));
      if (templateApplied) {
        log(`  Applied "${opts.template}" template to ${targetProject}`);
      }
      ensureProjectScaffold(projectDir, targetProject, firstProjectDomain, opts._walkthroughInferredScaffold);

      const targetProfile = opts.profile || "default";
      const addToProfile = addProjectToProfile(phrenPath, targetProfile, targetProject);
      if (!addToProfile.ok) {
        debugLog(`fresh init addProjectToProfile failed for ${targetProfile}/${targetProject}: ${addToProfile.error}`);
      }

      if (opts.template && !templateApplied) {
        log(`  Template "${opts.template}" not found. Available: ${listTemplates().join(", ") || "none"}`);
      }
      log(`  Seeded project "${targetProject}"`);
    }
    log(`  Created phren v${VERSION} \u2192 ${phrenPath}`);
  } else {
    log(`  Starter not found in package, creating minimal structure...`);
    writeRootManifest(phrenPath, {
      version: 1,
      installMode: "shared",
      syncMode: "managed-git",
    });
    fs.mkdirSync(path.join(phrenPath, "global", "skills"), { recursive: true });
    fs.mkdirSync(path.join(phrenPath, "profiles"), { recursive: true });
    atomicWriteText(
      path.join(phrenPath, "global", "CLAUDE.md"),
      `# Global Context\n\nThis file is loaded in every project.\n\n## General preferences\n\n<!-- Your coding style, preferred tools, things Claude should always know -->\n`
    );
    if (useTemplateProject) {
      const projectDir = path.join(phrenPath, firstProjectName);
      if (opts.template && applyTemplate(projectDir, opts.template, firstProjectName)) {
        log(`  Applied "${opts.template}" template to ${firstProjectName}`);
      }
      ensureProjectScaffold(projectDir, firstProjectName, firstProjectDomain, opts._walkthroughInferredScaffold);
    }
    const profileName = opts.profile || "default";
    const profileProjects = useTemplateProject
      ? `  - global\n  - ${firstProjectName}`
      : `  - global`;
    atomicWriteText(
      path.join(phrenPath, "profiles", `${profileName}.yaml`),
      `name: ${profileName}\ndescription: Default profile\nprojects:\n${profileProjects}\n`
    );
  }

  // If CWD is a project dir, bootstrap it now when onboarding or defaults allow it.
  if (cwdProjectPath && shouldBootstrapCurrentProject) {
    try {
      const created = bootstrapFromExisting(phrenPath, cwdProjectPath, {
        profile: opts.profile,
        ownership: bootstrapOwnership,
      });
      log(`  Added current project "${created.project}" (${created.ownership})`);
    } catch (e: unknown) {
      // Fresh-install bootstrap is best-effort. If it fails, the install
      // still succeeded and the user can add the project explicitly later.
      debugLog(`Bootstrap from CWD during fresh install failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Persist the local machine alias and map it to the selected profile.
  const effectiveMachine = opts.machine?.trim() || getMachineName();
  persistMachineName(effectiveMachine);
  updateMachinesYaml(phrenPath, effectiveMachine, opts.profile);
  ensureGovernanceFiles(phrenPath);
  const repaired = repairPreexistingInstall(phrenPath);
  applyOnboardingPreferences(phrenPath, opts);
  const localGitRepo = ensureLocalGitRepo(phrenPath);
  log(`  Updated machines.yaml with machine "${effectiveMachine}"`);
  log(`  MCP mode: ${mcpLabel}`);
  log(`  Hooks mode: ${hooksLabel}`);
  log(`  Default project ownership: ${ownershipDefault}`);
  log(`  Task mode: ${getWorkflowPolicy(phrenPath).taskMode}`);
  log(`  Git repo: ${localGitRepo.detail}`);
  if (repaired.removedLegacyProjects > 0) {
    log(`  Removed ${repaired.removedLegacyProjects} legacy starter project entr${repaired.removedLegacyProjects === 1 ? "y" : "ies"} from profiles.`);
  }
  const repairedAssets = collectRepairedAssetLabels(repaired);
  if (repairedAssets.length > 0) {
    log(`  Recreated missing generated assets: ${repairedAssets.join(", ")}`);
  }

  // Configure MCP for all detected AI coding tools and hooks
  configureMcpTargets(phrenPath, { mcpEnabled, hooksEnabled }, "Configured");
  configureHooksIfEnabled(phrenPath, hooksEnabled, "Configured");

  writeInstallPreferences(phrenPath, { mcpEnabled, hooksEnabled, skillsScope, installedVersion: VERSION, syncIntent });

  // Post-init verification
  log(`\nVerifying setup...`);
  const verify = runPostInitVerify(phrenPath);
  for (const check of verify.checks) {
    log(`  ${check.ok ? "pass" : "FAIL"} ${check.name}: ${check.detail}`);
  }

  log(`\nWhat was created:`);
  log(`  ${phrenPath}/global/CLAUDE.md    Global instructions loaded in every session`);
  log(`  ${phrenPath}/global/skills/      Phren slash commands`);
  log(`  ${phrenPath}/profiles/           Machine-to-project mappings`);
  log(`  ${phrenPath}/.config/        Memory quality settings and config`);

  // Ollama status summary (skip if already covered in walkthrough)
  const walkthroughCoveredOllama = Boolean(process.env._PHREN_WALKTHROUGH_OLLAMA_SKIP) || (!hasExistingInstall && !opts.yes);
  if (!walkthroughCoveredOllama) {
    try {
      const { checkOllamaStatus } = await import("../shared/ollama.js");
      const status = await checkOllamaStatus();
      if (status === "ready") {
        log("\n  Semantic search: Ollama + nomic-embed-text ready.");
      } else if (status === "no_model") {
        log("\n  Semantic search: Ollama running, but nomic-embed-text not pulled.");
        log("  Run: ollama pull nomic-embed-text");
      } else if (status === "not_running") {
        log("\n  Tip: Install Ollama for semantic search (optional).");
        log("  https://ollama.com → then: ollama pull nomic-embed-text");
        log("  (Set PHREN_OLLAMA_URL=off to hide this message)");
      }
    } catch (err: unknown) {
      logger.debug("init", `init ollamaInstallHint: ${errorMessage(err)}`);
    }
  }

  for (const envLabel of writeWalkthroughEnvDefaults(phrenPath, opts)) {
    log(`  ${envLabel}`);
  }

  if (opts._walkthroughSemanticSearch) {
    log(`\nWarming semantic search...`);
    try {
      log(`  ${await warmSemanticSearch(phrenPath, opts.profile)}`);
    } catch (err: unknown) {
      log(`  Semantic search warmup failed: ${errorMessage(err)}`);
    }
  }

  log(`\n\x1b[95m◆\x1b[0m phren initialized`);
  log(`\nNext steps:`);
  let step = 1;
  log(`  ${step++}. Start a new Claude session in your project directory — phren injects context automatically`);
  log(`  ${step++}. Run \`phren doctor\` to verify everything is wired correctly`);
  log(`  ${step++}. Change defaults anytime: \`phren config project-ownership\`, \`phren config workflow\`, \`phren config proactivity.findings\`, \`phren config proactivity.tasks\``);

  const gh = opts._walkthroughGithub;
  if (gh) {
    const remote = gh.username
      ? `git@github.com:${gh.username}/${gh.repo}.git`
      : `git@github.com:YOUR_USERNAME/${gh.repo}.git`;
    log(`  ${step++}. Push your phren to GitHub (private repo recommended):`);
    log(`     cd ${phrenPath}`);
    log(`     git add . && git commit -m "Initial phren setup"`);
    if (gh.username) {
      log(`     gh repo create ${gh.username}/${gh.repo} --private --source=. --push`);
      log(`     # or manually: git remote add origin ${remote} && git push -u origin main`);
    } else {
      log(`     git remote add origin ${remote}`);
      log(`     git push -u origin main`);
    }
  } else {
    log(`  ${step++}. Push to GitHub for cross-machine sync (private repo recommended):`);
    log(`     cd ${phrenPath}`);
    log(`     git add . && git commit -m "Initial phren setup"`);
    log(`     git remote add origin git@github.com:YOUR_USERNAME/my-phren.git`);
    log(`     git push -u origin main`);
  }

  log(`  ${step++}. Add more projects: cd ~/your-project && phren add`);

  if (!mcpEnabled) {
    log(`  ${step++}. Turn MCP on: phren mcp-mode on`);
  }
  log(`  ${step++}. After your first week, run phren-discover to surface gaps in your project knowledge`);
  log(`  ${step++}. After working across projects, run phren-consolidate to find cross-project patterns`);
  log(`\n  Read ${phrenPath}/README.md for a guided tour of each file.`);

  log(``);
}
