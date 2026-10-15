import { afterEach, describe, expect, it, vi } from "vitest";
import { moveAccounts, moveChoices, moveStatus, openMoveSheet } from "../ui/shell/move.js";

import { hookGet, hookPost } from "../ui/api.js";
vi.mock("../ui/api.js", () => ({ hookGet: vi.fn(), hookPost: vi.fn() }));
const hooks = vi.hoisted(() => ({ caps: {} as { moveNewChat?: boolean }, rows: [] as Array<{ computer: string; child: object }>, open: vi.fn() }));
vi.mock("../ui/shell/store.js", () => ({ store: { capabilities: async () => hooks.caps, sessions: () => hooks.rows } }));
vi.mock("../ui/shell/sections.js", async (original) => ({ ...await original<object>(), showSection: vi.fn(), sectionHandle: () => ({ openSession: hooks.open }) }));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.clearAllMocks(); hooks.caps = {}; hooks.rows = []; });

const inventory = [
  { source: "claude", installed: true, usable: true, accounts: [{ id: "default", usable: true }, { id: "work", label: "Work", usable: true }, { id: "old", usable: false }] },
  { source: "codex", installed: true, usable: true },
  { source: "opencode", installed: false, usable: false, reason: "Not installed" },
];

describe("continue in another agent", () => {
  it("offers the other harnesses, disabling ones the computer cannot run", () => {
    expect(moveChoices(inventory, "claude").map((c) => [c.source, c.usable, c.reason])).toEqual([
      ["codex", true, ""], ["opencode", false, "Not installed"], ["copilot", false, "Not installed"],
    ]);
    expect(moveChoices(null, "codex").every((c) => c.usable)).toBe(true);
  });

  it("lists usable Claude accounts other than the default", () => {
    expect(moveAccounts(inventory).map((a) => a.id)).toEqual(["work"]);
  });

  it("offers Claude again only for a different usable account, including a return to default", () => {
    expect(moveChoices(inventory, "claude", "work").find((c) => c.source === "claude")?.usable).toBe(true);
    expect(moveAccounts(inventory, { includeDefault: true }).map((a) => a.id)).toEqual(["default", "work"]);
    expect(moveChoices([{ source: "claude", installed: true, usable: true, accounts: [{ id: "work", usable: true }] }], "claude", "work").some((c) => c.source === "claude")).toBe(false);
  });

  it("words each move state", () => {
    expect(moveStatus({ state: "handing-off" })).toBe("Writing a hand-off…");
    expect(moveStatus({ state: "moved", handoff: { source: "fallback" } })).toBe("Moved (Phren wrote the hand-off from the transcript)");
    expect(moveStatus({ state: "failed", error: "pane closed" })).toBe("The move failed: pane closed");
  });
});


// Minimal DOM behavior for modal keyboard tests, including disabled focus and ancestry.
type KeyEvent = { key: string; shiftKey: boolean; preventDefault: ReturnType<typeof vi.fn>; stopPropagation: ReturnType<typeof vi.fn> };
class Node {
  children: Node[] = [];
  parent: Node | null = null;
  textContent = "";
  className = "";
  disabled = false;
  hidden = false;
  tagName: string;
  style: Record<string, string> = {};
  listeners = new Map<string, (event?: KeyEvent) => void>();
  constructor(tag = "div") { this.tagName = tag.toUpperCase(); }
  append(...children: Node[]) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren(...children: Node[]) { for (const child of this.children) child.parent = null; this.children = []; this.append(...children); }
  setAttribute() {}
  addEventListener(event: string, fn: (event?: KeyEvent) => void) { this.listeners.set(event, fn); }
  focus() { if (!this.disabled) { dom.activeElement = this; dom.listeners.get("focusin")?.(); } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = null; }
  get isConnected(): boolean { return this === dom.body || !!this.parent?.isConnected; }
  contains(node: Node): boolean { return node === this || this.children.some((child) => child.contains(node)); }
  closest(): Node | null { return this.hidden ? this : this.parent?.closest() ?? null; }
  querySelectorAll(): Node[] {
    return this.children.flatMap((child) => [
      ...(["BUTTON", "SELECT", "INPUT", "TEXTAREA"].includes(child.tagName) && !child.disabled ? [child] : []),
      ...child.querySelectorAll(),
    ]);
  }
  find(text: string): Node | undefined { return this.textContent === text ? this : this.children.map((n) => n.find(text)).find(Boolean); }
}
let dom: ReturnType<typeof setupDom>;
function setupDom() {
  const body = new Node("body");
  const doc = {
    body, activeElement: body, listeners: new Map<string, (event?: KeyEvent) => void>(),
    getElementById: () => ({}), createElement: (tag: string) => new Node(tag),
    addEventListener(type: string, fn: (event?: KeyEvent) => void) { this.listeners.set(type, fn); },
    removeEventListener(type: string, fn: (event?: KeyEvent) => void) { if (this.listeners.get(type) === fn) this.listeners.delete(type); },
  };
  dom = doc;
  vi.stubGlobal("document", doc);
  return doc;
}
function press(key: string, shiftKey = false) {
  const event = { key, shiftKey, preventDefault: vi.fn(), stopPropagation: vi.fn() };
  dom.listeners.get("keydown")?.(event);
  return event;
}

it("leaves Continue in unselected when no destination has room, until the user chooses", async () => {
  const { body } = setupDom();
  vi.mocked(hookGet).mockResolvedValue({ harnesses: inventory });
  await openMoveSheet({ computer: "Desk", child: { target: { source: "claude" } }, selectDefault: false, notice: "No account has room." });
  expect(body.find("No account has room.")).toBeDefined();
  expect(body.find("Continue")?.disabled).toBe(true);
  expect(body.find("Codex")?.className).not.toContain("selected");
  body.find("Codex")!.listeners.get("click")!();
  expect(body.find("Continue")?.disabled).toBe(false);
  expect(body.find("Codex")?.className).toContain("selected");
});


it.each([
  ["codex", true, "new-chat"], ["codex", false, undefined], ["claude", true, undefined],
])("sends the correct move mode for %s with capability %s and opens a landed new chat", async (harness, capability, mode) => {
  vi.useFakeTimers();
  hooks.caps = { moveNewChat: capability };
  const { body } = setupDom();
  const target = { server: "tmux", workspace: "w", tab: "old", pane: "old", source: "claude", session: "old" };
  const next = { ...target, tab: "new", pane: "new", source: harness, session: "new" };
  const oldChild = { title: "Original", account: { id: "work" }, target };
  hooks.rows = [{ computer: "Desk", child: oldChild }];
  vi.mocked(hookGet).mockImplementation(async (_computer, route) => route === "/v1/harnesses" ? { harnesses: inventory } : { move: { state: "moved", target: next } });
  vi.mocked(hookPost).mockResolvedValue({ move: { id: "move-id", state: "handing-off" } });
  await openMoveSheet({ computer: "Desk", child: oldChild, to: { harness, ...(harness === "claude" ? { account: "default" } : {}) } });
  const expectedLabel = harness === "claude" ? "Continues here on default" : capability ? "Opens a new Codex chat with a hand-off" : "Replaces this chat with Codex (update the Hook for a new chat)";
  expect(body.find(expectedLabel)).toBeDefined();
  await body.find("Continue")!.listeners.get("click")!();
  await vi.advanceTimersByTimeAsync(0);
  const request = vi.mocked(hookPost).mock.calls[0][2];
  if (mode) expect(request).toMatchObject({ mode: "new-chat", target, to: { harness } });
  else expect(request).not.toHaveProperty("mode");
  expect(hooks.open).not.toHaveBeenCalled();
  if (mode) {
    const nextChild = { title: "New", target: next, handedOffFrom: { target, title: "Original" } };
    hooks.rows.push({ computer: "Desk", child: nextChild });
    await vi.advanceTimersByTimeAsync(2000);
    expect(hooks.open).toHaveBeenCalledWith("Desk", nextChild);
    expect(hooks.rows[0].child).toBe(oldChild);
  }
});


it("focuses an enabled control while loading, traps focus after rendering and restores Switch on Escape", async () => {
  const { body } = setupDom();
  const change = new Node("button");
  change.textContent = "Switch";
  body.append(change);
  change.focus();
  let resolveInventory!: (value: { harnesses: typeof inventory }) => void;
  vi.mocked(hookGet).mockImplementation(() => new Promise((resolve) => { resolveInventory = resolve; }));
  const opening = openMoveSheet({ computer: "Desk", child: { target: { source: "claude" } }, selectDefault: false });
  const close = body.find("×")!;
  expect(dom.activeElement).toBe(close);
  expect(body.find("Continue")?.disabled).toBe(true);
  resolveInventory({ harnesses: inventory });
  await opening;
  expect(press("Tab", true).preventDefault).toHaveBeenCalled();
  expect(dom.activeElement).toBe(body.find("Codex"));
  expect(press("Tab").preventDefault).toHaveBeenCalled();
  expect(dom.activeElement).toBe(close);
  change.focus();
  expect(dom.activeElement).toBe(close);
  body.find("Codex")!.listeners.get("click")!();
  body.find("Continue")!.focus();
  expect(press("Tab").preventDefault).toHaveBeenCalled();
  expect(dom.activeElement).toBe(close);
  body.find("Codex")!.focus();
  expect(press("Escape").stopPropagation).toHaveBeenCalled();
  expect(body.find("Continue")).toBeUndefined();
  expect(dom.activeElement).toBe(change);
  expect(dom.listeners.size).toBe(0);
});

it("restores the current Switch control when an overview refresh replaced the invoker", async () => {
  const { body } = setupDom();
  let change = new Node("button");
  body.append(change);
  change.focus();
  vi.mocked(hookGet).mockResolvedValue({ harnesses: inventory });
  await openMoveSheet({ computer: "Desk", child: { target: { source: "claude" } }, returnFocus: () => change.focus() });
  change.remove();
  change = new Node("button");
  body.append(change);
  body.find("×")!.listeners.get("click")!();
  expect(dom.activeElement).toBe(change);
  expect(dom.listeners.size).toBe(0);
});
