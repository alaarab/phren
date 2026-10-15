import { afterEach, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  merged: { computers: [{ computer: "Desk", state: "online" }] } as { computers: Array<{ computer: string; state: string }> },
  live: null as null | { computer: string; child: Record<string, unknown> },
  inventory: null as null | ((value: unknown) => void),
  rows: [] as object[],
  load: async () => {},
  usage: null as null | ((snapshot: unknown) => void),
  openSwitch: vi.fn(async () => {}),
}));
vi.mock("../ui/api.js", () => ({
  hookGet: vi.fn((_computer: string, route: string) => route === "/v1/harnesses"
    ? new Promise((resolve) => { hooks.inventory = resolve; }) : new Promise(() => {})),
  hookPost: vi.fn(() => new Promise(() => {})),
}));
vi.mock("../ui/shell/store.js", () => ({
  store: { subscribe: (fn: (merged: unknown) => void) => { fn(hooks.merged); return () => {}; }, find: () => hooks.live },
  sessions: () => [], needsYou: () => [], projectOf: () => "project",
}));
vi.mock("../ui/shell/approvals.js", () => ({ approvals: { approval: () => null, answerKey: vi.fn(), subscribe: () => () => {} } }));
vi.mock("../ui/shell/ci-watch.js", () => ({ checksStrip: () => [], followChecks: () => () => {} }));
vi.mock("../ui/shell/away.js", () => ({ away: { current: () => null, subscribe: () => () => {}, dismiss: () => {} } }));
vi.mock("../ui/shell/usage-rings.js", () => ({ openUsage: vi.fn(), followUsage: (fn: (snapshot: unknown) => void) => { hooks.usage = fn; return () => { hooks.usage = null; }; } }));
vi.mock("../ui/shell/quota-warn-prefs.js", () => ({ loadQuotaState: () => hooks.load(), quotaSettings: () => ({ threshold: 90 }) }));
vi.mock("../ui/shell/quota-warn-sheet.js", () => ({ openQuotaSwitch: hooks.openSwitch }));
vi.mock("../ui/shell/home-usage.js", () => ({ runningLow: () => hooks.rows }));
vi.mock("../ui/shell/needs-notify.js", () => ({ sendReply: vi.fn() }));
// @ts-expect-error plain ESM without declarations
import { mountHome } from "../ui/sections/home.js";

// Only the DOM operations Home's mount and the Running low block use.
class Node {
  className = ""; textContent = ""; type = ""; title = ""; hidden = false; disabled = false;
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  classList = { add: (name: string) => { this.className += ` ${name}`; }, toggle: () => {} };
  listeners = new Map<string, (event: object) => unknown>();
  children: Node[] = [];
  selectors = new Map<string, Node>();
  append(...nodes: Node[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Node[]) { this.children = nodes; }
  setAttribute() {}
  focus() {}
  addEventListener(type: string, fn: (event: object) => unknown) { this.listeners.set(type, fn); }
  contains(node: unknown): boolean { return node === this || this.children.some((child) => child.contains(node)); }
  querySelectorAll(): Node[] { return []; }
  querySelector(selector: string): Node {
    if (!this.selectors.has(selector)) this.selectors.set(selector, new Node());
    return this.selectors.get(selector)!;
  }
  find(text: string): Node | undefined {
    return this.textContent === text ? this : this.children.map((child) => child.find(text)).find(Boolean);
  }
}

const child = { id: "chat", title: "Fix login", target: { source: "claude", session: "s1" } };
const row = { key: "Desk/chat", computer: "Desk", child, account: { name: "Claude", account: "Work" }, text: "92% of 5-hour · resets in 1h" };

afterEach(() => {
  vi.unstubAllGlobals(); vi.useRealTimers(); vi.clearAllMocks();
  hooks.rows = []; hooks.live = null; hooks.inventory = null; hooks.load = async () => {};
  hooks.merged.computers[0].state = "online";
});

function mount() {
  vi.useFakeTimers();
  const root = new Node();
  vi.stubGlobal("document", { activeElement: null, createElement: () => new Node(), querySelector: () => null, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  vi.stubGlobal("HTMLElement", Node);
  const home = mountHome(root);
  const low = root.querySelector('[data-block="low"]');
  return { home, low, list: low.querySelector(".home-list") };
}

it("keeps Running low hidden until preferences load, then hides it again when every chat has room", async () => {
  let loaded!: () => void;
  hooks.load = () => new Promise<void>((resolve) => { loaded = resolve; });
  hooks.rows = [row];
  const { home, low, list } = mount();
  try {
    home.show();
    hooks.usage!({ accounts: [] });
    // The default 90% threshold must not flash rows before the saved one is known.
    expect(low.hidden).toBe(true);
    loaded();
    await vi.advanceTimersByTimeAsync(0);
    expect(low.hidden).toBe(false);
    expect(list.find("Fix login")).toBeDefined();
    hooks.rows = [];
    hooks.usage!({ accounts: [] });
    expect(low.hidden).toBe(true);
  } finally { home.destroy(); }
});

it.each([
  ["closed", () => { hooks.live = null; }],
  ["replaced by another conversation", () => { hooks.live = { computer: "Desk", child: { ...child, target: { source: "claude", session: "s2" } } }; }],
  ["on a computer that went offline", () => { hooks.live = { computer: "Desk", child }; hooks.merged.computers[0].state = "offline"; }],
])("does not open Switch for a chat %s while the harness inventory loaded", async (_label, change) => {
  hooks.rows = [row];
  const { home, list } = mount();
  try {
    home.show();
    await vi.advanceTimersByTimeAsync(0);
    const button = list.find("Switch")!;
    const clicked = button.listeners.get("click")!({});
    expect(button.disabled).toBe(true);
    change();
    hooks.inventory!({ harnesses: [{ id: "codex" }] });
    await clicked;
    expect(hooks.openSwitch).not.toHaveBeenCalled();
    expect(button.disabled).toBe(false);
  } finally { home.destroy(); }
});

it("opens Switch for the live chat with the loaded inventory and current usage", async () => {
  hooks.rows = [row];
  const { home, list } = mount();
  try {
    home.show();
    await vi.advanceTimersByTimeAsync(0);
    const accounts = [{ id: "claude|work" }];
    hooks.usage!({ accounts });
    const live = { computer: "Desk", child: { ...child, title: "Fix login (renamed)" } };
    hooks.live = live;
    const clicked = list.find("Switch")!.listeners.get("click")!({});
    hooks.inventory!({ harnesses: [{ id: "codex" }] });
    await clicked;
    expect(hooks.openSwitch).toHaveBeenCalledExactlyOnceWith(live, [{ id: "codex" }], accounts, expect.objectContaining({ returnFocus: expect.any(Function) }));
  } finally { home.destroy(); }
});
