// cli-hooks-context.ts — HookContext: everything a hook handler needs as plain data + helpers.
// Centralizes the "resolve state and check guards" pattern so hook handlers don't
// reach into governance, init, project-config, hooks, init-setup, etc. directly.

import {
  debugLog,
  appendAuditLog,
  getPhrenPath,
  readRootManifest,
  sessionMarker,
  runtimeFile,
  EXEC_TIMEOUT_MS,
  getProjectDirs,
  findProjectNameCaseInsensitive,
  homePath,
} from "./shared.js";
import {
  updateRuntimeHealth,
  getWorkflowPolicy,
  withFileLock,
  appendReviewQueue,
  recordFeedback,
  getQualityMultiplier,
} from "./shared-governance.js";
import { detectProject } from "./shared-index.js";
import { getHooksEnabledPreference } from "./init.js";
import { isToolHookEnabled } from "./hooks.js";
import { isProjectHookEnabled, readProjectConfig, getProjectSourcePath } from "./project-config.js";
import { resolveRuntimeProfile } from "./runtime-profile.js";
import {
  detectProjectDir,
  ensureLocalGitRepo,
  isProjectTracked,
  repairPreexistingInstall,
} from "./init-setup.js";
import { getProactivityLevelForTask, getProactivityLevelForFindings } from "./proactivity.js";
import { FINDING_SENSITIVITY_CONFIG } from "./cli-config.js";
import { isFeatureEnabled, errorMessage } from "./utils.js";
import { bootstrapPhrenDotEnv } from "./phren-dotenv.js";
import { finalizeTaskSession } from "./task-lifecycle.js";
import { appendFindingJournal } from "./finding-journal.js";
import { runDoctor } from "./link.js";

export interface HookContext {
  phrenPath: string;
  profile: string;
  cwd: string;
  hookTool: string;
  activeProject: string | null;
  hooksEnabled: boolean;
  toolHookEnabled: boolean;
  manifest: ReturnType<typeof readRootManifest>;
}

/** Build a HookContext from the current process environment. */
export function buildHookContext(): HookContext {
  const phrenPath = getPhrenPath();
  const profile = resolveRuntimeProfile(phrenPath);
  const cwd = process.cwd();
  const hookTool = process.env.PHREN_HOOK_TOOL || "claude";
  const hooksEnabled = getHooksEnabledPreference(phrenPath);
  const toolHookEnabled = hooksEnabled && isToolHookEnabled(phrenPath, hookTool);
  const activeProject = detectProject(phrenPath, cwd, profile);
  const manifest = readRootManifest(phrenPath);
  return { phrenPath, profile, cwd, hookTool, activeProject, hooksEnabled, toolHookEnabled, manifest };
}

export type HookEvent = "SessionStart" | "Stop" | "UserPromptSubmit" | "PostToolUse";

/** Check common hook guards. Returns a reason string if the hook should NOT run, null if OK. */
export function checkHookGuard(
  ctx: HookContext,
  event: HookEvent,
): string | null {
  if (!ctx.hooksEnabled) return "disabled";
  if (!ctx.toolHookEnabled) return `tool_disabled tool=${ctx.hookTool}`;
  if (!isProjectHookEnabled(ctx.phrenPath, ctx.activeProject, event)) {
    return `project_disabled project=${ctx.activeProject}`;
  }
  return null;
}

/** Log a guard skip and optionally update runtime health. */
export function handleGuardSkip(
  ctx: HookContext,
  hookName: string,
  reason: string,
  healthUpdate?: Record<string, unknown>,
): void {
  if (healthUpdate) updateRuntimeHealth(ctx.phrenPath, healthUpdate);
  appendAuditLog(ctx.phrenPath, hookName, `status=${reason}`);
}

// Re-export frequently used functions so hook handlers can import from one place
export {
  debugLog,
  appendAuditLog,
  getPhrenPath,
  readRootManifest,
  sessionMarker,
  runtimeFile,
  EXEC_TIMEOUT_MS,
  getProjectDirs,
  findProjectNameCaseInsensitive,
  homePath,
} from "./shared.js";
export {
  updateRuntimeHealth,
  getWorkflowPolicy,
  withFileLock,
  appendReviewQueue,
  recordFeedback,
  getQualityMultiplier,
} from "./shared-governance.js";
export { detectProject } from "./shared-index.js";
export { isProjectHookEnabled, readProjectConfig, getProjectSourcePath } from "./project-config.js";
export { resolveRuntimeProfile } from "./runtime-profile.js";
export {
  detectProjectDir,
  ensureLocalGitRepo,
  isProjectTracked,
  repairPreexistingInstall,
} from "./init-setup.js";
export { getProactivityLevelForTask, getProactivityLevelForFindings } from "./proactivity.js";
export { hasExplicitFindingSignal, shouldAutoCaptureFindingsForLevel } from "./proactivity.js";
export { FINDING_SENSITIVITY_CONFIG } from "./cli-config.js";
export { isFeatureEnabled, errorMessage } from "./utils.js";
export { bootstrapPhrenDotEnv } from "./phren-dotenv.js";
export { finalizeTaskSession } from "./task-lifecycle.js";
export { appendFindingJournal } from "./finding-journal.js";
export { getHooksEnabledPreference } from "./init.js";
export { isToolHookEnabled } from "./hooks.js";
export { runDoctor } from "./link.js";
