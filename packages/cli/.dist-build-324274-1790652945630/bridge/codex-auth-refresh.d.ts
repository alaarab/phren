/**
 * Every Codex process on a computer shares one ChatGPT sign-in in
 * `$CODEX_HOME/auth.json`, and each refreshes it when `last_refresh` grows
 * old (Codex's own threshold is 8 days). The refresh token rotates on every
 * use, so processes that reach the threshold together (a batch of workers,
 * one app-server per pane) race: one wins, the rest spend a token that is
 * already used and fail ("refresh token was already used"). Codex re-reads
 * the file before refreshing and skips when another process already did.
 * So the Hook refreshes first, once, before any process reaches the
 * threshold, and the others take that skip path.
 */
/** Refresh when the sign-in is this old: well before Codex's 8 days. */
export declare const REFRESH_AFTER_MS: number;
/** The sign-in's last refresh, or undefined when auth.json holds no ChatGPT
 * sign-in (an API key, no file) and there is nothing to refresh. */
export declare function lastCodexRefresh(file?: string): Promise<number | undefined>;
export declare function codexAuthRefreshEnabled(env?: NodeJS.ProcessEnv): boolean;
export interface CodexAuthRefresher {
    /** One proactive refresh through Codex's own flow (`account/read` with
     * `refreshToken`). */
    refreshAuth(): Promise<void>;
}
/** Checks the sign-in's age and refreshes it once when it is due. One check
 * runs at a time; a failed refresh is logged and tried again next tick. */
export declare class CodexAuthKeeper {
    private readonly refresher;
    private readonly file?;
    private readonly now;
    private running?;
    constructor(refresher: CodexAuthRefresher, file?: string | undefined, now?: () => number);
    tick(): Promise<boolean>;
    private check;
}
