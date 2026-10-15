import { afterEach, expect, it, vi } from "vitest";
const hooks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), sessions: [] as object[], open: vi.fn() }));
vi.mock("../ui/api.js", () => ({ hookGet: hooks.get, hookPost: hooks.post }));
vi.mock("../ui/shell/palette.js", () => ({ registerCommand: vi.fn() }));
vi.mock("../ui/shell/sections.js", () => ({ showSection: vi.fn(), sectionHandle: () => ({ openSession: hooks.open }) }));
vi.mock("../ui/shell/store.js", () => ({
  store: {
    merged: { computers: [{ computer: "Desk", state: "online" }, { computer: "Laptop", state: "online" }] },
    capabilities: async () => ({ taskDependencies: true }), can: () => true, subscribe: () => () => {},
  },
  sessions: () => hooks.sessions, projectOf: () => "phren",
}));
// @ts-expect-error plain ESM
import { createActiveTasks } from "../ui/sections/home/active-tasks.js";
const doc = { activeElement: null as unknown };
class FakeNode {
  constructor(public tagName = "DIV") {}
  className = "";
  textContent = "";
  hidden = false;
  title = "";
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  classList = { add: (name: string) => { this.className += ` ${name}`; }, toggle: () => {} };
  listeners = new Map<string, (event: object) => void>();
  children: FakeNode[] = [];
  selectors = new Map<string, FakeNode>();
  append(...nodes: FakeNode[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: FakeNode[]) {
    if (this.children.some((child) => child.contains(doc.activeElement))) doc.activeElement = null;
    this.children = nodes;
  }
  focus() { doc.activeElement = this; }
  readOnly = false; disabled = false; value = "";
  get childNodes() { return this.children; }
  remove() {}
  click() { if (!this.disabled) this.listeners.get("click")?.({}); }
  find(predicate: (node: FakeNode) => boolean): FakeNode | undefined {
    return predicate(this) ? this : this.children.map((node) => node.find(predicate)).find(Boolean);
  }
  closest() { return null; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  addEventListener(type: string, fn: (event: object) => void) { this.listeners.set(type, fn); }
  contains(node: unknown): boolean {
    return node === this || [...this.children, ...this.selectors.values()].some((child) => child.contains(node));
  }
  querySelector(selector: string): FakeNode {
    if (!this.selectors.has(selector)) this.selectors.set(selector, new FakeNode());
    return this.selectors.get(selector)!;
  }
  querySelectorAll() { return []; }
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); vi.useRealTimers(); doc.activeElement = null; });

function stubDocument() {
  vi.stubGlobal("HTMLElement", FakeNode);
  vi.stubGlobal("document", Object.assign(doc, {
    head: new FakeNode(), getElementById: () => null, body: new FakeNode(), createElement: (tag: string) => new FakeNode(tag.toUpperCase()), querySelector: () => null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }));
}



const settle = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
it("launches same-named projects from their own stores through the real sheet on their source computer", async () => {
  stubDocument(); vi.useFakeTimers();
  hooks.sessions = [];
  const body = document.body as unknown as FakeNode;
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ accounts: [] }) })));
  const revision = "a".repeat(64);
  hooks.get.mockImplementation(async (computer, route, query) => {
    if (route === "/v1/tasks/stores") return { stores: computer === "Desk" ? [
      { id: "11111111", primary: true, projects: ["phren"] }, { id: "22222222", projects: ["phren"] },
    ] : [] };
    if (route === "/v1/tasks") return { revision, items: { Active: [{ stableId: "abcdef01", line: `${query.storeId} task`, createdAt: "2026-10-15" }] } };
    if (route === "/v1/dispatch/capacity") return { harnesses: [{ source: "codex", installed: true, usable: true }] };
    return {};
  });
  hooks.post.mockImplementation(async (computer, _route, data) => {
    const cwd = data.storeId === "22222222" ? "/repos/secondary/phren" : "/repos/primary/phren";
    hooks.sessions = [{ computer, child: { id: cwd, cwd } }];
    return { cwd };
  });
  const scope = new FakeNode();
  const block = createActiveTasks({ block: () => scope, state: { merged: { computers: [{ computer: "Desk", state: "online" }] } } });
  block.show(); await settle();
  const rows = scope.querySelector(".home-list").children;
  expect(rows).toHaveLength(2);
  for (const [index, storeId] of ["11111111", "22222222"].entries()) {
    rows[index].children[1].click(); await settle();
    const sheet = body.children.at(-1)!;
    const launch = sheet.find((n) => n.className === "launch-btn accent")!;
    expect(launch.disabled).toBe(false);
    launch.click(); await settle();
    expect(hooks.post).toHaveBeenLastCalledWith("Desk", "/v1/tasks/launch", {
      storeId, project: "phren", stableId: "abcdef01", expectedRevision: revision, kind: "codex", effort: "medium",
    });
    expect(hooks.open).toHaveBeenLastCalledWith("Desk", expect.objectContaining({ cwd: index ? "/repos/secondary/phren" : "/repos/primary/phren" }));
    expect(sheet.find((n) => n.attributes.get("aria-label") === "Project")?.readOnly).toBe(true);
    const laptop = sheet.find((n) => n.className.split(" ").includes("launch-computer") && !!n.find((c) => c.textContent === "Laptop"));
    expect(laptop?.disabled).toBe(true);
  }
  block.hide();
});
