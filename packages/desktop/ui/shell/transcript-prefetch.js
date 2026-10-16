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
export const FETCH_TIMEOUT_MS = 5_000;
export const BACKOFF_MS = 30_000;
// The live backlog's opening page (packages/cli/src/bridge/transcripts.ts): the snapshot is trimmed to the
// same window so the chat never shrinks or jumps when the backlog replaces it.
export const OPENING_ENTRIES = 60;
export const OPENING_BYTES = 1_048_576;
// The history route clamps to the transcript's length, so this asks for the newest page.
const NEWEST = String(Number.MAX_SAFE_INTEGER);

/** The newest `OPENING_ENTRIES` entries within `OPENING_BYTES`, with the cursor and hasMore for what was left out; null when it holds nothing. */
export function trimSnapshot(frame, maxEntries = OPENING_ENTRIES, maxBytes = OPENING_BYTES) {
  if (!frame || !Array.isArray(frame.entries)) return null;
  const kept = [];
  let bytes = 0;
  for (let i = frame.entries.length - 1; i >= 0 && kept.length < maxEntries; i--) {
    const size = JSON.stringify(frame.entries[i]).length;
    if (bytes + size > maxBytes) break;
    bytes += size;
    kept.push(frame.entries[i]);
  }
  kept.reverse();
  if (!kept.length && frame.entries.length) return null;
  const dropped = kept.length < frame.entries.length;
  const first = kept[0]?.line;
  return { ...frame, entries: kept, ...(dropped && first !== undefined ? { startLine: first } : {}), hasMore: dropped || frame.hasMore === true, bytes };
}

/**
 * `fetchSnapshot(computer, target, signal)` resolves a transcript frame.
 * `ready(computer)` says whether the computer may be read ahead of a click.
 * Rows are keyed by `key`; a `stamp` (the row's lastChangedAt) pins the snapshot
 * to the row state it was read for, so a session that moved on is never served.
 */
export function createPrefetcher({
  fetchSnapshot, ready = () => true, now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id),
  dwellMs = DWELL_MS, ttlMs = TTL_MS, max = MAX_ENTRIES, timeoutMs = FETCH_TIMEOUT_MS, backoffMs = BACKOFF_MS, maxBytes = OPENING_BYTES,
} = {}) {
  const entries = new Map(); // key -> { at, stamp, frame }, oldest first
  const timers = new Map(); // key -> dwell timer
  const inflight = new Map(); // computer -> { key, abort }
  const backoff = new Map(); // computer -> time it may be read again
  const open = new Set(); // keys of chats already open: their live stream is the transcript

  const live = (entry) => Boolean(entry) && now() - entry.at < ttlMs;
  const prune = () => { for (const [key, entry] of entries) if (!live(entry)) entries.delete(key); };
  const allowed = (computer, key) => !open.has(key) && ready(computer) && !((backoff.get(computer) ?? 0) > now());

  function start(computer, key, target, stamp) {
    if (!allowed(computer, key) || inflight.has(computer)) return;
    const entry = entries.get(key);
    if (live(entry) && entry.stamp === stamp) return;
    const controller = new AbortController();
    let cancelled = false;
    const timeout = setTimer(() => { backoff.set(computer, now() + backoffMs); controller.abort(); if (inflight.get(computer) === mine) inflight.delete(computer); }, timeoutMs);
    const mine = { key, abort: () => { cancelled = true; controller.abort(); if (inflight.get(computer) === mine) inflight.delete(computer); } };
    inflight.set(computer, mine);
    Promise.resolve().then(() => fetchSnapshot(computer, target, controller.signal)).then((read) => {
      if (controller.signal.aborted) throw new Error("aborted");
      const frame = trimSnapshot(read);
      if (!frame) return;
      if (frame.bytes > maxBytes) return;
      entries.delete(key);
      entries.set(key, { at: now(), stamp, frame });
      prune();
      while (entries.size > max) entries.delete(entries.keys().next().value);
    }).catch(() => { if (!cancelled) backoff.set(computer, now() + backoffMs); })
      .finally(() => { clearTimer(timeout); if (inflight.get(computer) === mine) inflight.delete(computer); });
  }

  return {
    /** The pointer rested on (or focus reached) a row: read ahead once it has dwelt. */
    hover(computer, key, target, stamp) {
      prune();
      if (timers.has(key) || !allowed(computer, key)) return;
      const entry = entries.get(key);
      if (live(entry) && entry.stamp === stamp) return;
      timers.set(key, setTimer(() => {
        timers.delete(key);
        start(computer, key, target, stamp);
      }, dwellMs));
    },
    /** The pointer left or focus moved on: nothing is read, and a read in flight for the row is aborted. */
    cancel(key) {
      const id = timers.get(key);
      if (id !== undefined) { clearTimer(id); timers.delete(key); }
      for (const read of inflight.values()) if (read.key === key) read.abort();
    },
    /** The snapshot for a row about to open, if it is fresh and the row has not changed since. Used up. */
    take(key, stamp) {
      const entry = entries.get(key);
      entries.delete(key);
      return live(entry) && entry.stamp === stamp ? entry.frame : null;
    },
    /** A chat opened (or closed) on this row: an open chat is never read ahead. */
    setOpen(key, isOpen) { if (isOpen) { open.add(key); this.cancel(key); } else open.delete(key); },
    size: () => entries.size,
    inflight: (computer) => inflight.has(computer),
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
  fetchSnapshot: (computer, target, signal) => hookGet(computer, "/v1/transcripts/history", { ...target, beforeLine: NEWEST }, { signal }),
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
/** A chat is open on this row (or closed): the open chat's own stream is its transcript. */
export function setChatOpen(computer, child, isOpen) {
  if (child?.target) prefetcher.setOpen(keyOf(computer, child.target), isOpen);
}
