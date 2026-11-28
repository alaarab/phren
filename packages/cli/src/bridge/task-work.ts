/** Read existing task links and record workers started by the legacy task-launch route. */
import path from "node:path";
import { readTasks, updateTaskWork, type TaskItem } from "../data/tasks.js";
import { taskIdentity, taskStores, type TaskDependency } from "../data/task-contract.js";
import { getStoreProjectDirs } from "../store-registry.js";
import type { WorkWorkerState } from "../task/work.js";

export function taskWorkEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PHREN_TASK_WORK?.trim().toLowerCase() !== "off";
}

export interface OpenTask { root: string; project: string; item: TaskItem; identity: TaskDependency }

/** Every open (Active or Queue) task with a usable identity in the writable stores. */
export function openTasks(base: string, project?: string): OpenTask[] {
  const found: OpenTask[] = [];
  for (const store of taskStores(base)) {
    if (store.available === false || store.role === "readonly") continue;
    for (const directory of getStoreProjectDirs(store)) {
      const name = path.basename(directory);
      if (project && name !== project) continue;
      const doc = readTasks(store.path, name);
      if (!doc.ok || path.resolve(doc.data.path) !== path.join(path.resolve(store.path), name, "tasks.md")) continue;
      for (const item of [...doc.data.items.Active, ...doc.data.items.Queue]) {
        const identity = item.stableId && !item.identityAmbiguous ? taskIdentity(base, doc.data, item) : undefined;
        if (identity) found.push({ root: store.path, project: name, item, identity });
      }
    }
  }
  return found;
}

// ---------------------------------------------------------------- the worker, from its dispatch

/** The receipt fields used to render a stored task work link. */
export interface DispatchReceiptView {
  id: string; createdAt: string; updatedAt: string; computer: string; label: string; harness?: string;
  state: string; branch?: string; cloneDir?: string; closedAt?: string;
  target?: { server?: string; session?: string };
  worker?: { state: string; since: string; waitingOn?: "ci" | "background" | "queue" | "other" };
  returned?: { state: string; at: string; checkout?: { path: string; branch?: string }; waitingOn?: "ci" | "background" | "queue" | "other" };
}

/** The receipt's worker state as a task records it. A return wins unless the
 * worker was seen working again after it. */
export function dispatchWorkerState(receipt: DispatchReceiptView): WorkWorkerState {
  const returned = receipt.returned;
  const workingAgain = receipt.worker?.state === "working" && returned && Date.parse(receipt.worker.since) > Date.parse(returned.at);
  if (returned && !workingAgain) return returned.state as WorkWorkerState;
  if (receipt.closedAt) return "closed";
  if (receipt.state === "launching" || receipt.state === "sending") return "launching";
  if (receipt.state === "failed") return "failed";
  if (receipt.worker) return receipt.worker.state as WorkWorkerState;
  return receipt.state === "uncertain" ? "uncertain" : "working";
}

/** A worker the task-launch route started: no receipt follows it, so it is recorded once. */
export function recordLaunchedWorker(root: string, task: TaskDependency, worker: { launchId: string; computer: string; session?: string; label?: string; harness: string; started: boolean }): void {
  if (!taskWorkEnabled()) return;
  updateTaskWork(root, task.project, `bid:${task.stableId}`, (work, item) => item.stableId !== task.stableId ? undefined : { work: { version: 1, ...work,
    worker: { dispatchId: worker.launchId, computer: worker.computer.slice(0, 200), ...(worker.session ? { session: worker.session.slice(0, 200) } : {}),
      ...(worker.label ? { label: worker.label.slice(0, 200) } : {}), harness: worker.harness, state: worker.started ? "working" : "uncertain", at: new Date().toISOString() } } });
}
