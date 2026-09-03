/**
 * The controller is the terminal graph's brain: what a key does, when the
 * graph rebuilds, how selection and search behave. It is exercised here with
 * a fixture payload instead of a real store.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphPayload } from "../../graph-core/types.js";
import { FILTER_PRESETS, GraphController } from "./controller.js";
import { GraphWatch } from "./watch.js";
import type { LookupEvent } from "../../governance/activity.js";

const DAY = 86400000;

function fixture(): GraphPayload {
  const stale = new Date(Date.now() - 200 * DAY).toISOString();
  return {
    nodes: [
      { id: "hub", label: "hub", group: "project", project: "hub", findingCount: 2, taskCount: 1 },
      { id: "api", label: "api", group: "project", project: "api", findingCount: 1, taskCount: 0 },
      { id: "f1", label: "Retry uses jitter", fullLabel: "Retry uses jitter for backoff", group: "topic:architecture", project: "hub", topicSlug: "architecture", scoreKey: "k1" },
      { id: "f2", label: "Old retry note", group: "topic:debugging", project: "hub", topicSlug: "debugging", scoreKey: "k2" },
      { id: "f3", label: "Rate limit is 100/s", group: "topic:api", project: "api", topicSlug: "api" },
      { id: "t1", label: "Ship retry docs", group: "task-active", project: "hub", section: "Active" },
      { id: "e1", label: "PolicyRetry", group: "entity", entityType: "class", refCount: 3, refDocs: [{ doc: "hub/FINDINGS.md", project: "hub" }, { doc: "api/FINDINGS.md", project: "api" }] },
    ],
    links: [
      { source: "hub", target: "f1" },
      { source: "hub", target: "f2" },
      { source: "hub", target: "t1" },
      { source: "api", target: "f3" },
      { source: "e1", target: "hub" },
      { source: "e1", target: "api" },
      { source: "f1", target: "f2", kind: "supersedes" },
    ],
    scores: { k2: { lastUsedAt: stale } },
  };
}

function make(opts: { token?: () => string; builder?: () => Promise<GraphPayload> } = {}) {
  const builder = vi.fn(opts.builder ?? (async () => fixture()));
  const controller = new GraphController("/store", "default", {
    builder,
    tokenOf: opts.token ?? (() => "t1"),
    frameMs: 5,
  });
  return { controller, builder };
}

function host() {
  return { messages: [] as string[], inputs: [] as string[], setMessage(m: string) { this.messages.push(m); }, startInput(ctx: string, initial: string) { this.inputs.push(`${ctx}:${initial}`); } };
}

const controllers: GraphController[] = [];
afterEach(() => { for (const c of controllers.splice(0)) c.dispose(); });

describe("data loading", () => {
  it("blocks the first render on the build when there is no repaint hook, then reuses the payload", async () => {
    const { controller, builder } = make();
    controllers.push(controller);
    expect(controller.status).toBe("idle");
    await controller.ensureData();
    expect(controller.status).toBe("ready");
    expect(controller.visible.nodes.length).toBe(7);
    await controller.ensureData();
    expect(builder).toHaveBeenCalledTimes(1);
  });

  it("rebuilds exactly once when the store token changes, keeping the old picture meanwhile", async () => {
    let token = "t1";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const { controller, builder } = make({
      token: () => token,
      builder: async () => { calls++; if (calls > 1) await gate; return fixture(); },
    });
    controllers.push(controller);
    await controller.ensureData();
    controller.setRepaintHook(() => {});
    token = "t2";
    // The token is re-read at most every 2s; force a fresh read.
    vi.useFakeTimers({ now: Date.now() + 5000 });
    try {
      await controller.ensureData();
      await controller.ensureData();
      expect(controller.refreshing).toBe(true);
      expect(controller.status).toBe("ready");
      expect(builder).toHaveBeenCalledTimes(2);
      release();
      await gate;
      await vi.waitFor(() => expect(controller.refreshing).toBe(false));
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces a failed build and lets r retry", async () => {
    let fail = true;
    const { controller } = make({ builder: async () => { if (fail) throw new Error("boom"); return fixture(); } });
    controllers.push(controller);
    await controller.ensureData();
    expect(controller.status).toBe("error");
    expect(controller.errorText).toBe("boom");
    fail = false;
    const h = host();
    expect(controller.handleKey("r", h)).toBe(true);
    await controller.ensureData();
    expect(controller.status).toBe("ready");
  });
});

describe("keys", () => {
  async function ready() {
    const { controller } = make();
    controllers.push(controller);
    await controller.ensureData();
    controller.setViewport(200, 100);
    return controller;
  }

  it("declines the keys the shell owns", async () => {
    const c = await ready();
    const h = host();
    for (const key of ["q", ":", "?", "p", "h", "\t"]) expect(c.handleKey(key, h)).toBeUndefined();
    expect(c.handleKey("\x1b", h)).toBeUndefined(); // nothing to clear → shell goes back
  });

  it("walks along the geometry: the first arrow selects the centre node, later ones follow direction", async () => {
    const c = await ready();
    const h = host();
    expect(c.handleKey("\x1b[C", h)).toBe(true);
    expect(c.selectedId).not.toBeNull();
    const first = c.selectedId!;
    const from = c.positions.get(first)!;
    c.handleKey("\x1b[C", h);
    const second = c.selectedId!;
    expect(second).not.toBe(first);
    const to = c.positions.get(second)!;
    expect(to.x).toBeGreaterThan(from.x);
    // Application-cursor spelling is normalised too.
    expect(c.handleKey("\x1bOD", h)).toBe(true);
  });

  it("jumps to numbered neighbours and describes them", async () => {
    const c = await ready();
    const h = host();
    c.select("hub");
    const neighbours = c.neighborsOf("hub").map((n) => n.id);
    expect(neighbours).toContain("f1");
    expect(c.handleKey("1", h)).toBe(true);
    expect(c.selectedId).toBe(neighbours[0]);
    expect(h.messages.at(-1)).toContain(c.model.nodeById.get(neighbours[0])!.label);
    expect(c.handleKey("9", h)).toBe(true);
    expect(h.messages.at(-1)).toContain("no such neighbour");
  });

  it("layers Escape: search, then selection, then project focus, then falls through", async () => {
    const c = await ready();
    const h = host();
    c.focusProject("hub");
    c.applySearch("retry");
    expect(c.selectedId).toBe("f1");
    expect(c.handleKey("\x1b", h)).toBe(true);
    expect(c.search.query).toBe("");
    expect(c.handleKey("\x1b", h)).toBe(true);
    expect(c.selectedId).toBeNull();
    expect(c.handleKey("\x1b", h)).toBe(true);
    expect(c.focusedProject).toBeNull();
    expect(c.handleKey("\x1b", h)).toBeUndefined();
  });

  it("searches: best match first, n/N cycle, non-matches stay on the map", async () => {
    const c = await ready();
    const h = host();
    expect(c.handleKey("/", h)).toBe(true);
    expect(h.inputs).toEqual(["graph-search:"]);
    const best = c.applySearch("retry");
    expect(best?.id).toBe("f1"); // label prefix beats substring
    expect(c.search.results.map((n) => n.id)).toEqual(expect.arrayContaining(["f1", "t1", "e1", "f2"]));
    expect(c.visible.nodes.length).toBe(7);
    c.handleKey("n", h);
    expect(c.search.index).toBe(1);
    c.handleKey("N", h);
    expect(c.search.index).toBe(0);
    expect(c.handleKey("/", h)).toBe(true);
    expect(h.inputs.at(-1)).toBe("graph-search:retry");
  });

  it("cycles filter presets and project focus, changing what is visible", async () => {
    const c = await ready();
    const h = host();
    c.handleKey("f", h);
    expect(c.preset.name).toBe(FILTER_PRESETS[1].name);
    expect(c.visible.nodes.every((n) => n.kind === "project" || n.kind === "finding")).toBe(true);
    c.handleKey("F", h);
    expect(c.preset.name).toBe("all");
    for (let i = 0; i < FILTER_PRESETS.length - 1; i++) c.handleKey("f", h);
    expect(c.preset.name).toBe("aging");
    expect(c.visible.nodes.filter((n) => n.kind !== "project").map((n) => n.id)).toEqual(["f2"]);
    c.cyclePreset(1);
    expect(c.handleKey("]", h)).toBe(true);
    expect(c.focusedProject).toBe("api");
    expect(c.visible.nodes.map((n) => n.id).sort()).toEqual(["api", "e1", "f3"]);
    expect(c.selectedId).toBe("api");
    c.handleKey("]", h);
    expect(c.focusedProject).toBe("hub");
    c.handleKey("]", h);
    expect(c.focusedProject).toBeNull();
    expect(c.visible.nodes.length).toBe(7);
  });

  it("Enter selects the centre node, then toggles focus on a project", async () => {
    const c = await ready();
    const h = host();
    expect(c.handleKey("\r", h)).toBe(true);
    expect(c.selectedId).not.toBeNull();
    c.select("hub");
    c.handleKey("\r", h);
    expect(c.focusedProject).toBe("hub");
    c.handleKey("\r", h);
    expect(c.focusedProject).toBeNull();
  });

  it("zooms, pans and refits", async () => {
    const c = await ready();
    const h = host();
    const scale = c.camera.scale;
    c.handleKey("+", h);
    expect(c.camera.scale).toBeCloseTo(scale * 1.25, 5);
    c.handleKey("-", h);
    expect(c.camera.scale).toBeCloseTo(scale, 5);
    const cx = c.camera.cx;
    c.handleKey("\x1b[1;2C", h);
    expect(c.camera.cx).toBeGreaterThan(cx);
    c.handleKey("L", h);
    c.handleKey("0", h);
    expect(c.camera.cx).toBeCloseTo(cx, 5);
  });
});

describe("animation", () => {
  it("settles through the repaint hook and stops on its own", async () => {
    const { controller } = make();
    controllers.push(controller);
    const repaints: number[] = [];
    controller.setRepaintHook(() => repaints.push(Date.now()));
    await controller.ensureData();
    await vi.waitFor(() => expect(controller.status).toBe("ready"));
    expect(controller.animating).toBe(true);
    await vi.waitFor(() => expect(controller.animating).toBe(false), { timeout: 5000 });
    expect(repaints.length).toBeGreaterThan(2);
    const before = repaints.length;
    controller.flyTo("api");
    expect(controller.animating).toBe(true);
    await vi.waitFor(() => expect(controller.animating).toBe(false), { timeout: 5000 });
    expect(repaints.length).toBeGreaterThan(before);
    const p = controller.positions.get("api")!;
    expect(controller.camera.cx).toBeCloseTo(p.x, 3);
    controller.dispose();
    expect(controller.animating).toBe(false);
  });
});

describe("watch mode", () => {
  /** A controller wired to a hand-fed event tail instead of a log file. */
  async function watched(opts: { watchEnabled?: boolean } = {}) {
    const queue: LookupEvent[][] = [];
    const watch = new GraphWatch("/store", {
      tail: { poll: () => queue.shift() ?? [] },
      backfill: () => [],
    });
    const controller = new GraphController("/store", "", {
      builder: async () => fixture(),
      tokenOf: () => "t",
      frameMs: 5,
      watch,
      ...opts,
    });
    controllers.push(controller);
    await controller.ensureData();
    controller.setViewport(200, 100);
    const emit = (...events: LookupEvent[]) => { queue.push(events); watch.poll(); };
    return { controller, watch, emit };
  }

  const lookup = (over: Partial<LookupEvent> = {}): LookupEvent => ({
    at: new Date().toISOString(), query: "retry", project: "hub",
    filename: "FINDINGS.md", type: "findings", source: "search", ...over,
  });

  it("starts tailing when the view opens and stops on dispose", async () => {
    const { controller, watch } = await watched();
    expect(watch.running).toBe(true);
    controller.dispose();
    expect(watch.running).toBe(false);
  });

  it("selects and flies to the node an event lands on", async () => {
    const { controller, emit } = await watched();
    expect(controller.selectedId).toBeNull();
    emit(lookup({ nodeId: "f1", snippet: "Retry uses jitter" }));
    expect(controller.selectedId).toBe("f1");
    expect(controller.watch.heatOf("f1")).toBeGreaterThan(0);
    expect(controller.watch.activity[0].event.snippet).toBe("Retry uses jitter");
  });

  it("follows the newest event that is actually on the graph", async () => {
    const { controller, emit } = await watched();
    emit(lookup({ nodeId: "f1" }), lookup({ nodeId: "not-a-node" }));
    // The newest resolvable node wins; an unknown id never steals the camera.
    expect(controller.selectedId).toBe("f1");
  });

  it("falls back to the project node when an event has no finding id", async () => {
    const { controller, emit } = await watched();
    emit(lookup({ project: "api", type: "reference", filename: "reference/x.md" }));
    expect(controller.selectedId).toBe("api");
  });

  it("does not steal the camera while the user is navigating", async () => {
    const { controller, emit } = await watched();
    const host = { messages: [] as string[], setMessage(m: string) { this.messages.push(m); }, startInput() {} };
    controller.handleKey("\x1b[C", host);      // user walks the graph
    const chosen = controller.selectedId;
    emit(lookup({ nodeId: "f2" }));
    expect(controller.selectedId).toBe(chosen);  // selection left alone
    expect(controller.watch.heatOf("f2")).toBeGreaterThan(0); // but it still lights up
    expect(controller.watch.activity[0].event.query).toBe("retry");
  });

  it("w toggles watching, and toggling does not count as navigating", async () => {
    const { controller, watch } = await watched();
    const host = { messages: [] as string[], setMessage(m: string) { this.messages.push(m); }, startInput() {} };
    expect(controller.handleKey("w", host)).toBe(true);
    expect(controller.watchEnabled).toBe(false);
    expect(watch.running).toBe(false);
    expect(controller.handleKey("w", host)).toBe(true);
    expect(controller.watchEnabled).toBe(true);
    expect(watch.running).toBe(true);
  });

  it("stays off when started with watching disabled", async () => {
    const { controller, watch, emit } = await watched({ watchEnabled: false });
    expect(watch.running).toBe(false);
    emit(lookup({ nodeId: "f1" }));
    expect(controller.selectedId).toBeNull();
  });
});
