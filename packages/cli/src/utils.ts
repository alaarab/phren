// Barrel re-export — all public API preserved for existing importers.
// Actual implementations live in:
//   utils-helpers.ts  — errorMessage, runGit*, isFeatureEnabled, clampInt, exec helpers
//   utils-paths.ts    — isValidProjectName, safeProjectPath, queueFilePath
//   utils-fts.ts      — FTS5 sanitization, synonym expansion, keyword extraction, query building

export {
  runGitOrThrow,
  runGit,
  normalizeExecCommand,
  resolveExecCommand,
  errorMessage,
  isFeatureEnabled,
  clampInt,
} from "./utils-helpers.js";

export {
  isValidProjectName,
  safeProjectPath,
  queueFilePath,
} from "./utils-paths.js";

export {
  STOP_WORDS,
  extractKeywordEntries,
  extractKeywords,
  learnedSynonymsPath,
  loadLearnedSynonyms,
  loadSynonymMap,
  learnSynonym,
  removeLearnedSynonym,
  sanitizeFts5Query,
  buildRobustFtsQuery,
  buildRelaxedFtsQuery,
  buildFtsQueryVariants,
} from "./utils-fts.js";
