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
// @ts-expect-error plain ESM without declarations
import { watchQuotaWarnings } from "../ui/shell/quota-warn-sheet.js";

class Node {
  children: Node[] = [];
  dataset: Record<string, string> = {};
  textContent = "";
  className = "";
  disabled = false;
  removed = false;
  listeners = new Map<string, () => void>();
  append(...nodes: Node[]) { this.children.push(...nodes); }
  setAttribute() {}
  addEventListener(event: string, fn: () => void) { this.listeners.set(event, fn); }
  remove() { this.removed = true; }
  find(text: string): Node | undefined { return this.textContent === text ? this : this.children.map((n) => n.find(text)).find(Boolean); }
  click() { if (!this.disabled) this.listeners.get("click")?.(); }
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); hooks.get.mockReset(); hooks.move.mockReset(); });

function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
  const body = new Node();
  vi.stubGlobal("document", { body, head: new Node(), createElement: () => new Node(), getElementById: () => ({}), querySelector: () => null });
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => data.get(k) ?? (k.endsWith("-chats") || k.endsWith("-seen") ? "[]" : "{}"), setItem: (k: string, v: string) => data.set(k, v) });
  let session: object | null = { computer: "Desk", child: { id: "tab", account: { id: "work" }, target: { source: "claude", session: "chat" } } };
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
  return { usage, watcher, sheets, setSession: (next: object | null) => { session = next; } };
}

describe("quota sheet lifecycle", () => {
  it("shows reset and remaining usage, and opens the existing hand-off on the roomiest account", async () => {
    const ui = setup();
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
    const ui = setup();
    await vi.advanceTimersByTimeAsync(0);
    ui.sheets()[0].find("Not now")!.click();
    await ui.watcher.check();
    expect(ui.sheets()).toHaveLength(0);
    ui.usage.accounts[0].windows[0].usedPercent = 100;
    hooks.usage(ui.usage);
    await vi.advanceTimersByTimeAsync(0);
    ui.sheets()[0].find("Don't ask again for this chat")!.click();
    ui.usage.accounts[0].windows[0].resetsAt = "2026-10-14T20:00:00Z";
    watchQuotaWarnings(() => ({ computer: "Desk", child: { id: "new-tab", account: { id: "work" }, target: { source: "claude", session: "chat" } } }));
    hooks.usage(ui.usage);
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.sheets()).toHaveLength(0);
  });

  it("replaces an open near-limit notice at exhaustion and closes it when the window resets", async () => {
    const ui = setup();
    await vi.advanceTimersByTimeAsync(0);
    const near = ui.sheets()[0];
    ui.usage.accounts[0].windows[0].usedPercent = 100;
    hooks.usage(ui.usage);
    await vi.advanceTimersByTimeAsync(0);
    expect(near.removed).toBe(true);
    expect(ui.sheets()[0].find("Claude is at 100% of its 5-hour limit")).toBeDefined();
    vi.setSystemTime(new Date("2026-10-14T14:00:00Z"));
    hooks.overview();
    expect(ui.sheets()).toHaveLength(0);
  });

  it("discards an inventory response after leaving the chat without consuming the warning", async () => {
    const ui = setup();
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
