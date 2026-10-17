// Which chats have an unsent draft, for the small "Draft" mark on sidebar rows. The composer keeps
// one draft per chat in localStorage under `draftKey(target, computer)`; this module caches the set
// of those keys that hold text (one scan at startup), then follows the composer's `phren:draft`
// event and other windows' `storage` events, so a render never reads storage.
import { draftKey } from "../chat/composer.js";

const PREFIX = "phren.composer.draft.";
export const DRAFT_EVENT = "phren:draft";

/**
 * The row keys (`<computer>/<child id>`) whose draft is in `storageKeys`; rows are `{ computer, child }`.
 * The composer keys a draft by the target it captured when the tab opened, and `target.session` can
 * appear afterwards, so a row matches the key without the session too. A key with a different
 * session belongs to an earlier conversation in a reused pane and does not mark this one; a row
 * with no session yet matches any session's key in its pane.
 */
export function draftRowKeys(storageKeys, rows) {
  const out = new Set();
  if (!storageKeys.size) return out;
  const keys = [...storageKeys];
  for (const { computer, child } of rows) {
    if (!child?.target) continue;
    const { source, server, pane, session } = child.target;
    const base = draftKey({ source, server, pane }, computer);
    const own = session ? (key) => key === base || key === draftKey(child.target, computer) : (key) => key === base || key.startsWith(`${base}:`);
    if (keys.some(own)) out.add(`${computer}/${child.id}`);
  }
  return out;
}

/** True when a saved draft value is worth marking (whitespace alone is not). */
export function isDraftText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function defaultStorage() {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

/** The draft-key cache over `storage`. `note(key, value)` is the composer's write; `reload()` rescans. */
export function createDrafts({ storage = defaultStorage() } = {}) {
  let keys = new Set();
  const listeners = new Set();
  const emit = () => { for (const fn of [...listeners]) fn(); };

  function scan() {
    keys = new Set();
    try {
      for (let i = 0; storage && i < storage.length; i++) {
        const key = storage.key(i);
        if (key && key.startsWith(PREFIX) && isDraftText(storage.getItem(key))) keys.add(key);
      }
    } catch { /* storage unavailable */ }
  }
  scan();

  const api = {
    keys: () => keys,
    /** One key's new value: updates the cache and notifies only when membership changed. */
    note(key, value) {
      if (!key.startsWith(PREFIX)) return;
      const has = keys.has(key);
      const next = isDraftText(value);
      if (next === has) return;
      if (next) keys.add(key); else keys.delete(key);
      emit();
    },
    reload() {
      const before = keys.size;
      const old = keys;
      scan();
      if (keys.size !== before || [...keys].some((k) => !old.has(k))) emit();
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener(DRAFT_EVENT, (event) => api.note(String(event.detail?.key ?? ""), event.detail?.value));
    window.addEventListener("storage", (event) => {
      if (event.storageArea && storage && event.storageArea !== storage) return;
      if (event.key === null) api.reload();
      else if (event.key.startsWith(PREFIX)) api.note(event.key, event.newValue);
    });
  }
  return api;
}

export const drafts = createDrafts();
