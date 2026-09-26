// Agent status for panes whose terminal does not report one (tmux). Herdr
// watches its agents and says "working", "idle" or "blocked"; tmux knows only
// processes. The harnesses tell the Hook themselves through their lifecycle
// hooks (agent-hooks.ts), so the last event a pane's agent sent is its status:
// a submitted prompt or a tool call means working, a finished turn or a fresh
// session idle, a permission request blocked. The event is also kept in the
// pane's binding file, so a restarted Hook does not forget a pane's status.
import { readFile } from "node:fs/promises";
import { bindingPath } from "./agent-hook-stores.js";
import { object } from "./protocol.js";

const EVENT_STATUS: Record<string, string> = {
  SessionStart: "idle", UserPromptSubmit: "working", PreToolUse: "working", PostToolUse: "working",
  PreCompact: "working", Stop: "idle", PermissionRequest: "blocked",
};

/** The status a lifecycle event leaves the agent in; undefined for events that say nothing about it. */
export function eventStatus(event: unknown): string | undefined {
  return typeof event === "string" && Object.hasOwn(EVENT_STATUS, event) ? EVENT_STATUS[event] : undefined;
}

interface Entry { terminal: string; status: string; seq: number; at: number }
const entries = new Map<string, Entry>();
/** Climbs with every change, like Herdr's state_change_seq, so the phone can order "just finished" first. */
let sequence = 0;
const key = (server: string, pane: string) => `${server}\0${pane}`;

/** Records the status of the agent in `pane`, which runs in terminal instance `terminal`. */
export function notePaneStatus(server: string, pane: string, terminal: string, status: string, at = Date.now()): void {
  const id = key(server, pane), current = entries.get(id);
  if (current && current.terminal === terminal && current.status === status) { current.at = at; return; }
  entries.delete(id);
  while (entries.size >= 512) entries.delete(entries.keys().next().value!);
  entries.set(id, { terminal, status, seq: ++sequence, at });
}

/** A blocked pane whose dialog is gone was answered in the terminal: the
 * agent went back to work. Only after `minimumMs`, so a request whose
 * dialog is still being drawn is not settled early. */
export function settleBlockedPane(server: string, pane: string, minimumMs = 3_000): void {
  const current = entries.get(key(server, pane));
  if (current?.status === "blocked" && Date.now() - current.at >= minimumMs) notePaneStatus(server, pane, current.terminal, "working");
}

/** The pane's last known status while `terminal` still runs there: from
 * memory, else from the binding file the last lifecycle event wrote. */
export async function paneStatus(server: string, pane: string, terminal: string): Promise<{ status: string; seq: number } | undefined> {
  const current = entries.get(key(server, pane));
  if (current && current.terminal === terminal) return { status: current.status, seq: current.seq };
  if (current) return undefined;
  try {
    const value = object(JSON.parse(await readFile(bindingPath(server, pane), "utf8")));
    const status = eventStatus(value.event);
    if (value.terminal !== terminal || !status) return undefined;
    const at = Date.parse(String(value.at));
    notePaneStatus(server, pane, terminal, status, Number.isFinite(at) ? at : Date.now());
    return { status, seq: entries.get(key(server, pane))!.seq };
  } catch { return undefined; }
}

/** For tests. */
export function resetPaneStatus(): void { entries.clear(); }
