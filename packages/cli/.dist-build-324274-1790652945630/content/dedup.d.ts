export declare function callLlm(prompt: string, signal?: AbortSignal, maxTokens?: number, timeoutMs?: number): Promise<string>;
/**
 * Strip all common finding metadata:
 * - HTML comments: <!-- ... -->
 * - "migrated from" annotations: (migrated from ...)
 * - Leading bullet dash: "- " at the start of the string
 */
export declare function stripMetadata(s: string): string;
export declare function jaccardTokenize(text: string): Set<string>;
export declare function jaccardSimilarity(a: Set<string>, b: Set<string>): number;
/**
 * Scan existing findings for proper nouns / tool names that appear in 2+ bullets.
 * Results are cached in .runtime/project-entities-{project}.json (1h TTL or
 * invalidated when FINDINGS.md changes).
 */
export declare function extractDynamicEntities(phrenPath: string, project: string): Set<string>;
/** Returns existing learning lines that appear to conflict with newFinding. */
export declare function detectConflicts(newFinding: string, existingLines: string[], dynamicEntities?: Set<string>): string[];
export declare function isDuplicateFinding(existingContent: string, newLearning: string, threshold?: number): boolean;
/**
 * Normalize known observation tags in learning text to lowercase.
 * Returns the normalized text and a warning if unknown bracket tags are found.
 */
export declare function normalizeObservationTags(text: string): {
    text: string;
    warning?: string;
};
export { looksLikePlaceholderSecret, scanForSecrets, redactSecretsForLog } from "./secrets.js";
/**
 * Resolve coreferences in learning text by replacing vague pronouns with concrete names.
 */
export declare function resolveCoref(text: string, context: {
    project?: string;
    file?: string;
}): string;
/**
 * LLM-based semantic dedup check. Only called when PHREN_FEATURE_SEMANTIC_DEDUP=1.
 * Must be called before addFindingToFile() since that function is sync.
 * Returns true if the new learning is a semantic duplicate of any existing bullet.
 */
export declare function checkSemanticDedup(phrenPath: string, project: string, newLearning: string, signal?: AbortSignal): Promise<boolean>;
/**
 * LLM-based conflict check. Only called when PHREN_FEATURE_SEMANTIC_CONFLICT=1.
 * Call after detectConflicts() in addFindingToFile flow.
 * Returns conflict annotations to append to the bullet.
 * Also scans global findings and other projects for cross-project contradictions.
 * Has a 30-second total timeout; returns partial results if the deadline is hit.
 */
export declare function checkSemanticConflicts(phrenPath: string, project: string, newFinding: string, signal?: AbortSignal): Promise<{
    annotations: string[];
    checked: boolean;
}>;
