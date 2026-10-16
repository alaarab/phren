import { describe, expect, it } from "vitest";
import { carriesFiles, createRowDrop, dropHint, leftRow } from "../ui/shell/row-drop.js";

function fakeNode() {
  const classes = new Set<string>();
  const attrs = new Map<string, string>();
  const children = new Set<unknown>();
  return {
    classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c), has: (c: string) => classes.has(c) },
    setAttribute: (k: string, v: string) => attrs.set(k, v),
    removeAttribute: (k: string) => attrs.delete(k),
    getAttribute: (k: string) => attrs.get(k),
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

  it("highlights one row at a time and clears on Escape, dragend and drop", () => {
    const doc = Object.assign(new EventTarget(), {
      tips: [] as Array<{ textContent: string; style: Record<string, string>; removed: boolean }>,
      defaultView: { innerWidth: 420 },
      body: { append(tip: { removed: boolean }) { tip.removed = false; } },
      createElement() {
        const tip = { textContent: "", className: "", style: {} as Record<string, string>, removed: false, setAttribute() {}, remove() { tip.removed = true; } };
        doc.tips.push(tip);
        return tip;
      },
    });
    const drop = createRowDrop(doc as unknown as Document);
    const a = fakeNode();
    const b = fakeNode();
    drop.over(a, "First");
    expect(a.classList.has("sb-drop")).toBe(true);
    expect(a.getAttribute("data-drop-hint")).toBe("Attach to First");
    expect(doc.tips[0].textContent).toBe("Attach to First");
    drop.over(b, "Second");
    expect(doc.tips[0].removed).toBe(true);
    expect(doc.tips[1].textContent).toBe("Attach to Second");
    expect(a.classList.has("sb-drop")).toBe(false);
    expect(a.getAttribute("data-drop-hint")).toBeUndefined();
    expect(drop.active()).toBe(b);

    const other = new Event("keydown") as Event & { key: string };
    other.key = "a";
    doc.dispatchEvent(other);
    expect(drop.active()).toBe(b);
    const esc = new Event("keydown") as Event & { key: string };
    esc.key = "Escape";
    doc.dispatchEvent(esc);
    expect(drop.active()).toBeNull();
    expect(doc.tips[1].removed).toBe(true);
    expect(b.classList.has("sb-drop")).toBe(false);

    for (const type of ["dragend", "drop"]) {
      drop.over(a, "First");
      doc.dispatchEvent(new Event(type));
      expect(drop.active()).toBeNull();
    }
  });
});
