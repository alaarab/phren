import { afterEach, describe, expect, it, vi } from "vitest";
import { installKeys, shadowedByPrefix } from "../ui/keys.js";

describe("shadowedByPrefix", () => {
  it("lets Herdr's Ctrl+B prefix win over the Cmd+B sidebar default off macOS only", () => {
    expect(shadowedByPrefix("cmd+b", ["ctrl+b"], false)).toBe(true);
    expect(shadowedByPrefix("cmd+b", ["ctrl+b"], true)).toBe(false);
    expect(shadowedByPrefix("cmd+shift+b", ["ctrl+b"], false)).toBe(false);
    expect(shadowedByPrefix("cmd+k", ["ctrl+b"], false)).toBe(false);
    expect(shadowedByPrefix("cmd+a", ["ctrl+a"], false)).toBe(true);
  });
});

vi.mock("../ui/shell/palette.js", () => ({ registerCommand: vi.fn() }));
vi.mock("../ui/shell/usage-rings.js", () => ({ openUsage: vi.fn() }));

afterEach(() => vi.unstubAllGlobals());

it("leaves nested control activation alone while Enter on a sidebar row still opens it", async () => {
  // Only the DOM surface used by key installation and sidebar navigation.
  class Element {
    classList = { toggle: vi.fn() };
    click = vi.fn();
    constructor(readonly tagName: string, readonly parent: Element | null = null, readonly row = false) {}
    contains(node: Element): boolean { return node === this || !!node.parent && this.contains(node.parent); }
    closest(selector: string): Element | null {
      const matches = selector.split(",").some((part) => part.trim() === (this.row ? ".sb-row" : this.tagName.toLowerCase()));
      return matches ? this : this.parent?.closest(selector) ?? null;
    }
  }
  const row = new Element("DIV", null, true);
  let keydown!: (event: object) => void;
  vi.stubGlobal("Element", Element);
  vi.stubGlobal("window", { addEventListener: vi.fn() });
  vi.stubGlobal("document", {
    createElement: () => ({}), head: { append: vi.fn() },
    getElementById: () => ({ addEventListener: (_type: string, handler: typeof keydown) => { keydown = handler; } }),
    querySelectorAll: () => [row],
  });
  vi.stubGlobal("fetch", async () => ({ json: async () => ({ bindings: {}, appBindings: {} }) }));
  await installKeys({});

  for (const tag of ["BUTTON", "A", "INPUT"]) {
    const control = new Element(tag, row);
    for (const target of [control, new Element("SPAN", control)]) {
      for (const key of ["Enter", " "]) {
        const preventDefault = vi.fn();
        keydown({ target, key, preventDefault });
        expect(preventDefault, `${tag} ${key} keeps native activation`).not.toHaveBeenCalled();
        expect(row.click).not.toHaveBeenCalled();
      }
    }
  }
  const preventDefault = vi.fn();
  keydown({ target: row, key: "Enter", preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(row.click).toHaveBeenCalledOnce();
});
