import { describe, expect, it } from "vitest";
// @ts-expect-error Plain browser ESM.
import { createFinder, highlight, isChrome, ranges, restore, textNodes } from "../ui/chat/find.js";
// @ts-expect-error Plain browser ESM.
import { counterText, isFindKey } from "../ui/chat/find-bar.js";

// A tiny DOM: just the node API find.js uses (no jsdom in this repo).
class FakeNode {
  parentNode: FakeElement | null = null;
  ownerDocument: FakeDocument;
  constructor(doc: FakeDocument) { this.ownerDocument = doc; }
}
class FakeText extends FakeNode {
  nodeType = 3;
  constructor(doc: FakeDocument, public nodeValue: string) { super(doc); }
  splitText(offset: number) {
    const tail = new FakeText(this.ownerDocument, this.nodeValue.slice(offset));
    this.nodeValue = this.nodeValue.slice(0, offset);
    this.parentNode!.insertBefore(tail, this.nextSibling);
    return tail;
  }
  get nextSibling() { const k = this.parentNode!.childNodes; return k[k.indexOf(this) + 1] ?? null; }
}
class FakeElement extends FakeNode {
  nodeType = 1;
  childNodes: FakeNode[] = [];
  className = "";
  hidden = false;
  attrs: Record<string, string> = {};
  constructor(doc: FakeDocument, public tagName: string) { super(doc); }
  get classList() {
    const self = this;
    const names = () => self.className.split(/\s+/).filter(Boolean);
    return {
      contains: (n: string) => names().includes(n),
      add: (n: string) => { if (!names().includes(n)) self.className = [...names(), n].join(" "); },
      remove: (n: string) => { self.className = names().filter((x) => x !== n).join(" "); },
    };
  }
  getAttribute(n: string) { return this.attrs[n] ?? null; }
  appendChild(node: any) { return this.insertBefore(node, null); }
  insertBefore(node: any, ref: any) {
    node.parentNode?.removeChild(node);
    const at = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
    this.childNodes.splice(at, 0, node);
    node.parentNode = this;
    return node;
  }
  removeChild(node: any) { this.childNodes.splice(this.childNodes.indexOf(node), 1); node.parentNode = null; return node; }
  get firstChild() { return this.childNodes[0] ?? null; }
  normalize() {
    const out: FakeNode[] = [];
    for (const k of this.childNodes) {
      const last = out[out.length - 1];
      if (k instanceof FakeText && last instanceof FakeText) last.nodeValue += k.nodeValue;
      else if (!(k instanceof FakeText && k.nodeValue === "")) out.push(k);
    }
    this.childNodes = out;
  }
}
class FakeDocument {
  createElement(tag: string) { return new FakeElement(this, tag.toUpperCase()); }
  text(value: string) { return new FakeText(this, value); }
}

function build(doc: FakeDocument, spec: any): FakeNode {
  if (typeof spec === "string") return doc.text(spec);
  const [tag, cls, ...kids] = spec;
  const el = doc.createElement(tag);
  el.className = cls || "";
  for (const kid of kids) {
    el.appendChild(build(doc, kid));
  }
  return el;
}
const text = (node: any): string => node.nodeType === 3 ? node.nodeValue : node.childNodes.map(text).join("");
const shape = (node: any): any => node.nodeType === 3 ? node.nodeValue : [node.tagName, node.className, ...node.childNodes.map(shape)];

function conversation() {
  const doc = new FakeDocument();
  const root = build(doc, ["DIV", "ct-column",
    ["DIV", "ct-md", "The guard drops the Token. ", ["STRONG", "", "token"], " again."],
    ["DIV", "ct-toolbox",
      ["BUTTON", "ct-toolrow", ["SPAN", "ct-icon", "token-icon"], ["SPAN", "ct-toolrow-title", "Ran token tests"], ["SPAN", "ct-chevron", "token"]],
      ["DIV", "ct-toolbox-body", ["PRE", "ct-pre", "token ok"]]],
    ["BUTTON", "ct-more", "token more"],
    ["FIGURE", "ct-md-pre", ["DIV", "ct-md-pre-bar", ["BUTTON", "ct-md-copy", "token copy"]], ["PRE", "", "const token = 1;"]],
  ]) as FakeElement;
  const body = (root.childNodes[1] as FakeElement).childNodes[1] as FakeElement;
  return { doc, root, body };
}

describe("ranges", () => {
  it("finds every case-insensitive occurrence and escapes the query", () => {
    expect(ranges("Token token TOKEN", "token")).toEqual([[0, 5], [6, 11], [12, 17]]);
    expect(ranges("a.b axb", "a.b")).toEqual([[0, 3]]);
    expect(ranges("anything", "")).toEqual([]);
  });
});

describe("textNodes", () => {
  it("skips chrome (icons, chevrons, plain buttons, copy bars) and keeps tool row titles", () => {
    const { root, body } = conversation();
    const seen = textNodes(root).map((n: any) => n.nodeValue);
    expect(seen).toContain("Ran token tests");
    expect(seen).toContain("const token = 1;");
    expect(seen).not.toContain("token-icon");
    expect(seen).not.toContain("token more");
    expect(seen).not.toContain("token copy");
    expect(seen.filter((v: string) => v === "token")).toHaveLength(1); // the <strong>, not the chevron
    // A collapsed tool body is still searched; other hidden subtrees are not.
    body.hidden = true;
    expect(textNodes(root).map((n: any) => n.nodeValue)).toContain("token ok");
    (root.childNodes[0] as FakeElement).hidden = true;
    expect(textNodes(root).map((n: any) => n.nodeValue)).not.toContain("The guard drops the Token. ");
  });

  it("treats aria-hidden elements as chrome", () => {
    const doc = new FakeDocument();
    const el = doc.createElement("div");
    el.attrs["aria-hidden"] = "true";
    expect(isChrome(el)).toBe(true);
  });
});

describe("highlight and restore", () => {
  it("wraps each hit in a mark, across inline elements, and restores the exact DOM", () => {
    const { root } = conversation();
    const before = shape(root);
    const textBefore = text(root);
    const marks = highlight(root, "TOKEN");
    expect(marks.map(text)).toEqual(["Token", "token", "token", "token", "token"]);
    expect(text(root)).toBe(textBefore); // copy / selection see the same text
    expect(marks.every((m: any) => m.className === "ct-find-hit")).toBe(true);
    restore(marks);
    expect(shape(root)).toEqual(before);
  });

  it("never marks chrome", () => {
    const { root } = conversation();
    const marks = highlight(root, "token");
    expect(marks.map(text).join("")).not.toContain("copy");
    const buttons = textNodes(root, () => false).filter((n: any) => ["token more", "token copy"].includes(n.nodeValue));
    expect(buttons).toHaveLength(2); // still there, unmarked
  });
});

describe("createFinder", () => {
  it("steps with wrap-around, marks one current hit and clears everything", () => {
    const { root } = conversation();
    const before = shape(root);
    const finder = createFinder(root);
    const result = finder.search("token");
    expect(result.count).toBe(5);
    expect(result.index).toBe(0);
    const current = () => finder.marks.filter((m: any) => m.classList.contains("ct-find-current"));
    expect(current()).toEqual([finder.marks[0]]);
    finder.step(1);
    expect(finder.index).toBe(1);
    expect(current()).toEqual([finder.marks[1]]);
    finder.step(-1); finder.step(-1);
    expect(finder.index).toBe(4);
    finder.step(1);
    expect(finder.index).toBe(0);
    finder.clear();
    expect(finder.count).toBe(0);
    expect(shape(root)).toEqual(before);
  });

  it("reveals the hit it steps to", () => {
    const { root } = conversation();
    const revealed: string[] = [];
    const finder = createFinder(root, { reveal: (m: any) => revealed.push(text(m)) });
    finder.search("ok");
    finder.step(1);
    expect(revealed).toEqual(["ok"]);
  });

  it("keeps the current hit when messages stream in and it is searched again", () => {
    const { doc, root } = conversation();
    const finder = createFinder(root);
    finder.search("token");
    finder.step(1); finder.step(1); // third hit: the tool row title
    const title = finder.marks[2].parentNode;
    // A new message lands at the end of the conversation.
    root.appendChild(build(doc, ["DIV", "ct-md", "one more token here"]));
    const again = finder.search("token", { keep: true });
    expect(again.count).toBe(6);
    expect(finder.marks[again.index].parentNode).toBe(title);
    // A changed query starts over.
    expect(finder.search("guard", { keep: true }).index).toBe(0);
  });

  it("survives its rows being re-rendered away", () => {
    const { root } = conversation();
    const finder = createFinder(root);
    finder.search("token");
    root.childNodes.splice(0, 1); // the first row is replaced by the timeline
    expect(() => finder.search("token", { keep: true })).not.toThrow();
    expect(finder.count).toBe(3);
    finder.clear();
  });
});

describe("find bar helpers", () => {
  it("opens on ⌘F or Ctrl+F only", () => {
    expect(isFindKey({ key: "f", metaKey: true })).toBe(true);
    expect(isFindKey({ key: "F", ctrlKey: true })).toBe(true);
    expect(isFindKey({ key: "f", metaKey: true, shiftKey: true })).toBe(false); // ⇧⌘F is Search
    expect(isFindKey({ key: "f", metaKey: true, altKey: true })).toBe(false);
    expect(isFindKey({ key: "f" })).toBe(false);
  });

  it("words the counter", () => {
    expect(counterText("", 0, -1)).toBe("");
    expect(counterText("x", 0, -1)).toBe("0/0");
    expect(counterText("x", 3, 1)).toBe("2/3");
  });
});
