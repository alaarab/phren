// Prefetch a session's transcript snapshot while the pointer rests on its
// sidebar row, so the chat opens with the conversation already rendered.
//
// Only the snapshot is fetched (the history route's newest page, over HTTP);
// no live socket is opened. The chat still attaches its own stream when it
// opens, and the stream's backlog replaces the snapshot exactly as a fresh
// load's would.
import { hookGet } from "../api.js";
import { store } from "./store.js";

export const DWELL_MS = 150;
export const TTL_MS = 60_000;
export const MAX_ENTRIES = 8;
// The history route clamps to the transcript's length, so this asks for the newest page.
const NEWEST = String(Number.MAX_SAFE_INTEGER);

/**
 * `fetchSnapshot(computer, target)` resolves a transcript frame.
 * `ready(computer)` says whether the computer may be read ahead of a click.
 * Rows are keyed by `key`; a `stamp` (the row's lastChangedAt) pins the snapshot
 * to the row state it was read for, so a session that moved on is never served.
 */
export function createPrefetcher({
  fetchSnapshot, ready = () => true, now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id),
  dwellMs = DWELL_MS, ttlMs = TTL_MS, max = MAX_ENTRIES,
} = {}) {
  const entries = new Map(); // key -> { at, stamp, frame }, oldest first
  const timers = new Map(); // key -> dwell timer
  const inflight = new Map(); // computer -> key
  const generation = new Map(); // key -> bumped by invalidate, so an older read never lands

  const live = (entry) => Boolean(entry) && now() - entry.at < ttlMs;

  function start(computer, key, target, stamp) {
    if (!ready(computer) || inflight.has(computer)) return;
    const entry = entries.get(key);
    if (live(entry) && entry.stamp === stamp) return;
    inflight.set(computer, key);
    const gen = generation.get(key) ?? 0;
    Promise.resolve().then(() => fetchSnapshot(computer, target)).then((frame) => {
      if (!frame || (generation.get(key) ?? 0) !== gen) return;
      entries.delete(key);
      entries.set(key, { at: now(), stamp, frame });
      while (entries.size > max) entries.delete(entries.keys().next().value);
    }).catch(() => {}).finally(() => { if (inflight.get(computer) === key) inflight.delete(computer); });
  }

  return {
    /** The pointer rested on (or focus reached) a row: read ahead once it has dwelt. */
    hover(computer, key, target, stamp) {
      if (timers.has(key) || !ready(computer)) return;
      const entry = entries.get(key);
      if (live(entry) && entry.stamp === stamp) return;
      timers.set(key, setTimer(() => {
        timers.delete(key);
        start(computer, key, target, stamp);
      }, dwellMs));
    },
    /** The pointer left or focus moved on before the dwell elapsed: nothing is read. */
    cancel(key) {
      const id = timers.get(key);
      if (id === undefined) return;
      clearTimer(id);
      timers.delete(key);
    },
    /** The snapshot for a row about to open, if it is fresh and the row has not changed since. Used up. */
    take(key, stamp) {
      const entry = entries.get(key);
      entries.delete(key);
      return live(entry) && entry.stamp === stamp ? entry.frame : null;
    },
    /** Forget a row's snapshot; a read in flight for it is dropped on arrival. */
    invalidate(key) {
      generation.set(key, (generation.get(key) ?? 0) + 1);
      entries.delete(key);
    },
    size: () => entries.size,
  };
}

// A computer read ahead of a click must be online, not stressed and not running down its battery.
export function computerReady(computer, merged = store.merged) {
  const co = (merged?.computers ?? []).find((c) => c.computer === computer);
  if (!co || co.state !== "online") return false;
  const res = co.resources;
  if (!res) return true;
  if (res.level === "stressed" || (res.warnings ?? []).includes("battery-low")) return false;
  return !(res.battery && !res.battery.onAC && res.battery.percent < 20);
}

export const keyOf = (computer, target) => `${computer}/${target?.server ?? ""}/${target?.session ?? ""}/${target?.pane ?? ""}`;

const prefetcher = createPrefetcher({
  ready: computerReady,
  fetchSnapshot: (computer, target) => hookGet(computer, "/v1/transcripts/history", { ...target, beforeLine: NEWEST }),
});

export function prefetchTranscript(computer, child) {
  if (child?.target) prefetcher.hover(computer, keyOf(computer, child.target), child.target, child.lastChangedAt ?? "");
}
export function cancelPrefetch(computer, child) {
  if (child?.target) prefetcher.cancel(keyOf(computer, child.target));
}
export function takePrefetched(computer, child) {
  return child?.target ? prefetcher.take(keyOf(computer, child.target), child.lastChangedAt ?? "") : null;
}
export function invalidatePrefetch(computer, child) {
  if (child?.target) prefetcher.invalidate(keyOf(computer, child.target));
}
