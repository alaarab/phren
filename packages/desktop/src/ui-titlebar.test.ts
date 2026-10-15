import { afterEach, beforeEach, expect, it, vi } from "vitest";
let installSections: typeof import("../ui/shell/sections.js").installSections;
let registerSection: typeof import("../ui/shell/sections.js").registerSection;
let showPillAt: typeof import("../ui/shell/sections.js").showPillAt;
let showSection: typeof import("../ui/shell/sections.js").showSection;

beforeEach(async () => {
  vi.resetModules();
  ({ installSections, registerSection, showPillAt, showSection } = await import("../ui/shell/sections.js"));
  for (const [id, label, group] of [["home", "Home"], ["agents", "Agents"], ["review", "Review"], ["projects", "Projects", "work"], ["conductor", "Fleet", "fleet"]]) {
    registerSection(id, { label, group, mount() {} });
  }
});

import { renderComputerCount } from "../ui/shell/titlebar.js";

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
  replaceChildren(...nodes: Node[]) { this.children = nodes; }
  addEventListener() {}
  hidden = false;
  classList = { toggle: vi.fn() };
  scrollIntoView = vi.fn();
  querySelector(selector: string): Node | null {
    return this.children.find((n) => selector === ".section-sub.selected"
      ? n.className === "section-sub selected"
      : n.attributes["aria-selected"] === "true") ?? null;
  }
}

afterEach(() => vi.unstubAllGlobals());

it("keeps every compact navigation icon named and keyboard shortcuts discoverable", () => {
  vi.stubGlobal("document", { createElement: () => new Node(), querySelectorAll: () => [] });
  vi.stubGlobal("window", { addEventListener() {} });
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

it("reveals sections opened by shortcuts, hash changes and compact resizing, including group pages", () => {
  const pills = new Node();
  const sub = new Node();
  const events: Record<string, () => void> = {};
  const win = { innerWidth: 420, addEventListener: (name: string, fn: () => void) => { events[name] = fn; } };
  const location = { hash: "#/home" };
  vi.stubGlobal("window", win);
  vi.stubGlobal("location", location);
  vi.stubGlobal("history", { replaceState: (_state: unknown, _title: string, hash: string) => { location.hash = hash; } });
  vi.stubGlobal("document", { createElement: () => new Node(), querySelectorAll: () => pills.children });
  registerSection("tasks", { label: "Tasks", group: "work", mount() {} });
  installSections(pills, new Node(), { sub });

  showPillAt(1);
  const agents = pills.children.find(n => n.dataset.section === "agents")!;
  expect(agents.scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
  location.hash = "#/tasks";
  events.hashchange();
  expect(sub.querySelector(".section-sub.selected")?.scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });

  showSection("home");
  const home = pills.children.find(n => n.dataset.section === "home")!;
  home.scrollIntoView.mockClear();
  win.innerWidth = 1280;
  events.resize();
  expect(home.scrollIntoView).not.toHaveBeenCalled();
  win.innerWidth = 360;
  events.resize();
  expect(home.scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
});

it("gives the compact computers fraction readable text without naming a generic span", () => {
  vi.stubGlobal("document", { createElement: () => new Node() });
  const count = new Node();
  renderComputerCount(count, [{ computer: "Desk", state: "online" }, { computer: "Laptop", state: "offline" }]);
  const readable = count.children.filter(n => n.attributes["aria-hidden"] !== "true").map(n => n.textContent).join("");
  expect(readable).toBe("1/2 computers online");
  expect(count.attributes["aria-label"]).toBeUndefined();
  expect(count.title).toBe("Desk: online\nLaptop: offline");
});
