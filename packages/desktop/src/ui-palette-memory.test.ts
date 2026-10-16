import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  get: vi.fn(), open: vi.fn(), load: vi.fn(), session: null as object | null,
  projects: [] as { computer: string; name: string; lastSeen?: string }[],
  merged: { computers: [{ computer: "mini", state: "online" }, { computer: "jets", state: "online" }, { computer: "old", state: "offline" }] },
}));
vi.mock("../ui/api.js", () => ({ hookGet: state.get, hookPost: vi.fn(), targetQuery: () => "" }));
vi.mock("../ui/shell/sections.js", () => ({
  sectionIds: () => [], sectionLabel: () => "", showSection: vi.fn(),
  sectionHandle: (name: string) => name === "agents" ? { currentSession: () => state.session }
    : name === "projects" ? { projects: () => state.projects, load: state.load } : { open: state.open },
}));
vi.mock("../ui/shell/store.js", () => ({ store: { get merged() { return state.merged; }, sessions: () => [] }, projectOf: () => "scoped" }));
vi.mock("../ui/shell/ci-watch.js", () => ({ lastChecks: () => [], checksStrip: () => [] }));
import { closePalette, openPalette } from "../ui/shell/palette.js";

class Node {
  constructor(public tagName = "div") {}
  className = "";
  textContent = "";
  value = "";
  children: Node[] = [];
  isConnected = true;
  listeners = new Map<string, (event: object) => void>();
  classList = { toggle: vi.fn() };
  get childNodes() { return this.children; }
  append(...nodes: Node[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Node[]) { this.textContent = ""; this.children = nodes; }
  remove() { this.isConnected = false; }
  focus() { doc.activeElement = this; }
  setAttribute() {}
  addEventListener(type: string, fn: (event: object) => void) { this.listeners.set(type, fn); }
}
const doc = { body: new Node(), activeElement: null as Node | null, createElement: (tag: string) => new Node(tag),
  createDocumentFragment: () => new Node(), createTextNode: (text: string) => Object.assign(new Node(), { textContent: text }) };
const all = (node = doc.body): Node[] => [node, ...node.children.flatMap((n) => all(n))];
const nodes = (name: string) => all().filter((n) => n.className.split(" ").includes(name));
const text = (node: Node): string => node.textContent + node.children.map(text).join("");
function type(value: string) {
  const input = nodes("palette-input").at(-1)!;
  input.value = value;
  input.listeners.get("input")!({});
}
const hit = (text: string, score: number) => ({ kind: "finding", text, score, finding: { id: "same-id" } });
beforeEach(() => {
  vi.useFakeTimers();
  doc.body = new Node();
  vi.stubGlobal("document", doc);
  state.projects = [{ name: "alpha", computer: "mini" }, { name: "beta", computer: "jets" }];
  state.session = null;
  state.load.mockResolvedValue(undefined);
  state.get.mockResolvedValue({ results: [] });
});
afterEach(() => { closePalette(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("debounces, caps the newest online projects at 12, and keeps at most four reads in flight", async () => {
  state.projects = Array.from({ length: 15 }, (_, i) => ({ computer: i % 2 ? "jets" : "mini", name: `p${i}`, lastSeen: new Date(2026, 0, i + 1).toISOString() }));
  state.projects.push({ computer: "old", name: "offline", lastSeen: "2027-01-01" });
  const pending: (() => void)[] = [];
  let active = 0, peak = 0;
  state.get.mockImplementation(() => new Promise((resolve) => {
    peak = Math.max(peak, ++active);
    pending.push(() => { active--; resolve({ results: [] }); });
  }));
  openPalette(); type("? token");
  await vi.advanceTimersByTimeAsync(249);
  expect(state.get).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(state.get).toHaveBeenCalledTimes(4);
  for (let batch = 0; batch < 3; batch++) {
    pending.splice(0).forEach((resolve) => resolve());
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(peak).toBe(4);
  expect(state.get.mock.calls.map((c) => c[1])).toEqual(Array.from({ length: 12 }, (_, i) => `/v1/projects/p${14 - i}/memory/search`));
  expect(text(doc.body)).toContain("Searched 12 of 15 projects");
  expect(doc.activeElement).toBe(nodes("palette-input")[0]);
});

it("merges Hook scores across computers, labels rows and opens the exact destination", async () => {
  state.get.mockImplementation(async (computer: string) => ({ results: [hit(computer === "mini" ? "low" : "high", computer === "mini" ? 0.2 : 0.9)] }));
  openPalette(); type("? token");
  await vi.advanceTimersByTimeAsync(250);
  const rows = nodes("palette-row");
  expect(rows.map(text)).toEqual(["◆highbeta · jets · finding · 90%", "◆lowalpha · mini · finding · 20%"]);
  rows[0].listeners.get("click")!({});
  expect(state.open).toHaveBeenCalledWith({ computer: "jets", project: "beta", segment: "findings", search: "high" });
});

it.each(["? newer", "> command", "close"])("aborts in-flight searches on %s and discards late answers", async (next) => {
  const pending: ((value: object) => void)[] = [];
  const signals: AbortSignal[] = [];
  state.get.mockImplementation((_c, _r, _q, options) => {
    signals.push(options.signal);
    return new Promise((resolve) => pending.push(resolve));
  });
  openPalette(); type("? old");
  await vi.advanceTimersByTimeAsync(250);
  if (next === "close") closePalette(); else type(next);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  pending.forEach((resolve) => resolve({ results: [hit("stale answer", 1)] }));
  await vi.advanceTimersByTimeAsync(0);
  expect(nodes("palette-row").some((n) => text(n).includes("stale answer"))).toBe(false);
  expect(state.get).toHaveBeenCalledTimes(2);
  if (next === "? newer") {
    await vi.advanceTimersByTimeAsync(250);
    expect(state.get.mock.calls.slice(2).map((c) => c[2].q)).toEqual(["newer", "newer"]);
    pending.slice(2).forEach((resolve) => resolve({ results: [] }));
    await vi.advanceTimersByTimeAsync(0);
  }
});

it("keeps scoped ? on its opened project with quick chat, while ?? searches everywhere", async () => {
  state.session = { computer: "mini", child: {} };
  state.get.mockResolvedValue({ results: [hit("remembered", 0.8)] });
  openPalette(); type("? token");
  state.session = null;
  await vi.advanceTimersByTimeAsync(250);
  expect(state.get.mock.calls.map((c) => [c[0], c[1], c[2].q])).toEqual([["mini", "/v1/projects/scoped/memory/search", "token"]]);
  expect(nodes("palette-row").map(text)).toEqual(["◆rememberedscoped · mini · finding · 80%", "✦Ask in a quick chat: tokenscoped · mini"]);
  type("?? token");
  await vi.advanceTimersByTimeAsync(250);
  expect(state.get.mock.calls.slice(1).map((c) => c[1])).toEqual(["/v1/projects/alpha/memory/search", "/v1/projects/beta/memory/search"]);
  expect(nodes("palette-row")).toHaveLength(2);
});

it("retains keyed memory rows and input focus when project discovery repaints the same query", async () => {
  let loaded!: () => void;
  state.load.mockImplementationOnce(() => new Promise<void>((resolve) => { loaded = resolve; }));
  state.get.mockResolvedValue({ results: [hit("memory", 0.8)] });
  openPalette(); type("? token");
  await vi.advanceTimersByTimeAsync(250);
  const rows = nodes("palette-row");
  const input = doc.activeElement;
  loaded();
  await vi.advanceTimersByTimeAsync(0);
  expect(nodes("palette-row")).toEqual(rows);
  expect(nodes("palette-row")[0]).toBe(rows[0]);
  expect(doc.activeElement).toBe(input);
  expect(state.get).toHaveBeenCalledTimes(2);
});

it("ranks distinct matched tokens before project-relative score, then score and project recency", async () => {
  state.projects = [
    { name: "alpha", computer: "mini", lastSeen: "2026-10-15T12:00:00Z" },
    { name: "beta", computer: "jets", lastSeen: "2026-10-14T12:00:00Z" },
  ];
  state.get.mockImplementation(async (computer: string) => ({ results: computer === "mini" ? [
    { ...hit("one token", 1), matched: 1 },
    { ...hit("recent tie", 0.3), finding: { id: "recent" }, matched: 2 },
  ] : [
    { ...hit("fuller match", 0.4), matched: 2 },
    { ...hit("older tie", 0.3), finding: { id: "older" }, matched: 2 },
  ] }));
  openPalette(); type("?? login token");
  await vi.advanceTimersByTimeAsync(250);
  expect(nodes("palette-title").map(text)).toEqual(["fuller match", "recent tie", "older tie", "one token"]);
});

it("counts unsettled reads from a superseded query against the shared palette cap", async () => {
  state.projects = Array.from({ length: 6 }, (_, i) => ({ name: `p${i}`, computer: "mini" }));
  const pending: ((value: object) => void)[] = [];
  state.get.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
  openPalette(); type("? old");
  await vi.advanceTimersByTimeAsync(250);
  expect(state.get).toHaveBeenCalledTimes(4);
  type("? new");
  await vi.advanceTimersByTimeAsync(250);
  expect(state.get).toHaveBeenCalledTimes(4);
  pending.slice(0, 4).forEach((resolve) => resolve({ results: [] }));
  await vi.advanceTimersByTimeAsync(0);
  expect(state.get).toHaveBeenCalledTimes(8);
  expect(state.get.mock.calls.slice(4).every((call) => call[2].q === "new")).toBe(true);
  closePalette();
  pending.slice(4).forEach((resolve) => resolve({ results: [] }));
  await vi.advanceTimersByTimeAsync(0);
});
