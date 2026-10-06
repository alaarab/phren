/**
 * Marking a folder the Hook chose as trusted, so a Claude or Codex launched
 * there starts without its folder-trust screen. Claude's default on that
 * screen is "No, exit", so a dispatched worker would otherwise sit there
 * until the owner answers it (the brief is never sent; see dispatch.ts).
 *
 * Only callers that picked the folder themselves use this: a dispatched or
 * scheduled project's resolved source folder and a worktree the Hook just
 * created. Never a parent, never a folder the phone typed in. Each harness
 * gets exactly one key for exactly that path:
 *
 * - Claude: `projects[<dir>].hasTrustDialogAccepted = true` in its global
 *   config (`$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`; a
 *   legacy `<config dir>/.config.json` wins when it exists). Claude checks
 *   that key for the working folder and each parent up to its git root.
 * - Codex: `[projects."<dir>"]` `trust_level = "trusted"` in
 *   `$CODEX_HOME/config.toml`, the table Codex itself writes on "Yes".
 *
 * Both were checked against Claude Code 2.1.280 and codex-cli 0.155.1.
 * `PHREN_PRETRUST=off` turns all of it off.
 */
export type TrustHarness = "claude" | "codex";
export type TrustResult = "trusted" | "already" | "skipped";
export declare function pretrustEnabled(env?: NodeJS.ProcessEnv): boolean;
/** Claude Code's global config file, resolved the way Claude resolves it. */
export declare function claudeGlobalConfigFile(env?: NodeJS.ProcessEnv): Promise<string>;
/**
 * The `projects` key Claude reads for `dir`: the normalized path, with
 * forward slashes on Windows (`C:/Users/me/repo`). Claude 2.1.280 builds
 * every lookup and write key this way (`normalize`, then
 * `replaceAll("\\", "/")` when the platform is Windows) and looks the key up
 * exactly, so a backslash key is never read there.
 */
export declare function claudeProjectKey(dir: string, platform?: NodeJS.Platform): string;
/**
 * Sets `projects[dir].hasTrustDialogAccepted` and nothing else. Claude
 * rewrites this file all the time, so the write happens under Claude's own
 * lock, from a fresh read, and is retried when the file changed between the
 * read and the rename. A missing or unparsable file is left alone: that is
 * a Claude that has not finished its own first run, which needs the owner.
 */
export declare function ensureClaudeFolderTrusted(dir: string, env?: NodeJS.ProcessEnv): Promise<TrustResult>;
/** The config text with `[projects."<dir>"]` trusted, or undefined when it already is. */
export declare function codexTrustedText(text: string, dir: string): string | undefined;
/**
 * Adds or flips the one `trust_level` line for `dir` in Codex's
 * `config.toml`, appending the table when it is absent. The rest of the
 * file is kept byte for byte. An unreadable config is left untouched.
 */
export declare function ensureCodexDirTrusted(dir: string, env?: NodeJS.ProcessEnv): Promise<TrustResult>;
/**
 * Trusts `dir` for `harness` before a launch, when the harness has a trust
 * screen and pre-trust is on. Never throws: a failure is logged and the
 * launch goes on to meet the screen, which dispatch then reports.
 */
export declare function pretrustFolder(harness: string, dir: string, why: string, env?: NodeJS.ProcessEnv): Promise<TrustResult>;
