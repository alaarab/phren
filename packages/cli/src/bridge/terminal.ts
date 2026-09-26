// What the Hook needs from the terminal multiplexer its agents run in. Herdr
// is the only one today (terminal-herdr.ts); the interface is shaped so tmux
// fits too (list-panes -F, capture-pane -p [-e], send-keys / paste-buffer,
// new-window). Nothing Herdr-specific may leak past a provider's own file.
//
// Identity (which conversation a pane runs) and agent status are not the
// provider's job. A multiplexer that knows them reports them as `hints`; one
// that does not leaves them out and the Hook falls back to lifecycle hooks
// and process logs.
import { herdrTerminal } from "./terminal-herdr.js";

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

/** A new pane: a tab in `workspace`, or a new workspace when it is absent. */
export interface PanePlacement { workspace?: string; label?: string; cwd?: string }

/** Starts an agent in an existing, empty pane. */
export interface AgentStart { name: string; kind: string; args: string[]; timeoutMs: number }

/**
 * Key names are the Hook's vocabulary: "enter", "esc", "up", "down", "tab",
 * "space", "alt+Up" and single characters. A provider maps them to its own.
 *
 * Every method rejects with a BridgeError when the multiplexer refuses or is
 * unreachable; the message is shown to the phone.
 */
export interface TerminalProvider {
  readonly kind: string;
  /** Resolves when `server` is running and answering. */
  ping(server: string): Promise<void>;
  listPanes(server: string): Promise<TerminalPane[]>;
  processes(server: string, pane: string): Promise<PaneProcesses>;
  readScreen(server: string, pane: string, read: ScreenRead): Promise<string>;
  sendKeys(server: string, pane: string, keys: string[]): Promise<void>;
  /** Types `text` into the pane's agent and submits it. */
  prompt(server: string, pane: string, text: string, signal?: AbortSignal): Promise<void>;
  /** Opens a pane; the caller finds it in the next `listPanes`. */
  create(server: string, placement: PanePlacement): Promise<void>;
  startAgent(server: string, pane: string, agent: AgentStart): Promise<void>;
  focusPane(server: string, pane: string): Promise<void>;
  /** Focuses, renames or closes a whole tab (when `tab` is set) or workspace. */
  groupAction(server: string, operation: "focus" | "rename" | "close", group: { workspace?: string; tab?: string }, label?: string): Promise<void>;
}

let current: TerminalProvider = herdrTerminal;

/** The multiplexer the Hook drives. */
export function terminalProvider(): TerminalProvider { return current; }

/** For tests: drive the Hook through `provider`; the returned function restores the previous one. */
export function setTerminalProvider(provider: TerminalProvider): () => void {
  const previous = current;
  current = provider;
  return () => { current = previous; };
}
