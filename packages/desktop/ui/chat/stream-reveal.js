// How a reply appears while it is still being written. The Hook sends the reply
// so far about twice a second; drawn as it lands, the text arrives in blocks.
// This paces it: what has arrived is let out a little every frame, at the speed
// the reply itself is arriving, so reading is steady rather than stop-and-start.
//
// src/ui-stream-reveal.test.ts drives `createReveal` under Node with stubbed
// animation frames.

/** The slowest text ever appears, in characters per millisecond. */
const MIN_RATE = 0.08;
/** However fast a reply arrives, what is on screen is never further behind than this. */
const MAX_LAG_MS = 650;
/** A line held back (a table row, a fence) is let out once nothing new has arrived for this long. */
const HOLD_MS = 1200;
/** Past this length the reply is redrawn at most every BIG_INTERVAL_MS, since each redraw reads all of it. */
const BIG_TEXT = 24_000;
const BIG_INTERVAL_MS = 48;

/**
 * How far the text is shown after `elapsedMs` more. `arrival` is how fast the
 * reply is arriving (characters per millisecond, 0 when unknown); `carry` is
 * the fraction of a character left over from the frame before.
 */
function revealStep({ shown, total, arrival = 0, carry = 0 }, elapsedMs) {
  const remaining = total - shown;
  if (remaining <= 0) return { shown: total, carry: 0 };
  const rate = Math.max(MIN_RATE, arrival, remaining / MAX_LAG_MS);
  const due = carry + rate * Math.max(0, elapsedMs);
  const whole = Math.floor(due);
  return { shown: Math.min(total, shown + whole), carry: due - whole };
}

const TABLE_ROW = /^[ \t]*\|/;
const FENCE_LINE = /^[ \t]*(?:`{3,}|~{3,})/;
// What a line can open with before its words: a heading, quote, list or rule marker, or the start of a fence.
const LEADING_MARKER = /^[ \t]*(?:#{1,6}|>+|\d{1,9}[.)]?|[-*+_]{1,}|`{1,2}|~{1,2})[ \t]*(?:\[[ xX]\][ \t]*)?/;

/**
 * Where a reveal heading for `index` may stop, so the reader never sees
 * Markdown half-written: a line's opening marker appears with its first words, a
 * fence line and a table row appear whole, and a table's first row waits for the
 * divider that makes it a table. `shown` is what is on screen now; nothing held
 * back moves it backwards. `force` lets everything out (the reply went quiet).
 */
function settle(text, shown, index, force = false) {
  if (index >= text.length) return text.length;
  if (index <= shown) return shown;
  index = wholeCharacter(text, index);
  // A link's words and its address come together: "[docs]" alone would show its brackets.
  if (text[index - 1] === "]" && text[index] === "(") index += 1;
  if (force || index >= text.length) return Math.min(index, text.length);

  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  const newline = text.indexOf("\n", index);
  const complete = newline >= 0;
  const lineEnd = complete ? newline : text.length;
  const line = text.slice(lineStart, lineEnd);
  const hold = Math.max(shown, lineStart);

  if (TABLE_ROW.test(line)) {
    if (!complete) return hold;
    const previousStart = text.lastIndexOf("\n", lineStart - 2) + 1;
    const startsTable = lineStart === 0 || !TABLE_ROW.test(text.slice(previousStart, lineStart - 1));
    if (startsTable) {
      // The row and the divider under it arrive together, or the row would be drawn as a paragraph first.
      if (lineEnd + 1 >= text.length) return hold;
      const nextNewline = text.indexOf("\n", lineEnd + 1);
      const nextLine = text.slice(lineEnd + 1, nextNewline < 0 ? text.length : nextNewline);
      if (TABLE_ROW.test(nextLine) || /^[ \t]*:?-/.test(nextLine)) return nextNewline < 0 ? hold : nextNewline + 1;
    }
    return lineEnd + 1;
  }
  if (FENCE_LINE.test(line)) return complete ? lineEnd + 1 : hold;
  const marker = LEADING_MARKER.exec(line);
  if (marker && marker[0].length > 0 && index - lineStart <= marker[0].length) {
    const markerEnd = lineStart + marker[0].length;
    // A marker at the very end of what has arrived may still be growing ("#" into "##").
    if (markerEnd >= text.length && !complete) return hold;
    // The marker comes with the first character after it, so a bullet never stands empty.
    return wholeCharacter(text, Math.min(lineEnd, markerEnd + 1));
  }
  return index;
}

/** `index`, moved past the second half of a surrogate pair it would otherwise split. */
function wholeCharacter(text, index) {
  const code = text.charCodeAt(index - 1);
  return code >= 0xd800 && code <= 0xdbff ? Math.min(text.length, index + 1) : index;
}

/** How many leading characters `a` and `b` share. */
function sharedPrefix(a, b) {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

/**
 * Paces a growing text onto the screen. `show(text)` is called with what should
 * be visible now. `set(text)` gives the reply so far; a reply that was rewritten
 * rather than extended carries on from where the two agree. With reduced motion
 * the text is shown as it lands.
 */
export function createReveal({ show }) {
  const still = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  let target = "";
  let shown = 0;
  let carry = 0;
  let arrival = 0;
  let lastSetAt = 0;
  let lastFrameAt = 0;
  let lastShowAt = 0;
  let dirty = false;
  let handle = 0;

  function emit(now) {
    dirty = false;
    lastShowAt = now;
    show(target.slice(0, shown));
  }

  function tick() {
    handle = 0;
    const now = performance.now();
    // A frame after a long gap (the window was hidden) catches up at the usual pace, not in one jump.
    const elapsed = Math.min(100, now - lastFrameAt);
    lastFrameAt = now;
    const stepped = revealStep({ shown, total: target.length, arrival, carry }, elapsed);
    carry = stepped.carry;
    const next = settle(target, shown, stepped.shown, now - lastSetAt > HOLD_MS);
    if (next !== shown) { shown = next; dirty = true; }
    const interval = target.length > BIG_TEXT ? BIG_INTERVAL_MS : 0;
    if (dirty && (shown >= target.length || now - lastShowAt >= interval)) emit(now);
    if (shown < target.length || dirty) handle = requestAnimationFrame(tick);
  }

  return {
    set(text) {
      if (text === target) return;
      const now = performance.now();
      const added = text.length - target.length;
      if (lastSetAt && added > 0) {
        const rate = added / Math.max(50, now - lastSetAt);
        arrival = arrival ? (arrival + rate) / 2 : rate;
      }
      lastSetAt = now;
      const keep = sharedPrefix(target, text);
      const rewound = shown > keep;
      if (rewound) { shown = keep; carry = 0; }
      target = text;
      if (still()) { shown = target.length; emit(now); return; }
      if (rewound || shown >= target.length) emit(now);
      if (shown < target.length && !handle) { lastFrameAt = now; handle = requestAnimationFrame(tick); }
    },
    /** Stop pacing; nothing more is shown. */
    stop() {
      if (handle) cancelAnimationFrame(handle);
      handle = 0;
    },
  };
}
