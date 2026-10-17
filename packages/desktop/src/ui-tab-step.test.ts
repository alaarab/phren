import { describe, expect, it } from "vitest";
import { DEFAULTS_APP } from "./keys-config.js";
// @ts-expect-error plain browser module without types
import { matches, parseBinding } from "../ui/keys.js";
import { stepTarget, widgetKeepsTabKey } from "../ui/shell/tab-step.js";

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
  const press = (fields: object) => ({ ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...fields });
  it("a terminal or editor keeps a bare Ctrl+PageUp / PageDown", () => {
    expect(widgetKeepsTabKey(press({ ctrlKey: true }), true)).toBe(true);
  });
  it("but not the shifted pair or Cmd, and nothing outside a widget", () => {
    expect(widgetKeepsTabKey(press({ ctrlKey: true, shiftKey: true }), true)).toBe(false);
    expect(widgetKeepsTabKey(press({ metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(widgetKeepsTabKey(press({ ctrlKey: true }), false)).toBe(false);
  });
});

describe("the default bindings", () => {
  const ev = (fields: object) => ({ key: "", code: "", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, getModifierState: () => false, ...fields });
  const hit = (action: string, e: object) => DEFAULTS_APP[action].some((text) => matches(parseBinding(text), ev(e)) !== false);
  it("Ctrl+PageDown / PageUp step forward and back", () => {
    expect(hit("tab_next", { key: "PageDown", code: "PageDown", ctrlKey: true })).toBe(true);
    expect(hit("tab_previous", { key: "PageUp", code: "PageUp", ctrlKey: true })).toBe(true);
    expect(hit("tab_next", { key: "PageUp", code: "PageUp", ctrlKey: true })).toBe(false);
    expect(hit("tab_next", { key: "PageDown", code: "PageDown" })).toBe(false);
  });
  it("Command+Shift+] / [ step on a Mac keyboard, whatever character Shift makes", () => {
    expect(hit("tab_next", { key: "}", code: "BracketRight", metaKey: true, shiftKey: true })).toBe(true);
    expect(hit("tab_previous", { key: "{", code: "BracketLeft", metaKey: true, shiftKey: true })).toBe(true);
    expect(DEFAULTS_APP.tab_next).toContain("cmd+shift+]");
    expect(DEFAULTS_APP.tab_previous).toContain("cmd+shift+[");
  });
});
