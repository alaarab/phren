import { BridgeError } from "./protocol.js";

interface Entry<T> {
  value?: { data: T; at: number };
  pending?: Promise<T>;
}

/** Bounded Hook lookups. Invalidated/expired refreshes may finish, but cannot
 * repopulate the cache. Failed refreshes retain successes only until maxAge. */
export class LookupCache<T> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(
    private readonly ttl: number,
    private readonly maxAge = 300_000,
    private readonly limit = 64,
    private readonly available: (value: T) => boolean = () => true,
    private readonly pendingTimeout = 45_000,
  ) {}

  invalidate(matches: (key: string) => boolean): void {
    for (const key of this.entries.keys()) if (matches(key)) this.entries.delete(key);
  }

  get(key: string, read: () => Promise<T>): Promise<T> {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {};
      this.entries.set(key, entry);
      if (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
    }
    const cached = entry.value;
    const age = cached ? Date.now() - cached.at : Infinity;
    const available = cached && this.available(cached.data);
    const ttl = available ? this.ttl : 5_000;
    const maxAge = available ? this.maxAge : 5_000;
    if (cached && age < ttl) return Promise.resolve(cached.data);
    if (!entry.pending) {
      const current = entry;
      let timer: ReturnType<typeof setTimeout>;
      const timeout = new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new BridgeError(504, "Lookup did not finish within the request time limit.", { code: "lookup-timeout" })), this.pendingTimeout);
      });
      const pending = Promise.race([Promise.resolve().then(read), timeout]).then(data => {
        if (this.entries.get(key) === current && current.pending === pending) {
          const previous = current.value;
          const keepSuccess = previous && this.available(previous.data) &&
            !this.available(data) && Date.now() - previous.at < this.maxAge;
          if (!keepSuccess) current.value = { data, at: Date.now() };
        }
        return data;
      }).finally(() => {
        clearTimeout(timer);
        if (current.pending === pending) current.pending = undefined;
      });
      entry.pending = pending;
    }
    if (cached && age < maxAge) {
      void entry.pending.catch(() => {});
      return Promise.resolve(cached.data);
    }
    return entry.pending;
  }
}
