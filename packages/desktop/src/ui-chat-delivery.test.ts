import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatTranscriptPreparation } from "../../desktop-kit/src/index.js";
// @ts-expect-error Plain browser ESM.
import { openChat } from "../ui/chat.js";
// @ts-expect-error Plain browser ESM.
import { createComposer } from "../ui/chat/composer.js";

vi.mock("/vendor/kit/index.js", async () => import("../../desktop-kit/src/index.js"));
const timeline = vi.hoisted(() => ({ render: vi.fn(), isAtBottom: () => true, scrollToBottom() {}, destroy() {} }));
vi.mock("../ui/chat/timeline-view.js", () => ({ createTimelineView: () => timeline }));
vi.mock("../ui/chat/recall.js", () => ({ createRecall: () => ({ el: new Element(), update() {}, destroy() {} }) }));
vi.mock("../ui/chat/knows.js", () => ({ installRememberSelection: () => ({ destroy() {} }), openKnowsDrawer: vi.fn() }));

// Minimal DOM for exercising the actual composer and chat socket callbacks.
class Element {
  children: Element[] = [];
  value = "";
  textContent = "";
  className = "";
  style = {};
  dataset = {};
  hidden = false;
  isConnected = false;
  selectionStart = null;
  selectionEnd = null;
  classList = { add() {}, remove() {}, toggle() {} };
  listeners = new Map<string, Function>();
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Element[]) { this.children = nodes; }
  setAttribute() {}
  addEventListener(name: string, fn: Function) { this.listeners.set(name, fn); }
  removeEventListener() {}
  focus() {}
  setSelectionRange() {}
  remove() {}
  fire(name: string) { return this.listeners.get(name)?.({ key: "Enter", shiftKey: false, preventDefault() {} }); }
  find(cls: string): Element | undefined { return this.className === cls ? this : this.children.map(n => n.find(cls)).find(Boolean); }
}
class Socket {
  static all: Socket[] = [];
  onmessage?: (event: { data: string }) => void;
  constructor(public url: string) { Socket.all.push(this); }
  close() {}
  frame(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}
const target = { source: "claude", server: "default", pane: "1", session: "s1" };
const user = (line: number, text: string) => ({ line, raw: { type: "user", message: { role: "user", content: text } } });
let storage: Map<string, string>;
let views: { close?: Function; destroy?: Function }[];
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  views = [];
  storage = new Map();
  Socket.all = [];
  timeline.render.mockClear();
  vi.stubGlobal("document", { createElement: () => new Element(), createElementNS: () => new Element(), getElementById: () => true, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  vi.stubGlobal("location", { protocol: "http:", host: "localhost" });
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ state: "queued" }) }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { for (const view of views) { view.close?.(); view.destroy?.(); } vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function chat() {
  const el = new Element();
  const update = vi.spyOn(ChatTranscriptPreparation.prototype, "update");
  views.push(openChat(el, "mini", { target }));
  const socket = Socket.all.find(s => s.url.includes("/v1/transcripts"))!;
  const echoes = () => update.mock.calls.at(-1)![1]!.pendingEchoes;
  const send = async (text: string) => { el.find("pc-input")!.value = text; el.find("pc-input")!.fire("keydown"); await vi.advanceTimersByTimeAsync(0); };
  return { el, socket, echoes, send };
}

describe("chat delivery reconciliation", () => {
  it("keeps duplicate submissions until distinct exact user rows after submission", async () => {
    const c = chat();
    c.socket.frame({ type: "backlog", totalLines: 10, entries: [user(3, "yes")] });
    await c.send("yes");
    await c.send("yes");
    c.socket.frame({ type: "append", totalLines: 11, entries: [user(10, "yesterday yes")] });
    expect(c.echoes()).toHaveLength(2);
    c.socket.frame({ type: "older", totalLines: 10, entries: [user(1, "yes")] });
    expect(c.echoes()).toHaveLength(2);
    c.socket.frame({ type: "append", totalLines: 12, entries: [user(11, "yes")] });
    expect(c.echoes()).toHaveLength(1);
    c.socket.frame({ type: "append", totalLines: 12, entries: [user(11, "yes")] });
    expect(c.echoes()).toHaveLength(1);
    c.socket.frame({ type: "append", totalLines: 13, entries: [user(12, "yes")] });
    expect(c.echoes()).toHaveLength(0);
    expect(c.el.find("pc-pending")!.hidden).toBe(true);
  });

  it("uses pushed receipts for both the composer and echoes without stale polling reviving them", async () => {
    const c = chat();
    await c.send("one");
    await c.send("two");
    const [one, two] = c.echoes();
    c.socket.frame({ type: "delivery", deliveryId: "someone-else", state: "delivered" });
    c.socket.frame({ type: "delivery", deliveryId: one.id, state: "delivered" });
    await vi.advanceTimersByTimeAsync(1200);
    expect(c.echoes().map(e => e.id)).toEqual([two.id]);
    expect(c.el.find("pc-pending-msg")!.textContent).toBe("two");
    await vi.advanceTimersByTimeAsync(800);
    const polls = fetchMock.mock.calls.filter(([url]) => url.endsWith("/v1/prompt/status"));
    expect(polls).toHaveLength(1);
    expect(JSON.parse(polls[0][1].body).deliveryId).toBe(two.id);
  });

  it("ignores a queued poll response arriving after a pushed delivered receipt", async () => {
    const c = chat();
    await c.send("hello");
    let finishPoll!: (value: unknown) => void;
    fetchMock.mockImplementation(() => new Promise(resolve => { finishPoll = resolve; }));
    await vi.advanceTimersByTimeAsync(2000);
    c.socket.frame({ type: "delivery", deliveryId: c.echoes()[0].id, state: "delivered" });
    finishPoll({ ok: true, status: 200, text: async () => JSON.stringify({ state: "queued" }) });
    await vi.advanceTimersByTimeAsync(1200);
    expect(c.echoes()).toHaveLength(0);
    expect(c.el.find("pc-pending")!.hidden).toBe(true);
  });

  it("reserves the next matching row for a receipt settled before the transcript arrives", async () => {
    const c = chat();
    await c.send("yes");
    await c.send("yes");
    const [one, two] = c.echoes();
    c.socket.frame({ type: "delivery", deliveryId: one.id, state: "delivered" });
    await vi.advanceTimersByTimeAsync(1200);
    c.socket.frame({ type: "append", totalLines: 1, entries: [user(0, "yes")] });
    expect(c.echoes().map(e => e.id)).toEqual([two.id]);
    c.socket.frame({ type: "append", totalLines: 2, entries: [user(1, "yes")] });
    expect(c.echoes()).toHaveLength(0);
  });

  it("labels unknown receipts separately from queued and keeps polling", async () => {
    fetchMock.mockImplementation(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ state: "unknown" }) }));
    const c = chat();
    await c.send("hello");
    expect(c.el.find("pc-pending-state unknown")?.textContent).toBe("Unknown");
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/v1/prompt/status"))).toBe(true);
  });
});

it("applies preview changes and clears carried by append and backlog frames", () => {
  const c = chat();
  const preview = { turnStartedAt: "2026-10-13T12:00:00.000Z", text: "Finished reply" };
  c.socket.frame({ type: "preview", preview });
  expect(timeline.render.mock.calls.at(-1)![1]).toMatchObject(preview);
  c.socket.frame({ type: "append", totalLines: 1, entries: [{ line: 0, raw: { type: "assistant", message: { role: "assistant", content: "Finished reply" } } }], preview: null });
  expect(timeline.render.mock.calls.at(-1)![1]).toBeNull();
  c.socket.frame({ type: "backlog", totalLines: 1, entries: [], preview });
  expect(timeline.render.mock.calls.at(-1)![1]).toMatchObject(preview);
  c.socket.frame({ type: "append", totalLines: 1, entries: [] });
  expect(timeline.render.mock.calls.at(-1)![1]).toMatchObject(preview);
});

describe("computer-scoped drafts", () => {
  function composer(computer: string) { const c = createComposer({ computer, target, provider: "claude" }); views.push(c); return c.el as Element; }
  it("keeps drafts separate for the same target on two computers", () => {
    const mini = composer("mini");
    mini.find("pc-input")!.value = "mini draft";
    mini.find("pc-input")!.fire("input");
    expect(composer("book").find("pc-input")!.value).toBe("");
    expect(composer("mini").find("pc-input")!.value).toBe("mini draft");
  });
  it("moves a legacy draft once to the first computer that reads it", () => {
    const legacy = "phren.composer.draft.claude:default:1:s1";
    storage.set(legacy, "saved draft");
    expect(composer("mini").find("pc-input")!.value).toBe("saved draft");
    expect(storage.has(legacy)).toBe(false);
    expect(composer("book").find("pc-input")!.value).toBe("");
    expect(composer("mini").find("pc-input")!.value).toBe("saved draft");
  });
});
