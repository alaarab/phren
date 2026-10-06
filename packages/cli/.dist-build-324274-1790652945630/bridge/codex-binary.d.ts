/** The `codex` the Hook runs for its own helper calls (`codex queue`, `codex
 * app-server`). `phren init` can put a session wrapper at ~/.local/bin/codex
 * that runs phren's session-start hook before the real binary for every
 * subcommand except a bare --help. That takes seconds (about 8 s on the Linux
 * box), longer than the Hook's 5 s `codex queue --help` probe, so Codex async
 * questions were reported as terminal-only, and each call opened a phren
 * session. The Hook skips its own wrapper and runs the binary it names. */
export declare function codexExecutable(env?: NodeJS.ProcessEnv): string;
/** The real binary a phren session wrapper names, "" for a phren wrapper
 * whose target cannot be read, undefined for anything else. */
export declare function phrenWrapperTarget(file: string): string | undefined;
