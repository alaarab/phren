import { getPhrenPath } from "./shared.js";
// Re-export from split modules so existing test imports keep working
export { detectTaskIntent, parseHookInput, applyTrustFilter, rankResults, selectSnippets, buildHookOutput, trackSessionMetrics, filterTaskByPriority, parseCitations, validateCitation, annotateStale, getProjectGlobBoost, clearProjectGlobCache, clearCitationValidCache, filterConversationInsightsForProactivity, extractToolFindings, filterToolFindingsForProactivity, } from "./cli-hooks.js";
export { scoreFindingCandidate } from "./cli-extract.js";
import { handleHookPrompt, handleHookSessionStart, handleHookStop, handleBackgroundSync, handleHookContext, handleHookTool, } from "./cli-hooks.js";
import { handleExtractMemories } from "./cli-extract.js";
import { handleGovernMemories, handlePruneMemories, handleConsolidateMemories, handleMaintain, handleBackgroundMaintenance, } from "./cli-govern.js";
import { handleConfig, handleIndexPolicy, handleRetentionPolicy, handleWorkflowPolicy, } from "./cli-config.js";
import { parseSearchArgs } from "./cli-search.js";
import { handleDetectSkills, handleFindingNamespace, handleHooksNamespace, handleProjectsNamespace, handleSkillsNamespace, handleSkillList, handleTaskNamespace, } from "./cli-namespaces.js";
import { handleTaskView, handleSessionsView, handleQuickstart, handleDebugInjection, handleInspectIndex, } from "./cli-ops.js";
import { handleAddFinding, handleDoctor, handleFragmentSearch, handleMemoryUi, handlePinCanonical, handleQualityFeedback, handleRelatedDocs, handleReview, handleConsolidationStatus, handleSessionContext, handleSearch, handleShell, handleStatus, handleUpdate, } from "./cli-actions.js";
import { handleGraphNamespace } from "./cli-graph.js";
import { resolveRuntimeProfile } from "./runtime-profile.js";
// ── CLI router ───────────────────────────────────────────────────────────────
export async function runCliCommand(command, args) {
    const getProfile = () => resolveRuntimeProfile(getPhrenPath());
    switch (command) {
        case "search":
            {
                const opts = parseSearchArgs(getPhrenPath(), args);
                if (!opts)
                    return;
                return handleSearch(opts, getProfile());
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
        case "web-ui":
            return handleMemoryUi(args);
        case "shell":
            return handleShell(args, getProfile());
        case "update":
            return handleUpdate(args);
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
        case "tasks":
            return handleTaskView(getProfile());
        case "sessions":
            return handleSessionsView(args);
        case "task":
            return handleTaskNamespace(args);
        case "finding":
            return handleFindingNamespace(args);
        case "projects":
            return handleProjectsNamespace(args, args[0] === "--help" || args[0] === "-h" ? "" : getProfile());
        case "quickstart":
            return handleQuickstart();
        case "background-maintenance":
            return handleBackgroundMaintenance(args[0]);
        case "debug-injection":
            return handleDebugInjection(args, getProfile());
        case "inspect-index":
            return handleInspectIndex(args, getProfile());
        case "search-fragments":
            return handleFragmentSearch(args, getProfile());
        case "related-docs":
            return handleRelatedDocs(args, getProfile());
        case "detect-skills":
            return handleDetectSkills(args, getProfile());
        case "graph":
            return handleGraphNamespace(args);
        case "review":
            return handleReview(args);
        case "consolidation-status":
            return handleConsolidationStatus(args);
        case "session-context":
            return handleSessionContext();
        default:
            console.error(`Unknown command: ${command}`);
            process.exit(1);
    }
}
