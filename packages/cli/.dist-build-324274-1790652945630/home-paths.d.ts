/** The user's home: an absolute `HOME` when set (tests and POSIX), else
 * `USERPROFILE`, else the OS's answer. `os.homedir()` ignores `HOME` on Windows. */
export declare function homeDir(env?: NodeJS.ProcessEnv): string;
/** Claude Code's config directory: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export declare function claudeConfigDir(env?: NodeJS.ProcessEnv): string;
/** Codex's home: `CODEX_HOME`, else `~/.codex`. */
export declare function codexHome(env?: NodeJS.ProcessEnv): string;
