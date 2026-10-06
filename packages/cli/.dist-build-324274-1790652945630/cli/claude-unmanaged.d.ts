export interface ClaudeHookPayload {
    session_id?: string;
    transcript_path?: string;
    cwd?: string;
}
export declare function readClaudeHookPayload(): ClaudeHookPayload | undefined;
/** Returns true for a recognized unmanaged headless worker, even when already registered. */
export declare function registerUnmanagedClaude(payload: ClaudeHookPayload | undefined, store: string, cwd: string, env?: NodeJS.ProcessEnv, processInfo?: {
    pid: number;
    headless: boolean;
}): boolean;
export declare function finishUnmanagedClaude(payload: ClaudeHookPayload | undefined, store: string): boolean;
