// Herdr as the Hook's terminal provider: each method is one call on Herdr's
// socket API. It calls herdr.ts's exported `rpc`, the seam the bridge tests
// fake, so a test that records Herdr requests sees exactly what it did before
// the provider existed.
import { rpc, snapshot } from "./herdr.js";
import { object, objects, type Json } from "./protocol.js";
import type { PaneProcesses, TerminalPane, TerminalProvider } from "./terminal.js";

const text = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;

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
  async sendKeys(server, pane, keys) { await rpc(server, "agent.send_keys", { target: pane, keys }); },
  async prompt(server, pane, text, signal) {
    if (signal) await rpc(server, "agent.prompt", { target: pane, text }, signal);
    else await rpc(server, "agent.prompt", { target: pane, text });
  },
  async create(server, { workspace, label, cwd }) {
    await rpc(server, workspace ? "tab.create" : "workspace.create", { workspace_id: workspace, label, cwd, focus: false, env: {} });
  },
  async startAgent(server, pane, { name, kind, args, timeoutMs }) {
    // Herdr waits up to `timeout_ms` for the agent to become ready; the socket waits a little longer.
    await rpc(server, "agent.start", { name, kind, pane_id: pane, timeout_ms: timeoutMs, ...(args.length ? { args } : {}) }, undefined, timeoutMs + 5_000);
  },
  async focusPane(server, pane) { await rpc(server, "pane.focus", { pane_id: pane }); },
  async groupAction(server, operation, { workspace, tab }, label) {
    await rpc(server, `${tab ? "tab" : "workspace"}.${operation}`, { ...(tab ? { tab_id: tab } : { workspace_id: workspace }), ...(label ? { label } : {}) });
  },
};
