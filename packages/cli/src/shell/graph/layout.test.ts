/**
 * The terminal graph must draw the same map every time a store opens, and it
 * must keep project clusters apart — otherwise arrow-key walking becomes a
 * lottery. These tests pin determinism and cluster separation.
 */

import { describe, expect, it } from "vitest";
import { ForceSim, IDEAL_DISTANCE, bounds, seedPositions, type LayoutNode } from "./layout.js";
import type { RawLink } from "../../graph-core/types.js";

function star(projects: number, leavesPer: number): { nodes: LayoutNode[]; links: RawLink[] } {
  const nodes: LayoutNode[] = [];
  const links: RawLink[] = [];
  for (let p = 0; p < projects; p++) {
    const project = `proj-${p}`;
    nodes.push({ id: project, kind: "project", project, size: 30 });
    for (let i = 0; i < leavesPer; i++) {
      const id = `${project}:f${i}`;
      nodes.push({ id, kind: "finding", project, size: 10 });
      links.push({ source: project, target: id });
    }
  }
  return { nodes, links };
}

function centroid(sim: ForceSim, ids: string[]): { x: number; y: number } {
  const pts = ids.map((id) => sim.positions.get(id)!);
  return { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length };
}

describe("seedPositions", () => {
  it("places leaves around their home project and orphans on the outer ring", () => {
    const { nodes, links } = star(3, 4);
    nodes.push({ id: "lonely", kind: "entity", size: 12 });
    const pos = seedPositions(nodes, links);
    const home = pos.get("proj-1")!;
    const leaf = pos.get("proj-1:f2")!;
    expect(Math.hypot(leaf.x - home.x, leaf.y - home.y)).toBeLessThan(IDEAL_DISTANCE * 2);
    const lonely = pos.get("lonely")!;
    expect(Math.hypot(lonely.x, lonely.y)).toBeGreaterThan(Math.hypot(home.x, home.y));
  });

  it("puts a fragment shared by two projects between them", () => {
    const { nodes, links } = star(2, 2);
    nodes.push({ id: "shared", kind: "entity", size: 12 });
    links.push({ source: "shared", target: "proj-0" }, { source: "shared", target: "proj-1" });
    const pos = seedPositions(nodes, links);
    const a = pos.get("proj-0")!;
    const b = pos.get("proj-1")!;
    const s = pos.get("shared")!;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    expect(Math.hypot(s.x - mid.x, s.y - mid.y)).toBeLessThan(IDEAL_DISTANCE);
  });
});

describe("ForceSim", () => {
  it("is deterministic", () => {
    const { nodes, links } = star(4, 12);
    const a = new ForceSim(nodes, links);
    const b = new ForceSim(nodes, links);
    a.settle();
    b.settle();
    for (const node of nodes) expect(a.positions.get(node.id)).toEqual(b.positions.get(node.id));
  });

  it("settles within the tick budget and keeps project clusters apart", () => {
    const { nodes, links } = star(4, 15);
    const sim = new ForceSim(nodes, links);
    sim.settle(400);
    expect(sim.settled).toBe(true);
    expect(sim.alpha).toBeLessThan(0.05);
    const clusters = [0, 1, 2, 3].map((p) => centroid(sim, nodes.filter((n) => n.project === `proj-${p}`).map((n) => n.id)));
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        expect(Math.hypot(clusters[i].x - clusters[j].x, clusters[i].y - clusters[j].y)).toBeGreaterThan(IDEAL_DISTANCE * 2);
      }
    }
    // Leaves stay near their own project rather than drifting to another cluster.
    for (const leaf of nodes.filter((n) => n.kind !== "project")) {
      const own = sim.positions.get(leaf.project!)!;
      const p = sim.positions.get(leaf.id)!;
      const ownDist = Math.hypot(p.x - own.x, p.y - own.y);
      for (const other of nodes.filter((n) => n.kind === "project" && n.id !== leaf.project)) {
        const o = sim.positions.get(other.id)!;
        expect(ownDist).toBeLessThan(Math.hypot(p.x - o.x, p.y - o.y));
      }
    }
    expect(bounds(sim.positions.values())).not.toBeNull();
  });

  it("warm-starts from a previous layout so a refresh does not scramble the map", () => {
    const { nodes, links } = star(3, 10);
    const first = new ForceSim(nodes, links);
    first.settle();
    const grown = { nodes: [...nodes, { id: "proj-0:new", kind: "finding" as const, project: "proj-0", size: 10 }], links: [...links, { source: "proj-0", target: "proj-0:new" }] };
    const second = new ForceSim(grown.nodes, grown.links);
    second.warmStart(first.positions);
    second.settle();
    let moved = 0;
    for (const node of nodes) {
      const a = first.positions.get(node.id)!;
      const b = second.positions.get(node.id)!;
      moved += Math.hypot(a.x - b.x, a.y - b.y);
    }
    expect(moved / nodes.length).toBeLessThan(IDEAL_DISTANCE);
    const fresh = second.positions.get("proj-0:new")!;
    const home = second.positions.get("proj-0")!;
    expect(Math.hypot(fresh.x - home.x, fresh.y - home.y)).toBeLessThan(IDEAL_DISTANCE * 3);
  });

  it("handles an empty graph", () => {
    const sim = new ForceSim([], []);
    sim.settle();
    expect(sim.settled).toBe(true);
    expect(bounds(sim.positions.values())).toBeNull();
  });
});

describe("packing the ring to its clusters", () => {
  /** Ring radius and mean cluster radius, both in aspect-corrected space. */
  function measure(projects: number, leavesPer: number, aspect = 2.4) {
    const { nodes, links } = star(projects, leavesPer);
    const sim = new ForceSim(nodes, links, undefined, aspect);
    sim.settle();
    const ids = nodes.filter((n) => n.kind === "project").map((n) => n.id);
    const norm = (id: string) => { const p = sim.positions.get(id)!; return { x: p.x / aspect, y: p.y }; };
    const ring = ids.reduce((sum, id) => { const p = norm(id); return sum + Math.hypot(p.x, p.y); }, 0) / ids.length;
    let cluster = 0;
    let count = 0;
    for (const id of ids) {
      const hub = norm(id);
      for (const leaf of nodes.filter((n) => n.project === id && n.kind !== "project")) {
        const p = norm(leaf.id);
        cluster += Math.hypot(p.x - hub.x, p.y - hub.y);
        count++;
      }
    }
    return { ring, cluster: count ? cluster / count : 0 };
  }

  it("sizes the ring from cluster size, not just project count", () => {
    // Sizing by count alone left the same gap at every density: five projects
    // with two findings each sat as far apart as five with forty.
    const sparse = measure(5, 2);
    const dense = measure(5, 40);
    expect(dense.ring).toBeGreaterThan(sparse.ring * 1.5);
    expect(dense.cluster).toBeGreaterThan(sparse.cluster);
  });

  it("keeps clusters within reach of each other at every density", () => {
    for (const [projects, leaves] of [[3, 5], [5, 2], [5, 40], [12, 60], [40, 8]] as const) {
      const { ring, cluster } = measure(projects, leaves);
      // The circumference should carry roughly one cluster per project rather
      // than stranding each one in its own quadrant.
      const arc = (2 * Math.PI * ring) / projects;
      expect(arc, `${projects}x${leaves} clusters are marooned`).toBeLessThan(Math.max(cluster, IDEAL_DISTANCE) * 8);
    }
  });

  it("holds the ring against the repulsion that used to expand it", () => {
    // Seeding a packed ring is not enough on its own: forty projects pushing on
    // each other expanded it to nearly twice the seeded size until a radial
    // spring held them.
    const many = measure(40, 8);
    const few = measure(4, 8);
    expect(many.ring / few.ring).toBeLessThan(14);
    expect(many.ring).toBeGreaterThan(few.ring);
  });
});
