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

/** Coalesce local freshness checks without a timer or any remote polling. */
export function localIndexRefresh(options: {
  isFresh: () => boolean;
  refresh: () => Promise<void>;
  runExclusive: (fn: () => Promise<void>) => Promise<unknown>;
  now?: () => number;
  intervalMs?: number;
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
      pending = options.runExclusive(options.refresh).then(() => { failure = undefined; })
        .catch((error: unknown) => { failure = error; throw error; })
        .finally(() => { checkedAt = now(); pending = undefined; });
      return pending;
    },
  };
}
