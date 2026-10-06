export declare const DEFAULT_ACCOUNT = "default";
export interface ClaudeHome {
    /** "default", or the slug of ~/.claude-<slug>. */
    id: string;
    /** The config directory (CLAUDE_CONFIG_DIR for non-default homes). */
    dir: string;
    /** Where Claude Code keeps this home's .claude.json. */
    configFile: string;
    isDefault: boolean;
}
/** What rows, usage and receipts carry to name an account. */
export interface AccountRef {
    id: string;
    label: string;
    key: string;
}
export declare function isAccountSlug(value: string): boolean;
/** Every Claude home on this computer, default first, then by slug. */
export declare function claudeHomes(env?: NodeJS.ProcessEnv): ClaudeHome[];
export declare function claudeHome(id: string | undefined, env?: NodeJS.ProcessEnv): ClaudeHome | undefined;
/** The home a transcript or other file lives in, by longest matching directory. */
export declare function claudeHomeOfPath(file: string, env?: NodeJS.ProcessEnv): ClaudeHome | undefined;
/** Environment a launch into this home needs; empty for the default home. */
export declare function claudeLaunchEnv(home: ClaudeHome): Record<string, string>;
/** The config home a running Claude process uses, from its CLAUDE_CONFIG_DIR. */
export declare function claudeHomeOfEnv(value: string | undefined, env?: NodeJS.ProcessEnv): ClaudeHome | undefined;
export declare const accountsFile: () => string;
export declare function accountLabel(id: string, labels?: Record<string, string>): string;
export declare function setAccountLabel(id: string, label: string): Promise<void>;
/** Stable across computers for one subscription; home-scoped when unknown. */
export declare function claudeAccountKey(home: ClaudeHome): string;
export declare function claudeAccountRef(home: ClaudeHome, labels?: Record<string, string>): AccountRef;
export declare const CODEX_ACCOUNT: AccountRef;
/** Only for tests. */
export declare function clearAccountCaches(): void;
/** `unknown`: Claude gave no answer (timeout, crash, unparseable), which must not block a launch. */
export interface AuthStatus {
    signedIn: boolean;
    unknown?: boolean;
    plan?: string;
    reason?: string;
}
/** Parse `claude auth status --json`. Never keeps anything but the state and plan. */
export declare function parseAuthStatus(output: string): AuthStatus;
export type AuthRunner = (home: ClaudeHome) => Promise<string>;
export declare function claudeAuthStatus(home: ClaudeHome, run?: AuthRunner, now?: number): Promise<AuthStatus>;
