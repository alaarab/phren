/**
 * In-memory Hook counters: Herdr RPCs by method, process identity probes,
 * git child processes and timer ticks by name. Counting is an integer add on
 * a Map entry, so the hot paths stay as they were. Nothing here is persisted
 * and names come from the Hook's own code, never from a request.
 */

export type MetricKind = "herdr" | "identity" | "git" | "timer";

/** Distinct names kept per kind; anything past this counts under "other". */
const MAX_NAMES = 64;
const NAME = /^[a-z0-9][a-z0-9_.:-]{0,47}$/i;

interface Counter { total: number; minute: number; current: number; previous: number }

export class HookMetrics {
  private readonly counters = new Map<MetricKind, Map<string, Counter>>();
  readonly startedAt: number;

  constructor(private readonly now: () => number = Date.now) { this.startedAt = now(); }

  count(kind: MetricKind, name: string): void {
    let names = this.counters.get(kind);
    if (!names) { names = new Map(); this.counters.set(kind, names); }
    const key = NAME.test(name) ? name : "other";
    let counter = names.get(key);
    if (!counter) {
      // "other" may take the slot past the limit, so it is always countable.
      if (names.size >= MAX_NAMES && key !== "other") return this.count(kind, "other");
      counter = { total: 0, minute: this.minute(), current: 0, previous: 0 };
      names.set(key, counter);
    }
    this.roll(counter);
    counter.total++; counter.current++;
  }

  /**
   * Totals since start, the last complete minute, the minute in progress and
   * the average per minute since start, for each counted name.
   */
  snapshot(): Json {
    const elapsedMinutes = Math.max((this.now() - this.startedAt) / 60_000, 1 / 60);
    const kinds: Record<string, Record<string, { total: number; lastMinute: number; currentMinute: number; perMinute: number }>> = {};
    for (const kind of ["herdr", "identity", "git", "timer"] as const) {
      const entries: Record<string, { total: number; lastMinute: number; currentMinute: number; perMinute: number }> = {};
      for (const [name, counter] of [...(this.counters.get(kind) ?? new Map<string, Counter>())].sort(([a], [b]) => a.localeCompare(b))) {
        this.roll(counter);
        entries[name] = { total: counter.total, lastMinute: counter.previous, currentMinute: counter.current,
          perMinute: Math.round(counter.total / elapsedMinutes * 100) / 100 };
      }
      kinds[kind] = entries;
    }
    return { pid: process.pid, startedAt: new Date(this.startedAt).toISOString(), uptimeSeconds: Math.round((this.now() - this.startedAt) / 1000),
      herdr: kinds.herdr, identity: kinds.identity, git: kinds.git, timers: kinds.timer };
  }

  private minute(): number { return Math.floor(this.now() / 60_000); }
  private roll(counter: Counter): void {
    const minute = this.minute();
    if (minute === counter.minute) return;
    counter.previous = minute === counter.minute + 1 ? counter.current : 0;
    counter.current = 0; counter.minute = minute;
  }
}

type Json = Record<string, unknown>;

/** The Hook process's counters. */
export const hookMetrics = new HookMetrics();
export const countHerdr = (method: string) => hookMetrics.count("herdr", method);
export const countIdentity = (probe: string) => hookMetrics.count("identity", probe);
export const countGit = (caller: string) => hookMetrics.count("git", caller);
export const countTick = (timer: string) => hookMetrics.count("timer", timer);
