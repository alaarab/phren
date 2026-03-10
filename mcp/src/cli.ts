import { getCortexPath } from "./shared.js";

// Re-export from split modules so existing test imports keep working
export {
  detectTaskIntent,
  parseHookInput,
  applyTrustFilter,
  rankResults,
  selectSnippets,
  buildHookOutput,
  trackSessionMetrics,
  filterBacklogByPriority,
  parseCitations,
  validateCitation,
  annotateStale,
  getProjectGlobBoost,
  clearProjectGlobCache,
  clearCitationValidCache,
  extractToolFindings,
  type HookPromptInput,
  type SelectedSnippet,
} from "./cli-hooks.js";
export { scoreFindingCandidate } from "./cli-extract.js";

import {
  handleHookPrompt,
  handleHookSessionStart,
  handleHookStop,
  handleBackgroundSync,
  handleHookContext,
  handleHookTool,
} from "./cli-hooks.js";
import { handleExtractMemories } from "./cli-extract.js";
import {
  handleGovernMemories,
  handlePruneMemories,
  handleConsolidateMemories,
  handleMaintain,
  handleBackgroundMaintenance,
} from "./cli-govern.js";
import {
  handleConfig,
  handleIndexPolicy,
  handleRetentionPolicy,
  handleWorkflowPolicy,
  handleAccessControl,
} from "./cli-config.js";
import { parseSearchArgs } from "./cli-search.js";
import {
  handleDetectSkills,
  handleHooksNamespace,
  handleProjectsNamespace,
  handleSkillsNamespace,
  handleSkillList,
} from "./cli-namespaces.js";
import {
  handleBacklogView,
  handleQuickstart,
  handleDebugInjection,
  handleInspectIndex,
} from "./cli-ops.js";
import {
  handleAddFinding,
  handleDoctor,
  handleMemoryUi,
  handlePinCanonical,
  handleQualityFeedback,
  handleSearch,
  handleShell,
  handleStatus,
  handleUpdate,
} from "./cli-actions.js";
import { resolveRuntimeProfile } from "./runtime-profile.js";

// ── CLI router ───────────────────────────────────────────────────────────────

export async function runCliCommand(command: string, args: string[]) {
  const profile = resolveRuntimeProfile(getCortexPath());
  switch (command) {
    case "search":
      {
        const opts = parseSearchArgs(getCortexPath(), args);
        if (!opts) return;
        return handleSearch(opts, profile);
      }
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
    case "add-finding":
      return handleAddFinding(args[0], args.slice(1).join(" "));
    case "extract-memories":
      return handleExtractMemories(args[0]);
    case "govern-memories":
      return handleGovernMemories(args[0]);
    case "pin":
      return handlePinCanonical(args[0], args.slice(1).join(" "));
    case "doctor":
      return handleDoctor(args);
    case "status":
      return handleStatus();
    case "quality-feedback":
      return handleQualityFeedback(args);
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
    case "access":
      return handleAccessControl(args);
    case "review-ui":
      return handleMemoryUi(args);
    case "shell":
      return handleShell(args, profile);
    case "update":
      return handleUpdate(args);
    case "config":
      return handleConfig(args);
    case "maintain":
      return handleMaintain(args);
    case "skill-list":
      return handleSkillList(profile);
    case "skills":
      return handleSkillsNamespace(args, profile);
    case "hooks":
      return handleHooksNamespace(args);
    case "tasks":
      return handleBacklogView(profile);
    case "projects":
      return handleProjectsNamespace(args, profile);
    case "quickstart":
      return handleQuickstart();
    case "background-maintenance":
      return handleBackgroundMaintenance(args[0]);
    case "debug-injection":
      return handleDebugInjection(args, profile);
    case "inspect-index":
      return handleInspectIndex(args, profile);
    case "detect-skills":
      return handleDetectSkills(args, profile);
    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}
