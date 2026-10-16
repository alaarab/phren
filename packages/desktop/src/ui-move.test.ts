import { afterEach, describe, expect, it, vi } from "vitest";
import { moveAccounts, moveChoices, moveStatus, openMoveSheet } from "../ui/shell/move.js";

import { hookGet, hookPost } from "../ui/api.js";
vi.mock("../ui/api.js", () => ({ hookGet: vi.fn(), hookPost: vi.fn() }));
const hooks = vi.hoisted(() => ({ caps: {} as { moveNewChat?: boolean; moveToComputer?: boolean; moveConductorToComputer?: boolean; claudeAccountAdd?: boolean }, capsFor: {} as Record<string, object>, rows: [] as Array<{ computer: string; child: object }>, open: vi.fn(), pane: vi.fn() }));
vi.mock("../ui/shell/store.js", () => ({ projectOf: (child: { cwd?: string }) => child.cwd?.split("/").pop() ?? "", store: { capabilities: async (computer: string) => hooks.capsFor[computer] ?? hooks.caps, sessions: () => hooks.rows } }));
vi.mock("../ui/shell/sections.js", async (original) => ({ ...await original<object>(), showSection: vi.fn(), sectionHandle: () => ({ openSession: hooks.open, openPane: hooks.pane }) }));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.clearAllMocks(); hooks.caps = {}; hooks.capsFor = {}; hooks.rows = []; });

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
  dataset: Record<string, string> = {};
  value = "";
  classList = { toggle: (name: string, on: boolean) => { this.className = this.className.split(" ").filter((c) => c !== name).concat(on ? [name] : []).join(" "); }, add: (name: string) => { this.className += ` ${name}`; } };
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
  querySelectorAll(selector = ""): Node[] {
    return this.children.flatMap((child) => [
      ...(["BUTTON", "SELECT", "INPUT", "TEXTAREA"].includes(child.tagName) && (!selector.includes(":disabled") || !child.disabled) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
  find(text: string): Node | undefined { return this.textContent === text ? this : this.children.map((n) => n.find(text)).find(Boolean); }
}
let dom: ReturnType<typeof setupDom>;
function setupDom() {
  const body = new Node("body");
  const doc = {
    body, activeElement: body, listeners: new Map<string, (event?: KeyEvent) => void>(),
    getElementById: () => ({}), createTextNode: (text: string) => { const node = new Node("text"); node.textContent = text; return node; }, createElement: (tag: string) => new Node(tag),
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

const peers = { localClaudeLogins: 1, computers: [
  { name: "Desk", self: true, online: true, hasCheckout: true, harnesses: [{ source: "claude", usable: true, accounts: [
    { id: "default", email: "current@example.com", label: "Current", plan: "Pro", usable: true, current: true },
    { id: "work", email: "local@example.com", label: "Work", plan: "Max", usable: true, current: false },
  ] }, { source: "codex", usable: true }] },
  { name: "Studio", self: false, online: true, hasCheckout: true, harnesses: [{ source: "claude", usable: true, accounts: [
    { id: "work", label: "Work", email: "work@example.com", plan: "Max", usable: true, current: false, fiveHourLeft: 62, weekLeft: 35, fiveHourResetsAt: "2026-10-17T01:00:00Z" },
    { id: "personal", label: "Personal", plan: "Pro", usable: false, current: false, fiveHourLeft: 80 },
  ] }] },
  { name: "Laptop", self: false, online: false, hasCheckout: true, harnesses: [{ source: "claude", usable: true, accounts: [{ id: "laptop", label: "Laptop account", usable: true }] }] },
  { name: "No checkout", self: false, online: true, hasCheckout: false, harnesses: [{ source: "codex", usable: true }] },
] };
const localLabel = "local@example.com · Max · Desk · 5h unknown · week unknown";
const remoteLabel = "work@example.com · Max · Studio · 5h 62% · week 35% · 5h resets 2026-10-17T01:00:00Z";
function remoteInventory(result = peers) {
  vi.mocked(hookGet).mockImplementation(async (_computer, route) => {
    if (route === "/v1/harnesses") return { harnesses: inventory };
    if (route === "/v1/projects/repos") return { repos: [
      { name: "wrong", directory: "/repo/project-extra", registered: true },
      { name: "unregistered", directory: "/repo/project/src", registered: false },
      { name: "registered-name", directory: "/repo/project", registered: true },
    ] };
    return result;
  });
}
const session = { project: "phren", target: { source: "claude", session: "old" } };

it("retains local behavior without moveToComputer and performs no project or peer reads", async () => {
  const { body } = setupDom(); remoteInventory();
  await openMoveSheet({ computer: "Desk", child: session });
  expect(hookGet).toHaveBeenCalledTimes(1);
  expect(body.find("Claude accounts")?.closest()).not.toBeNull();
  expect(body.find("phren bridge accounts add <name>")).toBeUndefined();
});

it("organises every account before other harnesses, marks current/unusable accounts, preserves keyboard focus and copies the hint", async () => {
  hooks.caps = { moveToComputer: true };
  const { body } = setupDom(); remoteInventory();
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  await openMoveSheet({ computer: "Desk", child: session });
  expect(body.find("current@example.com · Pro · Desk · 5h unknown · week unknown · Current account")!.disabled).toBe(true);
  expect(body.find(localLabel)!.disabled).toBe(false);
  expect(body.find(remoteLabel)!.disabled).toBe(false);
  expect(body.find("Personal · Pro · Studio · 5h 80% · week unknown · Account unavailable")!.disabled).toBe(true);
  expect(body.find("Laptop account · Laptop · 5h unknown · week unknown · Offline")!.disabled).toBe(true);
  expect(body.find("Codex · No checkout · No checkout of this project")!.disabled).toBe(true);
  const accounts = body.find("Claude accounts")!.parent!;
  const other = body.find("Other harnesses")!.parent!;
  expect(accounts.parent!.children.indexOf(accounts)).toBeLessThan(accounts.parent!.children.indexOf(other));
  const copy = body.find("phren bridge accounts add <name>")!;
  expect(copy.parent!.children.map((n) => n.textContent).join("")).toBe("Only one Claude login on Desk. Add another with phren bridge accounts add <name>, or continue on another computer.");
  await copy.listeners.get("click")!(); expect(writeText).toHaveBeenCalledWith("phren bridge accounts add <name>");
  body.find("×")!.focus(); press("ArrowDown"); expect(dom.activeElement).toBe(body.find(localLabel));
  press("ArrowDown"); expect(dom.activeElement).toBe(body.find(remoteLabel));
  body.find("Continue")!.focus(); expect(press("Tab").preventDefault).toHaveBeenCalled();
  expect(dom.activeElement).toBe(body.find("×"));
});

it.each([false, true])("moves the chosen account with remote=%s and opens the landed peer chat", async (remote) => {
  vi.useFakeTimers(); hooks.caps = { moveToComputer: true };
  const { body } = setupDom(); remoteInventory({ ...peers, localClaudeLogins: 2 });
  await openMoveSheet({ computer: "Desk", child: session });
  expect(body.find("phren bridge accounts add <name>")).toBeUndefined();
  body.find(remote ? remoteLabel : localLabel)!.listeners.get("click")!();
  const next = { source: "claude", session: "new" };
  const nextChild = { target: next }; hooks.rows = [{ computer: "Studio", child: nextChild }];
  vi.mocked(hookPost).mockResolvedValue({ move: { id: "move" } });
  vi.mocked(hookGet).mockResolvedValue({ move: { state: "moved", handedOffTo: { computer: "Studio", target: next } } });
  await body.find("Continue")!.listeners.get("click")!(); await vi.advanceTimersByTimeAsync(0);
  const request = vi.mocked(hookPost).mock.calls[0][2];
  expect(request.to).toEqual({ harness: "claude", account: "work", ...(remote ? { computer: "Studio" } : {}) });
  if (remote) { expect(request.mode).toBe("new-chat"); expect(hooks.open).toHaveBeenCalledWith("Studio", nextChild); }
  else { expect(request).not.toHaveProperty("mode"); expect(hooks.open).not.toHaveBeenCalled(); }
});

it.each([false, true])("gates conductor peer accounts with moveConductorToComputer=%s", async (enabled) => {
  hooks.caps = { moveToComputer: true, moveConductorToComputer: enabled };
  const { body } = setupDom(); remoteInventory();
  await openMoveSheet({ computer: "Desk", child: { ...session, role: "conductor" } });
  expect(body.find(remoteLabel + (enabled ? "" : " · Update Desk's Hook to move the conductor"))!.disabled).toBe(!enabled);
  expect(body.find(localLabel)!.disabled).toBe(false);
});

it.each([true, false])("resolves project/src via reported project when present=%s, otherwise the registered ancestor", async (reported) => {
  hooks.caps = { moveToComputer: true }; setupDom(); remoteInventory();
  await openMoveSheet({ computer: "Desk", child: { ...session, project: reported ? "reported-project" : undefined, cwd: "/repo/project/src" } });
  expect(hookGet).toHaveBeenCalledWith("Desk", "/v1/sessions/move/computers", { project: reported ? "reported-project" : "registered-name" });
  expect(vi.mocked(hookGet).mock.calls.some((call) => call[1] === "/v1/projects/repos")).toBe(!reported);
});

it("refuses to guess a project from an unmatched cwd basename", async () => {
  hooks.caps = { moveToComputer: true }; const { body } = setupDom(); remoteInventory();
  await openMoveSheet({ computer: "Desk", child: { ...session, project: undefined, cwd: "/repo/project-extra2/src" } });
  expect(vi.mocked(hookGet).mock.calls.some((call) => call[1] === "/v1/sessions/move/computers")).toBe(false);
  expect(body.find("This session has no registered project. Open a chat in a registered checkout to continue on another computer.")).toBeDefined();
});

it.each([404, 409])("keeps peer %s errors visible and allows selecting a local account", async (status) => {
  hooks.caps = { moveToComputer: true }; const { body } = setupDom(); remoteInventory();
  await openMoveSheet({ computer: "Desk", child: session }); body.find(remoteLabel)!.listeners.get("click")!();
  vi.mocked(hookPost).mockRejectedValue({ status, message: "Studio is unavailable" });
  await body.find("Continue")!.listeners.get("click")!();
  expect(body.find("Studio is unavailable")).toBeDefined(); expect(body.find(remoteLabel)!.disabled).toBe(false);
  body.find(localLabel)!.listeners.get("click")!();
  vi.mocked(hookPost).mockResolvedValue({ move: { state: "failed" } }); vi.mocked(hookGet).mockResolvedValue({ move: { state: "failed" } });
  await body.find("Continue")!.listeners.get("click")!();
  expect(vi.mocked(hookPost).mock.calls.at(-1)![2].to).toEqual({ harness: "claude", account: "work" });
});

it.each(["Desk", "Studio"])("validates a new account slug on %s and opens its returned live pane", async (computer) => {
  hooks.caps = { moveToComputer: true, claudeAccountAdd: true }; const { body } = setupDom(); remoteInventory();
  await openMoveSheet({ computer: "Desk", child: session });
  const action = body.find(`Add a Claude account on ${computer}…`)!;
  action.listeners.get("click")!();
  const input = dom.activeElement; expect(input.tagName).toBe("INPUT");
  const form = input.parent!;
  for (const slug of ["Bad Name", "default", "-work", "a".repeat(33)]) {
    input.value = slug;
    await form.listeners.get("submit")!({ preventDefault: vi.fn() } as KeyEvent);
    expect(hookPost).not.toHaveBeenCalled();
  }
  input.value = "work-2";
  const target = { server: "default", pane: "login-pane" };
  vi.mocked(hookPost).mockResolvedValue({ target });
  await form.listeners.get("submit")!({ preventDefault: vi.fn() } as KeyEvent);
  expect(hookPost).toHaveBeenCalledWith(computer, "/v1/accounts/claude/add", { slug: "work-2" });
  expect(hooks.pane).toHaveBeenCalledWith(computer, target);
  expect(body.find("Continue")).toBeUndefined();
});

it("keeps login launch errors editable and Cancel returns focus to the action", async () => {
  hooks.caps = { claudeAccountAdd: true }; const { body } = setupDom(); remoteInventory();
  await openMoveSheet({ computer: "Desk", child: session });
  const action = body.find("Add a Claude account on Desk…")!; action.listeners.get("click")!();
  const input = dom.activeElement; input.value = "work";
  vi.mocked(hookPost).mockRejectedValue(new Error("Login could not start"));
  await input.parent!.listeners.get("submit")!({ preventDefault: vi.fn() } as KeyEvent);
  expect(body.find("Login could not start")).toBeDefined(); expect(input.disabled).toBe(false);
  body.find("Cancel")!.listeners.get("click")!(); expect(dom.activeElement).toBe(action);
});


it("gates add-account actions on each computer's own health, including the hint", async () => {
  hooks.caps = { moveToComputer: true, claudeAccountAdd: true };
  hooks.capsFor = { Studio: { claudeAccountAdd: false } };
  const { body } = setupDom(); remoteInventory();
  await openMoveSheet({ computer: "Desk", child: session });
  expect(body.find("Add a Claude account on Studio…")).toBeUndefined();
  const hint = body.find("phren bridge accounts add <name>")!.parent!;
  expect(hint.find("Add a Claude account on Desk…")).toBeDefined();
});

it("rechecks conductor capability at submission after a peer account was selected", async () => {
  hooks.caps = { moveToComputer: true, moveConductorToComputer: true };
  const { body } = setupDom(); remoteInventory();
  await openMoveSheet({ computer: "Desk", child: { ...session, role: "conductor" } });
  body.find(remoteLabel)!.listeners.get("click")!();
  hooks.caps.moveConductorToComputer = false;
  await body.find("Continue")!.listeners.get("click")!();
  expect(hookPost).not.toHaveBeenCalled();
  expect(body.find("Update Desk's Hook to move the conductor")).toBeDefined();
});
