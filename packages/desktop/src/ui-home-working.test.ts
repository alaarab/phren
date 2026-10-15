import { afterEach, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("../ui/api.js", () => ({ hookPost: hooks.post }));
vi.mock("../ui/shell/palette.js", () => ({ registerCommand: vi.fn() }));
// @ts-expect-error plain ESM without declarations
import { createWorking } from "../ui/sections/home/working.js";
// @ts-expect-error plain ESM without declarations
import { homeRows } from "../ui/sections/home/rows.js";

const doc = { activeElement: null as unknown };
class FakeNode {
  constructor(public tagName = "DIV") {}
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
  querySelectorAll(selector: string): FakeNode[] { return this.children.flatMap((child) => [...(selector === "button" && child.tagName === "BUTTON" ? [child] : []), ...child.querySelectorAll(selector)]); }
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); doc.activeElement = null; });

function stubDocument() {
  vi.stubGlobal("HTMLElement", FakeNode);
  vi.stubGlobal("document", Object.assign(doc, {
    body: new FakeNode(), createElement: (tag: string) => new FakeNode(tag.toUpperCase()), querySelector: () => null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }));
}

const child = (id: string, agentStatus = "working") => ({ id, title: `Build ${id}`, agentStatus, cwd: "/repo/phren", target: { server: "default", pane: id, session: id } });
function setup() {
  stubDocument();
  const scope = new FakeNode();
  const state = { merged: { computers: [] as object[] } };
  const open = vi.fn();
  const block = () => scope;
  const working = createWorking({ state, block, ...homeRows({ state, open, block }) });
  const publish = (children = [child("one"), child("two")], computerState = "online") => {
    state.merged = { computers: [{ computer: "Desk", state: computerState, overview: { groups: [{ children }] } }] };
    working.render();
  };
  publish();
  return { list: scope.querySelector(".home-list"), publish, working, open };
}

it("stops the selected target without opening chat, with a focusable busy control", async () => {
  let finish!: () => void;
  hooks.post.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  const { list, working, open } = setup();
  try {
    const stop = list.children[1].children[1];
    expect(stop.tagName).toBe("BUTTON");
    expect(stop.title).toBe("Stop Build two");
    expect(stop.attributes.get("aria-label")).toBe("Stop Build two");
    const event = { stopPropagation: vi.fn() };
    const pending = stop.listeners.get("click")!(event);
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(hooks.post).toHaveBeenCalledWith("Desk", "/v1/keys", { target: child("two").target, keys: ["Escape"] });
    expect(open).not.toHaveBeenCalled();
    expect(stop.attributes.get("aria-busy")).toBe("true");
    expect(stop.attributes.get("aria-disabled")).toBe("true");
    await stop.listeners.get("click")!(event);
    expect(hooks.post).toHaveBeenCalledOnce();
    finish();
    await pending;
    expect(stop.attributes.get("aria-busy")).toBe("false");
    expect(stop.textContent).toBe("■");
  } finally { working.destroy(); }
});

it("shows a stop failure only on its row through polls and clears it after a few seconds", async () => {
  vi.useFakeTimers();
  hooks.post.mockRejectedValueOnce(new Error("Hook refused Escape"));
  const { list, publish, working } = setup();
  try {
    await list.children[0].children[1].listeners.get("click")!({ stopPropagation: vi.fn() });
    const error = list.children[0].children[2];
    expect(error.textContent).toBe("Hook refused Escape");
    expect(error.hidden).toBe(false);
    expect(list.children[1].children[2].hidden).toBe(true);
    publish();
    expect(list.children[0].children[2]).toBe(error);
    expect(error.hidden).toBe(false);
    vi.advanceTimersByTime(4000);
    expect(error.hidden).toBe(true);
    expect(error.textContent).toBe("");
  } finally { working.destroy(); vi.useRealTimers(); }
});

it("omits idle and offline stop controls and retains Stop focus across changed and reordered polls", () => {
  const { list, publish, working, open } = setup();
  try {
    const stop = list.children[1].children[1];
    stop.focus();
    publish();
    expect(doc.activeElement).toBe(stop);
    publish([{ ...child("two"), title: "Renamed", currentStep: "Editing" }, child("one")] as ReturnType<typeof child>[]);
    expect(list.children[0].children[1]).toBe(stop);
    expect(doc.activeElement).toBe(stop);
    expect(stop.title).toBe("Stop Renamed");
    const chat = list.children[0].children[0].querySelectorAll("button")[0];
    chat.focus();
    publish([child("one"), { ...child("two"), title: "Updated again" }]);
    const currentChat = list.children[1].children[0].querySelectorAll("button")[0];
    expect(doc.activeElement).toBe(currentChat);
    currentChat.listeners.get("click")!({});
    expect(open).toHaveBeenLastCalledWith("Desk", { ...child("two"), title: "Updated again" });

    publish([child("idle", "idle")]);
    expect(list.children[0].className).toBe("home-empty");
    publish([child("one")], "offline");
    expect(list.children[0].className).toBe("home-empty");
    expect(hooks.post).not.toHaveBeenCalled();
  } finally { working.destroy(); }
});
