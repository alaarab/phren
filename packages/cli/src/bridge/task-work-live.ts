/** Live state and the sweep for task work links (task-work.ts records them,
 * task/work.ts holds the format): the worker from this Hook's dispatch
 * receipts, pull request and issue state from the forge through the git host
 * providers (cached for a minute, never written to the task), and the
 * five-minute sweep that links pull requests naming a task and closes tasks
 * whose linked pull request merged or linked issue closed. */
import { homedir } from "node:os";
import { updateTaskWork } from "../data/tasks.js";
import { permissionDeniedError } from "../governance/rbac.js";
import { autoCloseReason, bidReferences, branchTaskIds, parseForgeUrl, workerPhase, workStatusLine,
  type Forge, type ForgeItem, type ForgeRef, type LiveWork, type TaskWork } from "../task/work.js";
import { dispatchProjectDirectory, dispatchReceipt } from "./dispatch.js";
import { detectHost, hostInfo, providerFor, type RecentPull } from "./git-hosts.js";
import { dispatchWorkerState, openTasks, taskWorkEnabled, type DispatchReceiptView, type OpenTask } from "./task-work.js";
import { phrenStoreRoot } from "./transcripts.js";

const FORGE_TTL_MS = 60_000;
interface Cached { at: number; value?: ForgeItem; error?: string; pending?: Promise<void> }
const forgeCache = new Map<string, Cached>();

async function fetchForge(ref: ForgeRef, kind: "pull" | "issue"): Promise<ForgeItem> {
  const parsed = parseForgeUrl(ref.url);
  if (!parsed) throw new Error("Unrecognised forge link.");
  const host = hostInfo(ref.forge, { domain: parsed.domain, webUrl: `https://${parsed.domain}/${parsed.repo}`, remote: null, source: "url" });
  const provider = providerFor(host);
  if (!provider?.item) throw new Error(`Phren cannot read ${provider?.name ?? ref.forge} ${kind === "pull" ? "requests" : "issues"} yet.`);
  return provider.item(homedir(), kind, parsed.number, host);
}

/** The cached reading of one pull request or issue, refreshed when older than
 * a minute. Waits at most `waitMs` for a refresh; a slower one lands in the
 * cache for the next read. */
async function forgeState(ref: ForgeRef, kind: "pull" | "issue", waitMs: number): Promise<Cached | undefined> {
  const key = `${kind}:${ref.forge}:${ref.url}`;
  let entry = forgeCache.get(key);
  if (!entry || (Date.now() - entry.at >= FORGE_TTL_MS && !entry.pending)) {
    const next: Cached = entry ? { ...entry } : { at: 0 };
    next.pending = fetchForge(ref, kind).then(value => { next.value = value; next.error = undefined; },
      error => { next.error = (error instanceof Error ? error.message : String(error)).slice(0, 300); })
      .finally(() => { next.at = Date.now(); next.pending = undefined; });
    forgeCache.set(key, next);
    if (forgeCache.size > 2000) forgeCache.delete(forgeCache.keys().next().value!);
    entry = next;
  }
  if (entry.pending && waitMs > 0) await Promise.race([entry.pending, new Promise(resolve => setTimeout(resolve, waitMs).unref())]);
  return entry.at ? entry : undefined;
}

function shown(entry: Cached | undefined): LiveWork["pr"] {
  if (!entry) return null;
  const checkedAt = new Date(entry.at).toISOString();
  return entry.value ? { ...entry.value, checkedAt } : { error: entry.error ?? "Not read yet.", checkedAt };
}

export interface TaskLive extends LiveWork { status?: string }

/** A task's live state: the worker from this Hook's dispatch receipt when it
 * has one (else the state the task recorded), and the pull request and issue
 * from the forge. */
export async function liveWork(work: TaskWork | undefined, waitMs: number): Promise<TaskLive | undefined> {
  if (!work) return undefined;
  const [own, pr, issue] = await Promise.all([
    work.worker ? readReceipt(work.worker.dispatchId).catch(() => undefined) : undefined,
    work.pr ? forgeState(work.pr, "pull", waitMs) : undefined,
    work.issue ? forgeState(work.issue, "issue", waitMs) : undefined,
  ]);
  const live: TaskLive = {};
  if (work.worker) {
    const state = own ? dispatchWorkerState(own) : work.worker.state;
    live.worker = { phase: workerPhase(state), state, at: own?.updatedAt ?? work.worker.at, source: own ? "dispatch" : "task" };
  }
  if (work.pr) live.pr = shown(pr);
  if (work.issue) live.issue = shown(issue);
  live.status = workStatusLine(work, live);
  return live;
}

async function readReceipt(id: string): Promise<DispatchReceiptView | undefined> {
  return /^[0-9a-f-]{36}$/i.test(id) ? dispatchReceipt(id) : undefined;
}

// ---------------------------------------------------------------- the sweep

export const TASK_WORK_TICK_MS = 5 * 60_000;
const FORGE_READS_PER_TICK = 60;
/** Where the next sweep's forge reads start, so a long list is covered over a few sweeps. */
let closeCursor = 0;

export interface SweepResult { linked: number; closed: number; errors: number }

/** Link pull requests that name an open task, then close tasks whose linked
 * pull request merged or whose linked issue closed. */
export class TaskWorkSweeper {
  private running = false;
  constructor(private readonly base: string = phrenStoreRoot()) {}

  async tick(): Promise<SweepResult> {
    const result: SweepResult = { linked: 0, closed: 0, errors: 0 };
    if (this.running || !taskWorkEnabled()) return result;
    this.running = true;
    try {
      await this.link(result);
      await this.close(result);
    } finally { this.running = false; }
    return result;
  }

  private writable(task: OpenTask, action: "update_task" | "complete_task"): boolean {
    return !permissionDeniedError(task.root, action, task.project);
  }

  private async link(result: SweepResult): Promise<void> {
    const open = openTasks(this.base).filter(task => this.writable(task, "update_task"));
    for (const project of [...new Set(open.map(task => task.project))]) {
      const root = await dispatchProjectDirectory(project).catch(() => undefined);
      if (!root) continue;
      const host = await detectHost(root, "").catch(() => undefined);
      const provider = host ? providerFor(host) : null;
      if (!host?.kind || !provider?.recent) continue;
      let pulls: RecentPull[];
      try { pulls = await provider.recent(root, host); } catch { result.errors++; continue; }
      // One closed without merging is no task's work; linking it would hold the slot.
      for (const pull of pulls.filter(row => row.state !== "closed")) {
        const ids = bidReferences(pull.body), branchIds = branchTaskIds(pull.head);
        const matches = open.filter(task => ids.includes(task.identity.stableId)
          || (task.project === project && (branchIds.includes(task.identity.stableId) || (!!pull.head && task.item.work?.branch === pull.head && !task.item.work?.pr))));
        for (const task of matches) if (this.linkPull(task, host.kind, pull)) result.linked++;
      }
    }
  }

  /** The first pull request that names a task is its pull request; a later
   * one doesn't replace it (a dispatch report can). */
  private linkPull(task: OpenTask, forge: Forge, pull: RecentPull): boolean {
    const url = parseForgeUrl(pull.url);
    if (!url || url.kind !== "pull" || url.number !== pull.number) return false;
    const written = updateTaskWork(task.root, task.project, `bid:${task.identity.stableId}`, (work, item) => {
      if (item.stableId !== task.identity.stableId || (work?.pr && work.pr.url !== url.url)) return undefined;
      return { work: { version: 1, ...work, pr: { forge, number: pull.number, url: url.url }, ...(pull.head && !work?.branch ? { branch: pull.head.slice(0, 256) } : {}),
        ...(work?.pr ? {} : { autoClosed: undefined }) } };
    });
    return written.ok && written.data.changed;
  }

  private async close(result: SweepResult): Promise<void> {
    const linked = openTasks(this.base).filter(task => task.item.work && !task.item.work.autoClosed && (task.item.work.pr || task.item.work.issue) && this.writable(task, "complete_task"));
    const start = linked.length ? closeCursor % linked.length : 0;
    let reads = 0, visited = 0;
    for (const task of [...linked.slice(start), ...linked.slice(0, start)]) {
      const work = task.item.work!;
      if ((reads += (work.pr ? 1 : 0) + (work.issue ? 1 : 0)) > FORGE_READS_PER_TICK) break;
      visited++;
      const live = await liveWork({ ...work, worker: undefined }, 20_000);
      const reason = live && autoCloseReason(work, live);
      if (!reason) continue;
      const written = updateTaskWork(task.root, task.project, `bid:${task.identity.stableId}`, (current, item) => {
        // Re-checked under the lock: the same links, and not closed by phren before.
        if (item.stableId !== task.identity.stableId || !current || current.autoClosed || current.pr?.url !== work.pr?.url || current.issue?.url !== work.issue?.url) return undefined;
        return { work: { ...current, autoClosed: { at: new Date().toISOString(), reason: reason.slice(0, 300) } }, complete: reason };
      });
      if (written.ok && written.data.changed) result.closed++;
      else if (!written.ok) result.errors++;
    }
    closeCursor = start + visited;
  }
}
