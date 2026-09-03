import { describe, expect, it } from "vitest";
import type { RawLink } from "../../graph-core/types.js";
import type { LayoutNode, Point } from "./layout.js";
import { DEFAULT_ORBIT, buildOrbitLayout, parseMouse, projectOrbit, yawDelta, yawToFace } from "./orbit.js";

function flatStore() {
  const nodes: LayoutNode[] = [];
  const links: RawLink[] = [];
  const flat = new Map<string, Point>();
  ["a", "b", "c", "d"].forEach((p, i) => {
    nodes.push({ id: `project:${p}`, kind: "project", project: p, size: 6 });
    flat.set(`project:${p}`, { x: i * 100, y: 0 });
    for (let k = 0; k < 5; k++) {
      const id = `finding:${p}${k}`;
      nodes.push({ id, kind: "finding", project: p, size: 2 });
      flat.set(id, { x: i * 100 + (k - 2) * 6, y: (k % 2 ? 1 : -1) * 8 });
      links.push({ source: `project:${p}`, target: id, kind: "star" });
    }
  });
  nodes.push({ id: "fragment:shared", kind: "fragment", size: 3 });
  flat.set("fragment:shared", { x: 150, y: 40 });
  links.push({ source: "finding:a0", target: "fragment:shared", kind: "fragment" }, { source: "finding:c0", target: "fragment:shared", kind: "fragment" });
  links.push({ source: "project:a", target: "fragment:shared" }, { source: "project:c", target: "fragment:shared" });
  nodes.push({ id: "orphan", kind: "reference", size: 2 });
  flat.set("orphan", { x: 0, y: 0 });
  return { nodes, links, flat };
}

describe("buildOrbitLayout", () => {
  it("puts every project on the sphere and each finding near its home", () => {
    const { nodes, links, flat } = flatStore();
    const { positions, radius } = buildOrbitLayout(nodes, links, flat);
    for (const p of ["a", "b", "c", "d"]) {
      const v = positions.get(`project:${p}`)!;
      expect(Math.hypot(v.x, v.y / 0.82, v.z)).toBeCloseTo(radius, 5);
      for (let k = 0; k < 5; k++) {
        const f = positions.get(`finding:${p}${k}`)!;
        const home = Math.hypot(f.x - v.x, f.y - v.y, f.z - v.z);
        // Closer to its own project than to any other.
        for (const q of ["a", "b", "c", "d"]) {
          if (q === p) continue;
          const o = positions.get(`project:${q}`)!;
          expect(home).toBeLessThan(Math.hypot(f.x - o.x, f.y - o.y, f.z - o.z));
        }
      }
    }
  });

  it("drops a shared fragment into the middle and an orphan onto the outer shell", () => {
    const { nodes, links, flat } = flatStore();
    const { positions, radius } = buildOrbitLayout(nodes, links, flat);
    const shared = positions.get("fragment:shared")!;
    expect(Math.hypot(shared.x, shared.y, shared.z)).toBeLessThan(radius * 0.7);
    const orphan = positions.get("orphan")!;
    expect(Math.hypot(orphan.x, orphan.y / 0.82, orphan.z)).toBeGreaterThan(radius * 1.2);
  });

  it("is deterministic", () => {
    const { nodes, links, flat } = flatStore();
    const a = buildOrbitLayout(nodes, links, flat);
    const b = buildOrbitLayout(nodes, links, flat);
    expect([...a.positions]).toEqual([...b.positions]);
  });
});

describe("projectOrbit", () => {
  const viewport = { width: 200, height: 100 };
  it("draws the near side bright and the far side dim", () => {
    const near = projectOrbit({ x: 0, y: 0, z: 50 }, { ...DEFAULT_ORBIT, pitch: 0 }, viewport, 50);
    const far = projectOrbit({ x: 0, y: 0, z: -50 }, { ...DEFAULT_ORBIT, pitch: 0 }, viewport, 50);
    expect(near.t).toBeLessThan(far.t);
    expect(near.x).toBeCloseTo(100, 5);
    expect(far.x).toBeCloseTo(100, 5);
  });

  it("yawToFace turns a point to the front", () => {
    const v = { x: 50, y: 0, z: 0 };
    const yaw = yawToFace(v);
    const p = projectOrbit(v, { yaw, pitch: 0, zoom: 1 }, viewport, 50);
    expect(p.t).toBeLessThan(0.2);
    expect(p.x).toBeCloseTo(100, 3);
  });

  it("yawDelta takes the short way round", () => {
    expect(yawDelta(0.1, Math.PI * 2 - 0.1)).toBeCloseTo(-0.2, 6);
    expect(yawDelta(-3, 3)).toBeCloseTo(-(Math.PI * 2 - 6), 6);
  });

  it("zoom scales about the centre", () => {
    const a = projectOrbit({ x: 20, y: 0, z: 0 }, { yaw: 0, pitch: 0, zoom: 1 }, viewport, 50);
    const b = projectOrbit({ x: 20, y: 0, z: 0 }, { yaw: 0, pitch: 0, zoom: 2 }, viewport, 50);
    expect(b.x - 100).toBeCloseTo((a.x - 100) * 2, 5);
  });
});

describe("parseMouse", () => {
  it("decodes press, drag, release and wheel from SGR reports", () => {
    expect(parseMouse("\x1b[<0;10;5M")).toEqual({ type: "press", button: 0, col: 9, row: 4 });
    expect(parseMouse("\x1b[<32;12;6M")).toEqual({ type: "drag", button: 0, col: 11, row: 5 });
    expect(parseMouse("\x1b[<0;12;6m")).toEqual({ type: "release", button: 0, col: 11, row: 5 });
    expect(parseMouse("\x1b[<64;3;3M")).toEqual({ type: "wheel", delta: -1, col: 2, row: 2 });
    expect(parseMouse("\x1b[<65;3;3M")).toEqual({ type: "wheel", delta: 1, col: 2, row: 2 });
  });

  it("leaves ordinary keys alone", () => {
    expect(parseMouse("\x1b[A")).toBeNull();
    expect(parseMouse("v")).toBeNull();
    expect(parseMouse("\x1b[<0;10M")).toBeNull();
  });
});
