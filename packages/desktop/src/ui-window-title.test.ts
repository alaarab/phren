import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM UI module
import { clipTitle, startWindowTitle, TITLE_MAX, windowTitle } from "../ui/shell/window-title.js";

describe("windowTitle", () => {
  it("names the active chat, then the app, with the needs-you count in front when above zero", () => {
    expect(windowTitle({ needs: 0, chat: "Fix login", section: "Agents" })).toBe("Fix login — Phren");
    expect(windowTitle({ needs: 3, chat: "Fix login", section: "Agents" })).toBe("(3) Fix login — Phren");
  });

  it("falls back to the section, then to the bare app name", () => {
    expect(windowTitle({ needs: 2, chat: null, section: "Tasks" })).toBe("(2) Tasks — Phren");
    expect(windowTitle({ needs: 0, chat: "  ", section: "Home" })).toBe("Home — Phren");
    expect(windowTitle({ needs: 0 })).toBe("Phren");
    expect(windowTitle({ needs: 1 })).toBe("(1) Phren");
    expect(windowTitle()).toBe("Phren");
  });

  it("clips long chat titles with an ellipsis and keeps them to one line", () => {
    const long = "x".repeat(100);
    const clipped = clipTitle(long);
    expect([...clipped]).toHaveLength(TITLE_MAX);
    expect(clipped.endsWith("…")).toBe(true);
    expect(clipTitle("a".repeat(TITLE_MAX))).toBe("a".repeat(TITLE_MAX));
    expect(clipTitle("Fix\n  the   login\tform")).toBe("Fix the login form");
    expect(windowTitle({ needs: 0, chat: long })).toBe(`${clipped} — Phren`);
  });
});

describe("windowTitle privacy and spoofing", () => {
  it("uses the section when showChat is off", () => {
    expect(windowTitle({ needs: 2, chat: "Secret merger plan", section: "Agents", showChat: false })).toBe("(2) Agents \u2014 Phren");
    expect(windowTitle({ needs: 0, chat: "Secret", section: null, showChat: false })).toBe("Phren");
  });

  it("strips bidi overrides, zero-width and control characters", () => {
    expect(clipTitle("\u202Eevil\u202C title\u200B\u0007")).toBe("evil title");
    expect(clipTitle("a\u2028b\n\tc")).toBe("a b c");
    // a title that tries to open with its own count still sits after the real prefix
    expect(windowTitle({ needs: 1, chat: "\u202E(9) all clear" })).toBe("(1) (9) all clear \u2014 Phren");
  });
});

describe("startWindowTitle", () => {
  it("rewrites the title when refreshed or on a tabs change, once per burst", async () => {
    const listeners = new Map<string, () => void>();
    const target = { addEventListener: (name: string, fn: () => void) => listeners.set(name, fn) };
    const doc = { title: "", ...target };
    let state = { needs: 0, chat: "Alpha" as string | null, section: "Agents" };
    const title = startWindowTitle(() => state, doc, target);
    expect(doc.title).toBe("Alpha — Phren");
    state = { needs: 1, chat: "Bravo", section: "Agents" };
    title.refresh(); title.refresh();
    expect(doc.title).toBe("Alpha — Phren"); // deferred a microtask
    await Promise.resolve();
    expect(doc.title).toBe("(1) Bravo — Phren");
    state = { needs: 1, chat: null, section: "Home" };
    listeners.get("focus")!();
    await Promise.resolve();
    expect(doc.title).toBe("(1) Home — Phren");
    state = { needs: 0, chat: "Alpha", section: "Agents" };
    listeners.get("phren:tabs-changed")!();
    await Promise.resolve();
    expect(doc.title).toBe("Alpha — Phren");
  });
});
