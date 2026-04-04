/**
 * Barrel re-export for CLI namespace handlers.
 *
 * The three largest namespaces (tasks, findings, stores) have been extracted
 * into their own modules. The remaining handlers still live in the legacy
 * ../namespaces.ts file until they are split out in a follow-up.
 */

// Extracted modules
export { handleTaskNamespace } from "./tasks.js";
export { handleFindingNamespace } from "./findings.js";
export { handleStoreNamespace } from "./stores.js";

// Legacy — still in ../namespaces.ts
export {
  handleSkillsNamespace,
  handleHooksNamespace,
  handleSkillList,
  handleDetectSkills,
  handleProjectsNamespace,
  handleProfileNamespace,
  handlePromoteNamespace,
  handleReviewNamespace,
} from "../namespaces.js";
