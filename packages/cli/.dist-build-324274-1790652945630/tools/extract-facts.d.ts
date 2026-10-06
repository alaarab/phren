/**
 * Structured fact extraction from findings (PHREN_FEATURE_FACT_EXTRACT=1).
 * Each new finding is passed to an LLM that extracts a preference or fact
 * ("prefers X", "uses Y", "avoids Z"). Stored in project/preferences.json
 * and surfaced in session_start.
 */
export interface ExtractedFact {
    fact: string;
    source: string;
    at: string;
}
export declare function readExtractedFacts(phrenPath: string, project: string): ExtractedFact[];
/**
 * Fire-and-forget: extract a structured fact from a new finding using an LLM.
 * Skips silently if the feature flag is off or no LLM is configured.
 */
export declare function extractFactFromFinding(phrenPath: string, project: string, finding: string): void;
