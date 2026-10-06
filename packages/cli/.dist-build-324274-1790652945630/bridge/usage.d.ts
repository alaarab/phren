import { execFile } from "node:child_process";
import { type AccountRef, type ClaudeHome } from "./claude-accounts.js";
export interface UsageWindow {
    id: string;
    name: string;
    /** A percentage is omitted rather than invented when a service has no limit. */
    usedPercent?: number;
    /** Local Go-ledger values; quota readers deliberately do not use these. */
    usedUSD?: number;
    limitUSD?: number;
    usedTokens?: number;
    resetsAt?: string;
    /** The service says this window is refusing requests now (OpenCode Go's `rate-limited`). */
    limited?: boolean;
    asOf?: string;
}
export interface UsageSpend {
    amountUSD: number;
    period: "rolling_7_days" | "rolling_30_days" | "calendar_week";
}
export interface AccountUsage {
    source: "codex" | "claude" | "opencode" | "opencode-go" | "openrouter" | "copilot";
    windows: UsageWindow[];
    updatedAt?: string;
    message?: string;
    spend?: UsageSpend;
    /** Opaque key identity used only to avoid counting one OpenRouter key twice. */
    accountId?: string;
    /** Which Claude report fed this account: the status-line rate_limits payload
     *  or the OAuth usage endpoint. Per-model windows the status line never
     *  carries document their own age through each window's asOf instead. */
    origin?: "status-line" | "oauth";
    /** Which account this row is: a Claude home, or Codex's single one. Older phones ignore it. */
    account?: AccountRef;
}
export declare function codexUsage(value: unknown, now?: Date): AccountUsage;
/** Parse OpenCode's own cost ledger. `stats --days 7` is a rolling local view. */
export declare function openCodeUsage(output: string, now?: Date): AccountUsage;
/** Read the authoritative cost that OpenCode records for its local sessions. */
export declare function readOpenCodeUsage(executable?: string, now?: Date): Promise<AccountUsage>;
/** Not installed, not signed in and a failing command each say so, with the command's own first line. */
export declare function openCodeFailure(error: unknown): string;
/** OpenCode's OpenRouter key stays local and is used only with OpenRouter. */
export declare function readOpenRouterKey(): Promise<string | undefined>;
/** OpenCode Go's key stays local and is sent only to the Go gateway. */
export declare function readOpenCodeGoKey(): Promise<string | undefined>;
/**
 * Go's own report of the plan, `GET /zen/go/v1/usage`:
 * `{usage: {rolling|weekly|monthly: {status, percent, resetsAt}}}`. It is
 * account-wide, so it already counts every computer's use, and it is what
 * Go enforces: `status: "rate-limited"` is the window that refuses requests.
 * It carries no dollar amounts, so none are shown.
 */
export declare function openCodeGoPlan(value: unknown): UsageWindow[];
export declare function fetchOpenCodeGoPlan(key: string, fetchImpl?: typeof fetch): Promise<UsageWindow[]>;
export interface GoRefusals {
    count: number;
    first: string;
    last: string;
    models: string[];
}
/** "Go usage limit exceeded" refusals in OpenCode's own log over the last
 * `withinMs`. The first read of a log covers at most its last 64 MB. */
export declare function readGoRefusals(now?: Date, withinMs?: number, root?: string): Promise<GoRefusals | undefined>;
export declare function openCodeGoUsage(windows: UsageWindow[], refusals: GoRefusals | undefined, now: Date, hasKey: boolean, planError?: boolean): AccountUsage;
/** The accounts one caller can read: the sources it names, and Go's plan
 * windows only for a caller that asked for them (`goPlan=1`). */
export declare function usageForCaller(accounts: AccountUsage[], sources: Set<string>, goPlan: boolean): AccountUsage[];
export declare function readOpenCodeGoUsage(now?: Date, options?: {
    readKey?: () => Promise<string | undefined>;
    fetchImpl?: typeof fetch;
    readRefusals?: (now: Date) => Promise<GoRefusals | undefined>;
}): Promise<AccountUsage>;
/** OpenRouter reports the current UTC calendar week's charged usage per key. */
export declare function fetchOpenRouterUsage(key: string, fetchImpl?: typeof fetch, now?: Date): Promise<AccountUsage>;
/** Claude Code's documented status-line payload: rate_limits carries the
 *  five_hour and seven_day windows (the 5h/7d unified limits) and, when the
 *  build emits them, per-model keys such as seven_day_fable. Every window
 *  keeps its own reset time; a per-model window is its own weekly allowance
 *  with its own denominator, not a subset of seven_day, so it can show a
 *  higher percentage without contradicting the all-models window. */
export declare function claudeUsage(value: unknown, now?: Date): AccountUsage;
/**
 * Claude's per-model weekly windows (Fable today) never reach the status
 * line, so they come from the snapshot Claude Code itself keeps of its usage
 * endpoint in ~/.claude.json — refreshed whenever Claude opens /usage or
 * checks a limit. Each window carries the snapshot's own time so the phone
 * can say how old it is. No sign-in token is read or sent.
 */
export declare function claudeScopedWindows(config: unknown, now?: Date): UsageWindow[];
/**
 * The OAuth usage endpoint Claude Code itself reads, mapped to the same
 * windows the status-line snapshot produces. `limits` is the structured
 * list (session, weekly_all, weekly_scoped with the model name); the older
 * per-key fields are ignored because `limits` already carries them.
 */
export declare function claudeOAuthUsage(value: unknown, now?: Date): AccountUsage;
/**
 * Claude Code's own sign-in token, read locally and used only against
 * Anthropic's usage endpoint — never persisted, logged, or sent elsewhere.
 * The file is authoritative off macOS; macOS keeps it in the login keychain,
 * with the file left stale after a refresh. A non-default `home` reads only its
 * own file, and nothing on macOS (its keychain item name is unverified).
 */
export declare function readClaudeToken(execSecurity?: typeof execFile.__promisify__, platform?: NodeJS.Platform, home?: ClaudeHome): Promise<string | undefined>;
/** Fetch live limits; any failure falls back to the local snapshot. */
export declare function fetchClaudeUsage(token: string, fetchImpl?: typeof fetch, now?: Date): Promise<AccountUsage>;
/** Only initialize and read limits. Never create a thread, prompt, or login. */
export declare function readCodexLimits(executable?: string): Promise<AccountUsage>;
/**
 * GitHub Copilot's own quota report (`gh api /copilot_internal/user`): one
 * window per limited quota (premium requests, usually) with the monthly
 * reset. Unlimited quotas are named in the message, not drawn as 0%.
 */
export declare function copilotUsage(value: unknown, now?: Date): AccountUsage;
/** Reads through the GitHub CLI's own sign-in; the token never reaches Phren. */
export declare function readCopilotUsage(now?: Date, run?: (file: string, args: string[]) => Promise<string>): Promise<AccountUsage>;
export declare class AccountUsageReader {
    private readCodex;
    private now;
    private readClaudeLive;
    private readOpenCode;
    private readOpenRouter;
    private readOpenCodeGo;
    private readCopilot;
    private platform;
    private cached?;
    private pending?;
    private claudeCached;
    private claudePending;
    private spendingCached;
    private spendingPending;
    constructor(readCodex?: typeof readCodexLimits, now?: () => number, readClaudeLive?: (now: Date, home: ClaudeHome) => Promise<AccountUsage | undefined>, readOpenCode?: (now: Date) => Promise<AccountUsage>, readOpenRouter?: (now: Date) => Promise<AccountUsage | undefined>, readOpenCodeGo?: (now: Date) => Promise<AccountUsage>, readCopilot?: (now: Date) => Promise<AccountUsage>, platform?: NodeJS.Platform);
    /** `allAccounts`: one Claude row per home. Otherwise only the default home's, as
     *  before accounts existed, since older phones refuse two rows of one source. */
    read(sources?: Set<string>, allAccounts?: boolean): Promise<{
        accounts: AccountUsage[];
    }>;
    private spending;
    /** Live first, so the phone's minute-by-minute poll keeps Claude current
     *  even when Claude Code is not running; the local snapshot is the backup.
     *  Off macOS a non-default home reads its own credentials file; on macOS it
     *  has no live read (the keychain item name for custom homes is unverified). */
    private claude;
    private snapshotClaude;
}
/** Wrap an existing status line, preserving its input, output and options. */
export declare function usageStatusLine(current: unknown, program: string, remove: boolean): unknown;
export declare function captureClaudeUsage(original: string): Promise<void>;
