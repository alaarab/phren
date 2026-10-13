import { describe, expect, it } from "vitest";
import { acceleratorFromEvent, formatAccelerator } from "../ui/shell/summon.js";

const key = (code: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) => ({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

describe("acceleratorFromEvent", () => {
  it("records ⌘ on a Mac and Ctrl elsewhere as CommandOrControl", () => {
    expect(acceleratorFromEvent(key("Space", { metaKey: true, shiftKey: true }), "darwin")).toBe("CommandOrControl+Shift+Space");
    expect(acceleratorFromEvent(key("KeyP", { ctrlKey: true, altKey: true }), "linux")).toBe("CommandOrControl+Alt+P");
    expect(acceleratorFromEvent(key("F5", { altKey: true }), "win32")).toBe("Alt+F5");
  });

  it("refuses keys that would steal ordinary typing or are only modifiers", () => {
    expect(acceleratorFromEvent(key("KeyA"), "darwin")).toBeNull();
    expect(acceleratorFromEvent(key("KeyA", { shiftKey: true }), "darwin")).toBeNull();
    expect(acceleratorFromEvent(key("MetaLeft", { metaKey: true }), "darwin")).toBeNull();
  });
});

describe("formatAccelerator", () => {
  it("reads as symbols on a Mac and words elsewhere", () => {
    expect(formatAccelerator("CommandOrControl+Shift+Space", "darwin")).toBe("⌘⇧Space");
    expect(formatAccelerator("CommandOrControl+Shift+Space", "linux")).toBe("Ctrl+Shift+Space");
    expect(formatAccelerator("", "darwin")).toBe("Off");
  });
});
