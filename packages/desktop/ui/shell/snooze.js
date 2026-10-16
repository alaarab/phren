// Snooze for Home's Needs you list: a local view preference, per viewer.
// Only a chat that is plainly waiting for a reply can be snoozed. Approvals
// (sudo or any permission request) and blocked agents never can: those hold
// an agent up on a decision, and hiding one would hide that.
//
// An entry is keyed on the row key plus a version (status, last change and
// last reply), so a new message or a changed state brings the row back at once.
// Entries live in localStorage (`phren.desktop.snoozed`), capped and pruned.
// One timer wakes the next entry and is re-armed after every change; it is
// re-checked when the window becomes visible or focused, so a sleeping
// laptop wakes rows on time.

const KEY = "phren.desktop.snoozed";
const MAX_ENTRIES = 50;
const MAX_TIMER_MS = 2 ** 31 - 1;

/** The kinds of needs-you row that may be snoozed: a plain wait, nothing else. */
export function snoozable(child) {
  return !!child && child.agentStatus === "waiting" && child.approvalPending !== true && !!child.target;
}

/** What identifies "the same need": a new message or a state change makes a new version. */
export function snoozeVersion(child) {
  return [child?.agentStatus ?? "", child?.approvalPending ? "approval" : "", child?.lastChangedAt ?? "", child?.lastReply ?? ""].join("|");
}

/** The wake times the menu offers, for `now`: 15 minutes, 1 hour, tomorrow 9:00 local. */
export function snoozeChoices(now = Date.now()) {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return [
    { id: "15m", label: "15 minutes", until: now + 15 * 60_000 },
    { id: "1h", label: "1 hour", until: now + 60 * 60_000 },
    { id: "tomorrow", label: "Until tomorrow 9:00", until: tomorrow.getTime() },
  ];
}

function defaultStorage() {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

/** The snooze state over `storage`; `now` and the timer functions are seams for tests. */
export function createSnoozes({ storage = defaultStorage(), now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const entries = new Map(); // row key -> { version, until }
  const listeners = new Set();
  let timer = null;

  try {
    const list = JSON.parse(storage?.getItem(KEY) ?? "[]");
    if (Array.isArray(list)) {
      for (const e of list) {
        if (e && typeof e.key === "string" && typeof e.version === "string" && Number.isFinite(e.until)) entries.set(e.key, { version: e.version, until: e.until });
      }
    }
  } catch { /* unreadable: start empty */ }

  function persist() {
    try { storage?.setItem(KEY, JSON.stringify([...entries].map(([key, e]) => ({ key, ...e })))); } catch { /* this session only */ }
  }
  function emit() { for (const fn of listeners) { try { fn(); } catch (error) { console.error(error); } } }

  /** Drop expired entries and keep the latest-waking MAX_ENTRIES. True when something went. */
  function prune() {
    const at = now();
    let changed = false;
    for (const [key, e] of entries) if (e.until <= at) { entries.delete(key); changed = true; }
    if (entries.size > MAX_ENTRIES) {
      const keep = [...entries].sort((a, b) => b[1].until - a[1].until).slice(0, MAX_ENTRIES);
      entries.clear();
      for (const [key, e] of keep) entries.set(key, e);
      changed = true;
    }
    return changed;
  }

  function arm() {
    if (timer !== null) { clearTimer(timer); timer = null; }
    if (!entries.size) return;
    const next = Math.min(...[...entries.values()].map((e) => e.until));
    timer = setTimer(() => { timer = null; sweep(); }, Math.min(MAX_TIMER_MS, Math.max(0, next - now()) + 5));
  }

  /** Wake what is due: persist, re-arm and tell listeners. Run by the timer and on focus. */
  function sweep() {
    const changed = prune();
    if (changed) persist();
    arm();
    if (changed) emit();
  }

  const api = {
    /** Whether this row is hidden right now: unexpired, and nothing about it has changed. */
    isSnoozed(row) {
      const e = entries.get(row.key);
      return !!e && e.until > now() && snoozable(row.child) && e.version === snoozeVersion(row.child);
    },
    /** Rows not snoozed. */
    visible(rows) { return rows.filter((row) => !api.isSnoozed(row)); },
    /** Snoozed rows with their wake time, soonest first. */
    snoozed(rows) {
      return rows.filter((row) => snoozable(row.child) && api.isSnoozed(row))
        .map((row) => ({ ...row, until: entries.get(row.key).until }))
        .sort((a, b) => a.until - b.until);
    },
    /** Snooze a row until `until` (ms); refused (false) for anything not a plain wait. */
    snooze(row, until) {
      if (!snoozable(row.child) || !Number.isFinite(until) || until <= now()) return false;
      entries.set(row.key, { version: snoozeVersion(row.child), until });
      prune();
      persist();
      arm();
      emit();
      return true;
    },
    /** Wake one row now. */
    wake(key) {
      if (!entries.delete(key)) return;
      persist();
      arm();
      emit();
    },
    /** Forget entries for rows that changed (their version moved on) or can no longer be snoozed. */
    reconcile(rows) {
      let changed = false;
      for (const row of rows) {
        const e = entries.get(row.key);
        if (e && (e.version !== snoozeVersion(row.child) || !snoozable(row.child))) { entries.delete(row.key); changed = true; }
      }
      if (changed) { persist(); arm(); }
    },
    get size() { return entries.size; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    sweep,
    /** Arm for what was saved, and re-check whenever the window comes back (sleep, tab switch). Call once. */
    start() {
      sweep();
      if (typeof document === "undefined" || typeof window === "undefined") return () => {};
      const check = () => { if (document.visibilityState !== "hidden") sweep(); };
      document.addEventListener("visibilitychange", check);
      window.addEventListener("focus", check);
      return () => { document.removeEventListener("visibilitychange", check); window.removeEventListener("focus", check); };
    },
  };
  return api;
}

export const snoozes = createSnoozes();
