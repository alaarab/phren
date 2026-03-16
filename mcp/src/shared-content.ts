// Barrel re-export. Internal code imports from the specific modules directly.

export {
  type ConsolidationNeeded,
  type ConsolidationStatus,
  checkConsolidationNeeded,
  validateFindingsFormat,
  stripTaskDoneSection,
  validateTaskFormat,
  extractConflictVersions,
  mergeFindings,
  mergeTask,
  autoMergeConflicts,
} from "./content-validate.js";

export {
  filterTrustedFindings,
  filterTrustedFindingsDetailed,
} from "./content-citation.js";

export {
  scanForSecrets,
  resolveCoref,
  isDuplicateFinding,
  detectConflicts,
  extractDynamicEntities,
  checkSemanticDedup,
  checkSemanticConflicts,
} from "./content-dedup.js";

export {
  countActiveFindings,
  autoArchiveToReference,
} from "./content-archive.js";

export {
  upsertCanonical,
  addFindingToFile,
  addFindingsToFile,
  autoDetectFindingType,
  type AddFindingResult,
} from "./content-learning.js";

export {
  FINDING_LIFECYCLE_STATUSES,
  FINDING_TYPE_DECAY,
  extractFindingType,
  parseFindingLifecycle,
  buildLifecycleComments,
  isInactiveFindingLine,
  type FindingLifecycleStatus,
  type FindingLifecycleMetadata,
} from "./finding-lifecycle.js";

export {
  METADATA_REGEX,
  parseStatus,
  parseStatusField,
  parseSupersession,
  parseSupersedesRef,
  parseContradiction,
  parseAllContradictions,
  parseFindingId,
  parseCreatedDate,
  isCitationLine,
  isArchiveStart,
  isArchiveEnd,
  stripLifecycleMetadata,
  stripRelationMetadata,
  stripAllMetadata,
  stripComments,
  addMetadata,
} from "./content-metadata.js";
