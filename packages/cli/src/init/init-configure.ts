/**
 * MCP target configuration, hooks setup, and onboarding preference helpers.
 * Extracted from init.ts to keep the orchestrator focused on flow control.
 */
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type { ProactivityLevel } from "../proactivity.js";
import { getProjectOwnershipDefault } from "../project-config.js";
import {
  atomicWriteText,
  debugLog,
  readRootManifest,
  writeRootManifest,
} from "../shared.js";
import { errorMessage } from "../utils.js";
import { configureAllHooks, installPhrenCliWrapper } from "../hooks.js";
import { updateWorkflowPolicy } from "../shared/governance.js";
import {
  configureClaude,
  configureVSCode,
  configureCursorMcp,
  configureCopilotMcp,
  configureCodexMcp,
  logMcpTargetStatus,
} from "./config.js";
import { VERSION } from "./shared.js";
import {
  writeInstallPreferences,
  writeGovernanceInstallPreferences,
} from "./preferences.js";
import {
  repairPreexistingInstall,
  ensureGovernanceFiles,
  ensureGitignoreEntry,
  upsertProjectEnvVar,
  detectProjectDir,
  bootstrapFromExisting,
  runPostInitVerify,
} from "./setup.js";
import { log } from "./shared.js";
import type { InitOptions } from "./init.js";

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
export function configureHooksIfEnabled(phrenPath: string, hooksEnabled: boolean, verb: string): void {
  if (hooksEnabled) {
    try {
      const hooked = configureAllHooks(phrenPath, { allTools: true });
      if (hooked.length) log(`  ${verb} hooks: ${hooked.join(", ")}`);
    } catch (err: unknown) { debugLog(`configureAllHooks failed: ${errorMessage(err)}`); }
  } else {
    log(`  Hooks are disabled by preference (run: phren hooks-mode on)`);
  }

  // Install phren CLI wrapper at ~/.local/bin/phren so the bare command works
  const wrapperInstalled = installPhrenCliWrapper(phrenPath);
  if (wrapperInstalled) {
    log(`  ${verb} CLI wrapper: ~/.local/bin/phren`);
  } else {
    log(`  Note: phren CLI wrapper not installed (existing non-managed binary, or no entry script found)`);
  }
}

export function applyOnboardingPreferences(phrenPath: string, opts: InitOptions): void {
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
    riskySections?: ("Review" | "Stale" | "Conflicts")[];
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

export function writeWalkthroughEnvDefaults(phrenPath: string, opts: InitOptions): string[] {
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
  } else if (autoCaptureChoice !== false && !hasAutoCaptureFlag) {
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

export function collectRepairedAssetLabels(repaired: ReturnType<typeof repairPreexistingInstall>): string[] {
  const repairedAssets: string[] = [];
  if (repaired.createdContextFile) repairedAssets.push("~/.phren-context.md");
  if (repaired.createdRootMemory) repairedAssets.push("generated MEMORY.md");
  repairedAssets.push(...repaired.createdGlobalAssets);
  repairedAssets.push(...repaired.createdRuntimeAssets);
  repairedAssets.push(...repaired.createdFeatureDefaults);
  repairedAssets.push(...repaired.createdSkillArtifacts);
  return repairedAssets;
}

export function applyProjectStorageBindings(repoRoot: string, phrenPath: string): string[] {
  const updates: string[] = [];
  if (ensureGitignoreEntry(repoRoot, ".phren/")) {
    updates.push(`${path.join(repoRoot, ".gitignore")} (.phren/)`);
  }
  if (upsertProjectEnvVar(repoRoot, "PHREN_PATH", phrenPath)) {
    updates.push(`${path.join(repoRoot, ".env")} (PHREN_PATH=${phrenPath})`);
  }
  return updates;
}

export async function warmSemanticSearch(phrenPath: string, profile?: string): Promise<string> {
  const { checkOllamaAvailable, checkModelAvailable, getOllamaUrl, getEmbeddingModel } = await import("../shared/ollama.js");
  const ollamaUrl = getOllamaUrl();
  if (!ollamaUrl) return "Semantic search: disabled.";

  const model = getEmbeddingModel();
  if (!await checkOllamaAvailable()) {
    return `Semantic search not warmed: Ollama offline at ${ollamaUrl}.`;
  }
  if (!await checkModelAvailable()) {
    return `Semantic search not warmed: model ${model} is not pulled yet.`;
  }

  const { buildIndex, listIndexedDocumentPaths } = await import("../shared/index.js");
  const { getEmbeddingCache, formatEmbeddingCoverage } = await import("../shared/embedding-cache.js");
  const { backgroundEmbedMissingDocs } = await import("../startup-embedding.js");
  const { getPersistentVectorIndex } = await import("../shared/vector-index.js");

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

export async function runProjectLocalInit(opts: InitOptions = {}): Promise<void> {
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
