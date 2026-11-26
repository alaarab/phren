/** The nightly dream's first act (issue #934): Active tasks untouched for
 * STALE_MS go back to the Queue, claim released, with the reason appended to
 * their context. The owner inbox (bridge/task-stale.ts) is what surfaced them;
 * this is what settles them. The move stamps lastActivity, so a requeued task
 * is fresh again. `PHREN_TASK_STALE=off` turns it off. */
import { readTasks, updateTask } from "../data/tasks.js";
import { permissionDeniedError } from "../governance/rbac.js";
import { isStale, taskLastTouched, taskTitle } from "../task/session-tasks.js";
import { taskStaleEnabled } from "../bridge/task-stale.js";

/** A task this run returned to the Queue: its stable id and its line without metadata. */
export interface RequeuedTask { stableId: string; title: string }

const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);

export function requeueStaleTasks(phrenPath: string, project: string, now: Date): { requeued: RequeuedTask[]; errors: number } {
  if (!taskStaleEnabled() || permissionDeniedError(phrenPath, "update_task", project)) return { requeued: [], errors: 0 };
  const doc = readTasks(phrenPath, project);
  if (!doc.ok) return { requeued: [], errors: 0 };
  const requeued: RequeuedTask[] = [];
  let errors = 0;
  for (const item of doc.data.items.Active) {
    const touched = taskLastTouched(item);
    if (!item.stableId || touched === undefined || !isStale(item, now.getTime())) continue;
    // updateTask releases the claim on leaving Active and stamps lastActivity itself.
    const result = updateTask(phrenPath, project, `bid:${item.stableId}`, {
      section: "Queue",
      context: `Returned to Queue by the nightly dream on ${dayOf(now.getTime())}: Active and untouched since ${dayOf(touched)}.`,
    });
    if (result.ok) requeued.push({ stableId: item.stableId, title: taskTitle(item.line).slice(0, 200) });
    else errors++;
  }
  return { requeued, errors };
}
