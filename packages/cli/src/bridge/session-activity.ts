import { briefLabel } from "./launch-brief.js";
import { type Json, provider } from "./protocol.js";
import { readTurn, turnPhase, type TurnRecord } from "./turn-records.js";

/**
 * What a live session's row says about itself beyond Herdr's own status and
 * title, from the pane's turn record (turn-records.ts) and the dispatch label
 * (launch-brief.ts):
 *
 * - A Claude turn that ended while background shells or subagents still run
 *   (its Stop's `background` count), or a Codex session with running
 *   subagents or fanout jobs, is still working. Herdr reports it idle, so the
 *   phone listed it under IDLE with a moon badge. The tab keeps
 *   `agentStatus: "working"` and gains `backgroundTasks`, the count.
 * - A dispatched worker is named by its dispatch label. Claude and Codex title
 *   a session after its first prompt, which for a brief launch is
 *   "Read and follow the brief in <path>" (or "Brief d35c6189" once they
 *   shorten it), so those titles are never shown.
 */

/** The record, only when it belongs to this pane's terminal and conversation
 * (the guard dispatch returns use): a leftover record of an earlier terminal
 * or session in the same pane must not speak for this one. */
export function ownRecord(record: TurnRecord | undefined, pane: Json, source: unknown, session: string | undefined): TurnRecord | undefined {
  return record && session && record.terminal === pane.terminal_id && record.source === source && record.session === session ? record : undefined;
}

/** The pane's own turn record. OpenCode has no Stop hook to report background work or a dispatch id here. */
export async function paneRecord(server: string, pane: Json, session: string | undefined): Promise<TurnRecord | undefined> {
  if (!session || pane.agent === "opencode" || !provider.safeParse(pane.agent).success) return undefined;
  return ownRecord(await readTurn(server, String(pane.pane_id)).catch(() => undefined), pane, pane.agent, session);
}

/** Background tasks the recorded turn ended with, when it ended with any. */
export function recordedBackground(record: TurnRecord | undefined): number | undefined {
  if (!record) return undefined;
  const phase = turnPhase(record);
  return phase.phase === "ended" ? phase.background : undefined;
}

/**
 * Marks a tab whose main turn ended but whose background work continues:
 * an idle or done tab becomes `working` with `backgroundTasks: count`. Called
 * again with a second source (the transcript's running children), it keeps the
 * larger count, never the sum: Claude's own Stop count already includes its
 * subagents. A tab that is working, blocked or waiting on its own is left
 * alone, so `backgroundTasks` never sits on a tab with a live turn.
 */
export function markBackground(tab: Json, count: number | undefined): void {
  if (!count || count < 1) return;
  if (tab.agentStatus === "idle" || tab.agentStatus === "done") { tab.agentStatus = "working"; tab.backgroundTasks = count; }
  else if (typeof tab.backgroundTasks === "number") tab.backgroundTasks = Math.max(tab.backgroundTasks, count);
}

/** A tab or workspace label worth showing as a name: not empty, not Herdr's bare numbering, not an id. */
export function meaningfulLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && !/^\d+$/.test(text) && !/^\S*:\S*$/.test(text) && !/^[A-Za-z]{1,2}[_-]?\d+[A-Za-z]?$/.test(text) ? text : undefined;
}

/** A harness title made from the brief launch's first prompt rather than the work: the prompt itself, the brief path, or "Brief <id>". */
export function isBriefTitle(title: string): boolean {
  return /^\s*read and follow the brief/i.test(title) || title.includes("/briefs/")
    || /^\s*brief\s+[0-9a-f]{8}[0-9a-f-]*\s*(…|\.\.\.)?\s*$/i.test(title);
}

/**
 * The name a session is shown under, first that applies:
 * 1. the dispatch label its dispatcher gave it;
 * 2. for a dispatch with no stored label (sent before labels were kept), the
 *    tab label, else the workspace label, when meaningful;
 * 3. the harness's own title, unless it is brief boilerplate, which is
 *    replaced by a meaningful tab or workspace label or dropped (the phone
 *    then falls back to the label).
 */
export function sessionTitle(input: { dispatched: boolean; dispatchLabel?: string; harnessTitle?: unknown; tabLabel?: unknown; workspaceLabel?: unknown }): string | undefined {
  if (input.dispatchLabel) return input.dispatchLabel;
  const named = meaningfulLabel(input.tabLabel) ?? meaningfulLabel(input.workspaceLabel);
  if (input.dispatched) return named;
  const title = typeof input.harnessTitle === "string" && input.harnessTitle.trim() ? input.harnessTitle : undefined;
  return !title ? undefined : isBriefTitle(title) ? named : title;
}

/** `sessionTitle` for a pane, given its own turn record (the guarded one from `paneRecord`). */
export async function recordTitle(record: TurnRecord | undefined, input: { harnessTitle?: unknown; tabLabel?: unknown; workspaceLabel?: unknown }): Promise<string | undefined> {
  const dispatch = record?.dispatch;
  return sessionTitle({ ...input, dispatched: !!dispatch, dispatchLabel: dispatch ? await briefLabel(dispatch) : undefined });
}
