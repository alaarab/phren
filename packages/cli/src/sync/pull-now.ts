import { pollStore, type PullResult } from "./pull.js";

/** One running pull and one pending wakeup per store; also respects sibling-process locks. */
export class ImmediatePulls {
  private readonly states = new Map<string, { pending: boolean; running: boolean; last: number; timer?: ReturnType<typeof setTimeout> }>();
  private stopped = false;

  constructor(private readonly pull: (store: string) => Promise<PullResult> = store => pollStore(store, 0, undefined, Date.now(), true),
    private readonly intervalMs = 10_000) {}

  request(store: string): void {
    if (this.stopped) return;
    let state = this.states.get(store);
    if (!state) { state = { pending: false, running: false, last: -Infinity }; this.states.set(store, state); }
    state.pending = true;
    if (state.running || state.timer) return;
    const run = async () => {
      state.timer = undefined;
      if (this.stopped) return;
      state.pending = false; state.running = true; state.last = Date.now();
      try {
        const result = await this.pull(store);
        // A sibling process may own either coordination lock. Keep one wakeup until it releases.
        if (result.status === "deferred" && (result.detail === "Coordinated pull is running."
          || result.detail === "Periodic pull deferred: another Phren Git operation is running.")) state.pending = true;
      } catch { /* The next nudge or fallback poll retries failures. */ }
      finally {
        state.running = false;
        if (state.pending && !this.stopped) this.request(store);
      }
    };
    const delay = Math.max(0, state.last + this.intervalMs - Date.now());
    state.timer = setTimeout(() => { void run(); }, delay);
    state.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    for (const state of this.states.values()) clearTimeout(state.timer);
  }
}
