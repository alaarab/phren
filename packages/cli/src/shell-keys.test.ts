/**
 * Tests for the shell's terminal I/O plumbing: the raw-mode key decoder,
 * display-width measurement, and frame painting.
 *
 * The first two guard the same class of bug — treating a byte count as a key
 * count, or a UTF-16 length as a column count. Either one silently drops user
 * input or corrupts the in-place redraw.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeKeys, KeyDecoder, ESC_FLUSH_MS } from "./shell/keys.js";
import {
  displayWidth,
  truncateLine,
  padToWidth,
  stripAnsi,
  style,
  paintFrame,
  enterFullscreen,
  exitFullscreen,
} from "./shell/render.js";
import { PhrenShell } from "./shell/shell.js";

const ARROW_DOWN = "\x1b[B";
const ARROW_UP = "\x1b[A";

describe("decodeKeys", () => {
  it("returns a single key unchanged", () => {
    expect(decodeKeys(ARROW_DOWN)).toEqual({ keys: [ARROW_DOWN], pending: "" });
  });

  it("splits keys that autorepeat coalesced into one read", () => {
    // Holding an arrow key delivers several presses in a single stdin chunk.
    expect(decodeKeys(ARROW_DOWN.repeat(3)).keys).toEqual([ARROW_DOWN, ARROW_DOWN, ARROW_DOWN]);
  });

  it("splits fast typing into individual characters", () => {
    expect(decodeKeys("hub").keys).toEqual(["h", "u", "b"]);
  });

  it("splits a mix of text and escape sequences", () => {
    expect(decodeKeys(`ab${ARROW_UP}c`).keys).toEqual(["a", "b", ARROW_UP, "c"]);
  });

  it("handles CSI sequences with parameters", () => {
    expect(decodeKeys("\x1b[5~\x1b[6~").keys).toEqual(["\x1b[5~", "\x1b[6~"]);
  });

  it("handles SS3 sequences (application cursor mode arrows)", () => {
    expect(decodeKeys("\x1bOA\x1bOB").keys).toEqual(["\x1bOA", "\x1bOB"]);
  });

  it("keeps a surrogate pair together", () => {
    expect(decodeKeys("a😀b").keys).toEqual(["a", "😀", "b"]);
  });

  it("keeps combining marks attached to their base character", () => {
    expect(decodeKeys("éx").keys).toEqual(["é", "x"]);
  });

  it("buffers a CSI sequence split across reads", () => {
    const first = decodeKeys("ab\x1b[");
    expect(first.keys).toEqual(["a", "b"]);
    expect(first.pending).toBe("\x1b[");
  });

  it("buffers a trailing lone ESC rather than guessing", () => {
    expect(decodeKeys("x\x1b")).toEqual({ keys: ["x"], pending: "\x1b" });
  });

  it("emits ESC ESC as one complete Escape plus a pending one", () => {
    expect(decodeKeys("\x1b\x1b")).toEqual({ keys: ["\x1b"], pending: "\x1b" });
  });

  it("splits ESC followed by a printable character into two keys", () => {
    // The shell binds no Alt combos, so Esc-then-shortcut must survive.
    expect(decodeKeys("\x1bq").keys).toEqual(["\x1b", "q"]);
  });

  it("resyncs after a malformed escape sequence", () => {
    expect(decodeKeys("\x1b[\x00a").keys).toEqual(["\x00", "a"]);
  });
});

describe("KeyDecoder", () => {
  it("joins a sequence split across two chunks", () => {
    const decoder = new KeyDecoder();
    expect(decoder.push("\x1b")).toEqual([]);
    expect(decoder.hasPending()).toBe(true);
    expect(decoder.push("[B")).toEqual([ARROW_DOWN]);
    expect(decoder.hasPending()).toBe(false);
  });

  it("flushes a lone ESC as the Escape key", () => {
    const decoder = new KeyDecoder();
    expect(decoder.push("\x1b")).toEqual([]);
    expect(decoder.flush()).toEqual(["\x1b"]);
    expect(decoder.hasPending()).toBe(false);
  });

  it("flush is a no-op when nothing is buffered", () => {
    expect(new KeyDecoder().flush()).toEqual([]);
  });

  it("exposes a flush delay short enough to keep Escape responsive", () => {
    expect(ESC_FLUSH_MS).toBeGreaterThan(0);
    expect(ESC_FLUSH_MS).toBeLessThanOrEqual(50);
  });
});

describe("PhrenShell key handling via the decoder", () => {
  const shellFor = () => new PhrenShell(process.env.PHREN_DIR ?? "/tmp/phren-keys-test", "default");

  const feed = async (shell: PhrenShell, chunk: string) => {
    for (const key of new KeyDecoder().push(chunk)) await shell.handleRawKey(key);
  };

  it("moves the cursor once per press in a coalesced chunk", async () => {
    const shell = shellFor();
    if (shell.getListItems().length < 4) return; // needs a populated store
    await feed(shell, ARROW_DOWN.repeat(3));
    expect(shell.currentCursor()).toBe(3);
  });

  it("accepts every character of a fast-typed or pasted run", async () => {
    const shell = shellFor();
    shell.startInput("filter", "");
    await feed(shell, "hub");
    expect(shell.inputBuffer).toBe("hub");
  });

  it("accepts astral characters in the input buffer", async () => {
    const shell = shellFor();
    shell.startInput("filter", "");
    await feed(shell, "a😀");
    expect(shell.inputBuffer).toBe("a😀");
  });

  it("backspace removes a whole astral character", async () => {
    const shell = shellFor();
    shell.startInput("filter", "");
    await feed(shell, "a😀");
    await shell.handleRawKey("\x7f");
    expect(shell.inputBuffer).toBe("a");
  });

  it("ignores escape sequences while typing instead of inserting them", async () => {
    const shell = shellFor();
    shell.startInput("filter", "");
    await feed(shell, `a${ARROW_UP}b`);
    expect(shell.inputBuffer).toBe("ab");
  });
});

describe("displayWidth", () => {
  it("counts plain ASCII by character", () => {
    expect(displayWidth("hello")).toBe(5);
  });

  it("ignores ANSI escape codes", () => {
    expect(displayWidth(style.boldCyan("hello"))).toBe(5);
  });

  it("counts emoji-presentation characters as two cells", () => {
    // U+26A1 is the Hooks tab icon; terminals draw it double-wide.
    expect(displayWidth("⚡")).toBe(2);
    expect(displayWidth("😀")).toBe(2);
  });

  it("counts combining marks as zero cells", () => {
    expect(displayWidth("é")).toBe(1);
  });

  it("counts fullwidth CJK as two cells", () => {
    expect(displayWidth("日本")).toBe(4);
  });

  it("counts a zero-width joiner sequence by its rendered parts", () => {
    expect(displayWidth("a‍b")).toBe(2);
  });
});

describe("truncateLine / padToWidth honour display width", () => {
  it("truncates a wide-character line to fit the column budget", () => {
    const line = "⚡".repeat(10); // 20 cells, not 10
    const out = truncateLine(line, 10);
    expect(displayWidth(out)).toBeLessThanOrEqual(10);
  });

  it("leaves a line that already fits untouched", () => {
    const line = style.cyan("short");
    expect(truncateLine(line, 40)).toBe(line);
  });

  it("pads to exactly the requested number of cells", () => {
    expect(displayWidth(padToWidth("⚡ab", 10))).toBe(10);
    expect(displayWidth(padToWidth(style.dim("hi"), 8))).toBe(8);
  });

  it("never emits more cells than requested when padding overflows", () => {
    expect(displayWidth(padToWidth("⚡".repeat(10), 6))).toBeLessThanOrEqual(6);
  });

  it("appends a reset so truncation cannot leak SGR state", () => {
    expect(truncateLine(style.red("x".repeat(50)), 10).endsWith("\x1b[0m")).toBe(true);
  });

  it("does not split a surrogate pair when truncating", () => {
    const out = stripAnsi(truncateLine("a😀bbbbbbbb", 4));
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(out).not.toMatch(loneSurrogate);
    expect(out).toContain("😀");
  });
});

describe("frame painting", () => {
  const captureWrites = () => {
    const writes: string[] = [];
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    return writes;
  };

  afterEach(() => { vi.restoreAllMocks(); });

  it("emits the whole frame in one write", () => {
    // Three separate writes (home, body, erase) let a concurrent repaint
    // interleave between them and produce a torn frame.
    const writes = captureWrites();
    paintFrame("a\nb");
    expect(writes).toHaveLength(1);
  });

  it("wraps the frame in a synchronized update and repositions to home", () => {
    const writes = captureWrites();
    paintFrame("body");
    expect(writes[0]).toBe("\x1b[?2026h\x1b[Hbody\x1b[J\x1b[?2026l");
  });

  it("hides the cursor on entry so it does not race across the redraw", () => {
    const writes = captureWrites();
    enterFullscreen();
    expect(writes).toContain("\x1b[?25l");
    expect(writes).toContain("\x1b[?1049h");
  });

  it("disables autowrap so a mismeasured line cannot scroll the frame", () => {
    const writes = captureWrites();
    enterFullscreen();
    expect(writes).toContain("\x1b[?7l");
  });

  it("restores cursor, autowrap, and the main screen on exit", () => {
    const writes = captureWrites();
    exitFullscreen();
    expect(writes).toEqual(["\x1b[?7h", "\x1b[?25h", "\x1b[?1049l"]);
  });

  it("writes nothing when stdout is not a TTY", () => {
    const writes: string[] = [];
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    enterFullscreen();
    exitFullscreen();
    expect(writes).toEqual([]);
  });
});
