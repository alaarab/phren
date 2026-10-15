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


  class Node {
    children: Node[] = [];
    textContent = "";
    className = "";
    disabled = false;
    style: Record<string, string> = {};
    listeners = new Map<string, () => void>();
    append(...children: Node[]) { this.children.push(...children); }
    replaceChildren(...children: Node[]) { this.children = children; }
    setAttribute() {}
    addEventListener(event: string, fn: () => void) { this.listeners.set(event, fn); }
    focus() {}
    remove() {}
    find(text: string): Node | undefined { return this.textContent === text ? this : this.children.map((n) => n.find(text)).find(Boolean); }
  }

it("leaves Continue in unselected when no destination has room, until the user chooses", async () => {
  const body = new Node();
  vi.stubGlobal("document", { body, getElementById: () => ({}), createElement: () => new Node() });
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
  const body = new Node();
  vi.stubGlobal("document", { body, getElementById: () => ({}), createElement: () => new Node() });
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
