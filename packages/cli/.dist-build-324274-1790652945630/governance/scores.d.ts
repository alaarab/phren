export interface EntryScore {
    impressions: number;
    helpful: number;
    repromptPenalty: number;
    regressionPenalty: number;
    lastUsedAt: string;
}
export declare function flushEntryScores(phrenPath: string): void;
export declare function entryScoreKey(project: string, filename: string, snippet: string): string;
export declare function recordInjection(phrenPath: string, key: string, sessionId?: string): void;
/**
 * Injected snippet headers label the score key as `fb:<key>` so an agent can
 * see it. Callers are told to pass it without that prefix, but a model that
 * copies the token verbatim would otherwise score a key no `entryScoreKey`
 * can ever produce — an `ok: true` no-op, which is exactly the silent failure
 * printing the key was meant to end. Accept both spellings.
 */
export declare function normalizeFeedbackKey(key: string): string;
export declare function recordFeedback(phrenPath: string, rawKey: string, feedback: "helpful" | "reprompt" | "regression", sessionId?: string): void;
export declare function getQualityMultiplier(phrenPath: string, key: string): number;
