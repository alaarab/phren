/**
 * Deterministic 2D force layout for the terminal graph view.
 *
 * The web viewer leans on 3d-force-graph; in the terminal we want something
 * dependency-free, fast enough for a few hundred nodes, and — above all —
 * deterministic, so the same store draws the same map every time the view
 * opens. All jitter is derived from node ids via `seeded()`; nothing here
 * calls Math.random.
 *
 * The store's topology is a star (project → findings/tasks/fragments/refs),
 * so the simulation adds a gentle pull toward each node's home project. That
 * keeps clusters readable instead of letting repulsion smear everything into
 * one ring.
 */

import { seeded } from "../../graph-core/model.js";
import type { NodeKind, RawLink, RawLinkKind } from "../../graph-core/types.js";

export interface LayoutNode {
  id: string;
  kind: NodeKind;
  /** Owning project name, for the cluster pull. Projects own themselves. */
  project?: string;
  /** Visual size from `sizeForNode`; drives repulsion mass. */
  size: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Ideal edge length in world units. Everything else is scaled off this. */
export const IDEAL_DISTANCE = 12;

/**
 * A terminal canvas is far wider than it is tall. A layout that settles into a
 * circle therefore strands most of the screen, so the simulation is told the
 * canvas aspect and lays the graph out as a matching ellipse: the project ring
 * is stretched horizontally and vertical drift is damped by the same factor.
 */
export const DEFAULT_ASPECT = 2.4;
const MAX_ASPECT = 3.5;

export function normalizeAspect(aspect: number | undefined): number {
  if (!aspect || !Number.isFinite(aspect) || aspect <= 0) return DEFAULT_ASPECT;
  return Math.max(1, Math.min(aspect, MAX_ASPECT));
}

/** Spring strength by edge flavour: spokes hold the clusters, enrichment edges just nudge. */
const LINK_STRENGTH: Record<RawLinkKind, number> = {
  star: 1,
  fragment: 0.25,
  supersedes: 0.6,
  contradicts: 0.4,
};

/**
 * How far a project's own nodes sprawl from it, estimated from how many it has.
 * The ring is sized from this so clusters end up close to touching; sizing the
 * ring by project count alone left the same gap at every scale and the graph
 * never filled more than about a seventh of its own bounds.
 */
function clusterRadius(leafCount: number): number {
  return IDEAL_DISTANCE * (0.9 + 0.42 * Math.sqrt(Math.max(0, leafCount)));
}

/** Project ids in stable order plus, for every node, the project(s) it hangs off. */
export function homes(nodes: LayoutNode[], links: RawLink[]): { projects: LayoutNode[]; homeOf: Map<string, string[]> } {
  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  const projects = nodes.filter((node) => node.kind === "project").sort((a, b) => a.id.localeCompare(b.id));
  const projectByName = new Map(projects.map((node) => [node.project ?? node.id, node.id] as const));
  const homeOf = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.kind === "project") { homeOf.set(node.id, [node.id]); continue; }
    const own = node.project ? projectByName.get(node.project) : undefined;
    homeOf.set(node.id, own ? [own] : []);
  }
  for (const link of links) {
    if (link.kind && link.kind !== "star") continue;
    const a = byId.get(link.source);
    const b = byId.get(link.target);
    if (!a || !b) continue;
    if (a.kind === "project" && b.kind !== "project") pushUnique(homeOf.get(b.id)!, a.id);
    else if (b.kind === "project" && a.kind !== "project") pushUnique(homeOf.get(a.id)!, b.id);
  }
  return { projects, homeOf };
}

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

/**
 * Starting positions: projects on a ring, leaves in a jittered blob around
 * their home project, multi-home fragments at the centroid of their homes,
 * orphans on an outer ring.
 */
export function seedPositions(nodes: LayoutNode[], links: RawLink[], aspect = DEFAULT_ASPECT): Map<string, Point> {
  const positions = new Map<string, Point>();
  const ratio = normalizeAspect(aspect);
  const { projects, homeOf } = homes(nodes, links);
  // Pack the ring so neighbouring clusters nearly touch: the circumference has
  // to carry one cluster diameter per project, with a little air between.
  const leavesPer = new Map<string, number>();
  for (const [id, hosts] of homeOf) {
    if (hosts.length === 0) continue;
    const owner = hosts[0];
    if (owner === id) continue;
    leavesPer.set(owner, (leavesPer.get(owner) ?? 0) + 1);
  }
  // Each project gets a slice of the ring proportional to its cluster, not an
  // equal share. Equal slices gave a one-finding project the same forty
  // degrees as a fifty-finding one, so small and new projects sat alone in
  // empty space at full ring distance while the heavy clusters merged into a
  // blob — "most of it in the middle, a few way out", and the camera fitted
  // to the few. Small clusters also sit a little inside the ring, so their
  // outer edge lines up with their neighbours' rather than their centre.
  const radii = projects.map((p) => clusterRadius(leavesPer.get(p.id) ?? 0));
  const spread = Math.max(...radii, IDEAL_DISTANCE);
  const slices = radii.map((r) => r * 2.3);
  const circumference = slices.reduce((sum, w) => sum + w, 0);
  const ring = Math.max(IDEAL_DISTANCE * 2.2, circumference / (2 * Math.PI));
  // Projects sit at the start of their slice, so equal clusters land exactly
  // where the equal-slice ring put them (two projects side by side, not
  // stacked, which is the worst case on a wide screen).
  let offset = 0;
  projects.forEach((project, i) => {
    const angle = (offset / Math.max(circumference, 1)) * Math.PI * 2;
    offset += slices[i];
    const radius = Math.max(IDEAL_DISTANCE * 1.6, ring - (spread - radii[i]) * 0.7);
    positions.set(project.id, { x: Math.cos(angle) * radius * ratio, y: Math.sin(angle) * radius });
  });
  if (projects.length === 1) positions.set(projects[0].id, { x: 0, y: 0 });

  const outer = ring + IDEAL_DISTANCE * 3;
  for (const node of nodes) {
    if (node.kind === "project") continue;
    const home = (homeOf.get(node.id) ?? []).map((id) => positions.get(id)).filter((p): p is Point => Boolean(p));
    const angle = seeded(node.id, "angle") * Math.PI * 2;
    if (home.length === 0) {
      positions.set(node.id, { x: Math.cos(angle) * outer * ratio, y: Math.sin(angle) * outer });
      continue;
    }
    const cx = home.reduce((sum, p) => sum + p.x, 0) / home.length;
    const cy = home.reduce((sum, p) => sum + p.y, 0) / home.length;
    const radius = home.length > 1 ? IDEAL_DISTANCE * 0.4 : IDEAL_DISTANCE * (0.6 + seeded(node.id, "radius") * 1.2);
    positions.set(node.id, { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius });
  }
  return positions;
}

interface SimLink {
  a: number;
  b: number;
  strength: number;
}

export class ForceSim {
  readonly positions: Map<string, Point>;
  private readonly ids: string[];
  private readonly index: Map<string, number>;
  private readonly mass: number[];
  private readonly anchors: number[][];
  private readonly isProject: boolean[];
  private readonly links: SimLink[];
  private temperature: number;
  private readonly startTemperature: number;

  private readonly aspect: number;
  /** How far apart projects push each other; scaled to the clusters they carry. */
  private readonly projectCutoff: number;
  /**
   * The ring radius each project should sit at, measured in aspect-corrected
   * space. Seeding a packed ring is not enough on its own: mutual repulsion
   * between many projects expands it again, which is how a forty-project store
   * ended up sprawling to nearly twice its seeded size. A radial spring holds
   * each project at the radius the packing chose.
   */
  private readonly targetRadius: number[];

  constructor(nodes: LayoutNode[], links: RawLink[], seed?: Map<string, Point>, aspect = DEFAULT_ASPECT) {
    this.aspect = normalizeAspect(aspect);
    const leaves = nodes.filter((node) => node.kind !== "project").length;
    const projectCount = Math.max(1, nodes.length - leaves);
    this.projectCutoff = clusterRadius(leaves / projectCount) * 2.4;
    this.ids = nodes.map((node) => node.id);
    this.index = new Map(this.ids.map((id, i) => [id, i] as const));
    this.mass = nodes.map((node) => (node.kind === "project" ? 4 : 1) * Math.max(0.6, node.size / 12));
    this.isProject = nodes.map((node) => node.kind === "project");
    const { homeOf } = homes(nodes, links);
    this.anchors = nodes.map((node) => (homeOf.get(node.id) ?? []).map((id) => this.index.get(id)!).filter((i) => i !== undefined));
    this.links = [];
    for (const link of links) {
      const a = this.index.get(link.source);
      const b = this.index.get(link.target);
      if (a === undefined || b === undefined || a === b) continue;
      this.links.push({ a, b, strength: LINK_STRENGTH[link.kind ?? "star"] });
    }
    const seeded = seedPositions(nodes, links, this.aspect);
    this.positions = new Map();
    for (const id of this.ids) this.positions.set(id, { ...(seed?.get(id) ?? seeded.get(id)!) });
    this.targetRadius = this.ids.map((id, i) => {
      if (!this.isProject[i]) return 0;
      const p = seeded.get(id)!;
      return Math.hypot(p.x / this.aspect, p.y);
    });
    this.startTemperature = IDEAL_DISTANCE * Math.max(1, Math.sqrt(nodes.length) / 4);
    this.temperature = this.startTemperature;
  }

  /** 1 at the start, 0 when settled; mirrors d3's `alpha` for hosts that animate. */
  get alpha(): number {
    return this.startTemperature > 0 ? this.temperature / this.startTemperature : 0;
  }

  get settled(): boolean {
    return this.temperature < 0.15;
  }

  /**
   * Reuse a previous layout's positions for nodes that survived a data
   * refresh, and reheat only mildly so the map shifts instead of scrambling.
   */
  warmStart(previous: Map<string, Point>): void {
    let reused = 0;
    for (const id of this.ids) {
      const prev = previous.get(id);
      if (!prev) continue;
      this.positions.set(id, { ...prev });
      reused++;
    }
    if (reused > 0) this.temperature = Math.max(0.15, this.startTemperature * (reused === this.ids.length ? 0.15 : 0.4));
  }

  /** Reheat to the initial temperature (e.g. the `r` relayout key). */
  reheat(): void {
    this.temperature = this.startTemperature;
  }

  tick(count = 1): void {
    for (let n = 0; n < count; n++) {
      if (this.settled) return;
      this.step();
    }
  }

  /** Run until settled or the tick budget is spent. */
  settle(maxTicks = 400): void {
    for (let n = 0; n < maxTicks && !this.settled; n++) this.step();
  }

  private step(): void {
    const count = this.ids.length;
    if (count === 0) { this.temperature = 0; return; }
    const xs = new Float64Array(count);
    const ys = new Float64Array(count);
    const dx = new Float64Array(count);
    const dy = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      const p = this.positions.get(this.ids[i])!;
      xs[i] = p.x;
      ys[i] = p.y;
    }
    const k = IDEAL_DISTANCE;
    const k2 = k * k;

    // Repulsion: k² / d, weighted by mass so projects carve out room.
    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        let ddx = xs[i] - xs[j];
        let ddy = ys[i] - ys[j];
        let dist2 = ddx * ddx + ddy * ddy;
        if (dist2 < 0.01) {
          // Coincident nodes: split them deterministically by index.
          ddx = ((i * 7919 + j * 104729) % 17) / 17 - 0.5;
          ddy = ((i * 15485863 + j * 32452843) % 13) / 13 - 0.5;
          dist2 = ddx * ddx + ddy * ddy || 0.01;
        }
        const dist = Math.sqrt(dist2);
        const cutoff = this.isProject[i] || this.isProject[j] ? this.projectCutoff : k * 6;
        if (dist > cutoff) continue;
        const force = (k2 / dist) * Math.sqrt(this.mass[i] * this.mass[j]);
        const fx = (ddx / dist) * force;
        const fy = (ddy / dist) * force;
        dx[i] += fx; dy[i] += fy;
        dx[j] -= fx; dy[j] -= fy;
      }
    }

    // Attraction along links: d² / k, scaled by the edge flavour.
    for (const link of this.links) {
      const ddx = xs[link.a] - xs[link.b];
      const ddy = ys[link.a] - ys[link.b];
      const dist = Math.sqrt(ddx * ddx + ddy * ddy) || 0.01;
      const force = ((dist * dist) / k) * link.strength;
      const fx = (ddx / dist) * force;
      const fy = (ddy / dist) * force;
      dx[link.a] -= fx; dy[link.a] -= fy;
      dx[link.b] += fx; dy[link.b] += fy;
    }

    // Cluster pull toward the home project(s); projects drift gently to the origin.
    for (let i = 0; i < count; i++) {
      if (this.isProject[i]) {
        // Hold the project on its ring. The error is measured in
        // aspect-corrected space so the restoring force preserves the wide
        // ellipse rather than pulling the layout back into a circle. A soft
        // spring on purpose: pinning the radius outright left the clusters no
        // room to breathe once the node cap made them larger than the seeded
        // ring allowed for, and a forty-project store folded into a fan.
        const nx = xs[i] / this.aspect;
        const ny = ys[i];
        const radius = Math.hypot(nx, ny);
        if (radius > 0.01) {
          const pull = (this.targetRadius[i] - radius) * 0.18;
          dx[i] += (nx / radius) * pull * this.aspect;
          dy[i] += (ny / radius) * pull;
        }
        continue;
      }
      const anchors = this.anchors[i];
      if (!anchors.length) continue;
      let ax = 0;
      let ay = 0;
      for (const a of anchors) { ax += xs[a]; ay += ys[a]; }
      ax /= anchors.length;
      ay /= anchors.length;
      dx[i] += (ax - xs[i]) * 0.08;
      dy[i] += (ay - ys[i]) * 0.08 * Math.sqrt(this.aspect);
    }

    // Apply, capped by the current temperature.
    const cap = this.temperature;
    for (let i = 0; i < count; i++) {
      const len = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]);
      if (len === 0) continue;
      const scale = Math.min(len, cap) / len;
      const p = this.positions.get(this.ids[i])!;
      p.x = xs[i] + dx[i] * scale;
      p.y = ys[i] + dy[i] * scale;
    }
    this.temperature *= 0.94;
  }
}

/** Axis-aligned bounds of a position set; null when empty. */
export function bounds(positions: Iterable<Point>): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of positions) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}
