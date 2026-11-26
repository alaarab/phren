/** The Hook's side of task work links (task/work.ts holds the format; the
 * live state and the sweep are task-work-live.ts):
 *
 * - a dispatch whose brief names a task records its worker there, and the
 *   worker's state follows the dispatch receipt (`recordDispatchWorker`);
 * - a pull request whose body says `bid:<id>`, or whose branch names the id
 *   or the task's recorded branch, is linked with its branch (`TaskWorkSweeper`);
 * - a merged linked pull request, or a closed linked issue, moves the task to
 *   Done once, with the reason in its history. Nothing is ever reopened, and
 *   nothing is written to a forge;
 * - live state (worker, CI, mergeability, issue state) is read from the
 *   dispatch receipts and the forge through the git host providers, cached
 *   for a minute, and never stored in the task file (`liveWork`).
 *
 * `PHREN_TASK_WORK=off` turns off the sweep and the dispatch recording. */
import { homedir } from "node:os";
import path from "node:path";
import { readTasks, updateTaskWork, type TaskItem } from "../data/tasks.js";
import { taskIdentity, taskStores, type TaskDependency } from "../data/task-contract.js";
import { getStoreProjectDirs } from "../store-registry.js";
import { permissionDeniedError } from "../governance/rbac.js";
import { briefReferences, parseForgeUrl, textNamesTask, workerPhase, type Forge, type WorkWorkerState } from "../task/work.js";
import { git } from "./projects.js";
import { HOST_KINDS, kindFromDomain, type HostKind } from "./git-hosts.js";
import { phrenStoreRoot } from "./transcripts.js";

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

/** The one open task a worker brief names, strongest first: a `bid:` it
 * closes (`fixes bid:…`), the quoted line or title of a task (the dispatch's
 * project first), the brief's only `bid:`, a bare stable id of the dispatch's
 * project. A brief that mentions other tasks for context still binds to the
 * one it quotes. Two candidates at one level name none. */
export function resolveBriefTask(base: string, prompt: string, project: string): TaskDependency | undefined {
  const refs = briefReferences(prompt);
  if (!refs.ids.length && !refs.bareIds.length && !refs.texts.length) return undefined;
  // Several bid: references with no closing one and no quoted title name no task.
  const open = openTasks(base);
  const one = (matches: OpenTask[]) => {
    const unique = [...new Map(matches.map(match => [`${match.identity.storeId}/${match.identity.project}/${match.identity.stableId}`, match])).values()];
    return unique.length === 1 ? unique[0].identity : unique.length > 1 ? null : undefined;
  };
  const here = open.filter(task => task.project === project);
  for (const level of [
    () => open.filter(task => refs.closes.includes(task.item.stableId!)),
    () => here.filter(task => refs.texts.some(text => textNamesTask(text, task.item.line))),
    () => open.filter(task => refs.texts.some(text => textNamesTask(text, task.item.line))),
    () => refs.ids.length === 1 ? open.filter(task => task.item.stableId === refs.ids[0]) : [],
    () => here.filter(task => refs.bareIds.includes(task.item.stableId!)),
  ]) {
    const result = one(level());
    if (result !== undefined) return result ?? undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------- the worker, from its dispatch

/** What `recordDispatchWorker` reads from a dispatch receipt (bridge/dispatch.ts). */
export interface DispatchReceiptView {
  id: string; createdAt: string; updatedAt: string; computer: string; label: string; harness?: string;
  task?: TaskDependency; state: string; branch?: string; cloneDir?: string; closedAt?: string;
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

const recorded = new Map<string, string>();

/** Record (or follow) a dispatch's worker on the task it names. Called after
 * each receipt write; only a change of what the task shows writes the file.
 * A newer dispatch takes the task over; an older one never takes it back. */
export function recordDispatchWorker(receipt: DispatchReceiptView): void {
  if (!receipt.task || !taskWorkEnabled()) return;
  const base = phrenStoreRoot();
  const state = dispatchWorkerState(receipt);
  // A waiting worker parks on what its return named; one back at work after
  // waiting, on the background work its worker row still carries.
  const waitingOn = state === "waiting" ? receipt.returned?.waitingOn ?? receipt.worker?.waitingOn : undefined;
  // Only the branch phren made for the dispatch: a worker's own checkout may be on main.
  const worktree = receipt.cloneDir ?? receipt.returned?.checkout?.path;
  const branch = receipt.branch;
  const key = JSON.stringify([receipt.task, receipt.computer, receipt.target?.session, receipt.label, receipt.harness, state, waitingOn, branch, worktree]);
  if (recorded.get(receipt.id) === key) return;
  const store = taskStores(base).filter(candidate => candidate.taskStoreId === receipt.task!.storeId && candidate.available !== false && candidate.role !== "readonly");
  if (store.length !== 1 || permissionDeniedError(store[0].path, "update_task", receipt.task.project)) return;
  const at = new Date().toISOString();
  const result = updateTaskWork(store[0].path, receipt.task.project, `bid:${receipt.task.stableId}`, (work, item) => {
    if (item.stableId !== receipt.task!.stableId) return undefined;
    const current = work?.worker;
    if (current && current.dispatchId !== receipt.id && workerPhase(current.state) !== "done" && Date.parse(receipt.createdAt) <= Date.parse(current.at)) return undefined;
    const same = current?.dispatchId === receipt.id && current.state === state;
    const worker = { dispatchId: receipt.id, computer: receipt.computer.slice(0, 200),
      ...(receipt.target?.session ? { session: receipt.target.session.slice(0, 200) } : {}),
      ...(receipt.label ? { label: receipt.label.slice(0, 200) } : {}), ...(receipt.harness ? { harness: receipt.harness } : {}),
      state, ...(waitingOn ? { waitingOn } : {}), at: same ? current.at : at };
    return { work: { version: 1, ...work, worker, ...(branch ? { branch } : {}), ...(worktree ? { worktree } : {}) } };
  });
  if (result.ok) recorded.set(receipt.id, key);
  if (recorded.size > 500) recorded.delete(recorded.keys().next().value!);
}

/** A worker the task-launch route started: no receipt follows it, so it is recorded once. */
export function recordLaunchedWorker(root: string, task: TaskDependency, worker: { launchId: string; computer: string; session?: string; label?: string; harness: string; started: boolean }): void {
  if (!taskWorkEnabled()) return;
  updateTaskWork(root, task.project, `bid:${task.stableId}`, (work, item) => item.stableId !== task.stableId ? undefined : { work: { version: 1, ...work,
    worker: { dispatchId: worker.launchId, computer: worker.computer.slice(0, 200), ...(worker.session ? { session: worker.session.slice(0, 200) } : {}),
      ...(worker.label ? { label: worker.label.slice(0, 200) } : {}), harness: worker.harness, state: worker.started ? "working" : "uncertain", at: new Date().toISOString() } } });
}

/** A worker's reported pull request becomes its task's pull request (it
 * replaces a discovered one), on any forge. The task is the one the report or
 * its dispatch names, else the open task whose worker or launch claim is that dispatch. */
export async function linkReportedWork(reports: readonly { url: string; branch: string }[], task: TaskDependency | undefined, dispatch: string | undefined): Promise<{ linked: boolean; error?: string }> {
  const base = phrenStoreRoot();
  const report = [...reports].reverse().find(row => parseForgeUrl(row.url)?.kind === "pull");
  const url = report ? parseForgeUrl(report.url) : undefined;
  if (!report || !url) return { linked: false };
  const forge = await forgeForDomain(url.domain);
  if (!forge) return { linked: false, error: `Phren cannot tell which forge ${url.domain} is; name it with git config --global phren.${url.domain}.host github|gitlab|gitboy.` };
  const targets = openTasks(base).filter(open => task
    ? open.identity.storeId === task.storeId && open.identity.project === task.project && open.identity.stableId === task.stableId
    : !!dispatch && (open.item.work?.worker?.dispatchId === dispatch || open.item.claim?.session === `task-launch:${dispatch}`));
  if (targets.length !== 1) return { linked: false, ...(targets.length ? { error: "Ambiguous task association." } : {}) };
  const target = targets[0];
  if (permissionDeniedError(target.root, "update_task", target.project)) return { linked: false, error: "Task update denied." };
  const written = updateTaskWork(target.root, target.project, `bid:${target.identity.stableId}`, (work, item) => item.stableId !== target.identity.stableId ? undefined
    : { work: { version: 1, ...work, pr: { forge, number: url.number, url: url.url }, branch: report.branch.slice(0, 256) } });
  return written.ok ? { linked: true } : { linked: false, error: written.error };
}

/** The forge a domain is: the public hosts by name, else the owner's
 * `git config --global phren.<domain>.host`, as the git host layer reads it. */
async function forgeForDomain(domain: string): Promise<Forge | undefined> {
  const named = kindFromDomain(domain);
  if (named) return named;
  const configured = (await git(homedir(), "config", "--global", "--get", `phren.${domain}.host`).catch(() => "")).trim().toLowerCase();
  return (HOST_KINDS as readonly string[]).includes(configured) ? configured as HostKind : undefined;
}
