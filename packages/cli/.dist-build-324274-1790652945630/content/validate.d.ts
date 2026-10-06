/** Maximum allowed length for a single finding entry (token budget protection). */
export declare const MAX_FINDING_LENGTH = 2000;
export interface ConsolidationNeeded {
    project: string;
    entriesSince: number;
    daysSince: number | null;
    lastConsolidated: string | null;
}
export interface ConsolidationStatus extends ConsolidationNeeded {
    recommended: boolean;
}
/** Thresholds used for consolidation recommendations. */
export declare const CONSOLIDATION_ENTRY_THRESHOLD = 25;
/**
 * Validate a single finding text before it is persisted.
 * Returns null if valid, or an error message string if invalid.
 */
export declare function validateFinding(text: string): string | null;
/**
 * Compute consolidation status for a single project directory.
 * Returns null if the project has no FINDINGS.md.
 */
export declare function getProjectConsolidationStatus(dir: string): ConsolidationStatus | null;
/**
 * Check which projects have enough new findings to warrant consolidation.
 * Returns projects that exceed the entry or time thresholds.
 */
export declare function checkConsolidationNeeded(phrenPath: string, profile?: string): ConsolidationNeeded[];
/**
 * Validate FINDINGS.md format and structure.
 * Returns an array of issue description strings (empty array means valid).
 */
export declare function validateFindingsFormat(content: string): string[];
/**
 * Strip the ## Done section (and equivalents) from task content to reduce index bloat.
 * Keeps the title, Active, and Queue sections which are the actionable parts.
 * Handles: Done, Completed, Archived, Finished, Complete.
 */
export declare function stripTaskDoneSection(content: string): string;
/**
 * Validate tasks.md format and structure.
 * Returns an array of issue description strings (empty array means valid).
 */
export declare function validateTaskFormat(content: string): string[];
/**
 * Extract ours/theirs versions from a file containing git conflict markers.
 * Returns null if no conflict markers are found.
 */
export declare function extractConflictVersions(content: string): {
    ours: string;
    theirs: string;
} | null;
/** Raised when a merge would drop content; the caller must leave the conflict alone. */
export declare class FindingsMergeLossError extends Error {
}
/**
 * Merge two FINDINGS.md versions: union entries per date, newest date first.
 *
 * Deduplicates by bullet text, keeping the continuation lines of whichever copy
 * wins (ours takes priority). Preamble and trailing regions are unioned from
 * **both** sides — taking them from `ours` alone silently deleted theirs'
 * archive blocks and non-date sections.
 *
 * Runs unattended (push_changes, session-stop conflict recovery) and its result
 * is committed and pushed, so it verifies itself: every content line of either
 * input must appear in the output, and a merge that cannot manage that throws
 * `FindingsMergeLossError` rather than committing the loss. Callers leave the
 * conflict for the user.
 */
export declare function mergeFindings(ours: string, theirs: string): string;
/**
 * Merge two tasks.md versions: union items per section, deduplicated by stable ID when
 * present or by normalised bullet text otherwise. Context/continuation lines are preserved.
 * Ours wins on conflict. Section order follows Active > Queue > Done.
 */
export declare function mergeTask(ours: string, theirs: string): string;
/** The store paths whose record-oriented markdown can safely use union merge. */
export declare function isAutoMergeableStorePath(relFile: string): boolean;
/**
 * Attempt to auto-resolve git conflicts in union-safe store markdown files.
 * Returns true if all conflicts were resolved, false if any remain.
 */
export declare function autoMergeConflicts(phrenPath: string): boolean;
