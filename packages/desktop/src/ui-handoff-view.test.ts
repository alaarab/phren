import { afterEach, expect, it, vi } from "vitest";
// @ts-expect-error plain browser ESM
import { decorateHomeHandoff } from "../ui/shell/handoff-view.js";

// Minimal DOM tree supporting the renderer's moves and selectors.
class Node {
  className = "";
  textContent = "";
  children: Node[] = [];
  parent: Node | null = null;
  disabled = false;
  addEventListener = vi.fn();
  constructor(readonly tagName: string) {}
  append(...nodes: Node[]) {
    for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node); }
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((node) => node !== this);
    this.parent = null;
  }
  replaceChildren(...nodes: Node[]) { for (const node of [...this.children]) node.remove(); this.append(...nodes); }
  querySelectorAll(selector: string): Node[] {
    return this.children.flatMap((node) => [
      ...(node.className.split(" ").includes(selector.slice(1)) ? [node] : []), ...node.querySelectorAll(selector),
    ]);
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
}

afterEach(() => vi.unstubAllGlobals());

it.each(["to", "from"])("keeps the %s hand-off inside the session row alongside its metadata", (direction) => {
  vi.stubGlobal("document", { createElement: (tag: string) => new Node(tag) });
  const button = new Node("button");
  button.className = "home-row tone-working";
  const main = new Node("div"); main.className = "home-row-main";
  const title = new Node("span"); title.className = "home-row-title"; title.textContent = "Fix login";
  const sub = new Node("span"); sub.className = "home-row-sub";
  main.append(title, sub);
  const meta = new Node("span"); meta.className = "home-row-meta";
  button.append(main, meta);
  const target = { source: "codex", session: "new" };
  const child = { [direction === "to" ? "handedOffTo" : "handedOffFrom"]: { target, title: "Fix login" } };
  const row = decorateHomeHandoff(button, "Desk", child, [{ computer: "Desk", child: { target, title: "Fix login" } }]);
  expect(row.className.split(" ")).toContain("home-row");
  expect(row.querySelector(".home-row-meta")).toBe(meta);
  const tag = row.querySelector(".handoff-tag");
  expect(tag?.parent).toBe(meta);
  expect(tag?.tagName).toBe("button");
  expect(tag?.textContent).toBe(direction === "to" ? "→ Codex" : "← from Fix login");
  expect(button.querySelector(".handoff-tag")).toBeNull(); // Native buttons remain siblings.
  expect(row.querySelector(".home-row-title")?.textContent).toBe("Fix login");
  if (direction === "to") expect(row.querySelector(".home-handoff-sub")?.textContent).toBe("Handed off to Fix login");
});
