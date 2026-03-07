// Barrel re-export. Internal code imports from the specific modules directly.
// External consumers and legacy imports use this file.

export {
  type ConsolidationNeeded,
  checkConsolidationNeeded,
  validateFindingsFormat,
  stripBacklogDoneSection,
  validateBacklogFormat,
  extractConflictVersions,
  mergeFindings,
  mergeBacklog,
  autoMergeConflicts,
} from "./content-validate.js";

export {
  type FindingCitation,
  type FindingTrustIssue,
  type TrustFilterOptions,
  clearCitationCaches,
  filterTrustedFindings,
  filterTrustedFindingsDetailed,
} from "./content-citation.js";

export {
  KNOWN_OBSERVATION_TAGS,
  normalizeObservationTags,
  scanForSecrets,
  resolveCoref,
  isDuplicateFinding,
  detectConflicts,
  checkSemanticDedup,
  checkSemanticConflicts,
} from "./content-dedup.js";

export {
  countActiveFindings,
  autoArchiveToReference,
} from "./content-archive.js";

export {
  migrateLegacyFindings,
  upsertCanonical,
  addFindingToFile,
  addFindingsToFile,
} from "./content-learning.js";
