/**
 * The splash is shared by the shell and phren-agent. These tests drive it
 * with injected paint/sleep so the frame sequence — reveal, then shimmer
 * until dismissed — is checked without a terminal or real time.
 */

import { describe, expect, it } from "vitest";
import { LOGO_REVEAL_FRAMES, PHREN_LOGO } from "./logo-fx.js";
import { playSplash } from "./intro.js";
import { stripAnsi } from "./render.js";

function harness() {
  const frames: string[] = [];
  const screen = { entered: 0, exited: 0, enter() { this.entered++; }, exit() { this.exited++; } };
  const opts = { paint: (f: string) => frames.push(f), sleep: async () => {}, isTTY: true, screen };
  return { frames, screen, opts };
}

const wide = () => {
  Object.defineProperty(process.stdout, "columns", { value: 120, configurable: true });
  Object.defineProperty(process.stdout, "rows", { value: 30, configurable: true });
};

describe("playSplash", () => {
  it("does nothing without a terminal", async () => {
    const { frames, opts } = harness();
    await playSplash({ version: "1.0.0", reveal: true, dwellMs: 500, ...opts, isTTY: false });
    expect(frames).toEqual([]);
  });

  it("plays the reveal, then shimmers for the dwell, ending on the real wordmark", async () => {
    wide();
    const { frames, opts } = harness();
    await playSplash({ version: "1.0.0", reveal: true, dwellMs: 330, hint: "starting…", ...opts });
    expect(frames.length).toBe(LOGO_REVEAL_FRAMES + 3);
    const last = stripAnsi(frames.at(-1)!);
    for (const line of PHREN_LOGO) expect(last).toContain(line);
    expect(last).toContain("starting…");
    expect(stripAnsi(frames[0])).not.toContain(PHREN_LOGO[0]);
    // The reveal has no hint; it appears once the splash is holding.
    expect(stripAnsi(frames[0])).not.toContain("starting…");
  });

  it("holds until the keypress waiter resolves and wraps the alternate screen when asked", async () => {
    wide();
    const { frames, screen, opts } = harness();
    let release!: () => void;
    const waiter = () => new Promise<void>((resolve) => { release = resolve; });
    const run = playSplash({ version: "1.0.0", reveal: false, waitForKeypress: waiter, fullscreen: true, tagline: "agent · claude", ...opts });
    await new Promise((r) => setTimeout(r, 5));
    expect(screen.entered).toBe(1);
    expect(screen.exited).toBe(0);
    expect(frames.length).toBeGreaterThanOrEqual(1);
    expect(stripAnsi(frames[0])).toContain("agent · claude");
    release();
    await run;
    expect(screen.exited).toBe(1);
  });
});
