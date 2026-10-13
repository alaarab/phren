// A section's read ahead of opening it (hovering its pill): the click shows
// that read instead of starting another, as long as it is recent and was made
// against the same online computers.
import { store } from "./store.js";

export const READ_AHEAD_FRESH_MS = 5_000;

const onlineKey = () => (store.merged?.computers ?? []).filter((c) => c.state === "online").map((c) => c.computer).sort().join("\n");

/** `read()` is the section's full read; returns `{ prefetch(), show() }`. */
export function readAhead(read, { key = onlineKey, now = () => Date.now(), freshMs = READ_AHEAD_FRESH_MS } = {}) {
  let at = 0;
  let readFor = null;
  const fresh = () => at > 0 && now() - at < freshMs && readFor === key();
  return {
    /** Read ahead, unless one for the same computers is still fresh (so repeated hovers never overlap reads). */
    prefetch() {
      if (fresh()) return;
      at = now();
      readFor = key();
      void read();
    },
    /** On show: read, unless the read ahead is fresh. Either way it is used up. */
    show() {
      const skip = fresh();
      at = 0;
      readFor = null;
      if (!skip) void read();
    },
  };
}
