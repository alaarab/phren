import { type PushStatus, type SyncStatus } from "../shared/governance.js";
/**
 * Extract potential insights from conversation text using keyword heuristics.
 * Returns lines that contain insight-signal words and look like actionable knowledge.
 */
export declare function extractConversationInsights(text: string): string[];
export declare function filterConversationInsightsForProactivity(insights: string[], level?: "high" | "low" | "medium"): string[];
/**
 * Build the `lastSync` patch for a sync attempt, carrying the failure streak
 * forward. Success resets the counter and stamps `lastSuccessfulPushAt`;
 * failure increments it. Without this the runtime health file only ever showed
 * the most recent attempt, so "failed once" and "failed for two months" looked
 * identical.
 */
export declare function nextSyncStatus(previous: SyncStatus | undefined, patch: Omit<SyncStatus, "consecutiveFailures" | "lastSuccessfulPushAt"> & {
    lastPushStatus: PushStatus;
}, now: string): SyncStatus;
export declare function handleHookStop(): Promise<void>;
export declare function handleBackgroundSync(): Promise<void>;
