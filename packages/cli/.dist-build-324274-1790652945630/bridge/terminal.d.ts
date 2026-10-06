import { type Json } from "./protocol.js";
/** The pane this process runs in, from the variables its multiplexer sets:
 * inside Herdr only Herdr's pane counts, elsewhere a tmux pane does. */
export declare function terminalPaneFromEnv(env?: NodeJS.ProcessEnv): Promise<{
    server: string;
    workspace: string;
    tab: string;
    pane: string;
} | undefined>;
/** A pane as the multiplexer lists it. `server` names the multiplexer instance
 * (a Herdr session, a tmux socket), `workspace` and `tab` its place in it
 * (a Herdr workspace and tab, a tmux session and window). */
export interface TerminalPane {
    server: string;
    workspace: string;
    tab: string;
    pane: string;
    /** The foreground process's directory, else the pane's own. */
    cwd?: string;
    title?: string;
    label?: string;
    /** What the multiplexer itself knows about the agent in the pane. Optional:
     * a provider without agent awareness returns none. */
    hints?: {
        /** Which agent runs there ("claude", "codex", …). */
        agent?: string;
        /** "working", "idle", "blocked", "waiting", "done" or "unknown". */
        status?: string;
        /** The conversation id the multiplexer reports for the agent. */
        session?: string;
    };
}
/** The processes a pane runs. */
export interface PaneProcesses {
    shellPid?: number;
    /** The pane's foreground process group, in the multiplexer's order. */
    foregroundPids: number[];
}
/** One read of what a pane draws. */
export interface ScreenRead {
    /** "agent" reads through the pane's agent (refused while none runs there);
     * "pane" reads any pane, including one whose agent is still starting. */
    scope: "agent" | "pane";
    /** The visible screen, or the recent scrollback. */
    source: "visible" | "recent";
    lines: number;
    /** Plain text unless false. */
    stripAnsi?: boolean;
    /** "ansi" keeps the styles even where the multiplexer strips by default. */
    format?: "ansi";
    timeoutMs?: number;
}
/** A new pane: a tab in `workspace`, or a new workspace when it is absent.
 * `env` is added to the pane's shell environment, so an agent started there
 * inherits it (Herdr takes variables only here, at pane creation). */
export interface PanePlacement {
    workspace?: string;
    label?: string;
    cwd?: string;
    env?: Record<string, string>;
}
/** Starts an agent in an existing, empty pane. `env` is the same variables as
 * the pane's placement, for a provider that starts the agent in a fresh
 * process of its own (tmux respawns the pane). */
export interface AgentStart {
    name: string;
    kind: string;
    args: string[];
    timeoutMs: number;
    env?: Record<string, string>;
}
/**
 * Key names are the Hook's vocabulary: "enter", "esc", "up", "down", "tab",
 * "space", "shift+tab", "alt+Up" and single characters. A provider maps them to its own.
 *
 * Every method rejects with a BridgeError when the multiplexer refuses or is
 * unreachable; the message is shown to the phone.
 */
export interface TerminalProvider {
    readonly kind: string;
    /** Resolves when `server` is running and answering. */
    ping(server: string): Promise<void>;
    /**
     * The server's panes in the Hook's snapshot shape, the one Herdr's
     * `session.snapshot` answers: `workspaces` (`workspace_id`, `label`), `tabs`
     * (`tab_id`, `workspace_id`, `label`, `agent_status`) and `panes`
     * (`pane_id`, `tab_id`, `workspace_id`, `terminal_id`, `cwd`,
     * `foreground_cwd`, `title`, `label`, `agent`, `agent_status`,
     * `agent_name`, `state_change_seq`), plus `focused_workspace_id` /
     * `focused_tab_id` / `focused_pane_id`. `terminal_id` names the terminal
     * instance, so a pane reused by a new shell is a different terminal.
     */
    snapshot(server: string): Promise<Json>;
    listPanes(server: string): Promise<TerminalPane[]>;
    processes(server: string, pane: string): Promise<PaneProcesses>;
    readScreen(server: string, pane: string, read: ScreenRead): Promise<string>;
    sendKeys(server: string, pane: string, keys: string[]): Promise<void>;
    /** Types `text` and sends the submit key. Success acknowledges transport,
     * not a submitted turn; the harness must confirm that separately. */
    prompt(server: string, pane: string, text: string, signal?: AbortSignal): Promise<void>;
    /** Opens a pane; the caller finds it in the next `listPanes`. */
    create(server: string, placement: PanePlacement): Promise<void>;
    startAgent(server: string, pane: string, agent: AgentStart): Promise<void>;
    /** The variables a process started for `pane` outside it needs to be
     * recognized as running there (a Codex app-server whose hooks report the
     * pane). Absent where the multiplexer has none. */
    paneEnv?(server: string, place: {
        workspace: string;
        tab: string;
        pane: string;
    }): Record<string, string> | undefined;
    focusPane(server: string, pane: string): Promise<void>;
    /** Focuses, renames or closes a whole tab (when `tab` is set) or workspace. */
    groupAction(server: string, operation: "focus" | "rename" | "close", group: {
        workspace?: string;
        tab?: string;
    }, label?: string): Promise<void>;
}
/** Which multiplexer a Hook server name belongs to: "tmux" and "tmux-<socket>"
 * are tmux servers unless Herdr has a session of that name; every other name
 * is a Herdr server, exactly as before tmux support. */
export declare function terminalKind(server: string): "herdr" | "tmux";
/** The multiplexer's name as the phone shows it in messages. */
export declare function terminalName(server: string): string;
/** Stable source identity for overview/pane replies; agent source remains its harness. */
export declare function terminalMux(server: string): {
    id: string;
    kind: "herdr" | "tmux";
    session: string;
};
/** The provider for each server by its name: Herdr's or tmux's. */
export declare const routedTerminal: TerminalProvider;
/** True when a start or prompt was refused because the agent is still
 * starting (a folder-trust or login screen holds it). Herdr says so with its
 * own error code; another provider with `code`. */
export declare function agentNotReady(error: unknown): boolean;
/** The multiplexer the Hook drives: each call goes to its server's provider. */
export declare function terminalProvider(): TerminalProvider;
/** For tests: drive the Hook through `provider`; the returned function restores the previous one. */
export declare function setTerminalProvider(provider: TerminalProvider): () => void;
