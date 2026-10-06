export interface ConflictResolution {
    resolved: string[];
    unresolved: string[];
}
type Strategy = "tasks" | "findings" | "archive" | "topic" | "summary" | "union" | null;
export declare function conflictStrategy(relFile: string): Strategy;
/** Resolves what it can in the store's in-progress merge and stages it. */
export declare function resolveStoreConflicts(cwd: string): ConflictResolution;
export {};
