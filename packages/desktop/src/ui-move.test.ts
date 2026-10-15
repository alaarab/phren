import { afterEach, describe, expect, it, vi } from "vitest";
import { moveAccounts, moveChoices, moveStatus, openMoveSheet } from "../ui/shell/move.js";

import { hookGet } from "../ui/api.js";
vi.mock("../ui/api.js", () => ({ hookGet: vi.fn(), hookPost: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

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


it("leaves Continue in unselected when no destination has room, until the user chooses", async () => {
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
