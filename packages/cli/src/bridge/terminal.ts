// What the Hook needs from the terminal multiplexer its agents run in: Herdr
// (terminal-herdr.ts) or, on a computer without it, tmux (terminal-tmux.ts).
// Nothing Herdr- or tmux-specific may leak past a provider's own file.
//
// Identity (which conversation a pane runs) and agent status are not the
// provider's job. A multiplexer that knows them reports them as `hints`; one
// that does not leaves them out and the Hook falls back to lifecycle hooks
// and process logs.
import { existsSync } from "node:fs";
import { herdrPaneFromEnv, herdrSocketPath } from "./herdr.js";
import { BridgeError, type Json } from "./protocol.js";
import { herdrTerminal } from "./terminal-herdr.js";
import { tmuxPaneFromEnv, tmuxSocketName, tmuxTerminal } from "./terminal-tmux.js";

/** The pane this process runs in, from the variables its multiplexer sets:
 * inside Herdr only Herdr's pane counts, elsewhere a tmux pane does. */
export async function terminalPaneFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<{ server: string; workspace: string; tab: string; pane: string } | undefined> {
  if (env.HERDR_ENV === "1") return env.HERDR_SOCKET_PATH ? herdrPaneFromEnv(env) : undefined;
  return tmuxPaneFromEnv(env);
}

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
  /** Types `text` into the pane's agent and submits it. */
  prompt(server: string, pane: string, text: string, signal?: AbortSignal): Promise<void>;
  /** Opens a pane; the caller finds it in the next `listPanes`. */
  create(server: string, placement: PanePlacement): Promise<void>;
  startAgent(server: string, pane: string, agent: AgentStart): Promise<void>;
  focusPane(server: string, pane: string): Promise<void>;
  /** Focuses, renames or closes a whole tab (when `tab` is set) or workspace. */
  groupAction(server: string, operation: "focus" | "rename" | "close", group: { workspace?: string; tab?: string }, label?: string): Promise<void>;
}

/** Which multiplexer a Hook server name belongs to: "tmux" and "tmux-<socket>"
 * are tmux servers unless Herdr has a session of that name; every other name
 * is a Herdr server, exactly as before tmux support. */
export function terminalKind(server: string): "herdr" | "tmux" {
  if (!tmuxSocketName(server)) return "herdr";
  try { return existsSync(herdrSocketPath(server)) ? "herdr" : "tmux"; } catch { return "tmux"; }
}
/** The multiplexer's name as the phone shows it in messages. */
export function terminalName(server: string): string { return terminalKind(server) === "tmux" ? "tmux" : "Herdr"; }
const route = (server: string): TerminalProvider => terminalKind(server) === "tmux" ? tmuxTerminal : herdrTerminal;

/** The provider for each server by its name: Herdr's or tmux's. */
export const routedTerminal: TerminalProvider = {
  kind: "routed",
  ping: server => route(server).ping(server),
  snapshot: server => route(server).snapshot(server),
  listPanes: server => route(server).listPanes(server),
  processes: (server, pane) => route(server).processes(server, pane),
  readScreen: (server, pane, read) => route(server).readScreen(server, pane, read),
  sendKeys: (server, pane, keys) => route(server).sendKeys(server, pane, keys),
  prompt: (server, pane, text, signal) => route(server).prompt(server, pane, text, signal),
  create: (server, placement) => route(server).create(server, placement),
  startAgent: (server, pane, agent) => route(server).startAgent(server, pane, agent),
  focusPane: (server, pane) => route(server).focusPane(server, pane),
  groupAction: (server, operation, group, label) => route(server).groupAction(server, operation, group, label),
};

/** True when a start or prompt was refused because the agent is still
 * starting (a folder-trust or login screen holds it). Herdr says so with its
 * own error code; another provider with `code`. */
export function agentNotReady(error: unknown): boolean {
  return error instanceof BridgeError && (error.details?.code === "agent_not_ready" || error.details?.herdrCode === "agent_not_ready");
}

let current: TerminalProvider = routedTerminal;

/** The multiplexer the Hook drives: each call goes to its server's provider. */
export function terminalProvider(): TerminalProvider { return current; }

/** For tests: drive the Hook through `provider`; the returned function restores the previous one. */
export function setTerminalProvider(provider: TerminalProvider): () => void {
  const previous = current;
  current = provider;
  return () => { current = previous; };
}
