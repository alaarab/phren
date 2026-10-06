/**
 * In-memory Hook counters: Herdr RPCs by method, process identity probes,
 * git child processes and timer ticks by name. Counting is an integer add on
 * a Map entry, so the hot paths stay as they were. Nothing here is persisted
 * and names come from the Hook's own code, never from a request.
 */
/** Distinct names kept per kind; anything past this counts under "other". */
const MAX_NAMES = 64;
const NAME = /^[a-z0-9][a-z0-9_.:-]{0,47}$/i;
export class HookMetrics {
    now;
    counters = new Map();
    startedAt;
    constructor(now = Date.now) {
        this.now = now;
        this.startedAt = now();
    }
    count(kind, name) {
        let names = this.counters.get(kind);
        if (!names) {
            names = new Map();
            this.counters.set(kind, names);
        }
        const key = NAME.test(name) ? name : "other";
        let counter = names.get(key);
        if (!counter) {
            // "other" may take the slot past the limit, so it is always countable.
            if (names.size >= MAX_NAMES && key !== "other")
                return this.count(kind, "other");
            counter = { total: 0, minute: this.minute(), current: 0, previous: 0 };
            names.set(key, counter);
        }
        this.roll(counter);
        counter.total++;
        counter.current++;
    }
    /**
     * Totals since start, the last complete minute, the minute in progress and
     * the average per minute since start, for each counted name.
     */
    snapshot() {
        const elapsedMinutes = Math.max((this.now() - this.startedAt) / 60_000, 1 / 60);
        const kinds = {};
        for (const kind of ["herdr", "identity", "git", "timer"]) {
            const entries = {};
            for (const [name, counter] of [...(this.counters.get(kind) ?? new Map())].sort(([a], [b]) => a.localeCompare(b))) {
                this.roll(counter);
                entries[name] = { total: counter.total, lastMinute: counter.previous, currentMinute: counter.current,
                    perMinute: Math.round(counter.total / elapsedMinutes * 100) / 100 };
            }
            kinds[kind] = entries;
        }
        return { pid: process.pid, startedAt: new Date(this.startedAt).toISOString(), uptimeSeconds: Math.round((this.now() - this.startedAt) / 1000),
            herdr: kinds.herdr, identity: kinds.identity, git: kinds.git, timers: kinds.timer };
    }
    minute() { return Math.floor(this.now() / 60_000); }
    roll(counter) {
        const minute = this.minute();
        if (minute === counter.minute)
            return;
        counter.previous = minute === counter.minute + 1 ? counter.current : 0;
        counter.current = 0;
        counter.minute = minute;
    }
}
/** The Hook process's counters. */
export const hookMetrics = new HookMetrics();
export const countHerdr = (method) => hookMetrics.count("herdr", method);
export const countIdentity = (probe) => hookMetrics.count("identity", probe);
export const countGit = (caller) => hookMetrics.count("git", caller);
export const countTick = (timer) => hookMetrics.count("timer", timer);
