// Mute notifications for one chat: a per-viewer preference in localStorage (`phren.desktop.muted`,
// a JSON array of row keys, `<computer>/<child id>`). A muted chat raises no native notification
// and adds nothing to the dock badge or the tray; it still shows in Home's Needs you and the
// sidebar, which carry a small muted bell. Keys of chats that left the overview are pruned.

const KEY = "phren.desktop.muted";
const MAX_ENTRIES = 200;
export const GONE_MS = 60_000; // a chat missing this long (not just one frame) is forgotten

/** The decision: may this row raise a notification or count toward the badge? `mutedKeys` is a Set of row keys. */
export function notifiable(row, mutedKeys) {
  return !mutedKeys.has(row.key);
}

/** The rows that may notify or count. */
export function unmutedRows(rows, mutedKeys) {
  return mutedKeys.size ? rows.filter((row) => notifiable(row, mutedKeys)) : rows;
}

/** Forget muted keys whose chat has been absent from `liveKeys` for `graceMs`. `missing` (key -> first seen absent) is carried between calls. */
export function pruneMuted(keys, liveKeys, missing, now, graceMs = GONE_MS) {
  const kept = new Set();
  const nextMissing = new Map();
  for (const key of keys) {
    if (liveKeys.has(key)) { kept.add(key); continue; }
    const since = missing.get(key) ?? now;
    if (now - since < graceMs) { kept.add(key); nextMissing.set(key, since); }
  }
  return { keys: kept, missing: nextMissing };
}

function defaultStorage() {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

/** The muted set over `storage`; `now` is a seam for tests. */
export function createMuted({ storage = defaultStorage(), now = () => Date.now() } = {}) {
  let keys = new Set();
  let missing = new Map();
  const listeners = new Set();

  function load() {
    keys = new Set();
    try {
      const list = JSON.parse(storage?.getItem(KEY) ?? "[]");
      if (Array.isArray(list)) for (const key of list) if (typeof key === "string" && key) keys.add(key);
    } catch { /* unreadable: start empty */ }
    while (keys.size > MAX_ENTRIES) keys.delete(keys.values().next().value);
  }
  load();

  function persist() {
    try { storage?.setItem(KEY, JSON.stringify([...keys])); } catch { /* this session only */ }
  }
  function emit() { for (const fn of listeners) { try { fn(); } catch (error) { console.error(error); } } }

  const api = {
    has(key) { return keys.has(key); },
    /** A copy, safe to hold. */
    keys() { return new Set(keys); },
    set(key, on) {
      if (on === keys.has(key)) return;
      if (on) keys.add(key); else keys.delete(key);
      while (keys.size > MAX_ENTRIES) keys.delete(keys.values().next().value);
      persist();
      emit();
    },
    toggle(key) { api.set(key, !keys.has(key)); return keys.has(key); },
    /** Drop chats that have left the overview; `liveKeys` is every row key it lists, offline computers included. */
    prune(liveKeys) {
      const next = pruneMuted(keys, liveKeys, missing, now());
      missing = next.missing;
      if (next.keys.size === keys.size) return;
      keys = next.keys;
      persist();
      emit();
    },
    /** Re-read storage (another window changed it). */
    reload() {
      const before = [...keys].sort().join("\n");
      load();
      if ([...keys].sort().join("\n") !== before) emit();
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("storage", (event) => { if (event.key === KEY || event.key === null) api.reload(); });
  }
  return api;
}

export const muted = createMuted();
