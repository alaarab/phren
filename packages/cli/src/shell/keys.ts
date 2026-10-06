/**
 * Raw-mode stdin decoder.
 *
 * Node hands us whatever bytes happened to arrive in one read, not one keypress.
 * Key autorepeat, fast typing, mouse-wheel-as-arrows, and paste all coalesce
 * several keys into a single "data" chunk (e.g. "\x1b[B\x1b[B\x1b[B" or "ub"),
 * and any handler that compares the whole chunk against a single key drops
 * everything but an exact match. This splits a chunk back into discrete keys.
 *
 * A chunk can also end mid-sequence, so trailing partial escapes are buffered
 * and prepended to the next chunk. A lone ESC is indistinguishable from the
 * start of a split sequence, so the caller flushes on a short timer (see
 * ESC_FLUSH_MS) to keep the Escape key responsive.
 */

/** How long to wait for the rest of an escape sequence before treating ESC as the Escape key. */
export const ESC_FLUSH_MS = 30;

const ESC = "\x1b";

// One code point plus any trailing combining marks / variation selectors, so a
// surrogate pair or accented character is never split down the middle.
const GRAPHEME = /^(?:\P{M}\p{M}*)/u;

function nextChar(buf: string, i: number): string {
  const m = GRAPHEME.exec(buf.slice(i));
  return m ? m[0] : buf[i]!;
}

/**
 * Split `buf` into discrete keys.
 *
 * Returns the decoded keys plus any trailing bytes that form an incomplete
 * escape sequence; the caller must prepend `pending` to the next chunk.
 */
export function decodeKeys(buf: string): { keys: string[]; pending: string } {
  const keys: string[] = [];
  let i = 0;

  while (i < buf.length) {
    const ch = buf[i]!;

    if (ch !== ESC) {
      const char = nextChar(buf, i);
      keys.push(char);
      i += char.length;
      continue;
    }

    // ESC is the last byte we have — could be the Escape key or a split sequence.
    if (i + 1 >= buf.length) return { keys, pending: buf.slice(i) };

    const next = buf[i + 1]!;

    // ESC ESC — the first is a complete Escape keypress.
    if (next === ESC) { keys.push(ESC); i += 1; continue; }

    // CSI: ESC [ params intermediates final
    if (next === "[") {
      let j = i + 2;
      while (j < buf.length && buf[j]! >= "\x30" && buf[j]! <= "\x3f") j++;
      while (j < buf.length && buf[j]! >= "\x20" && buf[j]! <= "\x2f") j++;
      if (j >= buf.length) return { keys, pending: buf.slice(i) };
      if (buf[j]! >= "\x40" && buf[j]! <= "\x7e") { keys.push(buf.slice(i, j + 1)); i = j + 1; continue; }
      // Malformed — drop the ESC [ introducer and resync on the next byte.
      i += 2;
      continue;
    }

    // SS3: ESC O <final> — arrows in application cursor mode, F1-F4.
    if (next === "O") {
      if (i + 2 >= buf.length) return { keys, pending: buf.slice(i) };
      keys.push(buf.slice(i, i + 3));
      i += 3;
      continue;
    }

    // ESC followed by a printable character. The shell binds no Alt combos, so
    // emitting them separately recovers both keys (Esc-then-shortcut is common)
    // instead of dropping an unrecognised two-character token.
    keys.push(ESC);
    i += 1;
  }

  return { keys, pending: "" };
}

/** Stateful wrapper that carries incomplete sequences across chunk boundaries. */
export class KeyDecoder {
  private pending = "";

  /** Decode a stdin chunk into discrete keys. */
  push(chunk: string): string[] {
    const { keys, pending } = decodeKeys(this.pending + chunk);
    this.pending = pending;
    return keys;
  }

  /** True when a partial sequence is buffered and a flush timer should be armed. */
  hasPending(): boolean { return this.pending.length > 0; }

  /** Emit buffered bytes as literal keys — call when no continuation arrived in time. */
  flush(): string[] {
    if (!this.pending) return [];
    const buffered = this.pending;
    this.pending = "";
    // A lone ESC is the Escape key; anything longer is a sequence the terminal
    // truncated, so surface it whole and let the handler ignore it.
    return buffered === ESC ? [ESC] : [buffered];
  }
}
