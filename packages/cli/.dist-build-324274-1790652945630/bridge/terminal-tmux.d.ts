import { type Json } from "./protocol.js";
import type { TerminalProvider } from "./terminal.js";
/** The owner's own tmux server (the default socket). */
export declare const TMUX_DEFAULT = "tmux";
/** The hidden server phone-started agents run in: `tmux -L phren`. */
export declare const TMUX_HIDDEN = "tmux-phren";
/** The tmux socket name (`-L`) a Hook server name stands for: "tmux" is the
 * default socket and "tmux-<name>" the socket `<name>`. */
export declare function tmuxSocketName(server: string): string | undefined;
/** The Hook server name for a tmux socket name. */
export declare function tmuxServerName(socket: string): string | undefined;
/** Runs tmux with `args` (after the socket flags) and answers its stdout. */
export type TmuxRunner = (args: string[], options?: {
    input?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
}) => Promise<string>;
interface TmuxDeps {
    /** The tmux executable, or undefined when this computer has none. */
    binary: () => string | undefined;
    run: (socket: string, args: string[], options?: {
        input?: string;
        timeoutMs?: number;
        signal?: AbortSignal;
    }) => Promise<string>;
    /** `ps` rows: pid, process group, terminal's foreground group, terminal, command line. */
    processes: () => Promise<string>;
    /** `tmux -V`. */
    version: () => Promise<string>;
    /** The names of the tmux sockets this user has, whether or not they answer. */
    sockets: () => Promise<string[]>;
    sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}
/** The tmux on PATH or in the usual install folders; the Hook's service
 * PATH can be shorter than a login shell's. Rechecked every minute. */
export declare function tmuxBinary(): string | undefined;
/** The folders this user's tmux sockets live in: `$TMUX_TMPDIR/tmux-<uid>`,
 * where `-L` looks, then `/tmp/tmux-<uid>` when TMUX_TMPDIR points elsewhere
 * (a server started from a shell with another TMUX_TMPDIR than the Hook's). */
export declare function tmuxSocketFolders(env?: NodeJS.ProcessEnv): string[];
/** The tmux sockets in `folder` this user owns, by name (at most 32). A socket
 * outside the first folder of `tmuxSocketFolders` is remembered by path. */
export declare function tmuxSocketsIn(folder: string): Promise<string[]>;
/** For tests: replace how tmux and ps run; the returned function restores them. */
export declare function setTmuxDeps(replacement: Partial<TmuxDeps>): () => void;
declare const SIGILS: {
    readonly s: "$";
    readonly w: "@";
    readonly p: "%";
};
export declare function fromTmuxId(value: string): string | undefined;
export declare function toTmuxId(value: string, kind: keyof typeof SIGILS): string;
/** The agent a command line runs, by the harness's executable or package. */
export declare function agentFromCommand(command: string): string | undefined;
interface Proc {
    pid: number;
    pgid: number;
    tpgid: number;
    tty: string;
    args: string;
}
export declare function parseProcesses(text: string): Proc[];
declare const FIELDS: readonly ["session_id", "session_name", "session_attached", "session_activity", "window_id", "window_name", "window_active", "pane_id", "pane_pid", "pane_tty", "pane_active", "pane_current_path", "pane_current_command", "@phren_agent", "pane_title"];
type Row = Record<(typeof FIELDS)[number], string>;
export declare function parsePanes(text: string): Row[];
/** One tmux server in the shape of the Hook's pane snapshot (the shape
 * Herdr's `session.snapshot` answers): workspaces are tmux sessions, tabs
 * windows, panes panes. */
export declare function tmuxSnapshot(server: string): Promise<Json>;
/** The Hook's key names as tmux key names; undefined for a literal character. */
export declare function tmuxKey(key: string): string | undefined;
/** send-keys calls for `keys`, in order: named keys together, literal characters with -l. */
export declare function sendKeysCalls(pane: string, keys: string[]): string[][];
export declare const tmuxTerminal: TerminalProvider;
/** The tmux servers the Hook drives, as `/v1/muxes` lists servers: the owner's
 * servers that answer, and (unless `hidden: false`) the hidden server whenever
 * tmux is installed (a launch starts it). An already running hidden server
 * remains discoverable beside Herdr too. `kind` names the actual multiplexer. */
export declare function tmuxServers(options?: {
    hidden?: boolean;
}): Promise<Json[]>;
/** What `phren bridge doctor` and the health details say about tmux. */
export interface TmuxHealth {
    /** "off" when PHREN_TMUX=off, "missing" without a tmux executable. */
    state: "ok" | "off" | "missing";
    version?: string;
    /** Whether this tmux can start agents (3.0 and later). */
    launches?: boolean;
    /** The owner's servers that answer, by Hook server name. */
    servers?: string[];
    /** The hidden server phone launches use: running with its session count, or not started yet. */
    hidden?: {
        running: boolean;
        sessions?: number;
    };
}
export declare function tmuxHealth(): Promise<TmuxHealth>;
/** The tmux pane this process runs in, from the variables tmux sets in every
 * pane, with its session and window asked of that server. */
export declare function tmuxPaneFromEnv(env?: NodeJS.ProcessEnv): Promise<{
    server: string;
    workspace: string;
    tab: string;
    pane: string;
} | undefined>;
/** The command that attaches the phone's SSH terminal to a tmux server. */
export declare function tmuxAttach(server: string): {
    file: string;
    args: string[];
};
/** For tests: forget the tmux executable lookup and the sockets found by path. */
export declare function resetTmuxBinary(): void;
export {};
