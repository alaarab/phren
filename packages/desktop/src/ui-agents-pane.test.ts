import { afterEach, expect, it, vi } from "vitest";
const hooks = vi.hoisted(() => ({ terminal: vi.fn(), doc: null as null | { kind: string; persist: object; mount: (root: object) => void } }));
vi.mock("../ui/terminal.js", () => ({ openTerminal: hooks.terminal }));
vi.mock("../ui/sidebar.js", () => ({ renderSidebar: vi.fn() }));
vi.mock("../ui/chat.js", () => ({ openChat: vi.fn() }));
vi.mock("../ui/changes.js", () => ({ openChanges: vi.fn() }));
vi.mock("../ui/editor.js", () => ({ openFileTree: vi.fn(), openEditorDoc: vi.fn() }));
vi.mock("../ui/search.js", () => ({ openSearch: vi.fn() }));
vi.mock("../ui/keys.js", () => ({ setActiveSession: vi.fn() }));
vi.mock("../ui/shell/launch.js", () => ({ openLaunchSheet: vi.fn() }));
vi.mock("../ui/shell/sections.js", () => ({ showSection: vi.fn() }));
vi.mock("../ui/shell/store.js", () => ({ projectOf: () => "", store: { subscribe: vi.fn() } }));
vi.mock("../ui/shell/quota-warn-sheet.js", () => ({ watchQuotaWarnings: () => ({ check: vi.fn(), close: vi.fn() }) }));
vi.mock("../ui/shell/tiles.js", () => ({ createTiles: () => ({ saved: () => null, open: (doc: typeof hooks.doc) => { hooks.doc = doc; doc!.mount({}); } }) }));
// @ts-expect-error Plain ESM UI.
import { mountAgents } from "../ui/sections/agents.js";
class Node {
  style = {};
  append() {}
  classList = { toggle: vi.fn(), add: vi.fn() };
  selectors = new Map<string, Node>();
  querySelector(selector: string): Node { if (!this.selectors.has(selector)) this.selectors.set(selector, new Node()); return this.selectors.get(selector)!; }
  querySelectorAll() { return []; }
  addEventListener() {}
  setAttribute() {}
}
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); hooks.doc = null; });
it.each(["tmux", "tmux-login", "default"])("opens the returned pane on %s through the known-pane console path", (server) => {
  vi.stubGlobal("window", { innerWidth: 1280, addEventListener: vi.fn() });
  vi.stubGlobal("document", { body: new Node(), createElement: () => new Node(), addEventListener: vi.fn() });
  vi.stubGlobal("localStorage", { getItem: () => null });
  const agents = mountAgents(new Node());
  agents.openPane("Studio", { server, workspace: "s7", tab: "w19", pane: "p42" });
  expect(hooks.doc!.kind).toBe("console");
  expect(hooks.doc!.persist).toMatchObject({ computer: "Studio", server, pane: "p42" });
  expect(hooks.terminal).toHaveBeenCalledWith(expect.any(Object), "Studio", server, { pane: "p42" });
});
