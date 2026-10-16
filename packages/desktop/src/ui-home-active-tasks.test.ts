import { afterEach, beforeEach, expect, it, vi } from "vitest";
const hooks = vi.hoisted(() => ({ get: vi.fn(), launch: vi.fn(), show: vi.fn(), filter: vi.fn() }));
vi.mock("../ui/api.js", () => ({ hookGet: hooks.get }));
vi.mock("../ui/shell/store.js", () => ({ store: { capabilities: async () => ({ taskDependencies: true }) } }));
vi.mock("../ui/shell/launch.js", () => ({ openLaunchSheet: hooks.launch }));
vi.mock("../ui/shell/sections.js", () => ({ showSection: hooks.show }));
// @ts-expect-error plain ESM
import { createActiveTasks } from "../ui/sections/home/active-tasks.js";
// @ts-expect-error plain ESM
import { loadTaskSources, loadTaskDoc } from "../ui/shell/task-cache.js";
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
    body: new FakeNode(), createElement: (tag: string) => new FakeNode(tag.toUpperCase()), querySelector: () => null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }));
}


let serial = 0;
let items: Record<string, object[]>;
function setup() {
  stubDocument();
  vi.useFakeTimers();
  // Each mount uses distinct computers, as a real separate Hook/cache identity would.
  const computer = `Desk-${++serial}`;
  const state = { merged: { computers: [{ computer, state: "online" }, { computer: "offline", state: "offline" }] } };
  const scope = new FakeNode();
  const list = scope.querySelector(".home-list");
  const block = createActiveTasks({ state, block: () => scope });
  return { scope, list, block, state, computer };
}
beforeEach(() => {
  items = { phren: [], website: [] };
  hooks.show.mockReturnValue({ filterSection: hooks.filter });
  hooks.get.mockImplementation(async (_computer, route, query) => route === "/v1/tasks/stores"
    ? { stores: [{ id: "personal", primary: true, projects: ["phren", "website"] }] }
    : { revision: "revision", project: query.project, items: { Active: items[query.project], Queue: [{ line: "queued" }] } });
});
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const task = (n: number) => ({ id: `A${n}`, stableId: `task${n}`, line: `Task ${n}`, createdAt: `2026-10-${String(n).padStart(2, "0")}T12:00:00Z` });

it("orders Active tasks across projects and computers, caps six, and opens Active Tasks for overflow", async () => {
  items.phren = [task(2), task(6), task(4), { ...task(10), checked: true }];
  items.website = [task(1), task(7), task(3), task(5)];
  const { scope, list, block, state } = setup();
  const original = hooks.get.getMockImplementation()!;
  hooks.get.mockImplementation(async (computer, route, query) => {
    if (computer === "Laptop" && route === "/v1/tasks") return { items: { Active: query.project === "phren" ? [task(8)] : [] } };
    return original(computer, route, query);
  });
  state.merged.computers.push({ computer: "Laptop", state: "online" });
  block.show();
  await settle();
  expect(scope.hidden).toBe(false);
  expect(list.children.map((row) => row.children[0].children[0].textContent)).toEqual(["Task 8", "Task 7", "Task 6", "Task 5", "Task 4", "Task 3"]);
  const more = scope.children[0];
  expect(more.textContent).toBe("+2 more");
  more.listeners.get("click")!({});
  expect(hooks.show).toHaveBeenCalledWith("tasks");
  expect(hooks.filter).toHaveBeenCalledWith("Active");
  expect(hooks.get.mock.calls.some(([computer]) => computer === "offline")).toBe(false);
  block.hide();
});

it("launches the right task brief, preserves focused controls through polls and reordering, and shares reads for 60s", async () => {
  items.phren = [task(1), task(2)];
  const { list, block, state, computer } = setup();
  // Tasks and Home concurrently requesting the same store and projects.
  const tasksRead = loadTaskSources(state.merged.computers).then((sources: object[]) => Promise.all(
    sources.flatMap((source) => [loadTaskDoc(source, "phren"), loadTaskDoc(source, "website")])));
  block.show();
  await tasksRead;
  await settle();
  expect(hooks.get).toHaveBeenCalledTimes(3);
  const launch = list.children[0].children[1];
  launch.focus();
  launch.listeners.get("click")!({});
  expect(hooks.launch).toHaveBeenCalledWith({ project: "phren", computer, storeId: "personal", task: { stableId: "task2", expectedRevision: "revision" }, prompt: "Task 2", title: "Launch as agent" });
  block.hide(); block.show();
  await settle();
  await vi.advanceTimersByTimeAsync(59_999);
  expect(hooks.get).toHaveBeenCalledTimes(3);
  expect(list.children[0].children[1]).toBe(launch);
  expect(doc.activeElement).toBe(launch);
  items.phren = [task(1), task(2), task(3)];
  await vi.advanceTimersByTimeAsync(1);
  await settle();
  expect(hooks.get).toHaveBeenCalledTimes(6);
  expect(list.children[1].children[1]).toBe(launch);
  expect(doc.activeElement).toBe(launch);
  block.hide();
});

it("hides when empty and when the source goes offline, with no polling while hidden", async () => {
  const { scope, block, state } = setup();
  block.show(); await settle();
  expect(scope.hidden).toBe(true);
  expect(scope.children[0].hidden).toBe(true);
  items.phren = [task(1)];
  await vi.advanceTimersByTimeAsync(60_000); await settle();
  expect(scope.hidden).toBe(false);
  expect(scope.children[0].hidden).toBe(true);
  state.merged.computers[0].state = "offline";
  block.render();
  expect(scope.hidden).toBe(true);
  block.hide();
  const calls = hooks.get.mock.calls.length;
  await vi.advanceTimersByTimeAsync(120_000);
  expect(hooks.get).toHaveBeenCalledTimes(calls);
});

it("loads tasks when the first overview arrives after Home becomes visible and ignores late answers after hiding", async () => {
  items.phren = [task(1)];
  const { scope, list, block, state, computer } = setup();
  state.merged.computers = [];
  block.show(); await settle();
  expect(scope.hidden).toBe(true);
  expect(hooks.get).not.toHaveBeenCalled();
  state.merged.computers = [{ computer, state: "online" }];
  block.render(); await settle();
  expect(list.children).toHaveLength(1);
  expect(hooks.get).toHaveBeenCalledTimes(3);
  block.hide();
  let answer: (value: unknown) => void = () => {};
  hooks.get.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
  state.merged.computers = [{ computer: "late-answer", state: "online" }];
  block.show(); await settle(); block.hide();
  answer({ stores: [] }); await settle();
  expect(list.children).toHaveLength(1);
});

it("refreshes at the first 60s poll despite a delayed Hook response", async () => {
  items.phren = [task(1)];
  const { list, block } = setup();
  const original = hooks.get.getMockImplementation()!;
  hooks.get.mockImplementation(async (...args) => {
    const reply = await original(...args);
    await new Promise((resolve) => setTimeout(resolve, 500));
    return reply;
  });
  block.show();
  await vi.advanceTimersByTimeAsync(1_000);
  await settle();
  expect(list.children).toHaveLength(1);
  items.phren = [task(1), task(2)];
  await vi.advanceTimersByTimeAsync(59_000);
  await vi.advanceTimersByTimeAsync(1_000);
  await settle();
  expect(list.children.map((row) => row.children[0].children[0].textContent)).toEqual(["Task 2", "Task 1"]);
  expect(hooks.get).toHaveBeenCalledTimes(6);
  block.hide();
});
