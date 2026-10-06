/**
 * phren on the graph: he goes where the store was just touched, which is what
 * gives watch mode a face rather than an abstract pulse.
 */

import { describe, expect, it } from "vitest";
import { GraphMascot } from "./mascot.js";
import type { Point } from "./layout.js";

const positions = new Map<string, Point>([
  ["a", { x: 0, y: 0 }],
  ["b", { x: 100, y: 0 }],
  ["c", { x: 100, y: 100 }],
]);

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("GraphMascot", () => {
  it("arrives instantly the first time rather than walking in from nowhere", () => {
    const m = new GraphMascot();
    m.walkTo("b", positions);
    expect(m.pos).toEqual({ x: 100, y: 0 });
    expect(m.moving).toBe(true);
    m.step();
    expect(m.moving).toBe(false);
  });

  it("walks toward a later target and settles on it", () => {
    const m = new GraphMascot();
    m.walkTo("a", positions);
    m.step();
    m.walkTo("b", positions);
    expect(m.pos!.x).toBe(0);
    let guard = 0;
    while (m.step() && guard++ < 500) { /* walk */ }
    expect(guard).toBeGreaterThan(1); // it took real steps, not a teleport
    expect(m.pos!.x).toBeCloseTo(100, 1);
    expect(m.targetNodeId).toBe("b");
  });

  it("ignores a node that is not on the graph", () => {
    const m = new GraphMascot();
    m.walkTo("nowhere", positions);
    expect(m.pos).toBeNull();
    expect(m.targetNodeId).toBeNull();
  });

  it("sparkles on arrival and fades", () => {
    const c = clock();
    const m = new GraphMascot(c.now);
    m.walkTo("a", positions);
    m.step();
    expect(m.arrivalGlow()).toBeCloseTo(1, 1);
    c.advance(700);
    expect(m.arrivalGlow()).toBeGreaterThan(0);
    expect(m.arrivalGlow()).toBeLessThan(1);
    c.advance(1000);
    expect(m.arrivalGlow()).toBe(0);
  });

  it("wanders only after a long quiet spell, never while busy", () => {
    const c = clock();
    const m = new GraphMascot(c.now);
    m.walkTo("a", positions);
    m.step();
    const ids = ["a", "b", "c"];

    expect(m.maybeWander(ids, positions)).toBe(false); // too soon
    c.advance(13_000);
    expect(m.maybeWander(ids, positions)).toBe(true);
    expect(m.targetNodeId).toBe("b");
    // Busy walking, so it will not pick a new destination mid-trip.
    expect(m.maybeWander(ids, positions)).toBe(false);
  });

  it("a lookup resets the idle clock, so he does not wander off mid-activity", () => {
    const c = clock();
    const m = new GraphMascot(c.now);
    m.walkTo("a", positions);
    m.step();
    c.advance(11_000);
    m.walkTo("b", positions);           // a lookup landed
    while (m.step()) { /* settle */ }
    c.advance(2_000);                   // 13s since the first visit, 2s since the last
    expect(m.maybeWander(["a", "b", "c"], positions)).toBe(false);
  });

  it("forgets where he was when the layout is rebuilt", () => {
    const m = new GraphMascot();
    m.walkTo("a", positions);
    m.reset();
    expect(m.pos).toBeNull();
    expect(m.moving).toBe(false);
    expect(m.arrivalGlow()).toBe(0);
  });

  it("does nothing without anywhere to go", () => {
    const m = new GraphMascot();
    expect(m.step()).toBe(false);
    expect(m.maybeWander([], positions)).toBe(false);
  });
});
