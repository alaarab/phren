import { briefLabel } from "./launch-brief.js";
import { type Json, provider } from "./protocol.js";
import type { FinalTurn } from "./schedule-watch.js";
import { backgroundLeft, readTurn, turnPhase, type TurnRecord } from "./turn-records.js";

/**
 * What a live session's row says about itself beyond Herdr's own status and
 * title, from the pane's turn record (turn-records.ts) and the dispatch label
 * (launch-brief.ts):
 *
 * - A session whose turn ended while work it started still runs is still
 *   working: running sub-agents, teammates, workflow agents and fan-out jobs
 *   (its child tree, Claude and Codex alike), and for Claude the background
 *   shells and monitors started since the owner's last prompt that are not
 *   endless streams (`FinalTurn.awaited`, bounded by its Stop's count less the
 *   tasks finished since, for at most BACKGROUND_STALE_MS). A log tail, a
 *   watcher or a shell left over from an earlier exchange runs on without
 *   anyone waiting for it, so it does not count. Herdr reports such a session
 *   idle, so the phone listed it under IDLE with a moon badge. The tab keeps
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

/** How long after its Stop a background count may keep a row working. A task
 * whose finish the transcript never shows (a dev server left running, a
 * persistent monitor, a notification the tail no longer holds) would
 * otherwise keep it working forever. Matches dispatch returns' wait. */
export const BACKGROUND_STALE_MS = 2 * 60 * 60 * 1000;

/** Background tasks the recorded turn ended with that are still running:
 * the Stop's count less those `finishedTasks` (FinalTurn's) says finished
 * after it. Undefined once none are left or the Stop is BACKGROUND_STALE_MS old. */
export function recordedBackground(record: TurnRecord | undefined, finishedTasks?: readonly string[], now = Date.now()): number | undefined {
  if (!record) return undefined;
  const phase = turnPhase(record);
  if (phase.phase !== "ended" || !(now - Date.parse(phase.at) < BACKGROUND_STALE_MS)) return undefined;
  return backgroundLeft(phase.background, phase.at, finishedTasks) || undefined;
}

/** The background shells and monitors a pane's ended Claude turn is waiting
 * on (`FinalTurn.awaited`), at most `recordedBackground`. Reads the transcript
 * (`readFinalTurn`, passed in: schedule-watch imports herdr, which imports
 * this) only when the Stop left background work; only Claude's Stop reports
 * a count. Sub-agents are not in it: the overview adds its running children.
 * An unreadable transcript counts nothing, since the Stop's count alone
 * cannot tell a build from a log tail. */
export async function liveBackground(record: TurnRecord | undefined, readFinal: (source: "claude", session: string) => Promise<FinalTurn | undefined>, now = Date.now()): Promise<number | undefined> {
  if (!record || record.source !== "claude" || !recordedBackground(record, [], now)) return undefined;
  const final = await readFinal("claude", record.session).catch(() => undefined);
  const left = recordedBackground(record, final?.finishedTasks, now);
  return left && final?.awaited ? Math.min(left, final.awaited) : undefined;
}

/**
 * Marks a tab whose main turn ended but whose background work continues:
 * an idle or done tab becomes `working` with `backgroundTasks: count`. Called
 * again with a fuller count (the awaited shells plus the running children,
 * once the child tree is read), it keeps the larger. A tab that is working,
 * blocked or waiting on its own is left alone, so `backgroundTasks` never
 * sits on a tab with a live turn.
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

/** Spinner and status glyphs a harness puts around its terminal title while it
 * works: Braille spinner frames (Codex), dingbat stars and checks (Claude's
 * ✳), bullets, circles and hourglasses. */
const GLYPHS_AROUND = /^[\u2800-\u28ff\u2700-\u27bf\u25a0-\u25ff\u23f0-\u23ff\u2022\u00b7\u2219\u22c5\u2605\u2606\s]+|[\s\u2800-\u28ff\u2700-\u27bf\u25a0-\u25ff\u23f0-\u23ff\u2022\u00b7\u2219\u22c5\u2605\u2606]+$/gu;

/** A terminal title without the spinner or status glyphs around it, nor the
 * separator they leave dangling (Codex's "⠸ | phren" before its thread has a
 * title); undefined when nothing else is left. */
export function plainTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(GLYPHS_AROUND, "").replace(/^\|\s+|\s+\|$/g, "").replace(GLYPHS_AROUND, "").trim();
  return text || undefined;
}

/** A harness title made from the brief launch's first prompt rather than the work: the prompt itself, the brief path, or "Brief <id>". */
export function isBriefTitle(title: string): boolean {
  return /^\s*read and follow the brief/i.test(title) || title.includes("/briefs/")
    || /^\s*brief\s+[0-9a-f]{8}[0-9a-f-]*\s*(…|\.\.\.)?\s*$/i.test(title);
}

/**
 * The name a session is shown under, first that applies:
 * 1. the agent pane's own label, when meaningful (a rename from the phone or
 *    from Herdr or tmux itself; a pane has none until someone sets one);
 * 2. the dispatch label its dispatcher gave it;
 * 3. for a dispatch with no stored label (sent before labels were kept), the
 *    tab label, else the workspace label, when meaningful;
 * 4. the harness's own title, unless it is brief boilerplate, which is
 *    replaced by a meaningful tab or workspace label or dropped (the phone
 *    then falls back to the label).
 * Never leaves a row blank: when none applies and `fallbackLabel` (passed, even
 * if undefined) is the label the phone shows without a title and is blank, the raw harness title stands.
 */
export function sessionTitle(input: { dispatched: boolean; paneLabel?: unknown; dispatchLabel?: string; harnessTitle?: unknown; tabLabel?: unknown; workspaceLabel?: unknown; fallbackLabel?: unknown }): string | undefined {
  const renamed = meaningfulLabel(input.paneLabel);
  if (renamed) return renamed;
  if (input.dispatchLabel) return input.dispatchLabel;
  const named = meaningfulLabel(input.tabLabel) ?? meaningfulLabel(input.workspaceLabel);
  const title = plainTitle(input.harnessTitle);
  const chosen = input.dispatched ? named : !title ? undefined : isBriefTitle(title) ? named : title;
  const label = input.fallbackLabel;
  const blank = "fallbackLabel" in input && (typeof label !== "string" || !label.trim());
  return chosen ?? (blank ? title : undefined);
}

/** `sessionTitle` for a pane, given its own turn record (the guarded one from `paneRecord`). */
export async function recordTitle(record: TurnRecord | undefined, input: { paneLabel?: unknown; harnessTitle?: unknown; tabLabel?: unknown; workspaceLabel?: unknown; fallbackLabel?: unknown }): Promise<string | undefined> {
  const dispatch = record?.dispatch;
  return sessionTitle({ ...input, dispatched: !!dispatch, dispatchLabel: dispatch ? await briefLabel(dispatch) : undefined });
}
