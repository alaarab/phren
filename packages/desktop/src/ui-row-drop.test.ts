import { describe, expect, it } from "vitest";
import { carriesFiles, createRowDrop, dropHint, leftRow, placeHint } from "../ui/shell/row-drop.js";

function fakeNode() {
  const classes = new Set<string>();
  const children = new Set<unknown>();
  return {
    isConnected: true,
    getBoundingClientRect: () => ({ left: 4, right: 60, top: 100, height: 44 }),
    classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c), has: (c: string) => classes.has(c) },
    contains: (other: unknown) => children.has(other),
    children,
  };
}

describe("row drop target", () => {
  it("only counts drags that carry files", () => {
    expect(carriesFiles({ types: ["Files"] })).toBe(true);
    expect(carriesFiles({ types: ["text/phren-tab"] })).toBe(false);
    expect(carriesFiles({ types: ["text/plain", "Files"] })).toBe(true);
    expect(carriesFiles(null)).toBe(false);
  });

  it("names the chat in the hint", () => {
    expect(dropHint("Fix login")).toBe("Attach to Fix login");
    expect(dropHint("  ")).toBe("Attach to this chat");
    expect(dropHint(undefined)).toBe("Attach to this chat");
  });

  it("leaving into a child of the row keeps the target; leaving the row or window ends it", () => {
    const node = fakeNode();
    const inner = {};
    node.children.add(inner);
    expect(leftRow(node, inner)).toBe(false);
    expect(leftRow(node, {})).toBe(true);
    expect(leftRow(node, null)).toBe(true);
  });

  it("places the chip beside the row, flips left at the right edge and clamps top and bottom", () => {
    const size = { width: 120, height: 30 };
    expect(placeHint({ left: 4, right: 60, top: 100, height: 44 }, size, { width: 1280, height: 800 })).toEqual({ left: 68, top: 107 });
    // A row near the right edge: the chip flips to its left.
    expect(placeHint({ left: 300, right: 380, top: 100, height: 44 }, size, { width: 400, height: 800 })).toEqual({ left: 172, top: 107 });
    // First row hugging the top and last row hugging the bottom.
    expect(placeHint({ left: 4, right: 60, top: -10, height: 20 }, size, { width: 420, height: 800 }).top).toBe(8);
    expect(placeHint({ left: 4, right: 60, top: 790, height: 44 }, size, { width: 420, height: 800 }).top).toBe(762);
    // Narrower than the chip either way: it stays inside the left edge.
    expect(placeHint({ left: 0, right: 100, top: 0, height: 40 }, { width: 200, height: 30 }, { width: 220, height: 800 }).left).toBe(8);
  });

  it("highlights one row at a time with one persistent chip, and clears on Escape, dragend, drop and removal", () => {
    const doc = Object.assign(new EventTarget(), {
      tips: [] as Array<{ textContent: string; classes: Set<string>; style: Record<string, string> }>,
      defaultView: { innerWidth: 420, innerHeight: 800 },
      body: { append() {} },
      createElement() {
        const classes = new Set<string>();
        const tip = { textContent: "", className: "", classes, style: {} as Record<string, string>, offsetWidth: 100, offsetHeight: 30, setAttribute() {}, classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) } };
        doc.tips.push(tip);
        return tip;
      },
    });
    const drop = createRowDrop(doc as unknown as Document);
    const a = fakeNode();
    const b = fakeNode();
    drop.over(a, "First");
    expect(a.classList.has("sb-drop")).toBe(true);
    expect(doc.tips).toHaveLength(1);
    expect(doc.tips[0].textContent).toBe("Attach to First");
    expect(doc.tips[0].classes.has("show")).toBe(true);
    expect(doc.tips[0].style.left).toBe("68px");
    drop.over(b, "Second");
    expect(doc.tips).toHaveLength(1);
    expect(doc.tips[0].textContent).toBe("Attach to Second");
    expect(a.classList.has("sb-drop")).toBe(false);
    expect(drop.active()).toBe(b);

    const other = new Event("keydown") as Event & { key: string };
    other.key = "a";
    doc.dispatchEvent(other);
    expect(drop.active()).toBe(b);
    const esc = new Event("keydown") as Event & { key: string };
    esc.key = "Escape";
    doc.dispatchEvent(esc);
    expect(drop.active()).toBeNull();
    expect(doc.tips[0].classes.has("show")).toBe(false);
    expect(doc.tips[0].textContent).toBe("");

    for (const type of ["dragend", "drop"]) {
      drop.over(a, "First");
      doc.dispatchEvent(new Event(type));
      expect(drop.active()).toBeNull();
    }

    // A row reconciled away mid-drag: the sweep clears the chip; a row still in the page stays.
    drop.over(a, "First");
    drop.sweep();
    expect(drop.active()).toBe(a);
    a.isConnected = false;
    drop.sweep();
    expect(drop.active()).toBeNull();
    expect(doc.tips[0].classes.has("show")).toBe(false);
  });
});
