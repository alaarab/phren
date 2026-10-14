interface Entry<T> {
  value?: { data: T; at: number };
  pending?: Promise<T>;
}

/** Bounded Hook lookups. Invalidated/evicted refreshes may finish for their
 * callers, but cannot repopulate the cache. Failures are never retained. */
export class LookupCache<T> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(
    private readonly ttl: number,
    private readonly maxAge = 300_000,
    private readonly limit = 64,
    private readonly available: (value: T) => boolean = () => true,
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
      entry.pending = Promise.resolve().then(read).then(data => {
        current.value = { data, at: Date.now() };
        return data;
      }, error => {
        // A failed refresh must not keep serving an old success indefinitely.
        if (this.entries.get(key) === current) this.entries.delete(key);
        throw error;
      }).finally(() => { current.pending = undefined; });
    }
    if (cached && age < maxAge) {
      void entry.pending.catch(() => {});
      return Promise.resolve(cached.data);
    }
    return entry.pending;
  }
}
