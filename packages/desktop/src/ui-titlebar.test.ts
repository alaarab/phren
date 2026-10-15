import { afterEach, expect, it, vi } from "vitest";
import { installSections, registerSection } from "../ui/shell/sections.js";

class Node {
  className = "";
  textContent = "";
  innerHTML = "";
  title = "";
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  children: Node[] = [];
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  append(...nodes: Node[]) { this.children.push(...nodes); }
  replaceChildren() { this.children = []; }
  addEventListener() {}
}

afterEach(() => vi.unstubAllGlobals());

it("keeps every compact navigation icon named and keyboard shortcuts discoverable", () => {
  vi.stubGlobal("document", { createElement: () => new Node(), querySelectorAll: () => [] });
  vi.stubGlobal("window", { addEventListener() {} });
  for (const [id, label, group] of [["home", "Home"], ["agents", "Agents"], ["review", "Review"], ["projects", "Projects", "work"], ["conductor", "Fleet", "fleet"]]) {
    registerSection(id, { label, group, mount() {} });
  }
  const pills = new Node();
  installSections(pills, new Node());
  expect(pills.children).toHaveLength(5);
  for (const [i, label] of ["Home", "Agents", "Review", "Projects", "Fleet"].entries()) {
    const button = pills.children[i];
    expect(button.attributes["aria-label"]).toBe(label);
    expect(button.title).toContain(label);
    expect(button.attributes["aria-keyshortcuts"]).toContain(String(i + 1));
    expect(button.children[0].attributes["aria-hidden"]).toBe("true");
    expect(button.children[0].innerHTML).toContain("<svg");
    expect(button.children[1].textContent).toBe(label);
  }
});
