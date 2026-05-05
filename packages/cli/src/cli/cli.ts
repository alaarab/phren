// Barrel re-export. Test files and a handful of helper modules consume
// these symbols by name, so this file persists as a flat surface even
// though dispatch now lives in cli-registry.ts.

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
