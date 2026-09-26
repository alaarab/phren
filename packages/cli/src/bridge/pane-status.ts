// Agent status for panes whose terminal does not report one (tmux). Herdr
// watches its agents and says "working", "idle" or "blocked"; tmux knows only
// processes. Claude, Codex and phren-agent tell the Hook themselves through
// their lifecycle hooks (agent-hooks.ts), so the last event a pane's agent
// sent is its status: a submitted prompt or a tool call means working, a
// finished turn or a fresh session idle, a permission request blocked. The
// event is also kept in the pane's binding file, so a restarted Hook does not
// forget a pane's status. OpenCode and Copilot say it elsewhere
// (harness-status.ts); the snapshot notes what they say here, so every change
// gets a sequence number too.
//
// A harness that draws a permission dialog in its terminal with no hook
// behind it (Codex, OpenCode, Copilot, Claude's auto-mode fallback) still
// looks "working" to all of that. While a pane is working its screen is read,
// at most once per DIALOG_READ_MS, and a dialog there makes the pane blocked
// until the dialog is gone.
import { readFile } from "node:fs/promises";
import { stripTerminal } from "../terminal-text.js";
import { bindingPath } from "./agent-hook-stores.js";
import { claudeQuestionDialog } from "./claude-question-dialog.js";
import { intervalFromEnv } from "./limits.js";
import { object } from "./protocol.js";
import { numberedDialog, opencodePermissionDialog, visibleTerminalChoice } from "./terminal-choice.js";

/** A working pane's screen is read for a dialog at most once per this window. */
const DIALOG_READ_MS = intervalFromEnv("PHREN_DIALOG_THROTTLE_MS", 3_000);

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

/** Records the status of the agent in `pane`, which runs in terminal instance
 * `terminal`, and answers it with its sequence number. */
export function notePaneStatus(server: string, pane: string, terminal: string, status: string, at = Date.now()): { status: string; seq: number } {
  const id = key(server, pane), current = entries.get(id);
  if (current && current.terminal === terminal && current.status === status) { current.at = at; return { status, seq: current.seq }; }
  entries.delete(id);
  while (entries.size >= 512) entries.delete(entries.keys().next().value!);
  const entry = { terminal, status, seq: ++sequence, at };
  entries.set(id, entry);
  return { status, seq: entry.seq };
}

/** A blocked pane whose dialog is gone was answered in the terminal: the
 * agent went back to work. Only after `minimumMs`, so a request whose
 * dialog is still being drawn is not settled early. */
export function settleBlockedPane(server: string, pane: string, minimumMs = 3_000): void {
  const id = key(server, pane), current = entries.get(id), dialog = dialogs.get(id);
  if (current?.status === "blocked" && Date.now() - current.at >= minimumMs) notePaneStatus(server, pane, current.terminal, "working");
  if (dialog?.shown && Date.now() - dialog.shown.at >= minimumMs) {
    // The screen can show the answered dialog a moment longer: the next read
    // waits a whole window.
    dialog.shown = undefined; dialog.cleared = ++sequence; dialog.readAt = Date.now();
  }
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
    return notePaneStatus(server, pane, terminal, status, Number.isFinite(at) ? at : Date.now());
  } catch { return undefined; }
}

/** Whether `screen` (a pane's visible lines, with or without colors) shows a
 * dialog waiting for `agent`'s owner. Stricter than the readers that answer
 * a dialog, because it runs while the agent is still writing: Claude's and
 * phren-agent's numbered rows count only with their "Esc to cancel" footer,
 * OpenCode's only as its own permission prompt. */
export function screenDialog(agent: string, screen: string): boolean {
  const text = stripTerminal(screen);
  if (agent === "opencode") return !!opencodePermissionDialog(screen);
  if (agent === "codex" || agent === "copilot") return !!visibleTerminalChoice(text);
  if (agent === "claude" && claudeQuestionDialog(text)) return true;
  return /Esc to cancel/i.test(text) && !!numberedDialog(text);
}

interface Dialog { terminal: string; readAt: number; shown?: { at: number; seq: number }; cleared?: number }
const dialogs = new Map<string, Dialog>();

/** The status of a pane after a look at its screen: blocked while a working
 * agent shows a dialog there (`screenDialog`), else `base` unchanged. `read`
 * answers the pane's visible lines; it runs only for a working pane, at most
 * once per DIALOG_READ_MS per pane. */
export async function dialogStatus(server: string, pane: string, terminal: string, agent: string,
  base: { status: string; seq: number } | undefined, read: () => Promise<string>): Promise<{ status: string; seq: number } | undefined> {
  const id = key(server, pane);
  if (base?.status !== "working") { dialogs.delete(id); return base; }
  let entry = dialogs.get(id);
  if (!entry || entry.terminal !== terminal) {
    entry = { terminal, readAt: 0 };
    dialogs.delete(id);
    while (dialogs.size >= 512) dialogs.delete(dialogs.keys().next().value!);
    dialogs.set(id, entry);
  }
  const now = Date.now();
  if (now - entry.readAt >= DIALOG_READ_MS) {
    entry.readAt = now;
    // A failed read says nothing: the pane keeps what it had.
    const shown = await read().then(screen => screenDialog(agent, screen), () => undefined);
    if (shown === true && !entry.shown) entry.shown = { at: now, seq: ++sequence };
    else if (shown === false && entry.shown) { entry.shown = undefined; entry.cleared = ++sequence; }
  }
  if (entry.shown) return { status: "blocked", seq: entry.shown.seq };
  return { status: base.status, seq: Math.max(base.seq, entry.cleared ?? 0) };
}

/** For tests. */
export function resetPaneStatus(): void { entries.clear(); dialogs.clear(); }
