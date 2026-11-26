/** Stale Active tasks as owner-inbox rows (issue #934): an Active task
 * untouched for STALE_MS is the owner's business. This Hook lists the ones it
 * reports — unclaimed or claimed here; another computer's claim is that
 * computer's row — and the nightly dream (dream/stale-tasks.ts) returns them
 * to the Queue. A task that is touched, done or back in the Queue stops
 * being a source, and the inbox resolves its row itself.
 * `PHREN_TASK_STALE=off` turns both off. */
import { isLocalComputer } from "./dispatch-hosts.js";
import type { InboxSource } from "./owner-inbox.js";
import { openTasks } from "./task-work.js";
import { isStale, taskLastTouched, taskTitle } from "../task/session-tasks.js";
import { phrenStoreRoot } from "./transcripts.js";

export function taskStaleEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PHREN_TASK_STALE?.trim().toLowerCase() !== "off";
}

/** The inbox calls its sources every five seconds; recompute at most this often. */
const CACHE_MS = 5 * 60 * 1000;
const ROW_LIMIT = 20;

const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);
// The inbox parses rows with zod; a stray control character must never fail the list.
const clean = (text: string) => text.replace(/[\x00-\x1f\x7f]+/g, " ").trim();

export class StaleTaskSources {
  private cache?: { at: number; rows: InboxSource[] };
  constructor(private readonly base = phrenStoreRoot(), private readonly now: () => number = Date.now,
    private readonly local: (computer: string) => boolean = computer => isLocalComputer(computer)) {}

  sources(): InboxSource[] {
    if (!taskStaleEnabled()) return [];
    const now = this.now();
    if (this.cache && now - this.cache.at < CACHE_MS) return this.cache.rows;
    try {
      this.cache = { at: now, rows: this.compute(now) };
    } catch { /* a failed read keeps the previous rows rather than failing the inbox */ }
    return this.cache?.rows ?? [];
  }

  /** Oldest first, at most 20: one row per stale Active task this computer reports. */
  private compute(now: number): InboxSource[] {
    const found = openTasks(this.base)
      .filter(task => task.item.stableId && isStale(task.item, now)
        // A task claimed by another computer is that computer's row, not this Hook's.
        && (!task.item.claim || this.local(task.item.claim.computer)))
      .sort((a, b) => (taskLastTouched(a.item) ?? 0) - (taskLastTouched(b.item) ?? 0));
    return found.slice(0, ROW_LIMIT).map(task => ({
      source: `task-stale:${task.project}:${task.item.stableId}`,
      kind: "needs-you" as const,
      project: task.project,
      title: clean(`Stale task in ${task.project}: ${taskTitle(task.item.line).slice(0, 120)} (Active, untouched since ${dayOf(taskLastTouched(task.item) ?? now)})`).slice(0, 500),
    }));
  }
}
