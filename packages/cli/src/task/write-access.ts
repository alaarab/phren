/** Whether a background task writer (the scheduled dream's requeue, the weekly
 * audit) may change a project's tasks. readTasks and the task mutations
 * resolve a project into whichever store holds it, so access is checked
 * against that owning store, never the primary one the run started from: a
 * readonly attachment is refused outright, and the owning store's own access
 * rules decide the rest. */
import { permissionDeniedError } from "../governance/rbac.js";
import { resolveProject } from "../store-routing.js";

export function taskWriteDenied(phrenPath: string, project: string, action: "update_task" | "complete_task"): string | undefined {
  let store: { path: string; role: string; name: string } | undefined;
  try { store = resolveProject(phrenPath, project).store; } catch { store = undefined; }
  if (store?.role === "readonly") return `Store "${store.name}" is read-only; ${project}'s tasks cannot change.`;
  return permissionDeniedError(store?.path ?? phrenPath, action, project) ?? undefined;
}
