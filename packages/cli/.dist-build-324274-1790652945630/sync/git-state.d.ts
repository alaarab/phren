export type GitOperation = "rebase" | "merge" | "cherry-pick" | "revert" | "sequencer" | "index lock";
/** Detect user-owned Git state without running a command that could alter it. */
export declare function inProgressGitOperation(store: string): GitOperation | undefined;
export declare function gitOperationRecovery(operation: GitOperation): string;
