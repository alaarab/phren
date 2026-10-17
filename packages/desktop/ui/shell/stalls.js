// Stalled sessions: the Hook marks a working session `stalled` (with
// `stalledSince`) when its screen and transcript have not changed for its
// threshold (5 minutes by default) and no awaited work explains the silence.
import { countOf } from "../text.js";

/** Whole minutes a stalled row has been silent, or null when it is not stalled. */
export function stalledMinutes(child, now = Date.now()) {
  if (!child?.stalled || child.agentStatus !== "working") return null;
  const since = Date.parse(child.stalledSince ?? "");
  const seconds = Number.isFinite(since) ? (now - since) / 1000 : Number(child.stallFor) || 0;
  return Math.max(1, Math.round(seconds / 60));
}

/** "stalled 7m", "stalled 2h". */
export function stallLabel(minutes) {
  return minutes >= 60 ? `stalled ${Math.round(minutes / 60)}h` : `stalled ${minutes}m`;
}

/** "3 background tasks" for a session working only because work it started
 * still runs (the Hook's `backgroundTasks`: sub-agents, background shells). */
export function backgroundLabel(child) {
  const n = Number(child?.backgroundTasks);
  if (!(n > 0) || child.agentStatus !== "working") return "";
  return countOf(n, "background task");
}

/** Rows that turned stalled since the last look (`seen`: keys already stalled). */
export function newlyStalled(rows, seen) {
  return rows.filter((row) => stalledMinutes(row.child) !== null && !seen.has(row.key));
}
