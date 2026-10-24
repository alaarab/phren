// Herdr as the Hook's terminal provider: each method is one call on Herdr's
// socket API. It calls herdr.ts's exported `rpc`, the seam the bridge tests
// fake, so a test that records Herdr requests sees exactly what it did before
// the provider existed.
import { herdrSocketPath, rpc, snapshot } from "./herdr.js";
import { BridgeError, object, objects, type Json } from "./protocol.js";
import type { AgentStart, PaneProcesses, TerminalPane, TerminalProvider } from "./terminal.js";
import { agentFromCommand } from "./terminal-tmux.js";

const text = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;

/** Who reports phren-agent's lifecycle to Herdr, which does not detect it itself. */
export const PHREN_REPORT_SOURCE = "phren-hook";

/** A word for a POSIX shell, quoted only when it needs it. */
export function shellWord(word: string): string {
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** What the Hook types into a Herdr pane's shell to start phren-agent:
 * the agent, then Herdr's report of it released once it exits. */
export function phrenCommandLine(args: string[]): string {
  return [["phren", ...args].map(shellWord).join(" "),
    `herdr pane release-agent "$HERDR_PANE_ID" --source ${PHREN_REPORT_SOURCE} --agent phren >/dev/null 2>&1`].join("; ");
}

/** Herdr's `agent.prompt` and `agent.send_keys` take only agents it started
 * and still holds as active. A worker launched with its brief as the
 * harness's first prompt goes straight to work and can stay `launch_pending`
 * there, and an agent restarted in its pane (or alive across a Herdr restart)
 * is detected but never named again; Herdr refuses all of them with
 * `agent_not_ready` for good. Such a pane is typed into instead, the way the
 * terminal view types, when its foreground program is the harness Herdr
 * detects there (phren-agent counts by report alone, as Herdr cannot detect
 * it). For a prompt Herdr must also read the agent at rest or at work, so
 * text never lands in a starting harness or answers a dialog it draws. */
async function typableAgent(server: string, pane: string, forPrompt: boolean): Promise<boolean> {
  const info = object((await rpc(server, "pane.get", { pane_id: pane }).catch((): Json => ({}))).pane);
  if (info.agent === "phren") return true;
  if (typeof info.agent !== "string" || !info.agent) return false;
  if (forPrompt && !["idle", "working", "done"].includes(String(info.agent_status))) return false;
  const processes = object((await rpc(server, "pane.process_info", { pane_id: pane }).catch((): Json => ({}))).process_info);
  // The shell in the foreground would run the text as a command.
  if (!Number.isSafeInteger(processes.foreground_process_group_id) || processes.foreground_process_group_id === processes.shell_pid) return false;
  return objects(processes.foreground_processes).some(p => typeof p.cmdline === "string" && agentFromCommand(p.cmdline) === info.agent);
}

/** The refusal `typableAgent` answers: an agent Herdr does not hold as named. */
function unnamedAgent(error: unknown): boolean {
  return error instanceof BridgeError && error.details?.herdrCode === "agent_not_ready" && /not an active named agent/.test(error.message);
}

/** Herdr's `agent.start` knows a fixed list of harnesses and phren-agent is
 * not on it. The Hook types `phren agent ...` at the pane's login shell
 * instead, waits for it to be the foreground program, then reports it to
 * Herdr as agent "phren" under the launch name, so the pane reads as an agent
 * like the others. Its own lifecycle hooks keep the status (agent-hooks.ts). */
async function startPhren(server: string, pane: string, { name, args, timeoutMs }: AgentStart): Promise<void> {
  const before = object((await rpc(server, "pane.process_info", { pane_id: pane })).process_info);
  // Same refusal as Herdr's own start, so the caller waits for the shell.
  if (!Number.isSafeInteger(before.shell_pid) || before.foreground_process_group_id !== before.shell_pid) throw new BridgeError(409, `Herdr: agent target pane ${pane} is not an available shell`, { herdrCode: "agent_pane_busy" });
  await rpc(server, "pane.send_text", { pane_id: pane, text: phrenCommandLine(args) });
  await rpc(server, "pane.send_keys", { pane_id: pane, keys: ["Enter"] });
  const deadline = Date.now() + Math.min(timeoutMs, 30_000);
  for (;;) {
    const info = object((await rpc(server, "pane.process_info", { pane_id: pane })).process_info);
    if (objects(info.foreground_processes).some(p => typeof p.cmdline === "string" && agentFromCommand(p.cmdline) === "phren")) break;
    if (Date.now() >= deadline) throw new BridgeError(504, "phren agent did not start in the Herdr pane. Check that phren and @phren/agent are installed on the login shell's PATH.");
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  await rpc(server, "pane.report_agent", { pane_id: pane, source: PHREN_REPORT_SOURCE, agent: "phren", state: "idle" });
  await rpc(server, "agent.rename", { target: pane, name }).catch(() => undefined);
}

/** A Herdr snapshot's panes in the provider's shape; Herdr's agent report becomes hints. */
export function herdrPanes(server: string, s: Json): TerminalPane[] {
  return objects(s.panes).filter(p => typeof p.pane_id === "string" && typeof p.tab_id === "string" && typeof p.workspace_id === "string").map(p => {
    const reported = object(p.agent_session);
    const session = reported.kind === "id" && reported.agent === p.agent ? text(reported.value) : undefined;
    const hints = { agent: text(p.agent), status: text(p.agent_status), session };
    return { server, workspace: String(p.workspace_id), tab: String(p.tab_id), pane: String(p.pane_id),
      cwd: text(p.foreground_cwd) ?? text(p.cwd), title: text(p.title) ?? text(p.terminal_title_stripped), label: text(p.label),
      ...(hints.agent || hints.status || hints.session ? { hints } : {}) };
  });
}

export const herdrTerminal: TerminalProvider = {
  kind: "herdr",
  async ping(server) { await rpc(server, "ping"); },
  async snapshot(server) { return object((await rpc(server, "session.snapshot")).snapshot); },
  async listPanes(server) { return herdrPanes(server, await snapshot(server)); },
  async processes(server, pane): Promise<PaneProcesses> {
    const info = object((await rpc(server, "pane.process_info", { pane_id: pane })).process_info);
    return { ...(Number.isSafeInteger(info.shell_pid) ? { shellPid: Number(info.shell_pid) } : {}),
      foregroundPids: objects(info.foreground_processes).map(p => p.pid).filter((p): p is number => Number.isSafeInteger(p)) };
  },
  async readScreen(server, pane, read) {
    const params = { ...(read.scope === "agent" ? { target: pane } : { pane_id: pane }),
      source: read.source, lines: read.lines, strip_ansi: read.stripAnsi ?? true,
      // Herdr 0.9 answers plain text whatever `strip_ansi` says; "ansi" keeps the styles.
      ...(read.format ? { format: read.format } : {}) };
    // `pane.read` and `agent.read` both answer with a `read` object carrying the text.
    const result = await rpc(server, read.scope === "agent" ? "agent.read" : "pane.read", params, undefined, read.timeoutMs);
    const answer = object(result.read ?? result);
    return typeof answer.text === "string" ? answer.text : "";
  },
  async sendKeys(server, pane, keys) {
    try { await rpc(server, "agent.send_keys", { target: pane, keys }); } catch (error) {
      if (!unnamedAgent(error) || !await typableAgent(server, pane, false)) throw error;
      await rpc(server, "pane.send_keys", { pane_id: pane, keys });
    }
  },
  async shellCommand(server, pane, command) {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const info = object((await rpc(server, "pane.process_info", { pane_id: pane })).process_info);
      if (Number.isSafeInteger(info.shell_pid) && info.foreground_process_group_id === info.shell_pid) break;
      if (Date.now() >= deadline) throw new BridgeError(409, "The new pane did not become ready at its shell prompt.");
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    // An empty shell is not a named agent: agent.prompt cannot address it.
    await rpc(server, "pane.send_text", { pane_id: pane, text: command });
    await rpc(server, "pane.send_keys", { pane_id: pane, keys: ["Enter"] });
  },
  async prompt(server, pane, text, signal) {
    try {
      if (signal) await rpc(server, "agent.prompt", { target: pane, text }, signal);
      else await rpc(server, "agent.prompt", { target: pane, text });
    } catch (error) {
      if (!unnamedAgent(error) || !await typableAgent(server, pane, true)) throw error;
      // One bracketed paste keeps the newlines in the agent's composer; Enter submits it.
      // The route's delivery record (by deliveryId) is already armed: the agent's
      // UserPromptSubmit settles it, as for a prompt Herdr typed.
      await rpc(server, "pane.send_text", { pane_id: pane, text: `\x1b[200~${text}\x1b[201~` }, signal);
      await new Promise(resolve => setTimeout(resolve, 150));
      await rpc(server, "pane.send_keys", { pane_id: pane, keys: ["Enter"] }, signal);
    }
  },
  async create(server, { workspace, label, cwd, env }) {
    await rpc(server, workspace ? "tab.create" : "workspace.create", { workspace_id: workspace, label, cwd, focus: false, env: env ?? {} });
  },
  // `agent.start` takes no environment; the pane's shell got it at `create`.
  async startAgent(server, pane, agent) {
    const { name, kind, args, timeoutMs } = agent;
    if (kind === "phren") { await startPhren(server, pane, agent); return; }
    // Herdr waits up to `timeout_ms` for the agent to become ready; the socket waits a little longer.
    await rpc(server, "agent.start", { name, kind, pane_id: pane, timeout_ms: timeoutMs, ...(args.length ? { args } : {}) }, undefined, timeoutMs + 5_000);
  },
  // What Herdr sets in its own panes (herdrPaneFromEnv reads them back).
  paneEnv(server, { workspace, tab, pane }) {
    return { HERDR_ENV: "1", HERDR_SOCKET_PATH: herdrSocketPath(server), HERDR_WORKSPACE_ID: workspace, HERDR_TAB_ID: tab, HERDR_PANE_ID: pane };
  },
  async reportAgent(server, pane, agent, state) {
    await rpc(server, "pane.report_agent", { pane_id: pane, source: PHREN_REPORT_SOURCE, agent, state });
  },
  async focusPane(server, pane) { await rpc(server, "pane.focus", { pane_id: pane }); },
  async closePane(server, pane) { await rpc(server, "pane.close", { pane_id: pane }); },
  async renamePane(server, pane, label) { await rpc(server, "pane.rename", { pane_id: pane, label }); },
  async groupAction(server, operation, { workspace, tab }, label) {
    await rpc(server, `${tab ? "tab" : "workspace"}.${operation}`, { ...(tab ? { tab_id: tab } : { workspace_id: workspace }), ...(label ? { label } : {}) });
  },
};
