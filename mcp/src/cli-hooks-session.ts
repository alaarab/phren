/**
 * Thin re-export orchestrator for hook handlers.
 *
 * The actual implementations have been split into focused modules:
 * - cli-hooks-session-handlers.ts — SessionStart handler + onboarding helpers
 * - cli-hooks-stop.ts             — Stop handler, background sync, governance
 * - cli-hooks-prompt.ts           — handleHookContext, handleHookTool, tool finding extraction
 *
 * This file re-exports everything for backward compatibility so existing
 * consumers (cli-hooks.ts, tests, shared-retrieval.ts) continue to work
 * without import path changes.
 */

// ── Re-exports from cli-hooks-context (types + utilities) ────────────────────
export type { HookContext } from "./cli-hooks-context.js";
export { buildHookContext, checkHookGuard, handleGuardSkip } from "./cli-hooks-context.js";

// ── Re-exports from cli-hooks-git ────────────────────────────────────────────
export { type GitContext, getGitContext, trackSessionMetrics, resolveSubprocessArgs } from "./cli-hooks-git.js";

// ── Re-exports from cli-hooks-session-handlers (SessionStart) ────────────────
export {
  getUntrackedProjectNotice,
  getSessionStartOnboardingNotice,
  handleHookSessionStart,
} from "./cli-hooks-session-handlers.js";

// ── Re-exports from cli-hooks-stop (Stop + background sync) ─────────────────
export {
  handleHookStop,
  handleBackgroundSync,
  extractConversationInsights,
  filterConversationInsightsForProactivity,
} from "./cli-hooks-stop.js";

// ── Re-exports from cli-hooks-prompt (Context + Tool hooks + extraction) ─────
export {
  handleHookContext,
  handleHookTool,
  extractToolFindings,
  filterToolFindingsForProactivity,
} from "./cli-hooks-prompt.js";
