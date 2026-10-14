import { afterEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  post: vi.fn(),
  merged: { computers: [{ computer: "Desk", state: "online" }] },
  changed: (_merged: unknown) => {},
}));
vi.mock("../ui/api.js", () => ({ hookPost: hooks.post }));
vi.mock("../ui/shell/store.js", () => ({ store: {
  get merged() { return hooks.merged; },
  sessions: () => [],
  subscribe: (fn: typeof hooks.changed) => { hooks.changed = fn; fn(hooks.merged); return () => {}; },
} }));
// @ts-expect-error plain ESM without type declarations
import { mountSchedules } from "../ui/sections/schedules.js";

// Only DOM operations used to build schedule rows; preserve node identity as a browser does.
class Node {
  children: Node[] = [];
  textContent = "";
  className = "";
  listeners = new Map<string, () => void>();
  append(...nodes: Node[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Node[]) { this.children = nodes; }
  addEventListener(event: string, fn: () => void) { this.listeners.set(event, fn); }
  find(text: string): Node | undefined {
    return this.textContent === text ? this : this.children.map((child) => child.find(text)).find(Boolean);
  }
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); hooks.post.mockReset(); });

function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-14T01:00:00Z"));
  hooks.merged.computers[0].state = "online";
  const nodes = new Map<string, Node>();
  const root = { querySelector: (selector: string) => {
    if (!nodes.has(selector)) nodes.set(selector, new Node());
    return nodes.get(selector);
  } };
  vi.stubGlobal("document", {
    querySelector: () => ({}), createElement: () => new Node(),
    createTextNode: (text: string) => Object.assign(new Node(), { textContent: text }),
  });
  const schedule = {
    id: "sweep", project: "phren", name: "Sweep", computer: "Desk", owned: true,
    enabled: true, every: "daily", at: "07:30", harness: "claude", updatedAt: "2026-10-14T01:00:00Z",
    nextRun: "2026-10-14T01:05:00Z",
  };
  hooks.post.mockImplementation(async () => ({ schedules: [{ ...schedule }] }));
  const handle = mountSchedules(root);
  handle.show();
  return { nodes, schedule, handle };
}

describe("Schedules list refresh", () => {
  it("keeps Edit attached across identical polls, manual refreshes and overview ticks", async () => {
    const { nodes, handle } = setup();
    await vi.advanceTimersByTimeAsync(0);
    const list = nodes.get("[data-list]")!;
    const edit = list.find("Edit");
    expect(edit).toBeDefined();
    expect(list.find("in 5m")).toBeDefined();
    const reads = hooks.post.mock.calls.length;
    hooks.changed(hooks.merged);
    await vi.advanceTimersByTimeAsync(0);
    expect(hooks.post).toHaveBeenCalledTimes(reads);
    await vi.advanceTimersByTimeAsync(60_000);
    nodes.get("[data-refresh]")!.listeners.get("click")!();
    await vi.advanceTimersByTimeAsync(0);
    expect(hooks.post.mock.calls.length).toBeGreaterThan(reads);
    expect(list.find("Edit")).toBe(edit);
    expect(list.find("in 4m")).toBeDefined();
    handle.destroy();
  });

  it.each(["name", "enabled", "runtime", "removed", "offline"])("updates the list when %s changes", async (kind) => {
    const { nodes, schedule, handle } = setup();
    await vi.advanceTimersByTimeAsync(0);
    const list = nodes.get("[data-list]")!;
    const edit = list.find("Edit");
    if (kind === "name") schedule.name = "New name";
    if (kind === "enabled") schedule.enabled = false;
    if (kind === "runtime") hooks.post.mockResolvedValue({ schedules: [{ ...schedule, running: true }] });
    if (kind === "removed") hooks.post.mockResolvedValue({ schedules: [] });
    if (kind === "offline") { hooks.merged.computers[0].state = "offline"; hooks.changed(hooks.merged); }
    await vi.advanceTimersByTimeAsync(30_000);
    expect(list.find("Edit")).not.toBe(edit);
    if (kind === "name") expect(list.find("New name")).toBeDefined();
    if (kind === "enabled") expect(list.find("Resume")).toBeDefined();
    if (kind === "runtime") expect(list.find("running")).toBeDefined();
    if (kind === "removed" || kind === "offline") expect(list.find("Edit")).toBeUndefined();
    handle.destroy();
  });
});
