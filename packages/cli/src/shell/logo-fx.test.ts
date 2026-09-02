/**
 * The splash wordmark effect must end on the exact logo — a reveal that
 * leaves a stray scramble glyph or shifts a column would mangle the letters
 * the user sees every launch.
 */

import { describe, expect, it } from "vitest";
import { displayWidth, gradient, stripAnsi } from "./render.js";
import { LOGO_REVEAL_FRAMES, PHREN_LOGO, logoPlain, logoRevealFrame, logoShimmerFrame } from "./logo-fx.js";

/** Per-character colour as a terminal would resolve it (runs of one SGR are merged by the fx painter). */
function perCharColors(line: string): Array<{ ch: string; sgr: string }> {
  const out: Array<{ ch: string; sgr: string }> = [];
  let sgr = "";
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const emit = (text: string) => { for (const ch of text) if (ch !== " ") out.push({ ch, sgr }); };
  while ((m = re.exec(line))) {
    emit(line.slice(last, m.index));
    sgr = m[1] === "0" ? "" : `\x1b[${m[1]}m`;
    last = re.lastIndex;
  }
  emit(line.slice(last));
  return out;
}

describe("logo text effects", () => {
  it("logoPlain matches the gradient wordmark glyph for glyph and colour for colour", () => {
    const plain = logoPlain();
    expect(plain.map(stripAnsi)).toEqual(PHREN_LOGO);
    plain.forEach((line, r) => expect(perCharColors(line)).toEqual(perCharColors(gradient(PHREN_LOGO[r]))));
  });

  it("the reveal ends on the exact logo and never changes a line's width", () => {
    expect(logoRevealFrame(1).map(stripAnsi)).toEqual(PHREN_LOGO);
    expect(logoRevealFrame(1)).toEqual(logoPlain());
    for (let i = 0; i < LOGO_REVEAL_FRAMES; i++) {
      const frame = logoRevealFrame(i / (LOGO_REVEAL_FRAMES - 1));
      frame.forEach((line, r) => {
        expect(displayWidth(line)).toBe(displayWidth(PHREN_LOGO[r]));
        // Whitespace stays whitespace: the letter shapes are preserved throughout.
        const plain = [...stripAnsi(line)];
        [...PHREN_LOGO[r]].forEach((ch, c) => { if (ch === " ") expect(plain[c]).toBe(" "); else expect(plain[c]).not.toBe(" "); });
      });
    }
  });

  it("starts scrambled, settles left to right, and is deterministic", () => {
    const start = logoRevealFrame(0).map(stripAnsi);
    expect(start).not.toEqual(PHREN_LOGO);
    expect(logoRevealFrame(0.3)).toEqual(logoRevealFrame(0.3));
    const mid = logoRevealFrame(0.5).map(stripAnsi);
    const settled = (plain: string[]) => PHREN_LOGO.map((line, r) => [...line].filter((ch, c) => ch !== " " && [...plain[r]][c] === ch).length).reduce((a, b) => a + b, 0);
    expect(settled(mid)).toBeGreaterThan(settled(start));
    expect(settled(logoRevealFrame(0.9).map(stripAnsi))).toBeGreaterThan(settled(mid));
    // The left third settles before the right third does.
    const leftDone = mid.every((line, r) => [...line].slice(0, 8).every((ch, c) => ch === [...PHREN_LOGO[r]][c]));
    expect(leftDone).toBe(true);
  });

  it("the shimmer only recolours: glyphs are always the real logo", () => {
    for (const tick of [0, 5, 17, 40, 63]) {
      const frame = logoShimmerFrame(tick);
      expect(frame.map(stripAnsi)).toEqual(PHREN_LOGO);
    }
    expect(logoShimmerFrame(10)).not.toEqual(logoShimmerFrame(11));
  });
});
