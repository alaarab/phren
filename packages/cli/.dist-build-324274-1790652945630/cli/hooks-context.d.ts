import { readRootManifest } from "../shared.js";
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
export declare function buildHookContext(): HookContext;
export type HookEvent = "SessionStart" | "Stop" | "UserPromptSubmit" | "PostToolUse";
/** Check common hook guards. Returns a reason string if the hook should NOT run, null if OK. */
export declare function checkHookGuard(ctx: HookContext, event: HookEvent): string | null;
/** Log a guard skip and optionally update runtime health. */
export declare function handleGuardSkip(ctx: HookContext, hookName: string, reason: string, healthUpdate?: Record<string, unknown>): void;
export { debugLog, appendAuditLog, getPhrenPath, readRootManifest, sessionMarker, runtimeFile, EXEC_TIMEOUT_MS, getProjectDirs, findProjectNameCaseInsensitive, projectSlugFromPath, homePath, } from "../shared.js";
export { updateRuntimeHealth, buildSyncStatus, getWorkflowPolicy, withFileLock, appendReviewQueue, recordFeedback, getQualityMultiplier, } from "../shared/governance.js";
export { detectProject } from "../shared/index.js";
export { isProjectHookEnabled, readProjectConfig, getProjectSourcePath } from "../project-config.js";
export { resolveRuntimeProfile } from "../runtime-profile.js";
export { detectProjectDir, ensureLocalGitRepo, isProjectTracked, repairPreexistingInstall, } from "../init/setup.js";
export { getProactivityLevelForTask, getProactivityLevelForFindings } from "../proactivity.js";
export { hasExplicitFindingSignal, shouldAutoCaptureFindingsForLevel } from "../proactivity.js";
export { FINDING_SENSITIVITY_CONFIG } from "./config.js";
export { isFeatureEnabled, errorMessage } from "../utils.js";
export { bootstrapPhrenDotEnv } from "../phren-dotenv.js";
export { finalizeTaskSession } from "../task/lifecycle.js";
export { appendFindingJournal } from "../finding/journal.js";
export { getHooksEnabledPreference } from "../init/init.js";
export { isToolHookEnabled } from "../hooks.js";
export { runDoctor } from "../link/link.js";
