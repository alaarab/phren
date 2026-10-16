// Snooze for Home's Needs you list: a local view preference, per viewer.
// Only a chat that is plainly waiting for a reply can be snoozed. Approvals
// (sudo or any permission request) and blocked agents never can: those hold
// an agent up on a decision, and hiding one would hide that.
//
// An entry is keyed on the row key plus a version (status, approval flag and
// last reply), so a new message or a changed state brings the row back at once.
// `lastChangedAt` is not part of it: tab activity (a rename, a pane move, Herdr
// dropping the tab) bumps it without anything new being asked of the owner.
// A row missing from the overview for under a minute keeps its snooze.
// Entries live in localStorage (`phren.desktop.snoozed`), capped and pruned, and follow other windows through the `storage` event.
// One timer wakes the next entry and is re-armed after every change; it is
// re-checked when the window becomes visible or focused, so a sleeping
// laptop wakes rows on time.

const KEY = "phren.desktop.snoozed";
const MAX_ENTRIES = 50;
const MAX_TIMER_MS = 2 ** 31 - 1;
const GONE_MS = 60_000;

/** The kinds of needs-you row that may be snoozed: a plain wait, nothing else. */
export function snoozable(child) {
  return !!child && child.agentStatus === "waiting" && child.approvalPending !== true && !!child.target;
}

/** What identifies "the same need": a new message or a state change makes a new version. */
export function snoozeVersion(child) {
  return [child?.agentStatus ?? "", child?.approvalPending ? "approval" : "", child?.lastReply ?? ""].join("|");
}

/** The wake times the menu offers, for `now`: 15 minutes, 1 hour, then 9:00 local: today's when it is not yet 9:00, else tomorrow's. */
export function snoozeChoices(now = Date.now()) {
  const nine = new Date(now);
  nine.setHours(9, 0, 0, 0);
  const early = nine.getTime() > now;
  if (!early) nine.setDate(nine.getDate() + 1);
  return [
    { id: "15m", label: "15 minutes", until: now + 15 * 60_000 },
    { id: "1h", label: "1 hour", until: now + 60 * 60_000 },
    { id: "morning", label: early ? "Until 9:00" : "Until tomorrow 9:00", until: nine.getTime() },
  ];
}

function defaultStorage() {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

/** The snooze state over `storage`; `now` and the timer functions are seams for tests. */
export function createSnoozes({ storage = defaultStorage(), now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id) } = {}) {
  const entries = new Map(); // row key -> { version, until, created }
  const listeners = new Set();
  const wakeListeners = new Set();
  const missing = new Map(); // row key -> when it was first absent from an overview
  let timer = null;

  function load() {
    entries.clear();
    try {
      const list = JSON.parse(storage?.getItem(KEY) ?? "[]");
      if (Array.isArray(list)) {
        for (const e of list) {
          if (e && typeof e.key === "string" && typeof e.version === "string" && Number.isFinite(e.until)) {
            entries.set(e.key, { version: e.version, until: e.until, created: Number.isFinite(e.created) ? e.created : 0 });
          }
        }
      }
    } catch { /* unreadable: start empty */ }
  }
  load();

  function persist() {
    try { storage?.setItem(KEY, JSON.stringify([...entries].map(([key, e]) => ({ key, ...e })))); } catch { /* this session only */ }
  }
  function emit() { for (const fn of listeners) { try { fn(); } catch (error) { console.error(error); } } }

  /** Drop expired entries, then the oldest-created beyond MAX_ENTRIES, never `keep` (the one just added). Returns what expired. */
  function prune(keep) {
    const at = now();
    const expired = [];
    for (const [key, e] of entries) if (e.until <= at) { expired.push({ key, version: e.version }); entries.delete(key); }
    if (entries.size > MAX_ENTRIES) {
      const oldest = [...entries].filter(([key]) => key !== keep).sort((a, b) => a[1].created - b[1].created);
      for (const [key] of oldest.slice(0, entries.size - MAX_ENTRIES)) entries.delete(key);
    }
    return expired;
  }

  function arm() {
    if (timer !== null) { clearTimer(timer); timer = null; }
    if (!entries.size) return;
    const next = Math.min(...[...entries.values()].map((e) => e.until));
    timer = setTimer(() => { timer = null; sweep(); }, Math.min(MAX_TIMER_MS, Math.max(0, next - now()) + 5));
  }

  /** Wake what is due: persist, re-arm and tell listeners. Run by the timer and on focus. */
  function sweep() {
    const before = entries.size;
    const expired = prune();
    const changed = expired.length > 0 || entries.size !== before;
    if (changed) persist();
    arm();
    // Wake listeners first, so a notification knows which rows came back by expiry
    // before the redraw that makes them new.
    if (expired.length) for (const fn of wakeListeners) { try { fn(expired.map((e) => e.key), "time"); } catch (error) { console.error(error); } }
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
    /** The wake time of a snoozed row, or null. */
    until(row) { return api.isSnoozed(row) ? entries.get(row.key).until : null; },
    snoozed(rows) {
      return rows.filter((row) => snoozable(row.child) && api.isSnoozed(row))
        .map((row) => ({ ...row, until: entries.get(row.key).until }))
        .sort((a, b) => a.until - b.until);
    },
    /** Snooze a row until `until` (ms); refused (false) for anything not a plain wait. */
    snooze(row, until) {
      if (!snoozable(row.child) || !Number.isFinite(until) || until <= now()) return false;
      entries.set(row.key, { version: snoozeVersion(row.child), until, created: now() });
      missing.delete(row.key);
      prune(row.key);
      persist();
      arm();
      emit();
      return true;
    },
    /** Wake one row now. */
    wake(key) {
      if (!entries.delete(key)) return;
      for (const fn of wakeListeners) { try { fn([key], "manual"); } catch (error) { console.error(error); } }
      persist();
      arm();
      emit();
    },
    /** Forget entries for rows that changed (their version moved on) or can no longer be snoozed. */
    reconcile(rows) {
      const at = now();
      const byKey = new Map(rows.map((row) => [row.key, row]));
      let changed = false;
      for (const [key, e] of entries) {
        const row = byKey.get(key);
        if (row) {
          missing.delete(key);
          if (e.version !== snoozeVersion(row.child) || !snoozable(row.child)) { entries.delete(key); changed = true; }
        } else {
          // One frame without the row (Herdr dropping a tab) is not the end of the chat.
          if (!missing.has(key)) missing.set(key, at);
          if (at - missing.get(key) > GONE_MS) { entries.delete(key); missing.delete(key); changed = true; }
        }
      }
      if (changed) { persist(); arm(); }
    },
    get size() { return entries.size; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** Call `fn(keys, why)` when snoozes end: why is "time" (it ran out) or "manual" (Wake now). A changed row is neither. */
    onWake(fn) { wakeListeners.add(fn); return () => wakeListeners.delete(fn); },
    /** Another window changed the saved snoozes: read them again. */
    reload() { load(); arm(); emit(); },
    sweep,
    /** Arm for what was saved, and re-check whenever the window comes back (sleep, tab switch). Call once. */
    start() {
      sweep();
      if (typeof document === "undefined" || typeof window === "undefined") return () => {};
      const check = () => { if (document.visibilityState !== "hidden") sweep(); };
      document.addEventListener("visibilitychange", check);
      window.addEventListener("focus", check);
      const synced = (event) => { if (event.key === KEY || event.key === null) api.reload(); };
      window.addEventListener("storage", synced);
      return () => {
        document.removeEventListener("visibilitychange", check);
        window.removeEventListener("focus", check);
        window.removeEventListener("storage", synced);
      };
    },
  };
  return api;
}

export const snoozes = createSnoozes();
