/**
 * The braille canvas feeds lines straight into the shell's frame pipeline,
 * which assumes every character is one cell wide and every line is exactly
 * the canvas width. Those invariants, the dot→codepoint math, and label
 * collision handling are what these tests guard.
 */

import { afterEach, describe, expect, it } from "vitest";
import { stripAnsi } from "../render.js";
import { BrailleCanvas, blendHex, hexToAnsi256, hexToRgb, hexToSgr, setColorMode } from "./canvas.js";

afterEach(() => setColorMode(null));

describe("colour helpers", () => {
  it("parses hex and blends linearly", () => {
    expect(hexToRgb("#ff8000")).toEqual([255, 128, 0]);
    expect(hexToRgb("#fff")).toEqual([255, 255, 255]);
    expect(blendHex("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(blendHex("#ff0000", "#0000ff", 0)).toBe("#ff0000");
  });

  it("emits truecolor or 256-colour SGR depending on the mode", () => {
    setColorMode("truecolor");
    expect(hexToSgr("#ff8000")).toBe("\x1b[38;2;255;128;0m");
    setColorMode("256");
    expect(hexToSgr("#ff8000")).toBe(`\x1b[38;5;${hexToAnsi256("#ff8000")}m`);
    expect(hexToAnsi256("#000000")).toBe(16);
    expect(hexToAnsi256("#ffffff")).toBe(231);
    expect(hexToAnsi256("#808080")).toBeGreaterThanOrEqual(232);
  });
});

describe("BrailleCanvas", () => {
  it("maps dots to the right braille bits", () => {
    setColorMode("truecolor");
    const c = new BrailleCanvas(2, 1);
    c.setDot(0, 0, "#ffffff"); // top-left dot of cell 0 → 0x01
    c.setDot(3, 3, "#ffffff"); // bottom-right dot of cell 1 → 0x80
    const [line] = c.render().map(stripAnsi);
    expect(line).toBe(String.fromCharCode(0x2801) + String.fromCharCode(0x2880));
  });

  it("draws a line that lights both endpoints and stays inside the canvas", () => {
    const c = new BrailleCanvas(10, 4);
    c.line(-5, -5, 30, 30, "#ffffff");
    const plain = c.render().map(stripAnsi);
    expect(plain.every((line) => line.length === 10)).toBe(true);
    expect(plain[0].charCodeAt(0) & 0x01).toBe(0x01);
    expect(plain.some((line) => /[⠀-⣿]/.test(line))).toBe(true);
  });

  it("lets the higher z draw own the cell colour", () => {
    setColorMode("truecolor");
    const c = new BrailleCanvas(1, 1);
    c.setDot(0, 0, "#ff0000", 0);
    c.setDot(1, 0, "#00ff00", 5);
    c.setDot(0, 1, "#0000ff", 1);
    const [line] = c.render();
    expect(line).toContain("\x1b[38;2;0;255;0m");
    expect(line).not.toContain("38;2;255;0;0");
  });

  it("keeps every rendered line exactly cols wide, even with wide characters in labels", () => {
    const c = new BrailleCanvas(12, 3);
    c.disc(6, 6, 2, "#ffffff");
    expect(c.putText(1, 1, "日本 ok", "\x1b[1m")).toBe(5);
    c.putText(9, 2, "overflowing text", "");
    const plain = c.render().map(stripAnsi);
    expect(plain.every((line) => line.length === 12)).toBe(true);
    expect(plain[1]).toContain("·· ok");
    expect(plain[2].endsWith("ove")).toBe(true);
  });

  it("reports occupied label strips so callers can avoid collisions", () => {
    const c = new BrailleCanvas(20, 2);
    c.putText(4, 0, "hub", "");
    expect(c.isFree(0, 0, 4)).toBe(true);
    expect(c.isFree(2, 0, 4)).toBe(false);
    expect(c.isFree(7, 0, 5)).toBe(true);
    expect(c.isFree(18, 0, 5)).toBe(false); // runs off the right edge
    expect(c.isFree(0, 5, 1)).toBe(false); // off the bottom
  });

  it("renders a small fixture as expected (ANSI stripped)", () => {
    const c = new BrailleCanvas(8, 2);
    c.line(0, 0, 15, 7, "#46c8ff");
    c.putText(0, 1, "◉hub", "\x1b[1m");
    const plain = c.render().map(stripAnsi);
    expect(plain).toHaveLength(2);
    expect(plain[1].startsWith("◉hub")).toBe(true);
    expect(plain.join("\n")).toMatch(/[⠀-⣿]/);
    // Every line resets styling at the end so the next frame column starts clean.
    for (const line of c.render()) expect(line.endsWith("\x1b[0m")).toBe(true);
  });
});
