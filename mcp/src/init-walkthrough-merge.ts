/**
 * Merge walkthrough answers back into InitOptions.
 */
import { execFileSync } from "child_process";
import type { InitOptions } from "./init-types.js";
import { runWalkthrough } from "./init-walkthrough.js";
import { resolveInitPhrenPath, hasInstallMarkers } from "./init-detect.js";
import { log } from "./init-shared.js";

/**
 * Run the interactive walkthrough for first-time installs, merging answers into opts.
 * Mutates opts in-place and returns the (possibly updated) phrenPath and hasExistingInstall.
 */
export async function mergeWalkthroughAnswers(
  phrenPath: string,
  hasExisting: boolean,
  opts: InitOptions,
): Promise<{ phrenPath: string; hasExistingInstall: boolean }> {
  const answers = await runWalkthrough(phrenPath);
  opts._walkthroughStorageChoice = answers.storageChoice;
  opts._walkthroughStoragePath = answers.storagePath;
  opts._walkthroughStorageRepoRoot = answers.storageRepoRoot;
  const newPhrenPath = resolveInitPhrenPath(opts);
  const newHasExisting = hasInstallMarkers(newPhrenPath);
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
    process.env._PHREN_WALKTHROUGH_OLLAMA_SKIP = "1";
  } else {
    opts._walkthroughSemanticSearch = true;
  }
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

  return { phrenPath: newPhrenPath, hasExistingInstall: newHasExisting };
}

/**
 * Clone an existing phren from a remote URL.
 * @returns true if the clone succeeded (existing install), false otherwise
 */
export function cloneExistingPhren(phrenPath: string, cloneUrl: string): boolean {
  log(`\nCloning existing phren from ${cloneUrl}...`);
  try {
    execFileSync("git", ["clone", cloneUrl, phrenPath], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    log(`  Cloned to ${phrenPath}`);
    return true;
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
    return false;
  }
}
