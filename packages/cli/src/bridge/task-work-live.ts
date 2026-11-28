/** Live state for existing task work links, read from receipts and the forge. */
import { homedir } from "node:os";
import { parseForgeUrl, workerPhase, workStatusLine,
  type ForgeItem, type ForgeRef, type LiveForge, type LiveWork, type TaskWork } from "../task/work.js";
import { dispatchReceipt } from "./dispatch.js";
import { hostInfo, kindFromDomain, providerFor } from "./git-hosts.js";
import { dispatchWorkerState, type DispatchReceiptView } from "./task-work.js";

const FORGE_TTL_MS = 60_000;
/** `at` is the last completed attempt, `startedAt` the latest start, `readAt` the last success. */
interface Cached { at: number; startedAt: number; readAt?: number; value?: ForgeItem; error?: string; pending?: Promise<void> }
const forgeCache = new Map<string, Cached>();

/** At most this many forge reads (`gh` processes, gitboy calls) at once,
 * whatever a long task list asks for; the rest queue and fill the cache. */
const FORGE_CONCURRENCY = 4;
let forgeRunning = 0;
const forgeQueue: (() => void)[] = [];
async function limited<T>(run: () => Promise<T>): Promise<T> {
  if (forgeRunning >= FORGE_CONCURRENCY) await new Promise<void>(resolve => forgeQueue.push(resolve));
  forgeRunning++;
  try { return await run(); } finally { forgeRunning--; forgeQueue.shift()?.(); }
}

async function fetchForge(ref: ForgeRef, kind: "pull" | "issue"): Promise<ForgeItem> {
  const parsed = parseForgeUrl(ref.url);
  if (!parsed) throw new Error("Unrecognised forge link.");
  const host = hostInfo(ref.forge, { domain: parsed.domain, webUrl: `https://${parsed.domain}/${parsed.repo}`, remote: null, source: "url" });
  const provider = providerFor(host);
  if (!provider?.item) throw new Error(`Phren cannot read ${provider?.name ?? ref.forge} ${kind === "pull" ? "requests" : "issues"} yet.`);
  return limited(() => provider.item!(homedir(), kind, parsed.number, host));
}

/** Refresh after a minute or when the inbox needs a newer reversible reading. Wait at most `waitMs`. */
async function forgeState(ref: ForgeRef, kind: "pull" | "issue", waitMs: number, after = -Infinity): Promise<Cached | undefined> {
  const key = `${kind}:${ref.forge}:${ref.url}`, now = Date.now();
  let entry = forgeCache.get(key);
  if (!entry || (!entry.pending && (now - entry.at >= FORGE_TTL_MS || (entry.startedAt <= after && entry.value?.state !== "merged")))) {
    const next: Cached = { ...entry, at: entry?.at ?? 0, startedAt: now };
    next.pending = fetchForge(ref, kind).then(value => { next.value = value; next.error = undefined; next.readAt = Date.now(); },
      error => { next.error = (error instanceof Error ? error.message : String(error)).slice(0, 300); })
      .finally(() => { next.at = Date.now(); next.pending = undefined; });
    forgeCache.set(key, next);
    if (forgeCache.size > 2000) forgeCache.delete(forgeCache.keys().next().value!);
    entry = next;
  }
  if (entry.pending && waitMs > 0) await Promise.race([entry.pending, new Promise(resolve => setTimeout(resolve, waitMs).unref())]);
  return entry.at ? entry : undefined;
}

/** Nonblocking inbox probe. A reversible closure needs a successful read started after the item changed. */
export async function cachedPull(url: string, after: number): Promise<ForgeItem | undefined> {
  const parsed = parseForgeUrl(url);
  if (!parsed || parsed.kind !== "pull") return undefined;
  const entry = await forgeState({ forge: kindFromDomain(parsed.domain) ?? "github", number: parsed.number, url: parsed.url }, "pull", 0, after);
  if (entry?.value?.state === "closed" && (entry.startedAt <= after || entry.pending || entry.error !== undefined)) return undefined;
  return entry?.value;
}

function shown(entry: Cached | undefined): LiveForge {
  if (!entry) return null;
  if (entry.value && entry.readAt) return { ...entry.value, checkedAt: new Date(entry.readAt).toISOString(), ...(entry.error ? { error: entry.error } : {}) };
  return { error: entry.error ?? "Not read yet.", checkedAt: new Date(entry.at).toISOString() };
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
