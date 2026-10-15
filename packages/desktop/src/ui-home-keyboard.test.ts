import { afterEach, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ answer: vi.fn(), openUsage: vi.fn(), summary: null as null | { since: number; rows: object[]; checks: object[]; events: object[] }, awayChanged: null as null | (() => void), needs: [{ key: "Desk/approval", computer: "Desk", child: { id: "approval", approvalPending: true } }] }));
vi.mock("../ui/api.js", () => ({ hookGet: vi.fn(), hookPost: vi.fn() }));
vi.mock("../ui/shell/store.js", () => ({
  store: { subscribe: () => () => {} }, sessions: () => [], needsYou: () => hooks.needs, projectOf: () => "project",
}));
vi.mock("../ui/shell/approvals.js", () => ({ approvals: {
  approval: () => ({ summary: "Approve another chat" }), answerKey: hooks.answer, subscribe: () => () => {},
} }));
vi.mock("../ui/shell/ci-watch.js", () => ({ checksStrip: () => [], followChecks: () => () => {} }));
vi.mock("../ui/shell/away.js", () => ({ away: { current: () => hooks.summary, subscribe: (fn: () => void) => { hooks.awayChanged = fn; return () => { hooks.awayChanged = null; }; }, dismiss: () => {} } }));
vi.mock("../ui/shell/usage-rings.js", () => ({ openUsage: hooks.openUsage, followUsage: () => () => {} }));
vi.mock("../ui/shell/quota-warn-prefs.js", () => ({ loadQuotaState: async () => {}, quotaSettings: () => ({ threshold: 90 }) }));
vi.mock("../ui/shell/quota-warn-sheet.js", () => ({ openQuotaSwitch: vi.fn() }));
vi.mock("../ui/shell/needs-notify.js", () => ({ sendReply: vi.fn() }));
// @ts-expect-error plain ESM without declarations
import { mountHome } from "../ui/sections/home.js";

// Home's mount and empty background lists need only these DOM operations.
class Node {
  className = "";
  textContent = "";
  classList = { add: (name: string) => { this.className += ` ${name}`; } };
  listeners = new Map<string, (event: object) => void>();
  children: Node[] = [];
  selectors = new Map<string, Node>();
  append(...nodes: Node[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Node[]) { this.children = nodes; }
  addEventListener(type: string, fn: (event: object) => void) { this.listeners.set(type, fn); }
  contains(node: Node): boolean { return node === this || this.children.some((child) => child.contains(node)); }
  querySelector(selector: string): Node {
    if (!this.selectors.has(selector)) this.selectors.set(selector, new Node());
    return this.selectors.get(selector)!;
  }
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.clearAllMocks(); hooks.summary = null; });

it.each([".launch-backdrop", '[role="dialog"]', "dialog[open]"])("pauses Home approval keys behind %s and resumes after close", async (modal) => {
  vi.useFakeTimers();
  const body = new Node();
  const root = new Node();
  const listeners = new Map<string, (event: object) => void>();
  let open = true;
  vi.stubGlobal("document", {
    body, activeElement: body, createElement: () => new Node(),
    querySelector: (selector: string) => open && selector.includes(modal) ? new Node() : null,
    addEventListener: (type: string, fn: (event: object) => void) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
  });
  const home = mountHome(root);
  try {
    home.show();
    await vi.advanceTimersByTimeAsync(0);
    const key = (value: string) => listeners.get("keydown")!({ key: value, preventDefault: vi.fn() });
    // Even with focus lost to body, neither approval shortcut may escape a dialog.
    key("p");
    key("d");
    expect(hooks.answer).not.toHaveBeenCalled();
    open = false;
    key("p");
    expect(hooks.answer).toHaveBeenLastCalledWith("Desk/approval", "approve", "project");
    key("d");
    expect(hooks.answer).toHaveBeenLastCalledWith("Desk/approval", "deny");
  } finally { home.destroy(); }
});

it("shows an account recovery with a Usage affordance that opens the usage popover", () => {
  const root = new Node();
  const title = "Claude · work@example.com is available again (5-hour limit reset)";
  vi.stubGlobal("document", { createElement: () => new Node(), removeEventListener: vi.fn() });
  hooks.summary = { since: Date.now() - 60_000, rows: [], checks: [], events: [{ kind: "quota", title, computer: "Desk", at: Date.now() }] };
  const home = mountHome(root);
  try {
    hooks.awayChanged!();
    const list = root.querySelector('[data-block="finished"]').querySelector(".home-list");
    expect(list.children).toHaveLength(1);
    const button = list.children[0];
    expect(button.className.split(" ")).toContain("home-quota-row");
    expect(button.children[0].children[0].textContent).toBe(title);
    const usage = button.children[1].children.find((child) => child.textContent === "Usage ↗");
    expect(usage?.className.split(" ")).toContain("handoff-tag");
    expect(usage?.className.split(" ")).toContain("handoff-link");
    button.listeners.get("click")!({});
    expect(hooks.openUsage).toHaveBeenCalledOnce();
  } finally { home.destroy(); }
});
