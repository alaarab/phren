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

/** Whether `pane` runs phren-agent as Herdr reports it, for the prompt and key fallbacks below. */
async function reportedPhren(server: string, pane: string): Promise<boolean> {
  const info = object((await rpc(server, "pane.get", { pane_id: pane }).catch((): Json => ({}))).pane);
  return info.agent === "phren";
}

/** Herdr's `agent.prompt` and `agent.send_keys` take only agents it started;
 * a phren-agent pane it knows by report gets the pane calls instead. */
function unnamedAgent(error: unknown): boolean {
  return error instanceof BridgeError && error.details?.herdrCode === "agent_not_ready" && /not an active named agent/.test(error.message);
}

/** Herdr's `agent.start` knows a fixed list of harnesses and phren-agent is
 * not on it. The Hook types `phren agent ...` at the pane's login shell
 * instead, waits for it to be the foreground program, then reports it to
 * Herdr as agent "phren" under the launch name, so the pane reads as an agent
 * like the others. Its own lifecycle hooks keep the status (agent-hooks.ts). */
async function startPhren(server: string, pane: string, { name, kind, args, timeoutMs, command }: AgentStart): Promise<void> {
  const before = object((await rpc(server, "pane.process_info", { pane_id: pane })).process_info);
  // Same refusal as Herdr's own start, so the caller waits for the shell.
  if (!Number.isSafeInteger(before.shell_pid) || before.foreground_process_group_id !== before.shell_pid) throw new BridgeError(409, `Herdr: agent target pane ${pane} is not an available shell`, { herdrCode: "agent_pane_busy" });
  await rpc(server, "pane.send_text", { pane_id: pane, text: command ? `${[command.file, ...command.args].map(shellWord).join(" ")}; herdr pane release-agent "$HERDR_PANE_ID" --source ${PHREN_REPORT_SOURCE} --agent ${shellWord(kind)} >/dev/null 2>&1` : phrenCommandLine(args) });
  await rpc(server, "pane.send_keys", { pane_id: pane, keys: ["Enter"] });
  const deadline = Date.now() + Math.min(timeoutMs, 30_000);
  for (;;) {
    const info = object((await rpc(server, "pane.process_info", { pane_id: pane })).process_info);
    if (objects(info.foreground_processes).some(p => typeof p.cmdline === "string" && agentFromCommand(p.cmdline) === kind)) break;
    if (Date.now() >= deadline) throw new BridgeError(504, "phren agent did not start in the Herdr pane. Check that phren and @phren/agent are installed on the login shell's PATH.");
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  await rpc(server, "pane.report_agent", { pane_id: pane, source: PHREN_REPORT_SOURCE, agent: kind, state: "idle" });
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
      if (!unnamedAgent(error) || !await reportedPhren(server, pane)) throw error;
      await rpc(server, "pane.send_keys", { pane_id: pane, keys });
    }
  },
  async prompt(server, pane, text, signal) {
    try {
      if (signal) await rpc(server, "agent.prompt", { target: pane, text }, signal);
      else await rpc(server, "agent.prompt", { target: pane, text });
    } catch (error) {
      if (!unnamedAgent(error) || !await reportedPhren(server, pane)) throw error;
      // One bracketed paste keeps the newlines in phren-agent's composer; Enter submits it.
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
    if (kind === "phren" || agent.command) { await startPhren(server, pane, agent); return; }
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
