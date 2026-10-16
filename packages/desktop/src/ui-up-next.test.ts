import { afterEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  schedules: new Map<string, unknown>(),
  showSection: vi.fn(),
  run: vi.fn(), can: vi.fn(() => true),
  merged: { computers: [{ computer: "Desk", state: "online" }, { computer: "Laptop", state: "online" }] },
  publish: null as null | ((value: unknown) => void),
}));
vi.mock("../ui/api.js", () => ({
  hookGet: vi.fn(async () => ({ dispatches: [] })),
  hookPost: vi.fn(async (computer: string, route: string, body: unknown) => {
    if (route === "/v1/schedules/run") return hooks.run(computer, route, body);
    const answer = hooks.schedules.get(computer);
    if (answer instanceof Error) throw answer;
    return answer ?? { schedules: [] };
  }),
}));
vi.mock("../ui/shell/store.js", () => ({
  store: { can: hooks.can, subscribe: (fn: (value: unknown) => void) => { hooks.publish = fn; fn(hooks.merged); return () => {}; }, find: () => null },
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

// Home's mount needs only these DOM operations. Focus follows the DOM's rule:
// replacing a list's children blurs a focused child, even one put back.
const doc = { activeElement: null as unknown };
class FakeNode {
  disabled = false;
  className = "";
  textContent = "";
  hidden = false;
  title = "";
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  classList = { add: (name: string) => { this.className += ` ${name}`; }, toggle: () => {} };
  listeners = new Map<string, (event: object) => void>();
  children: FakeNode[] = [];
  selectors = new Map<string, FakeNode>();
  append(...nodes: FakeNode[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: FakeNode[]) {
    if (this.children.some((child) => child.contains(doc.activeElement))) doc.activeElement = null;
    this.children = nodes;
  }
  focus() { doc.activeElement = this; }
  closest() { return null; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  addEventListener(type: string, fn: (event: object) => void) { this.listeners.set(type, fn); }
  contains(node: unknown): boolean {
    return node === this || [...this.children, ...this.selectors.values()].some((child) => child.contains(node));
  }
  querySelector(selector: string): FakeNode {
    if (!this.selectors.has(selector)) this.selectors.set(selector, new FakeNode());
    return this.selectors.get(selector)!;
  }
  querySelectorAll() { return []; }
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); hooks.schedules.clear(); hooks.can.mockReturnValue(true); vi.useRealTimers(); doc.activeElement = null; });

function stubDocument() {
  vi.stubGlobal("HTMLElement", FakeNode);
  vi.stubGlobal("document", Object.assign(doc, {
    body: new FakeNode(), createElement: () => new FakeNode(), querySelector: () => null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }));
}

it("keeps a focused Up next row, and its focus, across re-renders and polls", async () => {
  stubDocument();
  const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
  hooks.schedules.set("Desk", { schedules: [schedule("triage", null, { nextRun: at(42) }), schedule("deps", null, { nextRun: at(185) })] });
  const root = new FakeNode();
  const scope = root.querySelector('[data-block="upnext"]');
  const list = scope.querySelector(".home-list");
  const home = mountHome(root);
  try {
    home.show();
    await vi.waitFor(() => expect(list.children).toHaveLength(2));
    const [first, second] = list.children;
    second.focus();
    hooks.publish!(hooks.merged); // an overview update re-renders Home with identical schedules
    expect(list.children[1] === second, "same row element").toBe(true);
    expect(doc.activeElement === second, "focus kept").toBe(true);

    // Changed content keeps action controls mounted.
    hooks.schedules.set("Desk", { schedules: [schedule("triage", null, { nextRun: at(42), name: "Renamed" }), schedule("deps", null, { nextRun: at(185) })] });
    home.hide();
    home.show(); // show() reads the schedules again
    await vi.waitFor(() => expect(list.children[0].children[0].children[0].children[0].textContent).toBe("Renamed"));
    expect(list.children[0]).toBe(first);
    expect(list.children[1] === second, "same row element").toBe(true);
    expect(doc.activeElement === second, "focus kept").toBe(true);
  } finally { home.destroy(); }
});

it("Home lists the schedules due next from the schedules it already reads, and opens Schedules", async () => {
  stubDocument();
  const soon = Date.now() + 42 * 60_000;
  hooks.schedules.set("Desk", { schedules: [
    { ...schedule("triage", null), name: "Nightly triage", harness: "codex", nextRun: new Date(soon).toISOString(), prompt: "Triage today's issues.\nThen file tasks." },
    { ...schedule("paused", null), enabled: false, nextRun: new Date(soon).toISOString() },
  ] });
  hooks.schedules.set("Laptop", new Error("offline"));
  const root = new FakeNode();
  const scope = root.querySelector('[data-block="upnext"]');
  const home = mountHome(root);
  try {
    expect(scope.hidden).toBe(true); // nothing read yet
    home.show();
    await vi.waitFor(() => expect(scope.hidden).toBe(false));
    const list = scope.querySelector(".home-list");
    expect(list.children).toHaveLength(1);
    const row = list.children[0].children[0];
    expect(row.children[0].children[0].textContent).toBe("Nightly triage");
    expect(row.children[0].children[1].textContent).toBe("Triage today's issues.");
    const meta = row.children[1].children.map((child) => child.textContent);
    expect(meta).toEqual(["Codex", "phren", "Desk", "in 42m"]);
    expect(scope.querySelector(".count").textContent).toBe("1");
    row.listeners.get("click")!({});
    expect(hooks.showSection).toHaveBeenCalledWith("schedules");
  } finally { home.destroy(); }
});

const click = (node: FakeNode) => node.listeners.get("click")!({ stopPropagation: vi.fn() });
async function runSetup() {
  stubDocument();
  const root = new FakeNode();
  const list = root.querySelector('[data-block="upnext"]').querySelector(".home-list");
  const source = { ...schedule("triage", null), computer: "hook-name", updatedAt: "revision-1", nextRun: new Date(Date.now() + 600_000).toISOString() };
  hooks.schedules.set("Desk", { schedules: [source] });
  const home = mountHome(root); home.show();
  await vi.waitFor(() => expect(list.children).toHaveLength(1));
  return { home, list, source, run: list.children[0].children[1].children[0] };
}
it("confirms for five seconds, cancels, sends the Schedules payload once and shows busy then Started", async () => {
  const { home, list, run, source } = await runSetup();
  try {
    vi.useFakeTimers();
    const cancel = list.children[0].children[1].children[1];
    await click(run);
    expect(run.textContent).toBe("Run? Yes"); expect(cancel.hidden).toBe(false);
    expect(hooks.run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5000); expect(run.textContent).toBe("Run now");
    await click(run); await click(cancel);
    expect(run.textContent).toBe("Run now"); expect(doc.activeElement).toBe(run);
    let finish!: () => void;
    hooks.run.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    await click(run); const pending = click(run);
    expect(run.textContent).toBe("Starting…"); expect(run.disabled).toBe(true);
    await click(run);
    expect(hooks.run).toHaveBeenCalledExactlyOnceWith("Desk", "/v1/schedules/run", { project: "phren", id: "triage", expectedUpdatedAt: source.updatedAt });
    finish(); await pending;
    const note = list.children[0].children[2];
    expect(note.textContent).toBe("Started"); expect(note.hidden).toBe(false);
    vi.advanceTimersByTime(4000); expect(note.hidden).toBe(true);
    expect(hooks.showSection).not.toHaveBeenCalled();
  } finally { home.destroy(); }
});
it.each([409, 404])("shows Hook %s errors inline and disables missing routes", async (status) => {
  const { home, list, run } = await runSetup();
  try {
    hooks.run.mockRejectedValueOnce(Object.assign(new Error("Hook refused this run"), { status }));
    await click(run); await click(run);
    expect(list.children[0].children[2].textContent).toBe("Hook refused this run");
    expect(run.disabled).toBe(status === 404);
    hooks.publish!(hooks.merged);
    expect(list.children[0].children[2].hidden).toBe(false);
  } finally { home.destroy(); }
});
it("gates unsupported owners and keeps confirmation focus through changed and reordered polls", async () => {
  const { home, list, run, source } = await runSetup();
  try {
    hooks.can.mockReturnValue(false); hooks.publish!(hooks.merged);
    expect(run.disabled).toBe(true); await click(run); expect(run.textContent).toBe("Run now");
    hooks.can.mockReturnValue(true); hooks.publish!(hooks.merged);
    await click(run); run.focus();
    hooks.schedules.set("Desk", { schedules: [{ ...source, id: "earlier", nextRun: new Date(Date.now() + 60_000).toISOString() }, { ...source, name: "Renamed", updatedAt: "revision-2" }] });
    home.hide(); home.show();
    await vi.waitFor(() => expect(list.children).toHaveLength(2));
    expect(list.children[1].children[1].children[0]).toBe(run);
    expect(doc.activeElement).toBe(run); expect(run.textContent).toBe("Run? Yes");
    hooks.schedules.set("Desk", { schedules: [{ ...source, running: true }] });
    home.hide(); home.show(); await vi.waitFor(() => expect(list.children).toHaveLength(0));
    expect(hooks.run).not.toHaveBeenCalled();
  } finally { home.destroy(); }
});
