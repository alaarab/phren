import { getPhrenPath } from "../shared.js";

// Re-export from split modules so existing test imports keep working
export {
  detectTaskIntent,
  parseHookInput,
  applyTrustFilter,
  rankResults,
  selectSnippets,
  buildHookOutput,
  trackSessionMetrics,
  filterTaskByPriority,
  parseCitations,
  validateCitation,
  annotateStale,
  getProjectGlobBoost,
  clearProjectGlobCache,
  clearCitationValidCache,
  filterConversationInsightsForProactivity,
  extractToolFindings,
  filterToolFindingsForProactivity,
  type HookPromptInput,
  type SelectedSnippet,
} from "./hooks.js";
export { scoreFindingCandidate } from "./extract.js";

import {
  handleHookPrompt,
  handleHookSessionStart,
  handleHookStop,
  handleBackgroundSync,
  handleHookContext,
  handleHookTool,
} from "./hooks.js";
import { handleExtractMemories } from "./extract.js";
import {
  handleGovernMemories,
  handlePruneMemories,
  handleConsolidateMemories,
  handleMaintain,
  handleBackgroundMaintenance,
} from "./govern.js";
import {
  handleConfig,
  handleIndexPolicy,
  handleRetentionPolicy,
  handleWorkflowPolicy,
} from "./config.js";
import {
  handleHooksNamespace,
  handleProjectsNamespace,
  handleSkillsNamespace,
  handleSkillList,
  handleStoreNamespace,
} from "./namespaces.js";
import { handleTeamNamespace } from "./team.js";
import {
  handleDebugInjection,
  handleInspectIndex,
} from "./ops.js";
import { resolveRuntimeProfile } from "../runtime-profile.js";

// ── CLI router ───────────────────────────────────────────────────────────────

export async function runCliCommand(command: string, args: string[]) {
  const getProfile = () => resolveRuntimeProfile(getPhrenPath());
  switch (command) {
    case "hook-prompt":
      return handleHookPrompt();
    case "hook-session-start":
      return handleHookSessionStart();
    case "hook-stop":
      return handleHookStop();
    case "background-sync":
      return handleBackgroundSync();
    case "hook-context":
      return handleHookContext();
    case "hook-tool":
      return handleHookTool();
    case "extract-memories":
      return handleExtractMemories(args[0]);
    case "govern-memories":
      return handleGovernMemories(args[0]);
    case "prune-memories":
      return handlePruneMemories(args);
    case "consolidate-memories":
      return handleConsolidateMemories(args);
    case "index-policy":
      return handleIndexPolicy(args);
    case "policy":
      return handleRetentionPolicy(args);
    case "workflow":
      return handleWorkflowPolicy(args);
    case "config":
      return handleConfig(args);
    case "maintain":
      return handleMaintain(args);
    case "skill-list":
      return handleSkillList(getProfile());
    case "skills":
      return handleSkillsNamespace(args, getProfile());
    case "hooks":
      return handleHooksNamespace(args);
    case "projects":
      return handleProjectsNamespace(args, getProfile());
    case "background-maintenance":
      return handleBackgroundMaintenance(args[0]);
    case "debug-injection":
      return handleDebugInjection(args, getProfile());
    case "inspect-index":
      return handleInspectIndex(args, getProfile());
    case "store":
      return handleStoreNamespace(args);
    case "team":
      return handleTeamNamespace(args);
    default:
      console.error(`Unknown command: ${command}\nRun 'phren --help' for available commands.`);
      process.exit(1);
  }
}
