export { parseCitations, validateCitation, annotateStale, clearCitationValidCache, type ParsedCitation, } from "./hooks-citations.js";
export { getProjectGlobBoost, clearProjectGlobCache, } from "./hooks-globs.js";
export { detectTaskIntent, filterTaskByPriority, searchDocuments, applyTrustFilter, rankResults, applyRelevanceFloor, promptRarity, DEFAULT_MIN_QUERY_RELEVANCE, selectSnippets, type SelectedSnippet, } from "../shared/retrieval.js";
export { buildHookOutput, } from "./hooks-output.js";
export { handleHookSessionStart, handleHookStop, handleBackgroundSync, handleHookContext, handleHookTool, trackSessionMetrics, filterConversationInsightsForProactivity, extractToolFindings, filterToolFindingsForProactivity, resolveSubprocessArgs, } from "./hooks-session.js";
export interface HookPromptInput {
    prompt: string;
    cwd?: string;
    sessionId?: string;
}
export declare function parseHookInput(raw: string): HookPromptInput | null;
export declare function handleHookPrompt(): Promise<void>;
