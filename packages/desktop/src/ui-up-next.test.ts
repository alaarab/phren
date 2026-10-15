import { afterEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  schedules: new Map<string, unknown>(),
  showSection: vi.fn(),
  merged: { computers: [{ computer: "Desk", state: "online" }, { computer: "Laptop", state: "online" }] },
}));
vi.mock("../ui/api.js", () => ({
  hookGet: vi.fn(async () => ({ dispatches: [] })),
  hookPost: vi.fn(async (computer: string) => {
    const answer = hooks.schedules.get(computer);
    if (answer instanceof Error) throw answer;
    return answer ?? { schedules: [] };
  }),
}));
vi.mock("../ui/shell/store.js", () => ({
  store: { subscribe: (fn: (value: unknown) => void) => { fn(hooks.merged); return () => {}; }, find: () => null },
  sessions: () => [], needsYou: () => [], projectOf: () => "project",
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
import { clockLabel, promptLine, untilLabel, upNext } from "../ui/shell/up-next.js";
// @ts-expect-error plain ESM without declarations
import { mountHome } from "../ui/sections/home.js";

const now = new Date(2026, 9, 15, 20, 0).getTime();
const inMinutes = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
const schedule = (id: string, minutes: number | null, extra: object = {}) => ({
  id, name: `Schedule ${id}`, project: "phren", harness: "claude", enabled: true, owned: true, running: false,
  prompt: `Run ${id}`, nextRun: minutes === null ? null : inMinutes(minutes), ...extra,
});

describe("upNext", () => {
  it("keeps enabled, idle, owned schedules due within the window, soonest first across computers", () => {
    const rows = upNext(new Map([
      ["Desk", [
        schedule("later", 300), schedule("paused", 10, { enabled: false }), schedule("busy", 10, { running: true }),
        schedule("not-mine", 10, { owned: false }), schedule("never", null), schedule("past", -1), schedule("tomorrow", 13 * 60),
      ]],
      ["Laptop", [schedule("soon", 15)]],
    ]), now);
    expect(rows.map((row: { computer: string; schedule: { id: string } }) => `${row.computer}:${row.schedule.id}`)).toEqual(["Laptop:soon", "Desk:later"]);
  });

  it("caps the list and honours a custom window", () => {
    const list = [1, 2, 3, 4, 5, 6].map((n) => schedule(`s${n}`, n * 10));
    expect(upNext([["Desk", list]], now)).toHaveLength(4);
    expect(upNext([["Desk", list]], now, { hours: 0.5, limit: 10 }).map((row: { schedule: { id: string } }) => row.schedule.id)).toEqual(["s1", "s2", "s3"]);
    expect(upNext(null, now)).toEqual([]);
  });

  it("words the wait, the clock and the prompt's first line", () => {
    expect(untilLabel(now + 30_000, now)).toBe("in 1m");
    expect(untilLabel(now + 42 * 60_000, now)).toBe("in 42m");
    expect(untilLabel(now + 120 * 60_000, now)).toBe("in 2h");
    expect(untilLabel(now + 185 * 60_000, now)).toBe("in 3h 5m");
    expect(clockLabel(now + 90 * 60_000, now)).toBe("21:30");
    expect(clockLabel(now + 5 * 3_600_000, now)).toBe("tomorrow 01:00");
    expect(promptLine({ prompt: "\n  Triage today's issues.\nThen file tasks." })).toBe("Triage today's issues.");
    expect(promptLine({ prompt: "x".repeat(200) }, 10)).toBe(`${"x".repeat(9)}…`);
  });
});

// Home's mount needs only these DOM operations.
class Node {
  className = "";
  textContent = "";
  hidden = false;
  title = "";
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  classList = { add: (name: string) => { this.className += ` ${name}`; }, toggle: () => {} };
  listeners = new Map<string, (event: object) => void>();
  children: Node[] = [];
  selectors = new Map<string, Node>();
  append(...nodes: Node[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Node[]) { this.children = nodes; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  addEventListener(type: string, fn: (event: object) => void) { this.listeners.set(type, fn); }
  contains(node: unknown): boolean { return node === this || this.children.some((child) => child.contains(node)); }
  querySelector(selector: string): Node {
    if (!this.selectors.has(selector)) this.selectors.set(selector, new Node());
    return this.selectors.get(selector)!;
  }
  querySelectorAll() { return []; }
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); hooks.schedules.clear(); });

it("Home lists the schedules due next from the schedules it already reads, and opens Schedules", async () => {
  vi.stubGlobal("HTMLElement", Node);
  vi.stubGlobal("document", {
    body: new Node(), activeElement: null, createElement: () => new Node(), querySelector: () => null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  });
  const soon = Date.now() + 42 * 60_000;
  hooks.schedules.set("Desk", { schedules: [
    { ...schedule("triage", null), name: "Nightly triage", harness: "codex", nextRun: new Date(soon).toISOString(), prompt: "Triage today's issues.\nThen file tasks." },
    { ...schedule("paused", null), enabled: false, nextRun: new Date(soon).toISOString() },
  ] });
  hooks.schedules.set("Laptop", new Error("offline"));
  const root = new Node();
  const scope = root.querySelector('[data-block="upnext"]');
  const home = mountHome(root);
  try {
    expect(scope.hidden).toBe(true); // nothing read yet
    home.show();
    await vi.waitFor(() => expect(scope.hidden).toBe(false));
    const list = scope.querySelector(".home-list");
    expect(list.children).toHaveLength(1);
    const row = list.children[0];
    expect(row.children[0].children[0].textContent).toBe("Nightly triage");
    expect(row.children[0].children[1].textContent).toBe("Triage today's issues.");
    const meta = row.children[1].children.map((child) => child.textContent);
    expect(meta).toEqual(["Codex", "phren", "Desk", "in 42m"]);
    expect(scope.querySelector(".count").textContent).toBe("1");
    row.listeners.get("click")!({});
    expect(hooks.showSection).toHaveBeenCalledWith("schedules");
  } finally { home.destroy(); }
});
