/**
 * Session lifecycle hooks — orchestrator module.
 *
 * This file re-exports all session hook functionality from the split modules:
 * - session-git.ts — Git context and command helpers
 * - session-metrics.ts — Session metrics tracking
 * - session-background.ts — Background sync/maintenance scheduling
 * - session-start.ts — SessionStart hook handler + onboarding notices
 * - session-stop.ts — Stop hook handler + background sync + conversation capture
 * - session-tool-hook.ts — PostToolUse and context hook handlers + tool finding extraction
 */
export type { HookContext } from "./hooks-context.js";
export { buildHookContext, handleGuardSkip } from "./hooks-context.js";
export type { GitContext } from "./session-git.js";
export { getGitContext } from "./session-git.js";
export { trackSessionMetrics } from "./session-metrics.js";
export { resolveSubprocessArgs } from "./session-background.js";
export { getUntrackedProjectNotice, getSessionStartOnboardingNotice, handleHookSessionStart, } from "./session-start.js";
export { extractConversationInsights, filterConversationInsightsForProactivity, handleHookStop, handleBackgroundSync, } from "./session-stop.js";
export { handleHookContext, handleHookTool, extractToolFindings, filterToolFindingsForProactivity, } from "./session-tool-hook.js";
