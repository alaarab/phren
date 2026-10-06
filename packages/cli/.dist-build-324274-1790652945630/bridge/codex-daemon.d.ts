/** A conversation begins as its TUI starts; allow for clock rounding. */
export declare const START_SLACK_MS = 5000;
export interface ProcessRow {
    pid: number;
    ppid: number;
    startedAt: number;
    command: string;
}
export interface DaemonRollout {
    id: string;
    cwd: string;
    startedAt: number;
    activeAt: number;
    held: boolean;
}
/** `ps` etime: `[[dd-]hh:]mm:ss`, in milliseconds. */
export declare function parseElapsed(text: string): number | undefined;
/** Every process with its parent, start time and command line, from one `ps`. */
export declare function processTable(now?: number): Promise<ProcessRow[]>;
export declare function isCodexDaemon(command: string): boolean;
/** When a pane's agent started: its oldest foreground process. */
export declare function startedAt(rows: ProcessRow[], pids: number[]): number | undefined;
/** True when this process runs under a Codex app-server daemon: a hook the
 * daemon ran carries the environment of the pane that started the daemon,
 * which is not the pane of the conversation it reports. */
export declare function underCodexDaemon(env?: NodeJS.ProcessEnv, pid?: number): Promise<boolean>;
/** The session_meta fields identity needs, from a rollout's first line read
 * at most META_BYTES deep. Codex 0.157 writes its whole base instructions into
 * that line, so a cut line is read field by field instead of parsed. */
export declare function rolloutMeta(file: string): Promise<{
    id: string;
    cwd: string;
    startedAt: number;
    subagent: boolean;
} | undefined>;
/**
 * The conversations a running Codex daemon holds open (by `openFiles`, the
 * caller's lsof or /proc read), else, when it holds none, the recent rollouts
 * in Codex's sessions folder. Empty when no daemon runs: a TUI that runs its
 * own conversation holds its rollout itself.
 */
export declare function daemonRollouts(openFiles: (pids: number[]) => Promise<string[]>, now?: number): Promise<DaemonRollout[]>;
export declare function resetCodexDaemonCache(): void;
export declare function sameDirectory(a: unknown, b: unknown): Promise<boolean>;
/**
 * Which daemon conversation a Codex pane shows, given the conversations in
 * its folder, when its TUI started, which ones other panes' processes hold,
 * and when every other Codex pane in that folder started.
 *
 * With no other Codex pane in the folder, the pane shows the most recently
 * active conversation begun since its TUI started, so a later /new or
 * /resume follows. With several, the latest-started pane chooses first (ties
 * by pane key), each taking the earliest conversation begun after it started.
 */
export interface CodexPaneStart {
    key: string;
    start: number;
}
export declare function assignDaemonConversation(here: DaemonRollout[], self: CodexPaneStart, claimed: Set<string>, rivals: CodexPaneStart[], now?: number): string | undefined;
