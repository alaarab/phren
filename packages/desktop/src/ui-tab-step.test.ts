import { describe, expect, it } from "vitest";
import { DEFAULTS_APP } from "./keys-config.js";
// @ts-expect-error plain browser module without types
import { matches, parseBinding } from "../ui/keys.js";
import { recentOwnsKey, stepTarget, typedKeyStaysText, widgetKeepsTabKey } from "../ui/shell/tab-step.js";

const order = ["a", "b", "c"];

describe("stepTarget", () => {
  it("moves forward and back", () => {
    expect(stepTarget(order, "a", 1)).toBe("b");
    expect(stepTarget(order, "c", -1)).toBe("b");
  });
  it("wraps at both ends", () => {
    expect(stepTarget(order, "c", 1)).toBe("a");
    expect(stepTarget(order, "a", -1)).toBe("c");
    expect(stepTarget(order, "a", -4)).toBe("c");
  });
  it("starts from the ends when nothing is active", () => {
    expect(stepTarget(order, null, 1)).toBe("a");
    expect(stepTarget(order, "gone", -1)).toBe("c");
  });
  it("stays on a lone tab and says null for none", () => {
    expect(stepTarget(["a"], "a", 1)).toBe("a");
    expect(stepTarget([], null, 1)).toBeNull();
  });
});

describe("widgetKeepsTabKey", () => {
  it("a terminal, editor or iframe keeps the key, whatever the modifiers", () => {
    expect(widgetKeepsTabKey(true)).toBe(true);
  });
  it("nothing else does", () => {
    expect(widgetKeepsTabKey(false)).toBe(false);
    expect(widgetKeepsTabKey(null)).toBe(false);
  });
});

describe("recentOwnsKey", () => {
  const press = (fields: object) => ({ key: "Tab", ctrlKey: true, altKey: false, metaKey: false, ...fields });
  it("Ctrl+Tab and Ctrl+Shift+Tab stay the recent-chat switcher's while it is on", () => {
    expect(recentOwnsKey(press({}), true)).toBe(true);
    expect(recentOwnsKey(press({ shiftKey: true }), true)).toBe(true);
  });
  it("tab stepping may take Ctrl+Tab when the switcher is off, and other keys always", () => {
    expect(recentOwnsKey(press({}), false)).toBe(false);
    expect(recentOwnsKey(press({ key: "PageDown" }), true)).toBe(false);
    expect(recentOwnsKey(press({ metaKey: true }), true)).toBe(false);
  });
});

describe("typedKeyStaysText", () => {
  const press = (fields: object) => ({ key: "n", ctrlKey: false, altKey: false, metaKey: false, ...fields });
  it("a bare key typed into a field stays text", () => {
    expect(typedKeyStaysText(press({}), true)).toBe(true);
    expect(typedKeyStaysText(press({ key: "PageDown" }), true)).toBe(true);
  });
  it("a modified key, or any key outside a field, is a shortcut", () => {
    expect(typedKeyStaysText(press({ ctrlKey: true }), true)).toBe(false);
    expect(typedKeyStaysText(press({ metaKey: true }), true)).toBe(false);
    expect(typedKeyStaysText(press({}), false)).toBe(false);
  });
});

describe("the default bindings", () => {
  const ev = (fields: object) => ({ key: "", code: "", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, getModifierState: () => false, ...fields });
  const hit = (action: string, e: object) => DEFAULTS_APP[action].some((text) => matches(parseBinding(text), ev(e)) !== false);
  it("are Ctrl+PageDown / PageUp only", () => {
    expect(DEFAULTS_APP.tab_next).toEqual(["ctrl+pagedown"]);
    expect(DEFAULTS_APP.tab_previous).toEqual(["ctrl+pageup"]);
    expect(hit("tab_next", { key: "PageDown", code: "PageDown", ctrlKey: true })).toBe(true);
    expect(hit("tab_previous", { key: "PageUp", code: "PageUp", ctrlKey: true })).toBe(true);
    expect(hit("tab_next", { key: "PageUp", code: "PageUp", ctrlKey: true })).toBe(false);
    expect(hit("tab_next", { key: "PageDown", code: "PageDown" })).toBe(false);
  });
  it("never match the bracket keys section navigation uses", () => {
    for (const [key, code] of [["[", "BracketLeft"], ["]", "BracketRight"]]) {
      for (const mods of [{ metaKey: true }, { ctrlKey: true }]) {
        expect(hit("tab_next", { key, code, ...mods })).toBe(false);
        expect(hit("tab_previous", { key, code, ...mods })).toBe(false);
      }
    }
  });
});
