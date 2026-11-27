import { awaitedInReply, waitingOn, type WaitingOn } from "./worker-unfinished.js";
import { turnPhase, type TurnRecord } from "./turn-records.js";

/** What a session row's ended turn still waits on (`tab.waiting`): CI, the
 * background work it started, a queue, or something else it named. The same
 * kinds a dispatch return's `waitingOn` carries. */
export type TabWaiting = WaitingOn;

/**
 * Why a row whose turn has ended is not done, for the phone's live board:
 * absent while a turn runs, while the owner is needed (`blocked`/`waiting`),
 * and when nothing is waited on. A sentence in the ended turn's reply that
 * waits on CI or a queue says so; otherwise background work still running is
 * `background`; otherwise the awaited sentence's kind, if the reply has one.
 * Most "needs you" notices were workers waiting on CI (owner, 2026-11-26).
 */
export function tabWaiting(record: TurnRecord | undefined, tab: { agentStatus?: unknown; backgroundTasks?: unknown }): TabWaiting | undefined {
  if (["blocked", "waiting"].includes(String(tab.agentStatus))) return undefined;
  const phase = record ? turnPhase(record) : undefined;
  if (phase?.phase !== "ended") return undefined;
  const awaited = awaitedInReply(phase.reply);
  const kind = awaited ? waitingOn(awaited) : undefined;
  if (kind === "ci" || kind === "queue") return kind;
  if (typeof tab.backgroundTasks === "number" && tab.backgroundTasks > 0) return "background";
  return kind;
}
