import { type Json } from "./protocol.js";
import { type TurnRecord } from "./turn-records.js";
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
export declare function ownRecord(record: TurnRecord | undefined, pane: Json, source: unknown, session: string | undefined): TurnRecord | undefined;
/** The pane's own turn record. OpenCode has no Stop hook to report background work or a dispatch id here. */
export declare function paneRecord(server: string, pane: Json, session: string | undefined): Promise<TurnRecord | undefined>;
/** Background tasks the recorded turn ended with, when it ended with any. */
export declare function recordedBackground(record: TurnRecord | undefined): number | undefined;
/**
 * Marks a tab whose main turn ended but whose background work continues:
 * an idle or done tab becomes `working` with `backgroundTasks: count`. Called
 * again with a second source (the transcript's running children), it keeps the
 * larger count, never the sum: Claude's own Stop count already includes its
 * subagents. A tab that is working, blocked or waiting on its own is left
 * alone, so `backgroundTasks` never sits on a tab with a live turn.
 */
export declare function markBackground(tab: Json, count: number | undefined): void;
/** A tab or workspace label worth showing as a name: not empty, not Herdr's bare numbering, not an id. */
export declare function meaningfulLabel(value: unknown): string | undefined;
/** A harness title made from the brief launch's first prompt rather than the work: the prompt itself, the brief path, or "Brief <id>". */
export declare function isBriefTitle(title: string): boolean;
/**
 * The name a session is shown under, first that applies:
 * 1. the dispatch label its dispatcher gave it;
 * 2. for a dispatch with no stored label (sent before labels were kept), the
 *    tab label, else the workspace label, when meaningful;
 * 3. the harness's own title, unless it is brief boilerplate, which is
 *    replaced by a meaningful tab or workspace label or dropped (the phone
 *    then falls back to the label).
 * Never leaves a row blank: when none applies and `fallbackLabel` (passed, even
 * if undefined) is the label the phone shows without a title and is blank, the raw harness title stands.
 */
export declare function sessionTitle(input: {
    dispatched: boolean;
    dispatchLabel?: string;
    harnessTitle?: unknown;
    tabLabel?: unknown;
    workspaceLabel?: unknown;
    fallbackLabel?: unknown;
}): string | undefined;
/** `sessionTitle` for a pane, given its own turn record (the guarded one from `paneRecord`). */
export declare function recordTitle(record: TurnRecord | undefined, input: {
    harnessTitle?: unknown;
    tabLabel?: unknown;
    workspaceLabel?: unknown;
    fallbackLabel?: unknown;
}): Promise<string | undefined>;
