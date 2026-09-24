/**
 * Watch mode is the feature where a graph open in one terminal lights up as
 * an agent works in another. These tests drive it with an injected tail, so
 * no files or timers are involved.
 */

import { describe, expect, it, vi } from "vitest";
import type { LookupEvent } from "../../governance/activity.js";
import { ACTIVITY_LIMIT, GraphWatch, HEAT_MS, formatAge, targetNodeId } from "./watch.js";

function ev(over: Partial<LookupEvent> = {}): LookupEvent {
  return { at: "2026-09-02T00:00:00.000Z", query: "retry", project: "hub", filename: "FINDINGS.md", type: "findings", source: "search", ...over };
}

function harness(opts: { events?: LookupEvent[][]; backfill?: LookupEvent[] } = {}) {
  const queue = opts.events ?? [];
  let now = 1_000_000;
  const watch = new GraphWatch("/store", {
    tail: { poll: () => queue.shift() ?? [] },
    backfill: () => opts.backfill ?? [],
    now: () => now,
  });
  return { watch, advance: (ms: number) => { now += ms; }, at: () => now };
}

describe("targetNodeId", () => {
  it("prefers the precomputed finding node, and falls back to the project", () => {
    expect(targetNodeId(ev({ nodeId: "finding:abc" }))).toBe("finding:abc");
    expect(targetNodeId(ev())).toBe("hub");
    expect(targetNodeId(ev({ project: "" }))).toBeUndefined();
  });
});

describe("GraphWatch", () => {
  it("backfills history without lighting anything up", () => {
    const { watch } = harness({ backfill: [ev({ query: "old", nodeId: "finding:old" })] });
    watch.start(() => {});
    expect(watch.activity).toHaveLength(1);
    expect(watch.activity[0].historical).toBe(true);
    expect(watch.heatOf("finding:old")).toBe(0);
    expect(watch.hot).toBe(false);
  });

  it("delivers new events, lights their nodes, and keeps the feed newest first", () => {
    const seen: string[] = [];
    const { watch } = harness({ events: [[ev({ query: "a", nodeId: "n1" }), ev({ query: "b", nodeId: "n2" })]] });
    watch.start((items) => seen.push(...items.map((i) => i.event.query)));
    watch.poll();
    expect(seen).toEqual(["a", "b"]);
    expect(watch.activity.map((i) => i.event.query)).toEqual(["b", "a"]);
    expect(watch.activity.every((i) => i.historical)).toBe(false);
    expect(watch.heatOf("n1")).toBe(1);
    expect(watch.hot).toBe(true);
  });

  it("cools a node to nothing over HEAT_MS", () => {
    const { watch, advance } = harness({ events: [[ev({ nodeId: "n1" })]] });
    watch.start(() => {});
    watch.poll();
    expect(watch.heatOf("n1")).toBe(1);
    advance(HEAT_MS / 2);
    expect(watch.heatOf("n1")).toBeCloseTo(0.5, 5);
    expect(watch.hot).toBe(true);
    advance(HEAT_MS / 2 + 1);
    expect(watch.heatOf("n1")).toBe(0);
    expect(watch.hot).toBe(false);
  });

  it("bounds the feed", () => {
    const burst = Array.from({ length: ACTIVITY_LIMIT + 20 }, (_, i) => ev({ query: `q${i}` }));
    const { watch } = harness({ events: [burst] });
    watch.start(() => {});
    watch.poll();
    expect(watch.activity).toHaveLength(ACTIVITY_LIMIT);
    // Newest survives the trim; oldest is dropped.
    expect(watch.activity[0].event.query).toBe(`q${burst.length - 1}`);
  });

  it("is inert before start and after stop", () => {
    const { watch } = harness({ events: [[ev({ nodeId: "n1" })], [ev({ nodeId: "n2" })]] });
    expect(watch.running).toBe(false);
    expect(watch.poll()).toEqual([]);
    watch.start(() => {});
    expect(watch.running).toBe(true);
    watch.poll();
    watch.stop();
    expect(watch.running).toBe(false);
    expect(watch.poll()).toEqual([]);
    expect(watch.heatOf("n1")).toBe(0);
  });

  it("survives a tail that throws", () => {
    const watch = new GraphWatch("/store", { tail: { poll: () => { throw new Error("gone"); } }, backfill: () => [] });
    watch.start(() => {});
    expect(() => watch.poll()).not.toThrow();
    expect(watch.poll()).toEqual([]);
  });
});

describe("formatAge", () => {
  it("reads as a glance, not a timestamp", () => {
    expect(formatAge(300)).toBe("now");
    expect(formatAge(4000)).toBe("4s");
    expect(formatAge(120_000)).toBe("2m");
    expect(formatAge(7_200_000)).toBe("2h");
  });
});
