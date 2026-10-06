import { type PhrenErrorCode } from "./shared.js";
export interface HookError {
    code: PhrenErrorCode;
    message: string;
}
export declare function commandExists(cmd: string): boolean;
export declare function detectInstalledTools(): Set<string>;
/**
 * True if a path lives inside an ephemeral npx download cache
 * (`~/.npm/_npx/<hash>/…`). Baking such a path into a hook command that has no
 * self-healing fallback is fragile: npx prunes that cache and the `<hash>`
 * segment changes between versions, silently breaking every phren hook. Hook
 * commands that resolve here must fall back to `npx -y <spec>` (which
 * re-resolves on every run) or the ~/.local/bin/phren wrapper instead.
 */
export declare function isEphemeralNpxPath(p: string): boolean;
/**
 * Hook commands whose entrypoint no longer exists on disk. Deduplicated, so an
 * upgrade that breaks all four lifecycle hooks reports one path, not four.
 */
export declare function findStaleHookEntrypoints(commands: readonly string[]): string[];
export declare function phrenPackageSpec(): string;
/** Shell-escape a value by wrapping in single quotes with proper escaping of embedded single quotes. */
export declare function shellEscape(s: string): string;
export interface LifecycleCommands {
    sessionStart: string;
    userPromptSubmit: string;
    stop: string;
    hookTool: string;
}
export interface BuildLifecycleOptions {
    /**
     * Force POSIX shell syntax even on Windows. Used for tools that execute
     * hook commands via Git Bash (e.g. GitHub Copilot CLI's `bash:` key).
     */
    forcePosix?: boolean;
}
export declare function buildLifecycleCommands(phrenPath: string, options?: BuildLifecycleOptions): LifecycleCommands;
export declare function buildSharedLifecycleCommands(): LifecycleCommands;
/**
 * Windows-only: append `~/.local/bin` to the user's persistent PATH if it
 * isn't already there. On Linux/macOS `~/.local/bin` is on PATH by default
 * (XDG / `.profile`); on Windows nothing adds it, so the `phren.cmd` wrapper
 * is invisible to cmd/PowerShell/Git Bash until we fix PATH.
 *
 * Reads/writes the User PATH directly from the registry under
 * `HKCU\Environment` so we (a) keep the original value kind — `REG_EXPAND_SZ`
 * vs `REG_SZ` — intact, and (b) preserve any `%VAR%` references the user has
 * in their PATH. Going through `[Environment]::GetEnvironmentVariable` /
 * `SetEnvironmentVariable` would silently expand `%VAR%` on read and write
 * the result back as `REG_SZ`, baking expansions in permanently and
 * downgrading the registry type — corrupting unrelated PATH entries.
 *
 * After writing, broadcasts `WM_SETTINGCHANGE` so newly-launched processes
 * pick up the change without waiting for a logoff.
 *
 * Returns:
 *   "added"      — PATH was updated (user must open a new terminal).
 *   "already"    — dir was already on the user PATH.
 *   "skipped"    — not Windows (nothing to do).
 *   "failed"     — PowerShell call failed; caller should surface a manual hint.
 */
export declare function ensureLocalBinOnWindowsPath(): "added" | "already" | "skipped" | "failed";
/**
 * Install a lightweight `phren` CLI wrapper at ~/.local/bin/phren so the bare
 * `phren` command works without a global npm install. The wrapper simply execs
 * `node <entry_script> "$@"`.
 */
/** Whether a wrapper may be rewritten for `entry`: always, unless `entry` is
 * an ephemeral npx copy and the wrapper already runs a lasting entry that exists. */
export declare function keepsWrapperEntry(existing: string, entry: string, exists?: (file: string) => boolean): boolean;
export declare function installPhrenCliWrapper(phrenPath: string): boolean;
export interface HookToolPreferences {
    claude?: boolean;
    copilot?: boolean;
    cursor?: boolean;
    codex?: boolean;
}
export declare function clearHookPrefsCache(): void;
export declare function isToolHookEnabled(phrenPath: string, tool: string): boolean;
export type CustomHookEvent = "pre-save" | "post-save" | "post-search" | "pre-finding" | "post-finding" | "pre-index" | "post-index" | "post-session-end" | "post-consolidate" | "pre-prompt";
export interface CommandHookEntry {
    event: CustomHookEvent;
    command: string;
    timeout?: number;
}
export interface WebhookHookEntry {
    event: CustomHookEvent;
    webhook: string;
    secret?: string;
    timeout?: number;
}
export type CustomHookEntry = CommandHookEntry | WebhookHookEntry;
export declare const HOOK_EVENT_VALUES: readonly ["pre-save", "post-save", "post-search", "pre-finding", "post-finding", "pre-index", "post-index", "post-session-end", "post-consolidate", "pre-prompt"];
/** Return the target (URL or shell command) for display or matching. */
export declare function getHookTarget(h: CustomHookEntry): string;
export declare function validateCustomHookCommand(command: string): string | null;
export declare function validateCustomWebhookUrl(webhook: string): string | null;
export declare function readCustomHooks(phrenPath: string): CustomHookEntry[];
export declare function runCustomHooks(phrenPath: string, event: CustomHookEvent, env?: Record<string, string>): {
    ran: number;
    errors: HookError[];
};
/**
 * Read the set of pre-prompt command strings already registered as sibling
 * UserPromptSubmit entries in Claude Code's settings.json. Used by
 * runPrePromptHooks to avoid double-running a hook that Claude Code is
 * already invoking directly (in parallel with phren's own hook).
 *
 * Returns an empty set on any error or if the settings file doesn't exist.
 */
export declare function getRegisteredPrePromptSiblingCommands(): Set<string>;
/**
 * Run pre-prompt custom hooks, piping stdinJson to each and capturing stdout.
 * Returns concatenated stdout from all matching hooks (empty string if none).
 *
 * Skips any hook whose command is already registered as a sibling
 * UserPromptSubmit entry in Claude Code's settings.json — those are dispatched
 * directly by Claude Code in parallel with phren's hook, so re-running them
 * here would duplicate their work and (worse) re-import their slow latency
 * into phren's response budget.
 */
export declare function runPrePromptHooks(phrenPath: string, stdinJson: string, siblingCommandsOverride?: Set<string>): string;
export interface HookConfigOptions {
    tools?: Set<string>;
    allTools?: boolean;
    /**
     * Whether to install ~/.local/bin session wrappers. Defaults to the current
     * management preset's `installWrappers` capability. Assisted/manual presets
     * skip wrappers (hooks fall back to node/npx invocation).
     */
    installWrappers?: boolean;
}
export declare function configureAllHooks(phrenPath: string, options?: HookConfigOptions): string[];
