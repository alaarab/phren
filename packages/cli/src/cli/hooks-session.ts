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

// Re-export HookContext types for consumers
export type { HookContext } from "./hooks-context.js";
export { buildHookContext, handleGuardSkip } from "./hooks-context.js";

// ── Git helpers ─────────────────────────────────────────────────────────────
export type { GitContext } from "./session-git.js";
export { getGitContext } from "./session-git.js";

// ── Session metrics ─────────────────────────────────────────────────────────
export { trackSessionMetrics } from "./session-metrics.js";

// ── Background scheduling ───────────────────────────────────────────────────
export { resolveSubprocessArgs } from "./session-background.js";

// ── Session start ───────────────────────────────────────────────────────────
export {
  getUntrackedProjectNotice,
  getSessionStartOnboardingNotice,
  handleHookSessionStart,
} from "./session-start.js";

// ── Session stop + background sync ──────────────────────────────────────────
export {
  extractConversationInsights,
  filterConversationInsightsForProactivity,
  handleHookStop,
  handleBackgroundSync,
} from "./session-stop.js";

// ── Tool + context hooks ────────────────────────────────────────────────────
export {
  handleHookContext,
  handleHookTool,
  extractToolFindings,
  filterToolFindingsForProactivity,
} from "./session-tool-hook.js";
