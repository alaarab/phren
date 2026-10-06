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
export declare const ESC_FLUSH_MS = 30;
/**
 * Split `buf` into discrete keys.
 *
 * Returns the decoded keys plus any trailing bytes that form an incomplete
 * escape sequence; the caller must prepend `pending` to the next chunk.
 */
export declare function decodeKeys(buf: string): {
    keys: string[];
    pending: string;
};
/** Stateful wrapper that carries incomplete sequences across chunk boundaries. */
export declare class KeyDecoder {
    private pending;
    /** Decode a stdin chunk into discrete keys. */
    push(chunk: string): string[];
    /** True when a partial sequence is buffered and a flush timer should be armed. */
    hasPending(): boolean;
    /** Emit buffered bytes as literal keys — call when no continuation arrived in time. */
    flush(): string[];
}
