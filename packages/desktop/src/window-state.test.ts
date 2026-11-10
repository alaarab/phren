import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error The Electron shell is plain JavaScript.
import { readWindowState, restoredBounds } from "../electron/window-state.js";

const DEFAULTS = { width: 1440, height: 900, minWidth: 960, minHeight: 600 };
const LAPTOP = { x: 0, y: 25, width: 1512, height: 944 };
const SIDE_MONITOR = { x: 1512, y: 0, width: 2560, height: 1415 };

describe("where the window opens", () => {
  it.each([
    ["the default size, centred, the first time", null, [LAPTOP], { bounds: { width: 1440, height: 900 }, maximized: false }],
    ["where it was left", { x: 80, y: 60, width: 1200, height: 800, maximized: false }, [LAPTOP], { bounds: { x: 80, y: 60, width: 1200, height: 800 }, maximized: false }],
    ["on the second monitor it was left on", { x: 1700, y: 100, width: 1600, height: 1000, maximized: false }, [LAPTOP, SIDE_MONITOR], { bounds: { x: 1700, y: 100, width: 1600, height: 1000 }, maximized: false }],
    // The monitor it was on is gone: its size is kept (fitted to what is left) but not its place.
    ["centred when its monitor has been unplugged", { x: 1700, y: 100, width: 1600, height: 1000, maximized: false }, [LAPTOP], { bounds: { width: 1512, height: 944 }, maximized: false }],
    ["centred when only a sliver of it would show", { x: 1460, y: 100, width: 1200, height: 800, maximized: false }, [LAPTOP], { bounds: { width: 1200, height: 800 }, maximized: false }],
    ["centred when its title bar would be below the screen", { x: 80, y: 960, width: 1200, height: 800, maximized: false }, [LAPTOP], { bounds: { width: 1200, height: 800 }, maximized: false }],
    ["under the menu bar, not behind it", { x: 80, y: 24, width: 1200, height: 800, maximized: false }, [LAPTOP], { bounds: { x: 80, y: 25, width: 1200, height: 800 }, maximized: false }],
    ["no smaller than the window allows", { x: 80, y: 60, width: 300, height: 200, maximized: false }, [LAPTOP], { bounds: { x: 80, y: 60, width: 960, height: 600 }, maximized: false }],
    ["maximized, over the size to return to", { x: 80, y: 60, width: 1200, height: 800, maximized: true }, [LAPTOP], { bounds: { x: 80, y: 60, width: 1200, height: 800 }, maximized: true }],
  ])("%s", (_name, saved, workAreas, expected) => {
    expect(restoredBounds(saved, workAreas, DEFAULTS)).toEqual(expected);
  });
});

describe("the saved window state", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "window-state-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const saved = (name: string, text: string) => { const file = path.join(dir, name); writeFileSync(file, text); return readWindowState(file); };

  it("is read back as whole numbers", () => {
    expect(saved("ok.json", JSON.stringify({ x: 80.4, y: 60, width: 1200.6, height: 800, maximized: true }))).toEqual({ x: 80, y: 60, width: 1201, height: 800, maximized: true });
  });

  it.each([
    ["a missing file", null],
    ["a file that is not JSON", "{ nope"],
    ["a size that is not a number", JSON.stringify({ x: 0, y: 0, width: "wide", height: 800 })],
    ["an empty size", JSON.stringify({ x: 0, y: 0, width: 0, height: 800 })],
  ])("is ignored for %s", (name, text) => {
    expect(text === null ? readWindowState(path.join(dir, "absent.json")) : saved(`${name}.json`, text)).toBeNull();
  });
});
