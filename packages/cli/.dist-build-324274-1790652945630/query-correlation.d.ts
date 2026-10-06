import type { SelectedSnippet } from "./shared/retrieval.js";
export interface CorrelationEntry {
    timestamp: string;
    keywords: string;
    project: string;
    filename: string;
    sessionId?: string;
    helpful?: boolean;
}
/**
 * Check if query correlation feature is enabled via env var.
 */
export declare function isQueryCorrelationEnabled(): boolean;
/**
 * Log query-to-finding correlations after snippet selection.
 * Called from handleHookPrompt after selectSnippets.
 */
export declare function logCorrelations(phrenPath: string, keywords: string, selected: SelectedSnippet[], sessionId?: string): void;
/**
 * Mark correlations from a session as "helpful" when positive feedback is received.
 * This retroactively stamps entries so that future correlation lookups weight them higher.
 */
export declare function markCorrelationsHelpful(phrenPath: string, sessionId: string, docKey: string): void;
/**
 * Find documents that historically correlate with the given query keywords.
 * Returns doc keys (project/filename) sorted by correlation strength.
 *
 * Only looks at the last RECENT_WINDOW entries for performance.
 * Entries marked "helpful" get a 2x weight boost.
 */
export declare function getCorrelatedDocs(phrenPath: string, keywords: string, limit?: number): string[];
