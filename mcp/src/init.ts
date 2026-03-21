/**
 * CLI orchestrator for phren init, mcp-mode, hooks-mode, and uninstall.
 * Delegates to focused helpers in init-config, init-setup, and init-preferences.
 */
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { execFileSync } from "child_process";
import { configureAllHooks } from "./hooks.js";
import { getMachineName, persistMachineName } from "./machine-identity.js";
import {
  atomicWriteText,
  debugLog,
  hookConfigPath,
  homePath,
  expandHomePath,
  findPhrenPath,
  readRootManifest,
  writeRootManifest,
  type InstallMode,
} from "./shared.js";
import { isValidProjectName, errorMessage } from "./utils.js";

// Re-export everything consumers need from the helper modules
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

// Imports from helpers (used internally in this file)
import {
  configureClaude,
  configureVSCode,
  configureCursorMcp,
  configureCopilotMcp,
  configureCodexMcp,
  logMcpTargetStatus,
} from "./init-config.js";
import type { ToolStatus } from "./init-config.js";

import {
  getMcpEnabledPreference,
  getHooksEnabledPreference,
  setMcpEnabledPreference,
  setHooksEnabledPreference,
  writeInstallPreferences,
  writeGovernanceInstallPreferences,
  readInstallPreferences,
} from "./init-preferences.js";

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
  ensureGitignoreEntry,
  upsertProjectEnvVar,
  updateMachinesYaml,
  detectProjectDir,
  isProjectTracked,
  type InitProjectDomain,
  type InferredInitScaffold,
  inferInitScaffoldFromRepo,
} from "./init-setup.js";

import { DEFAULT_PHREN_PATH, STARTER_DIR, VERSION, log, confirmPrompt } from "./init-shared.js";
import {
  PROJECT_OWNERSHIP_MODES,
  type ProjectOwnershipMode,
  parseProjectOwnershipMode,
  getProjectOwnershipDefault,
} from "./project-config.js";
import { type ProactivityLevel } from "./proactivity.js";
import { getWorkflowPolicy, updateWorkflowPolicy } from "./shared-governance.js";
import { addProjectToProfile } from "./profile-store.js";
import {
  type McpMode,
  type WorkflowRiskSection,
  type StorageLocationChoice,
  createWalkthroughPrompts,
  createWalkthroughStyle,
  runWalkthrough,
} from "./init-walkthrough.js";

export type { McpMode } from "./init-walkthrough.js";
export { isVersionNewer } from "./init-npm.js";
import { isVersionNewer } from "./init-npm.js";
type SkillsScope = "global" | "project";

export function parseMcpMode(raw?: string): McpMode | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "on" || normalized === "off") return normalized;
  return undefined;
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
  riskySections?: WorkflowRiskSection[];
  taskMode?: "off" | "manual" | "suggest" | "auto";
  findingSensitivity?: "minimal" | "conservative" | "balanced" | "aggressive";
  skillsScope?: SkillsScope;
  applyStarterUpdate?: boolean;
  dryRun?: boolean;
  yes?: boolean;
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

function getPendingBootstrapTarget(phrenPath: string, opts: InitOptions): { path: string; mode: "explicit" | "detected" } | null {
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

export async function warmSemanticSearch(phrenPath: string, profile?: string): Promise<string> {
  const { checkOllamaAvailable, checkModelAvailable, getOllamaUrl, getEmbeddingModel } = await import("./shared-ollama.js");
  const ollamaUrl = getOllamaUrl();
  if (!ollamaUrl) return "Semantic search: disabled.";

  const model = getEmbeddingModel();
  if (!await checkOllamaAvailable()) {
    return `Semantic search not warmed: Ollama offline at ${ollamaUrl}.`;
  }
  if (!await checkModelAvailable()) {
    return `Semantic search not warmed: model ${model} is not pulled yet.`;
  }

  const { buildIndex, listIndexedDocumentPaths } = await import("./shared-index.js");
  const { getEmbeddingCache, formatEmbeddingCoverage } = await import("./shared-embedding-cache.js");
  const { backgroundEmbedMissingDocs } = await import("./startup-embedding.js");
  const { getPersistentVectorIndex } = await import("./shared-vector-index.js");

  const db = await buildIndex(phrenPath, profile);
  try {
    const cache = getEmbeddingCache(phrenPath);
    await cache.load().catch(() => {});
    const allPaths = listIndexedDocumentPaths(phrenPath, profile);
    const before = cache.coverage(allPaths);
    if (before.missing > 0) {
      await backgroundEmbedMissingDocs(db, cache);
    }
    await cache.load().catch(() => {});
    const after = cache.coverage(allPaths);
    if (cache.size() > 0) {
      getPersistentVectorIndex(phrenPath).ensure(cache.getAllEntries());
    }
    if (after.total === 0) {
      return `Semantic search ready (${model}), but there are no indexed docs yet.`;
    }
    const embeddedNow = Math.max(0, after.embedded - before.embedded);
    const prefix = after.state === "warm" ? "Semantic search warmed" : "Semantic search warming";
    const delta = embeddedNow > 0 ? `; embedded ${embeddedNow} new docs during init` : "";
    return `${prefix}: ${model}, ${formatEmbeddingCoverage(after)}${delta}.`;
  } finally {
    try { db.close(); } catch { /* ignore close errors in init */ }
  }
}

function applyOnboardingPreferences(phrenPath: string, opts: InitOptions): void {
  if (opts.projectOwnershipDefault) {
    writeInstallPreferences(phrenPath, { projectOwnershipDefault: opts.projectOwnershipDefault });
  }
  const runtimePatch: {
    proactivityFindings?: ProactivityLevel;
    proactivityTask?: ProactivityLevel;
  } = {};
  if (opts.findingsProactivity) runtimePatch.proactivityFindings = opts.findingsProactivity;
  if (opts.taskProactivity) runtimePatch.proactivityTask = opts.taskProactivity;
  if (Object.keys(runtimePatch).length > 0) {
    writeInstallPreferences(phrenPath, runtimePatch);
  }
  const governancePatch: {
    proactivityFindings?: ProactivityLevel;
    proactivityTask?: ProactivityLevel;
  } = {};
  if (opts.findingsProactivity) governancePatch.proactivityFindings = opts.findingsProactivity;
  if (opts.taskProactivity) governancePatch.proactivityTask = opts.taskProactivity;
  if (Object.keys(governancePatch).length > 0) {
    writeGovernanceInstallPreferences(phrenPath, governancePatch);
  }
  const workflowPatch: {
    lowConfidenceThreshold?: number;
    riskySections?: WorkflowRiskSection[];
    taskMode?: "off" | "manual" | "suggest" | "auto";
    findingSensitivity?: "minimal" | "conservative" | "balanced" | "aggressive";
  } = {};
  if (typeof opts.lowConfidenceThreshold === "number") workflowPatch.lowConfidenceThreshold = opts.lowConfidenceThreshold;
  if (Array.isArray(opts.riskySections)) workflowPatch.riskySections = opts.riskySections;
  if (opts.taskMode) workflowPatch.taskMode = opts.taskMode;
  if (opts.findingSensitivity) workflowPatch.findingSensitivity = opts.findingSensitivity;
  if (Object.keys(workflowPatch).length > 0) {
    updateWorkflowPolicy(phrenPath, workflowPatch);
  }
}

function writeWalkthroughEnvDefaults(phrenPath: string, opts: InitOptions): string[] {
  const envFile = path.join(phrenPath, ".env");
  let envContent = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "# phren feature flags — generated by init\n";
  const envFlags: { flag: string; label: string }[] = [];
  const autoCaptureChoice = opts._walkthroughAutoCapture;
  const hasAutoCaptureFlag = /^\s*PHREN_FEATURE_AUTO_CAPTURE=.*$/m.test(envContent);
  if (typeof autoCaptureChoice === "boolean") {
    envFlags.push({
      flag: `PHREN_FEATURE_AUTO_CAPTURE=${autoCaptureChoice ? "1" : "0"}`,
      label: `Auto-capture ${autoCaptureChoice ? "enabled" : "disabled"}`,
    });
  } else if (!hasAutoCaptureFlag) {
    // Default to enabled on fresh installs and non-walkthrough init.
    envFlags.push({ flag: "PHREN_FEATURE_AUTO_CAPTURE=1", label: "Auto-capture enabled" });
  }
  if (opts._walkthroughSemanticDedup) envFlags.push({ flag: "PHREN_FEATURE_SEMANTIC_DEDUP=1", label: "Semantic dedup" });
  if (opts._walkthroughSemanticConflict) envFlags.push({ flag: "PHREN_FEATURE_SEMANTIC_CONFLICT=1", label: "Conflict detection" });

  if (envFlags.length === 0) return [];
  let changed = false;
  const enabledLabels: string[] = [];

  for (const { flag, label } of envFlags) {
    const key = flag.split("=")[0];
    const lineRe = new RegExp(`^\\s*${key}=.*$`, "m");
    if (lineRe.test(envContent)) {
      const before = envContent;
      envContent = envContent.replace(lineRe, flag);
      if (envContent !== before) {
        changed = true;
        enabledLabels.push(label);
      }
    } else {
      if (!envContent.endsWith("\n")) envContent += "\n";
      envContent += `${flag}\n`;
      changed = true;
      enabledLabels.push(label);
    }
  }

  if (changed) {
    const tmpPath = `${envFile}.tmp-${crypto.randomUUID()}`;
    fs.writeFileSync(tmpPath, envContent);
    fs.renameSync(tmpPath, envFile);
  }
  return enabledLabels.map((label) => `${label} (${envFile})`);
}

function collectRepairedAssetLabels(repaired: ReturnType<typeof repairPreexistingInstall>): string[] {
  const repairedAssets: string[] = [];
  if (repaired.createdContextFile) repairedAssets.push("~/.phren-context.md");
  if (repaired.createdRootMemory) repairedAssets.push("generated MEMORY.md");
  repairedAssets.push(...repaired.createdGlobalAssets);
  repairedAssets.push(...repaired.createdRuntimeAssets);
  repairedAssets.push(...repaired.createdFeatureDefaults);
  repairedAssets.push(...repaired.createdSkillArtifacts);
  return repairedAssets;
}

function applyProjectStorageBindings(repoRoot: string, phrenPath: string): string[] {
  const updates: string[] = [];
  if (ensureGitignoreEntry(repoRoot, ".phren/")) {
    updates.push(`${path.join(repoRoot, ".gitignore")} (.phren/)`);
  }
  if (upsertProjectEnvVar(repoRoot, "PHREN_PATH", phrenPath)) {
    updates.push(`${path.join(repoRoot, ".env")} (PHREN_PATH=${phrenPath})`);
  }
  return updates;
}

async function runProjectLocalInit(opts: InitOptions = {}): Promise<void> {
  const detectedRoot = detectProjectDir(process.cwd(), path.join(process.cwd(), ".phren")) || process.cwd();
  const hasWorkspaceMarker =
    fs.existsSync(path.join(detectedRoot, ".git")) ||
    fs.existsSync(path.join(detectedRoot, "CLAUDE.md")) ||
    fs.existsSync(path.join(detectedRoot, "AGENTS.md")) ||
    fs.existsSync(path.join(detectedRoot, ".claude", "CLAUDE.md"));
  if (!hasWorkspaceMarker) {
    throw new Error("project-local mode must be run inside a repo or project root");
  }

  const workspaceRoot = path.resolve(detectedRoot);
  const phrenPath = path.join(workspaceRoot, ".phren");
  const existingManifest = readRootManifest(phrenPath);
  if (existingManifest && existingManifest.installMode !== "project-local") {
    throw new Error(`Refusing to reuse non-local phren root at ${phrenPath}`);
  }

  const ownershipDefault = opts.projectOwnershipDefault
    ?? (existingManifest ? getProjectOwnershipDefault(phrenPath) : "detached");
  if (!existingManifest && !opts.projectOwnershipDefault) {
    opts.projectOwnershipDefault = ownershipDefault;
  }
  const mcpEnabled = opts.mcp ? opts.mcp === "on" : true;
  const projectName = path.basename(workspaceRoot).toLowerCase().replace(/[^a-z0-9_-]/g, "-");

  if (opts.dryRun) {
    log("\nInit dry run. No files will be written.\n");
    log(`Mode: project-local`);
    log(`Workspace root: ${workspaceRoot}`);
    log(`Phren root: ${phrenPath}`);
    log(`Project: ${projectName}`);
    log(`VS Code workspace MCP: ${mcpEnabled ? "on" : "off"}`);
    log(`Hooks: unsupported in project-local mode`);
    log("");
    return;
  }

  fs.mkdirSync(phrenPath, { recursive: true });
  writeRootManifest(phrenPath, {
    version: 1,
    installMode: "project-local",
    syncMode: "workspace-git",
    workspaceRoot,
    primaryProject: projectName,
  });
  ensureGovernanceFiles(phrenPath);
  repairPreexistingInstall(phrenPath);
  fs.mkdirSync(path.join(phrenPath, "global", "skills"), { recursive: true });
  fs.mkdirSync(path.join(phrenPath, ".runtime"), { recursive: true });
  fs.mkdirSync(path.join(phrenPath, ".sessions"), { recursive: true });
  if (!fs.existsSync(path.join(phrenPath, ".gitignore"))) {
    atomicWriteText(
      path.join(phrenPath, ".gitignore"),
      [
        ".runtime/",
        ".sessions/",
        "*.lock",
        "*.tmp-*",
        "",
      ].join("\n")
    );
  }
  if (!fs.existsSync(path.join(phrenPath, "global", "CLAUDE.md"))) {
    atomicWriteText(
      path.join(phrenPath, "global", "CLAUDE.md"),
      "# Global Context\n\nRepo-local Phren instructions shared across this workspace.\n"
    );
  }

  const created = bootstrapFromExisting(phrenPath, workspaceRoot, { ownership: ownershipDefault });
  applyOnboardingPreferences(phrenPath, opts);
  writeInstallPreferences(phrenPath, {
    mcpEnabled,
    hooksEnabled: false,
    skillsScope: opts.skillsScope ?? "global",
    installedVersion: VERSION,
  });

  try {
    const vscodeResult = configureVSCode(phrenPath, { mcpEnabled, scope: "workspace" });
    logMcpTargetStatus("VS Code", vscodeResult, existingManifest ? "Updated" : "Configured");
  } catch (err: unknown) {
    debugLog(`configureVSCode(workspace) failed: ${errorMessage(err)}`);
  }

  log(`\n${existingManifest ? "Updated" : "Created"} project-local phren at ${phrenPath}`);
  log(`  Workspace root: ${workspaceRoot}`);
  log(`  Project: ${created.project}`);
  log(`  Ownership: ${created.ownership}`);
  log(`  Sync mode: workspace-git`);
  log(`  Hooks: off (unsupported in project-local mode)`);
  log(`  VS Code MCP: ${mcpEnabled ? "workspace on" : "workspace off"}`);

  const verify = runPostInitVerify(phrenPath);
  log(`\nVerifying setup...`);
  for (const check of verify.checks) {
    log(`  ${check.ok ? "pass" : "FAIL"} ${check.name}: ${check.detail}`);
  }
}

/**
 * Configure MCP for all detected AI coding tools (Claude, VS Code, Cursor, Copilot, Codex).
 * @param verb - label used in log messages, e.g. "Updated" or "Configured"
 */
export function configureMcpTargets(
  phrenPath: string,
  opts: { mcpEnabled: boolean; hooksEnabled: boolean },
  verb: "Configured" | "Updated" = "Configured",
): string {
  let claudeStatus = "no_settings";
  try {
    const status = configureClaude(phrenPath, { mcpEnabled: opts.mcpEnabled, hooksEnabled: opts.hooksEnabled });
    claudeStatus = status ?? "installed";
    if (status === "disabled" || status === "already_disabled") {
      log(`  ${verb} Claude Code hooks (MCP disabled)`);
    } else {
      log(`  ${verb} Claude Code MCP + hooks`);
    }
  } catch (e) {
    log(`  Could not configure Claude Code settings (${e}), add manually`);
  }

  let vsStatus = "no_vscode";
  try {
    vsStatus = configureVSCode(phrenPath, { mcpEnabled: opts.mcpEnabled }) ?? "no_vscode";
    logMcpTargetStatus("VS Code", vsStatus, verb);
  } catch (err: unknown) {
    debugLog(`configureVSCode failed: ${errorMessage(err)}`);
  }

  let cursorStatus = "no_cursor";
  try {
    cursorStatus = configureCursorMcp(phrenPath, { mcpEnabled: opts.mcpEnabled }) ?? "no_cursor";
    logMcpTargetStatus("Cursor", cursorStatus, verb);
  } catch (err: unknown) {
    debugLog(`configureCursorMcp failed: ${errorMessage(err)}`);
  }

  let copilotStatus = "no_copilot";
  try {
    copilotStatus = configureCopilotMcp(phrenPath, { mcpEnabled: opts.mcpEnabled }) ?? "no_copilot";
    logMcpTargetStatus("Copilot CLI", copilotStatus, verb);
  } catch (err: unknown) {
    debugLog(`configureCopilotMcp failed: ${errorMessage(err)}`);
  }

  let codexStatus = "no_codex";
  try {
    codexStatus = configureCodexMcp(phrenPath, { mcpEnabled: opts.mcpEnabled }) ?? "no_codex";
    logMcpTargetStatus("Codex", codexStatus, verb);
  } catch (err: unknown) {
    debugLog(`configureCodexMcp failed: ${errorMessage(err)}`);
  }

  const allStatuses = [claudeStatus, vsStatus, cursorStatus, copilotStatus, codexStatus];
  if (allStatuses.some((s) => s === "installed" || s === "already_configured")) return "installed";
  if (allStatuses.some((s) => s === "disabled" || s === "already_disabled")) return "disabled";
  return claudeStatus;
}

/**
 * Configure hooks if enabled, or log a disabled message.
 * @param verb - label used in log messages, e.g. "Updated" or "Configured"
 */
function configureHooksIfEnabled(phrenPath: string, hooksEnabled: boolean, verb: string): void {
  if (hooksEnabled) {
    try {
      const hooked = configureAllHooks(phrenPath, { allTools: true });
      if (hooked.length) log(`  ${verb} hooks: ${hooked.join(", ")}`);
    } catch (err: unknown) { debugLog(`configureAllHooks failed: ${errorMessage(err)}`); }
  } else {
    log(`  Hooks are disabled by preference (run: npx phren hooks-mode on)`);
  }
}

export async function runInit(opts: InitOptions = {}) {
  if ((opts.mode || "shared") === "project-local") {
    await runProjectLocalInit(opts);
    return;
  }
  let phrenPath = resolveInitPhrenPath(opts);
  const dryRun = Boolean(opts.dryRun);

  // Migrate the legacy hidden store directory into ~/.phren when upgrading
  // from the previous product name. Only runs when the resolved phrenPath
  // doesn't exist yet but the legacy directory does.
  if (!opts._walkthroughStoragePath && !fs.existsSync(phrenPath)) {
    // Pre-rebrand directory name — kept as literal for migration
    const legacyPath = path.resolve(homePath(".cortex"));
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
  if (!hasExistingInstall && !dryRun && !opts.yes && process.stdin.isTTY && process.stdout.isTTY) {
    const answers = await runWalkthrough(phrenPath);
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
        log(style.warning(`  Skipped. Later: cd ${pendingBootstrap.path} && npx phren add`));
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
        log(`  Run \`npx phren init --apply-starter-update\` to refresh global/CLAUDE.md and global skills.`);
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
      log(`  2. Run \`npx phren doctor\` to verify everything is wired correctly`);
      log(`  3. Change defaults anytime: \`npx phren config project-ownership\`, \`npx phren config workflow\`, \`npx phren config proactivity.findings\`, \`npx phren config proactivity.tasks\``);
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

  // Confirmation prompt before writing agent config
  if (!opts.yes) {
    const settingsPath = hookConfigPath("claude");
    log(`\nWill modify:`);
    log(`  ${settingsPath}  (add MCP server + hooks)`);

    const confirmed = await confirmPrompt("\nProceed?");
    if (!confirmed) {
      log("Aborted.");
      return;
    }
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
      const { checkOllamaAvailable, checkModelAvailable, getOllamaUrl } = await import("./shared-ollama.js");
      if (getOllamaUrl()) {
        const ollamaUp = await checkOllamaAvailable();
        if (ollamaUp) {
          const modelReady = await checkModelAvailable();
          if (modelReady) {
            log("\n  Semantic search: Ollama + nomic-embed-text ready.");
          } else {
            log("\n  Semantic search: Ollama running, but nomic-embed-text not pulled.");
            log("  Run: ollama pull nomic-embed-text");
          }
        } else {
          log("\n  Tip: Install Ollama for semantic search (optional).");
          log("  https://ollama.com → then: ollama pull nomic-embed-text");
          log("  (Set PHREN_OLLAMA_URL=off to hide this message)");
        }
      }
    } catch (err: unknown) {
      if ((process.env.PHREN_DEBUG)) process.stderr.write(`[phren] init ollamaInstallHint: ${errorMessage(err)}\n`);
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
  log(`  ${step++}. Run \`npx phren doctor\` to verify everything is wired correctly`);
  log(`  ${step++}. Change defaults anytime: \`npx phren config project-ownership\`, \`npx phren config workflow\`, \`npx phren config proactivity.findings\`, \`npx phren config proactivity.tasks\``);

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

  log(`  ${step++}. Add more projects: cd ~/your-project && npx phren add`);

  if (!mcpEnabled) {
    log(`  ${step++}. Turn MCP on: npx phren mcp-mode on`);
  }
  log(`  ${step++}. After your first week, run phren-discover to surface gaps in your project knowledge`);
  log(`  ${step++}. After working across projects, run phren-consolidate to find cross-project patterns`);
  log(`\n  Read ${phrenPath}/README.md for a guided tour of each file.`);

  log(``);
}

export async function runMcpMode(modeArg?: string) {
  const phrenPath = findPhrenPath() || (process.env.PHREN_PATH) || DEFAULT_PHREN_PATH;
  const manifest = readRootManifest(phrenPath);
  const normalizedArg = modeArg?.trim().toLowerCase();
  if (!normalizedArg || normalizedArg === "status") {
    const current = getMcpEnabledPreference(phrenPath);
    const hooks = getHooksEnabledPreference(phrenPath);
    log(`MCP mode: ${current ? "on (recommended)" : "off (hooks-only fallback)"}`);
    log(`Hooks mode: ${hooks ? "on (active)" : "off (disabled)"}`);
    log(`Change mode: npx phren mcp-mode on|off`);
    log(`Hooks toggle: npx phren hooks-mode on|off`);
    return;
  }
  const mode = parseMcpMode(normalizedArg);
  if (!mode) {
    throw new Error(`Invalid mode "${modeArg}". Use: on | off | status`);
  }
  const enabled = mode === "on";

  if (manifest?.installMode === "project-local") {
    const vscodeStatus = configureVSCode(phrenPath, { mcpEnabled: enabled, scope: "workspace" });
    setMcpEnabledPreference(phrenPath, enabled);
    log(`MCP mode set to ${mode}.`);
    log(`VS Code status: ${vscodeStatus}`);
    log(`Project-local mode only configures workspace VS Code MCP.`);
    return;
  }

  let claudeStatus: ToolStatus = "no_settings";
  let vscodeStatus: ToolStatus = "no_vscode";
  let cursorStatus: ToolStatus = "no_cursor";
  let copilotStatus: ToolStatus = "no_copilot";
  let codexStatus: ToolStatus = "no_codex";
  try { claudeStatus = configureClaude(phrenPath, { mcpEnabled: enabled }) ?? claudeStatus; } catch (err: unknown) { debugLog(`mcp-mode: configureClaude failed: ${errorMessage(err)}`); }
  try { vscodeStatus = configureVSCode(phrenPath, { mcpEnabled: enabled }) ?? vscodeStatus; } catch (err: unknown) { debugLog(`mcp-mode: configureVSCode failed: ${errorMessage(err)}`); }
  try { cursorStatus = configureCursorMcp(phrenPath, { mcpEnabled: enabled }) ?? cursorStatus; } catch (err: unknown) { debugLog(`mcp-mode: configureCursorMcp failed: ${errorMessage(err)}`); }
  try { copilotStatus = configureCopilotMcp(phrenPath, { mcpEnabled: enabled }) ?? copilotStatus; } catch (err: unknown) { debugLog(`mcp-mode: configureCopilotMcp failed: ${errorMessage(err)}`); }
  try { codexStatus = configureCodexMcp(phrenPath, { mcpEnabled: enabled }) ?? codexStatus; } catch (err: unknown) { debugLog(`mcp-mode: configureCodexMcp failed: ${errorMessage(err)}`); }

  // Persist preference only after config writes have been attempted
  setMcpEnabledPreference(phrenPath, enabled);

  log(`MCP mode set to ${mode}.`);
  log(`Claude status: ${claudeStatus}`);
  log(`VS Code status: ${vscodeStatus}`);
  log(`Cursor status: ${cursorStatus}`);
  log(`Copilot CLI status: ${copilotStatus}`);
  log(`Codex status: ${codexStatus}`);
  log(`Restart your agent to apply changes.`);
}

export async function runHooksMode(modeArg?: string) {
  const phrenPath = findPhrenPath() || (process.env.PHREN_PATH) || DEFAULT_PHREN_PATH;
  const manifest = readRootManifest(phrenPath);
  const normalizedArg = modeArg?.trim().toLowerCase();
  if (!normalizedArg || normalizedArg === "status") {
    const current = getHooksEnabledPreference(phrenPath);
    log(`Hooks mode: ${current ? "on (active)" : "off (disabled)"}`);
    log(`Change mode: npx phren hooks-mode on|off`);
    return;
  }
  const mode = parseMcpMode(normalizedArg);
  if (!mode) {
    throw new Error(`Invalid mode "${modeArg}". Use: on | off | status`);
  }

  if (manifest?.installMode === "project-local") {
    throw new Error("hooks-mode is unsupported in project-local mode");
  }

  const enabled = mode === "on";

  let claudeStatus: ToolStatus = "no_settings";
  try {
    claudeStatus = configureClaude(phrenPath, {
      mcpEnabled: getMcpEnabledPreference(phrenPath),
      hooksEnabled: enabled,
    }) ?? claudeStatus;
  } catch (err: unknown) { debugLog(`hooks-mode: configureClaude failed: ${errorMessage(err)}`); }

  if (enabled) {
    try {
      const hooked = configureAllHooks(phrenPath, { allTools: true });
      if (hooked.length) log(`Updated hooks: ${hooked.join(", ")}`);
    } catch (err: unknown) { debugLog(`hooks-mode: configureAllHooks failed: ${errorMessage(err)}`); }
  } else {
    log("Hooks will no-op immediately via preference and Claude hooks are removed.");
  }

  // Persist preference only after config writes have been attempted
  setHooksEnabledPreference(phrenPath, enabled);

  log(`Hooks mode set to ${mode}.`);
  log(`Claude status: ${claudeStatus}`);
  log(`Restart your agent to apply changes.`);
}

// Re-export runUninstall from its dedicated module
export { runUninstall } from "./init-uninstall.js";
