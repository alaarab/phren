// What the palette remembers about what you pick: item ids and when, never the
// query. Pure scoring plus a small localStorage store (per viewer). Each entry
// keeps a decayed pick count and the time it was last updated, so one row is
// enough to know "how much" without storing every pick.

export const STORE_KEY = "phren.palette.recent";
export const HALF_LIFE_MS = 3 * 24 * 3600 * 1000;
export const MAX_ENTRIES = 200;
export const RECENT_SHOWN = 6;
/** The most frecency can add to a text score: x1.5, so a clearly better match still wins. */
export const MAX_BOOST = 0.5;
const BOOST_PER_LOG2 = 0.25;
const FORGET_BELOW = 0.05;

/** A pick count that halves every HALF_LIFE_MS. */
export function decayed(count, at, now) {
  const age = Math.max(0, now - at);
  return count * Math.pow(0.5, age / HALF_LIFE_MS);
}

/** Multiplier on a match score: 1 + min(MAX_BOOST, 0.25 * log2(1 + decayed count)). */
export function boostFactor(decayedCount) {
  if (!(decayedCount > 0)) return 1;
  return 1 + Math.min(MAX_BOOST, BOOST_PER_LOG2 * Math.log2(1 + decayedCount));
}

/** Ids the palette never learns: memory hits and the "ask" row are one-off, file paths are never stored, and clearing is not a habit. */
export function isRememberable(id) {
  return typeof id === "string" && id !== "" && id !== "ask-quick-chat" && !id.startsWith("file:") && !id.startsWith("memory:") && id !== "command:palette.clear-recent";
}

/** Drop malformed and faded entries, then keep the MAX_ENTRIES strongest. */
export function prune(entries, now) {
  const clean = [];
  const seen = new Set();
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e.id !== "string" || seen.has(e.id) || !isRememberable(e.id)) continue;
    if (!Number.isFinite(e.n) || !Number.isFinite(e.t) || e.n <= 0) continue;
    if (decayed(e.n, Math.min(e.t, now), now) < FORGET_BELOW) continue;
    seen.add(e.id);
    clean.push({ id: e.id, n: e.n, t: Math.min(e.t, now) });
  }
  clean.sort((a, b) => decayed(b.n, b.t, now) - decayed(a.n, a.t, now) || b.t - a.t || a.id.localeCompare(b.id));
  return clean.slice(0, MAX_ENTRIES);
}

/** Record one pick of `id`. Returns the new entries. */
export function bump(entries, id, now) {
  if (!isRememberable(id)) return prune(entries, now);
  const prior = entries.find((e) => e.id === id);
  const n = (prior ? decayed(prior.n, prior.t, now) : 0) + 1;
  return prune([{ id, n, t: now }, ...entries.filter((e) => e.id !== id)], now);
}

/** id -> decayed count, for ranking. */
export function weights(entries, now) {
  return new Map(entries.map((e) => [e.id, decayed(e.n, e.t, now)]));
}

/** Blend a text score with frecency; a non-match (< 0) stays one. */
export function blend(score, id, weightMap) {
  return score < 0 ? score : score * boostFactor(weightMap.get(id) ?? 0);
}

/** The Recent group: the `limit` most recently picked ids that still exist in
 * `available` (id -> item), in frecency order (ties: newer, then id). */
export function recentRows(entries, available, now, limit = RECENT_SHOWN) {
  const live = entries.filter((e) => available.has(e.id));
  const latest = [...live].sort((a, b) => b.t - a.t || a.id.localeCompare(b.id)).slice(0, limit);
  latest.sort((a, b) => decayed(b.n, b.t, now) - decayed(a.n, a.t, now) || b.t - a.t || a.id.localeCompare(b.id));
  return latest.map((e) => available.get(e.id));
}

// ------------------------------------------------------------ storage
export function readRecent(now = Date.now(), storage = globalThis.localStorage) {
  try {
    return prune(JSON.parse(storage.getItem(STORE_KEY) ?? "[]"), now);
  } catch { return []; }
}

export function writeRecent(entries, storage = globalThis.localStorage) {
  try { storage.setItem(STORE_KEY, JSON.stringify(entries)); } catch { /* private window: this session only */ }
}

export function recordPick(id, now = Date.now(), storage = globalThis.localStorage) {
  const next = bump(readRecent(now, storage), id, now);
  writeRecent(next, storage);
  return next;
}

export function clearRecent(storage = globalThis.localStorage) {
  try { storage.removeItem(STORE_KEY); } catch { /* nothing stored */ }
}
