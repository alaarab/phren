import { AsyncLocalStorage } from "node:async_hooks";

/** Keep only the handles each in-flight reader actually obtained. */
export function indexReaders<T>(current: () => T, close: (handle: T) => void) {
  const calls = new AsyncLocalStorage<{ active: boolean; handles: Set<T> }>();
  const readers = new Map<T, number>();
  const retired = new Set<T>();
  return {
    get(): T {
      const handle = current();
      const call = calls.getStore();
      if (call?.active && !call.handles.has(handle)) {
        call.handles.add(handle);
        readers.set(handle, (readers.get(handle) ?? 0) + 1);
      }
      return handle;
    },
    retire(handle: T) {
      if (readers.has(handle)) retired.add(handle);
      else close(handle);
    },
    run<R>(fn: () => R | Promise<R>): Promise<R> {
      const call = { active: true, handles: new Set<T>() };
      return calls.run(call, async () => {
        try { return await fn(); }
        finally {
          call.active = false;
          for (const handle of call.handles) {
            const count = readers.get(handle)! - 1;
            if (count) readers.set(handle, count);
            else {
              readers.delete(handle);
              if (retired.delete(handle)) close(handle);
            }
          }
        }
      });
    },
  };
}

export interface BusyWait {
  /** Whether an error means "another process is rebuilding" (worth waiting out). */
  isBusy: (error: unknown) => boolean;
  /** Total budget across retries. */
  maxWaitMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** PHREN_INDEX_BUSY_WAIT_MS, default 5000, capped at 30000; 0 disables the wait. */
export function indexBusyWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.PHREN_INDEX_BUSY_WAIT_MS ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 5000;
  return Math.min(parsed, 30_000);
}

const sleepMs = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Run `fn`, and while it fails only because another process holds the rebuild
 * lock, retry with jittered backoff until `maxWaitMs` is spent. Any other
 * error, or the last busy error once the budget is gone, propagates.
 * Another process's rebuild usually leaves a cache entry for the same store
 * state, so the retry after it is a cheap cache load rather than a second build.
 */
export async function retryWhileBusy<T>(fn: () => Promise<T>, wait: BusyWait): Promise<T> {
  const now = wait.now ?? Date.now;
  const sleep = wait.sleep ?? sleepMs;
  const deadline = now() + Math.max(0, wait.maxWaitMs);
  let delay = 50;
  for (;;) {
    try {
      return await fn();
    } catch (error: unknown) {
      const remaining = deadline - now();
      if (!wait.isBusy(error) || remaining <= 0) throw error;
      // Jitter so a crowd of waiting servers does not retry in lockstep.
      await sleep(Math.min(remaining, delay + Math.floor(Math.random() * delay)));
      delay = Math.min(delay * 2, 500);
    }
  }
}

/** Coalesce local freshness checks without a timer or any remote polling. */
export function localIndexRefresh(options: {
  isFresh: () => boolean;
  refresh: () => Promise<void>;
  runExclusive: (fn: () => Promise<void>) => Promise<unknown>;
  now?: () => number;
  intervalMs?: number;
  /** Wait out another process's rebuild instead of failing on the first busy lock. */
  busyWait?: BusyWait;
}): { ensureFresh: () => Promise<void> } {
  const now = options.now ?? Date.now;
  const interval = options.intervalMs ?? 1000;
  let checkedAt = -Infinity;
  let pending: Promise<void> | undefined;
  let failure: unknown;
  return {
    async ensureFresh() {
      if (pending) return pending;
      if (now() - checkedAt < interval) {
        if (failure) throw failure;
        return;
      }
      checkedAt = now();
      try {
        if (options.isFresh()) { failure = undefined; return; }
      } catch (error) { failure = error; throw error; }
      // The wait happens outside runExclusive so queued writes keep flowing
      // between attempts; every concurrent caller shares this one pending run.
      const attempt = () => options.runExclusive(options.refresh);
      const run = options.busyWait ? retryWhileBusy(attempt, options.busyWait) : attempt();
      pending = run.then(() => { failure = undefined; })
        .catch((error: unknown) => { failure = error; throw error; })
        .finally(() => { checkedAt = now(); pending = undefined; });
      return pending;
    },
  };
}
