import { afterEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  get: vi.fn(), move: vi.fn(),
  usage: (_value: unknown) => {}, overview: () => {}, section: () => {},
}));
vi.mock("../ui/api.js", () => ({ hookGet: hooks.get }));
vi.mock("../ui/shell/store.js", () => ({ store: { subscribe: (fn: () => void) => { hooks.overview = fn; return () => {}; } } }));
vi.mock("../ui/shell/sections.js", () => ({ onSectionChange: (fn: () => void) => { hooks.section = fn; } }));
vi.mock("../ui/shell/usage-rings.js", async (original) => ({ ...await original<object>(), followUsage: (fn: typeof hooks.usage) => { hooks.usage = fn; return () => {}; } }));
vi.mock("../ui/shell/move.js", async (original) => ({ ...await original<object>(), openMoveSheet: hooks.move }));

class Node {
  children: Node[] = [];
  dataset: Record<string, string> = {};
  textContent = "";
  className = "";
  disabled = false;
  removed = false;
  listeners = new Map<string, () => void>();
  append(...nodes: Node[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Node[]) { this.children = nodes; }
  setAttribute() {}
  addEventListener(event: string, fn: () => void) { this.listeners.set(event, fn); }
  remove() { this.removed = true; }
  find(text: string): Node | undefined { return this.textContent === text ? this : this.children.map((n) => n.find(text)).find(Boolean); }
  click() { if (!this.disabled) this.listeners.get("click")?.(); }
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); hooks.get.mockReset(); hooks.move.mockReset(); });

async function setup(pending = false, saved = { settings: { on: true, threshold: 90 }, suppressed: [] as string[], seen: [] as string[] }) {
  vi.resetModules();
  // @ts-expect-error plain ESM without declarations
  const { watchQuotaWarnings } = await import("../ui/shell/quota-warn-sheet.js");
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
  const body = new Node();
  vi.stubGlobal("document", { body, head: new Node(), createElement: () => new Node(), getElementById: () => ({}), querySelector: () => null });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => saved })));
  let session: object | null = { interactionsPending: pending, computer: "Desk", child: { id: "tab", account: { id: "work" }, target: { source: "claude", session: "chat" } } };
  hooks.get.mockResolvedValue({ harnesses: [
    { source: "claude", installed: true, usable: true, accounts: [{ id: "work", usable: true }, { id: "default", usable: true, label: "Personal" }] },
    { source: "codex", installed: true, usable: true },
  ] });
  const usage = { accounts: [
    { id: "work", name: "Claude", harness: "claude", computers: [{ name: "Desk", account: "work" }], windows: [{ id: "five_hour", usedPercent: 92, resetsAt: "2026-10-14T13:20:00Z" }] },
    { id: "personal", harness: "claude", computers: [{ name: "Desk", account: "default" }], windows: [{ id: "five_hour", usedPercent: 10 }] },
    { id: "codex", harness: "codex", exhausted: true, computers: [{ name: "Desk" }], windows: [{ id: "codex:primary", exhausted: true }] },
  ] };
  const watcher = watchQuotaWarnings(() => session);
  hooks.usage(usage);
  const sheets = () => body.children.filter((n) => !n.removed);
  return { usage, watcher, sheets, recreate: watchQuotaWarnings, setPending: (value: boolean) => { Object.assign(session!, { interactionsPending: value }); hooks.overview(); }, setSession: (next: object | null) => { session = next; } };
}

describe("quota sheet lifecycle", () => {
  it("shows reset and remaining usage, and opens the existing hand-off on the roomiest account", async () => {
    const ui = await setup();
    await vi.advanceTimersByTimeAsync(0);
    const sheet = ui.sheets()[0];
    expect(sheet.find("Claude is at 92% of its 5-hour limit")).toBeDefined();
    expect(sheet.find("resets in 1h 20m")).toBeDefined();
    expect(sheet.find("Claude · Personal · 90% remaining")).toBeDefined();
    expect(sheet.find("Codex · Exhausted")).toBeDefined();
    sheet.find("Switch")!.click();
    expect(hooks.move).toHaveBeenCalledWith(expect.objectContaining({ to: { harness: "claude", account: "default" } }));
    expect(ui.sheets()).toHaveLength(0);
  });

  it("dismisses until exhaustion, then persists the chat opt-out across watcher recreation", async () => {
    const ui = await setup();
    await vi.advanceTimersByTimeAsync(0);
    ui.sheets()[0].find("Not now")!.click();
    await ui.watcher.check();
    expect(ui.sheets()).toHaveLength(0);
    ui.usage.accounts[0].windows[0].usedPercent = 100;
    hooks.usage(ui.usage);
    await vi.advanceTimersByTimeAsync(0);
    ui.sheets()[0].find("Don't ask again for this chat")!.click();
    ui.usage.accounts[0].windows[0].resetsAt = "2026-10-14T20:00:00Z";
    ui.recreate(() => ({ computer: "Desk", child: { id: "new-tab", account: { id: "work" }, target: { source: "claude", session: "chat" } } }));
    hooks.usage(ui.usage);
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.sheets()).toHaveLength(0);
  });

  it("replaces an open near-limit notice at exhaustion and closes it when the window resets", async () => {
    const ui = await setup();
    await vi.advanceTimersByTimeAsync(0);
    const near = ui.sheets()[0];
    ui.usage.accounts[0].windows[0].usedPercent = 100;
    hooks.usage(ui.usage);
    await vi.advanceTimersByTimeAsync(0);
    expect(near.removed).toBe(true);
    expect(ui.sheets()[0].find("Claude is at 100% of its 5-hour limit")).toBeDefined();
    vi.setSystemTime(new Date("2026-10-14T14:00:00Z"));
    await ui.watcher.check();
    expect(ui.sheets()).toHaveLength(0);
  });

  it("recomputes Switch from the latest usage and falls back without selecting an exhausted destination", async () => {
    const ui = await setup();
    await vi.advanceTimersByTimeAsync(0);
    const button = ui.sheets()[0].find("Switch")!;
    ui.usage.accounts[1].windows[0].usedPercent = 100;
    ui.usage.accounts[2].exhausted = false;
    ui.usage.accounts[2].windows = [{ id: "codex:primary", usedPercent: 30 }];
    hooks.usage(ui.usage);
    await vi.advanceTimersByTimeAsync(0);
    button.click();
    expect(hooks.move).toHaveBeenLastCalledWith(expect.objectContaining({ to: { harness: "codex" } }));
  });

  it("opens Continue in with no preselection and an explanation when no destination has room", async () => {
    const ui = await setup();
    await vi.advanceTimersByTimeAsync(0);
    Object.assign(ui.usage.accounts[1], { exhausted: true });
    hooks.usage(ui.usage);
    await vi.advanceTimersByTimeAsync(0);
    ui.sheets()[0].find("Switch")!.click();
    expect(hooks.move).toHaveBeenCalledWith(expect.objectContaining({ to: undefined, selectDefault: false, notice: "No other account or harness has known room. Choose where to continue." }));
  });

  it("prioritises weekly exhaustion over an open 5-hour threshold warning", async () => {
    const ui = await setup();
    await vi.advanceTimersByTimeAsync(0);
    ui.usage.accounts[0].windows.push({ id: "seven_day", usedPercent: 100, resetsAt: "2026-10-15T12:00:00Z" });
    hooks.usage(ui.usage);
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.sheets()).toHaveLength(1);
    expect(ui.sheets()[0].find("Claude is at 100% of its weekly limit")).toBeDefined();
  });

  it("defers for interaction cards and reopens an interrupted notice after they clear", async () => {
    const ui = await setup(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.sheets()).toHaveLength(0);
    ui.setPending(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.sheets()).toHaveLength(1);
    ui.setPending(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.sheets()).toHaveLength(0);
    ui.setPending(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.sheets()).toHaveLength(1);
  });

  it("hydrates saved preferences before considering a high-usage chat", async () => {
    const ui = await setup(false, { settings: { on: true, threshold: 95 }, suppressed: [], seen: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.sheets()).toHaveLength(0);
    ui.usage.accounts[0].windows[0].usedPercent = 95;
    hooks.usage(ui.usage);
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.sheets()).toHaveLength(1);
  });

  it("discards an inventory response after leaving the chat without consuming the warning", async () => {
    const ui = await setup();
    ui.setSession(null);
    hooks.section();
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.sheets()).toHaveLength(0);
    ui.setSession({ computer: "Desk", child: { id: "tab", account: { id: "work" }, target: { source: "claude", session: "chat" } } });
    await ui.watcher.check();
    expect(ui.sheets()).toHaveLength(1);
    ui.setSession(null);
    hooks.overview();
    expect(ui.sheets()).toHaveLength(0);
  });
});
