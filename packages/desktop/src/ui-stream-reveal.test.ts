import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error Plain browser ESM.
import { createReveal } from "../ui/chat/stream-reveal.js";

// The browser's animation frames, on the fake clock: one every 16 ms.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => setTimeout(fn, 16));
  vi.stubGlobal("cancelAnimationFrame", (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A reveal and everything it has shown, in order. */
function reveal() {
  const shown: string[] = [];
  return { shown, r: createReveal({ show: (text: string) => shown.push(text) }) };
}
const last = (shown: string[]) => shown[shown.length - 1] ?? "";
const PROSE = "The guard now restores the token before it decides to redirect, which removes the loop. ".repeat(3);

describe("createReveal", () => {
  it("lets a reply out a little each frame and ends with all of it", () => {
    const { shown, r } = reveal();
    r.set(PROSE);
    vi.advanceTimersByTime(48);
    expect(last(shown).length).toBeGreaterThan(0);
    expect(last(shown).length).toBeLessThan(PROSE.length);
    vi.advanceTimersByTime(3000);
    expect(last(shown)).toBe(PROSE);
    // Every frame extends the one before: nothing is taken back, nothing arrives in one block.
    for (let i = 1; i < shown.length; i++) expect(shown[i].startsWith(shown[i - 1])).toBe(true);
    const steps = shown.map((text, i) => text.length - (shown[i - 1]?.length ?? 0));
    expect(Math.max(...steps)).toBeLessThan(PROSE.length / 4);
  });

  it("is never far behind a reply that keeps arriving", () => {
    const { shown, r } = reveal();
    let sent = "";
    // 150 characters twice a second, as the Hook sends them.
    for (let i = 0; i < 8; i++) {
      sent += "x".repeat(149) + " ";
      r.set(sent);
      vi.advanceTimersByTime(500);
      expect(sent.length - last(shown).length).toBeLessThan(150);
    }
    vi.advanceTimersByTime(1000);
    expect(last(shown)).toBe(sent);
  });

  it("carries on from where a rewritten reply still agrees", () => {
    const { shown, r } = reveal();
    r.set("Checking the guard first");
    vi.advanceTimersByTime(3000);
    r.set("Checking the cache instead");
    expect(last(shown)).toBe("Checking the ");
    vi.advanceTimersByTime(3000);
    expect(last(shown)).toBe("Checking the cache instead");
  });

  it("shows a reply as it lands when motion is reduced", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const { shown, r } = reveal();
    r.set(PROSE);
    expect(shown).toEqual([PROSE]);
  });

  it("shows nothing more once stopped", () => {
    const { shown, r } = reveal();
    r.set(PROSE);
    vi.advanceTimersByTime(48);
    const count = shown.length;
    r.stop();
    vi.advanceTimersByTime(3000);
    expect(shown).toHaveLength(count);
  });
});

describe("what a reveal never shows half-written", () => {
  /** Everything shown while `text` arrives whole and is let out. */
  function frames(text: string, ms = 1000) {
    const { shown, r } = reveal();
    r.set(text);
    vi.advanceTimersByTime(ms);
    return shown;
  }

  it("a list or heading marker without its first words", () => {
    for (const text of ["## Plan for the fix", "- first item here", "12. twelfth step", "> quoted words", "- [x] done already"]) {
      const marker = /^(?:#+|-|\d+\.|>)\s+(?:\[.\]\s+)?/.exec(text)![0];
      for (const frame of frames(text)) expect(frame === "" || frame.length > marker.length).toBe(true);
    }
  });

  it("a fence line, or a table row, cut partway", () => {
    const text = "Before\n```typescript\nconst a = 1;\n```\n| File | Change |\n| --- | --- |\n| a.ts | reorder |\nAfter";
    for (const frame of frames(text, 4000)) {
      const lines = frame.split("\n");
      const tail = lines[lines.length - 1];
      expect(/^`{1,3}\w*$/.test(tail) && tail !== "```typescript" && tail !== "```").toBe(false);
      expect(tail.startsWith("|")).toBe(false);
    }
  });

  it("a table's first row before the divider that makes it a table", () => {
    const { shown, r } = reveal();
    r.set("Summary\n| File | Change |\n");
    vi.advanceTimersByTime(600);
    expect(last(shown)).toBe("Summary\n");
    r.set("Summary\n| File | Change |\n| --- | --- |\n| a.ts | reorder |\n");
    vi.advanceTimersByTime(600);
    expect(last(shown)).toBe("Summary\n| File | Change |\n| --- | --- |\n| a.ts | reorder |\n");
  });

  it("lets a held line out once the reply has gone quiet", () => {
    const { shown, r } = reveal();
    r.set("Summary\n| not a table after all");
    vi.advanceTimersByTime(600);
    expect(last(shown)).toBe("Summary\n");
    vi.advanceTimersByTime(2000);
    expect(last(shown)).toBe("Summary\n| not a table after all");
  });

  it("a link's words without its address", () => {
    for (const frame of frames("see [the docs](https://x.dev/guide) for more")) expect(frame.endsWith("]")).toBe(false);
  });

  it("half of a character outside the basic plane", () => {
    for (const frame of frames("ok 😀😀😀😀😀😀 done")) expect(frame.isWellFormed()).toBe(true);
  });
});
