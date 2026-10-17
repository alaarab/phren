// Reopen a closed chat tab: the last few closed chats of this window, newest
// last. Pure: no DOM, no store. agents.js feeds it closes and resolves entries
// against the overview; shell/palette and keys.js ask whether it is empty.

export const CLOSED_LIMIT = 10;

/** The key a session is known by across the app: `<computer>/<child id>`. */
export const closedKey = (computer, id) => `${computer}/${id}`;

/**
 * `{ key, computer, id, tile?, index?, mode? }` rows, or null for anything
 * malformed. `tile` is the id of the tile it closed in, `index` its tab position.
 */
export function closedEntry(value) {
  if (!value || typeof value.computer !== "string" || !value.computer || typeof value.id !== "string" || !value.id) return null;
  const entry = { key: closedKey(value.computer, value.id), computer: value.computer, id: value.id };
  if (typeof value.tile === "string") entry.tile = value.tile;
  if (Number.isInteger(value.index) && value.index >= 0) entry.index = value.index;
  if (value.mode === "console") entry.mode = "console";
  return entry;
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
     * Take the newest entry for which `exists(entry)` holds. Entries that no
     * longer exist are discarded on the way; null when nothing is left.
     */
    reopen(exists) {
      while (list.length) {
        const entry = list.pop();
        if (exists(entry)) return { ...entry };
      }
      return null;
    },
  };
}
