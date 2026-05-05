// Barrel re-export. Implementations split across utils-helpers.ts (general
// helpers, argv parsing, exec helpers), utils-paths.ts (path validation),
// utils-fts.ts (FTS5 query building, synonym/keyword extraction).

export {
  runGitOrThrow,
  runGit,
  normalizeExecCommand,
  resolveExecCommand,
  errorMessage,
  isFeatureEnabled,
  clampInt,
  getOptionValue,
  getPositionalArgs,
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
