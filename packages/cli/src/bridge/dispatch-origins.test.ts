import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  conductorOriginChanged, prepareDispatchOriginHandover, trackDispatchOrigin, type DispatchOriginWindow,
} from "./dispatch-origins.js";

let root: string, windows: DispatchOriginWindow[];
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "phren-origins-"));
  vi.stubEnv("PHREN_BRIDGE_HOME", root);
  windows = [];
});
afterEach(async () => {
  for (const window of windows) window.finish();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
const track = () => {
  const window = trackDispatchOrigin();
  windows.push(window);
  return window;
};
const pane = (name: string) => ({ server: "default", workspace: "w1", tab: "t1", pane: name, terminal: `term-${name}` });
const origin = (name: string) => ({ ...pane(name), agent: "claude" as const });

describe("dispatch origin hand-over", () => {
  it("retargets an earlier alias when the conductor moves on again", () => {
    const window = track(), a = origin("a"), b = origin("b"), c = origin("c");
    prepareDispatchOriginHandover(pane("a"), b)();
    expect(window.rewrite(a)).toEqual(b);
    prepareDispatchOriginHandover(pane("b"), c)();
    expect(window.rewrite(a)).toEqual(c);
    expect(window.rewrite(b)).toEqual(c);
    expect(window.rewrite(c)).toEqual(c);
    // The window ends with the dispatch: no alias outlives it.
    window.finish();
    expect(window.rewrite(a)).toEqual(a);
  });

  it("seals operations started before or during the commit, never one started after it", () => {
    const before = track(), a = origin("a"), b = origin("b");
    const seal = prepareDispatchOriginHandover(pane("a"), b);
    const during = track();
    seal();
    const after = track();
    expect(before.rewrite(a)).toEqual(b);
    expect(during.rewrite(a)).toEqual(b);
    expect(after.rewrite(a)).toEqual(a);
  });

  it("leaves in-flight dispatches on the old origin when the role commit never seals", () => {
    const window = track(), a = origin("a"), b = origin("b");
    prepareDispatchOriginHandover(pane("a"), b);
    expect(window.rewrite(a)).toEqual(a);
    expect(window.rewrite(undefined)).toBeUndefined();
  });

  it("does not rewrite another pane on the same server", () => {
    const window = track(), a = origin("a"), b = origin("b"), other = origin("other");
    prepareDispatchOriginHandover(pane("a"), b)();
    expect(window.rewrite(other)).toEqual(other);
    expect(window.rewrite({ ...a, server: "elsewhere" })).toEqual({ ...a, server: "elsewhere" });
  });

  it("keeps only aliases whose destination still matches the conductor, ignoring fields it omitted", () => {
    const window = track(), a = origin("a"), b = origin("b");
    prepareDispatchOriginHandover(pane("a"), b)();
    conductorOriginChanged({ ...pane("b"), source: "codex" });
    expect(window.rewrite(a)).toEqual(a);
    window.finish();
    const kept = track();
    prepareDispatchOriginHandover(pane("a"), b)();
    conductorOriginChanged(pane("b"));
    expect(kept.rewrite(a)).toEqual(b);
  });

  it("scopes aliases to the bridge root where each dispatch started", async () => {
    const other = await mkdtemp(path.join(tmpdir(), "phren-origins-other-"));
    try {
      const a = origin("a"), b = origin("b");
      const here = track();
      vi.stubEnv("PHREN_BRIDGE_HOME", other);
      const elsewhere = track();
      prepareDispatchOriginHandover(pane("a"), b)();
      expect(elsewhere.rewrite(a)).toEqual(b);
      vi.stubEnv("PHREN_BRIDGE_HOME", root);
      expect(here.rewrite(a)).toEqual(a);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});
