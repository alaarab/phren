// Reopen a closed chat tab: the last few closed chats of this window, newest
// last. Pure: no DOM, no store. agents.js feeds it closes and resolves entries
// against the overview; shell/palette and keys.js ask whether it is empty.

export const CLOSED_LIMIT = 10;

/** The key a session is known by across the app: `<computer>/<child id>`. */
export const closedKey = (computer, id) => `${computer}/${id}`;

/**
 * `{ key, computer, id, tile?, index?, after?, mode? }` rows, or null for anything
 * malformed. `tile` is the id of the tile it closed in, `index` its tab position.
 */
export function closedEntry(value) {
  if (!value || typeof value.computer !== "string" || !value.computer || typeof value.id !== "string" || !value.id) return null;
  const entry = { key: closedKey(value.computer, value.id), computer: value.computer, id: value.id };
  if (typeof value.tile === "string") entry.tile = value.tile;
  if (Number.isInteger(value.index) && value.index >= 0) entry.index = value.index;
  // The tabs on its left, nearest first: its position survives other tabs coming and going, and
  // closing several at once (a file between them never comes back, so the next one left anchors it).
  const after = (Array.isArray(value.after) ? value.after : [value.after]).filter((id) => typeof id === "string" && id).slice(0, 50);
  if (after.length) entry.after = after;
  if (value.mode === "console") entry.mode = "console";
  return entry;
}

/**
 * Where a reopened tab goes in `order` (the tile's tab ids, left to right): right after the
 * nearest tab that was on its left when it closed and is still there (`after`: an id, or ids
 * nearest first), else at its old index, else last (undefined). Anchoring on a neighbour keeps
 * the order right when other tabs, such as files, sat between closed chats.
 */
export function reopenPosition(order, { index, after } = {}) {
  for (const id of Array.isArray(after) ? after : [after]) {
    const anchor = typeof id === "string" ? order.indexOf(id) : -1;
    if (anchor >= 0) return anchor + 1;
  }
  return Number.isInteger(index) && index >= 0 ? Math.min(index, order.length) : undefined;
}

export function createClosedStack(limit = CLOSED_LIMIT) {
  let list = [];
  return {
    /** Remember a closed chat; a chat already on the stack moves to the top, and the oldest fall off. */
    push(value) {
      const entry = closedEntry(value);
      if (!entry) return false;
      list = [...list.filter((e) => e.key !== entry.key), entry].slice(-limit);
      return true;
    },
    /** Forget a chat (it was reopened another way). */
    drop(key) { list = list.filter((e) => e.key !== key); },
    size: () => list.length,
    entries: () => list.map((e) => ({ ...e })),
    /**
     * Take the newest entry that `check(entry)` calls "ok". Entries it calls
     * "open" (already open) or "gone" (the session no longer exists) are
     * discarded; "unknown" ones (their computer is not reporting right now) are
     * kept for later. Returns `{ entry, unknown, gone }`: the entry to reopen or
     * null, how many unknown entries were passed over, and whether any entry
     * was discarded as gone.
     */
    reopen(check) {
      const kept = [];
      let found = null;
      let gone = false;
      while (list.length && !found) {
        const entry = list.pop();
        const verdict = check(entry);
        if (verdict === "ok") found = entry;
        else if (verdict === "unknown") kept.unshift(entry);
        else if (verdict === "gone") gone = true;
      }
      list = [...list, ...kept];
      return { entry: found ? { ...found } : null, unknown: kept.length, gone };
    },
  };
}
