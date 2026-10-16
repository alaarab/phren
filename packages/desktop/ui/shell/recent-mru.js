// The most-recently-used list behind the Ctrl+Tab chat switcher: pure data, no
// DOM. Keys are `${computer}/${child.id}`, newest first.

export const RECENT_LIMIT = 8;

/** A MRU list of at most `limit` keys. */
export function createMru(limit = RECENT_LIMIT, initial = []) {
  let keys = [];
  const mru = {
    /** Move `key` to the front (adding it), dropping the oldest past the cap. */
    touch(key) {
      if (typeof key !== "string" || !key) return mru;
      keys = [key, ...keys.filter((k) => k !== key)].slice(0, limit);
      return mru;
    },
    /** Drop keys that `exists(key)` no longer accepts. */
    prune(exists) {
      keys = keys.filter((k) => exists(k));
      return mru;
    },
    list() { return [...keys]; },
  };
  for (const key of [...initial].reverse()) mru.touch(key);
  return mru;
}

/** The first selection when Ctrl+Tab opens: the previous session, or the oldest on Shift+Tab. */
export function initialSelection(count, backward = false) {
  if (count < 2) return -1;
  return backward ? count - 1 : 1;
}

/** Tab (delta 1) and Shift+Tab (delta -1) wrap around the list. */
export function moveSelection(index, count, delta) {
  if (count < 1) return -1;
  return (((index + delta) % count) + count) % count;
}
