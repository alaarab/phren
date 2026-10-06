/**
 * Governance enum values, kept in a dependency-free module so the profile store
 * (and through it the phone Hook's module gating) does not pull the whole
 * governance policy, hooks installer and file-lock machinery.
 */
export const VALID_PROACTIVITY_LEVELS = ["high", "medium", "low"];
export const VALID_TASK_MODES = ["off", "manual", "suggest", "auto"];
export const VALID_FINDING_SENSITIVITY = ["minimal", "conservative", "balanced", "aggressive"];
export const VALID_RISKY_SECTIONS = ["Review", "Stale", "Conflicts"];
