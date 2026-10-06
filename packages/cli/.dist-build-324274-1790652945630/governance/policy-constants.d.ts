/**
 * Governance enum values, kept in a dependency-free module so the profile store
 * (and through it the phone Hook's module gating) does not pull the whole
 * governance policy, hooks installer and file-lock machinery.
 */
export declare const VALID_PROACTIVITY_LEVELS: readonly ["high", "medium", "low"];
export declare const VALID_TASK_MODES: readonly ["off", "manual", "suggest", "auto"];
export type TaskMode = typeof VALID_TASK_MODES[number];
export declare const VALID_FINDING_SENSITIVITY: readonly ["minimal", "conservative", "balanced", "aggressive"];
export type FindingSensitivityLevel = typeof VALID_FINDING_SENSITIVITY[number];
export declare const VALID_RISKY_SECTIONS: readonly ["Review", "Stale", "Conflicts"];
