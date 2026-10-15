import { afterEach, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  get: vi.fn(async () => ({ dispatches: [] })), post: vi.fn(async () => ({ schedules: [] })),
  showSection: vi.fn(),
  merged: { computers: [{ computer: "Desk", state: "online" }, { computer: "Laptop", state: "online" }] },
  publish: null as null | ((value: unknown) => void),
}));
vi.mock("../ui/api.js", () => ({
  hookGet: hooks.get,
  hookPost: hooks.post,
}));
vi.mock("../ui/shell/store.js", async (importOriginal) => ({
  ...await importOriginal<object>(),
  store: { subscribe: (fn: (value: unknown) => void) => { hooks.publish = fn; fn(hooks.merged); return () => {}; }, find: () => null },
  needsYou: () => [],
}));
vi.mock("../ui/shell/sections.js", () => ({ showSection: hooks.showSection }));
vi.mock("../ui/shell/approvals.js", () => ({ approvals: { approval: () => null, answerKey: vi.fn(), subscribe: () => () => {} } }));
vi.mock("../ui/shell/ci-watch.js", () => ({ checksStrip: () => [], followChecks: () => () => {} }));
vi.mock("../ui/shell/away.js", () => ({ away: { current: () => null, subscribe: () => () => {}, dismiss: () => {} } }));
vi.mock("../ui/shell/usage-rings.js", () => ({ openUsage: vi.fn(), followUsage: () => () => {} }));
vi.mock("../ui/shell/quota-warn-prefs.js", () => ({ loadQuotaState: async () => {}, quotaSettings: () => ({ threshold: 90 }) }));
vi.mock("../ui/shell/quota-warn-sheet.js", () => ({ openQuotaSwitch: vi.fn() }));
vi.mock("../ui/shell/needs-notify.js", () => ({ sendReply: vi.fn() }));
// @ts-expect-error plain ESM without declarations
import { mountHome } from "../ui/sections/home.js";

// Home's mount needs only these DOM operations. Focus follows the DOM's rule:
// replacing a list's children blurs a focused child, even one put back.
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

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); doc.activeElement = null; });

function stubDocument() {
  vi.stubGlobal("HTMLElement", FakeNode);
  vi.stubGlobal("document", Object.assign(doc, {
    body: new FakeNode(), createElement: (tag: string) => new FakeNode(tag.toUpperCase()), querySelector: () => null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }));
}

const pane = { server: "default", workspace: "1", pane: "1" };
const child = { id: "chat", title: "Build app", target: { ...pane, session: "chat" } };
const job = (pid: number, cpuPercent: number, extra: object = {}) => ({ pid, name: `Job ${pid}`, cpuPercent, ...extra });
function publish(heavy: object[], extraComputers: object[] = []) {
  hooks.publish!({ computers: [{ computer: "Desk", state: "online", resources: { heavy }, overview: { groups: [{ children: [child] }] } }, ...extraComputers] });
}
function setup() {
  stubDocument();
  const root = new FakeNode();
  const list = root.querySelector('[data-block="computers"]').querySelector(".home-list");
  const openSession = vi.fn();
  const home = mountHome(root, { openSession });
  return { list, home, openSession };
}
const jobsOf = (list: FakeNode, index = 0) => list.children[index].children[1];

it("shows the three highest CPU jobs, overflow and observed time from overview data without reads", () => {
  vi.useFakeTimers();
  const { list, home } = setup();
  try {
    publish([job(1, 10), job(2, 180.25, { name: "xcodebuild" }), job(3, 80), job(4, 50), job(5, 20)]);
    const jobs = jobsOf(list);
    expect(jobs.children.map((row) => row.children[0]?.textContent ?? row.textContent)).toEqual(["xcodebuild", "Job 3", "Job 4", "+2 more"]);
    expect(jobs.children[0].children[1].textContent).toBe("180.3% CPU");
    vi.advanceTimersByTime(180_000);
    publish([job(2, 160, { name: "xcodebuild" })]);
    expect(jobs.children[0].children[2].textContent).toBe("3m observed");
    expect(jobs.children[0].children[2].title).toContain("process start time is unavailable");
    publish([]);
    expect(jobs.hidden).toBe(true);
    expect(jobs.children).toHaveLength(0);
    publish([job(2, 60)]);
    expect(jobs.hidden).toBe(false);
    expect(jobs.children[0].children[2].textContent).toBe("now observed");
    expect(hooks.get).not.toHaveBeenCalled();
    expect(hooks.post).not.toHaveBeenCalled();
  } finally { home.destroy(); vi.useRealTimers(); }
});

it("opens only the attributed session on the matching computer and explains unavailable panes", () => {
  const { list, home, openSession } = setup();
  try {
    publish([job(1, 100, { pane }), job(2, 80), job(3, 60, { pane: { ...pane, workspace: "other" } })], [
      { computer: "Laptop", state: "online", resources: { heavy: [job(1, 100, { pane })] }, overview: { groups: [] } },
    ]);
    const [linked, unowned, gone] = jobsOf(list).children;
    expect(linked.tagName).toBe("BUTTON");
    linked.listeners.get("click")!({});
    expect(openSession).toHaveBeenCalledWith("Desk", child);
    expect(unowned.tagName).toBe("DIV");
    expect(unowned.listeners.has("click")).toBe(false);
    expect(unowned.title).toContain("No starting pane");
    expect(gone.tagName).toBe("DIV");
    expect(gone.title).toContain("no known session");
    expect(jobsOf(list, 1).children[0].tagName).toBe("DIV");
    const replacement = { ...child, id: "replacement", title: "New chat" };
    hooks.publish!({ computers: [{ computer: "Desk", state: "online", resources: { heavy: [job(1, 100, { pane })] }, overview: { groups: [{ children: [replacement] }] } }] });
    jobsOf(list).children[0].listeners.get("click")!({});
    expect(openSession).toHaveBeenLastCalledWith("Desk", replacement);
  } finally { home.destroy(); }
});

it("preserves keyed computer and job controls and focus through resource updates and reordering", () => {
  const { list, home } = setup();
  try {
    publish([job(1, 100, { pane }), job(2, 60)]);
    const computer = list.children[0];
    const jobs = jobsOf(list);
    const linked = jobs.children[0];
    linked.focus();
    publish([job(1, 110, { pane }), job(2, 60)]);
    expect(list.children[0]).toBe(computer);
    expect(jobs.children[0]).toBe(linked);
    expect(doc.activeElement).toBe(linked);
    publish([job(1, 50, { pane }), job(2, 90)]);
    expect(jobs.children[1]).toBe(linked);
    expect(doc.activeElement).toBe(linked);
    publish([job(2, 90)]);
    expect(jobs.children).toHaveLength(1);
    expect(doc.activeElement).toBeNull();
  } finally { home.destroy(); }
});
