/**
 * The graph in three dimensions.
 *
 * Not a second layout: the settled 2D map is lifted into a sphere. Projects
 * sit on a fibonacci sphere in stable order, each cluster keeps the shape the
 * force layout gave it and gains a seeded depth, fragments shared between
 * projects fall to the middle where their homes' centroid is, and orphans go
 * to an outer shell. Then a yaw/pitch camera with a little perspective
 * projects it, and depth comes back as brightness and size.
 *
 * Also here: the SGR mouse protocol, because drag-to-orbit is the whole
 * point. Pure functions throughout; the controller owns the state.
 */

import type { RawLink } from "../../graph-core/types.js";
import { homes, type LayoutNode, type Point } from "./layout.js";

export interface Vec3 { x: number; y: number; z: number }

export interface OrbitCamera {
  /** Rotation about the vertical axis, radians. */
  yaw: number;
  /** Tilt toward the viewer, radians; clamped so the sphere never flips. */
  pitch: number;
  /** 1 fits the sphere to the viewport. */
  zoom: number;
}

export const DEFAULT_ORBIT: OrbitCamera = { yaw: 0, pitch: 0.32, zoom: 1 };
export const PITCH_LIMIT = 1.25;

export interface OrbitLayout {
  positions: Map<string, Vec3>;
  /** Radius of the project sphere, in world units. */
  radius: number;
}

function seeded(id: string, salt: string): number {
  let h = 2166136261;
  for (const ch of `${id}:${salt}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 10000) / 10000;
}

/** Lift the 2D layout onto a sphere. Deterministic for the same inputs. */
export function buildOrbitLayout(nodes: LayoutNode[], links: RawLink[], flat: Map<string, Point>): OrbitLayout {
  const { projects, homeOf } = homes(nodes, links);
  const positions = new Map<string, Vec3>();
  const n = projects.length;
  // How far each cluster reaches in the flat layout sets both its depth and
  // how big the sphere has to be for neighbours not to run into each other.
  const reach = new Map<string, number>();
  for (const node of nodes) {
    if (node.kind === "project") continue;
    const hosts = homeOf.get(node.id) ?? [];
    if (hosts.length !== 1) continue;
    const home = flat.get(hosts[0]);
    const p = flat.get(node.id);
    if (!home || !p) continue;
    reach.set(hosts[0], Math.max(reach.get(hosts[0]) ?? 0, Math.hypot(p.x - home.x, p.y - home.y)));
  }
  const maxReach = Math.max(12, ...reach.values());
  // Enough surface for every cluster: the sphere's area carries n discs.
  const radius = Math.max(maxReach * 1.6, Math.sqrt(n) * maxReach * 0.95);
  const golden = Math.PI * (3 - Math.sqrt(5));
  projects.forEach((project, i) => {
    const y = n === 1 ? 0 : 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const a = golden * i;
    positions.set(project.id, { x: Math.cos(a) * r * radius, y: y * radius * 0.82, z: Math.sin(a) * r * radius });
  });
  for (const node of nodes) {
    if (node.kind === "project") continue;
    const hosts = (homeOf.get(node.id) ?? []).map((id) => positions.get(id)).filter((p): p is Vec3 => Boolean(p));
    if (hosts.length === 0) {
      const u = seeded(node.id, "u") * Math.PI * 2;
      const v = Math.acos(2 * seeded(node.id, "v") - 1);
      const rr = radius * 1.28;
      positions.set(node.id, { x: Math.sin(v) * Math.cos(u) * rr, y: Math.cos(v) * rr * 0.82, z: Math.sin(v) * Math.sin(u) * rr });
      continue;
    }
    if (hosts.length > 1) {
      // Shared: the centroid of its homes, which lies inside the sphere.
      const c = hosts.reduce((s, p) => ({ x: s.x + p.x, y: s.y + p.y, z: s.z + p.z }), { x: 0, y: 0, z: 0 });
      positions.set(node.id, { x: (c.x / hosts.length) * 0.55, y: (c.y / hosts.length) * 0.55, z: (c.z / hosts.length) * 0.55 });
      continue;
    }
    const homeId = (homeOf.get(node.id) ?? [])[0];
    const home2 = flat.get(homeId);
    const p2 = flat.get(node.id);
    const home3 = hosts[0];
    const dx = home2 && p2 ? p2.x - home2.x : 0;
    const dy = home2 && p2 ? p2.y - home2.y : 0;
    const depth = (seeded(node.id, "z") * 2 - 1) * (reach.get(homeId) ?? maxReach) * 0.7;
    positions.set(node.id, { x: home3.x + dx * 0.85, y: home3.y + dy * 0.85, z: home3.z + depth });
  }
  return { positions, radius };
}

export interface Projected {
  x: number;
  y: number;
  /** 0 nearest the viewer, 1 farthest. */
  t: number;
}

/** World point → dot coordinates, with depth. */
export function projectOrbit(v: Vec3, cam: OrbitCamera, viewport: { width: number; height: number }, radius: number): Projected {
  const cy = Math.cos(cam.yaw);
  const sy = Math.sin(cam.yaw);
  const x1 = v.x * cy - v.z * sy;
  const z1 = v.x * sy + v.z * cy;
  const cp = Math.cos(cam.pitch);
  const sp = Math.sin(cam.pitch);
  const y2 = v.y * cp - z1 * sp;
  const z2 = v.y * sp + z1 * cp;
  // z2 toward the viewer. Depth 0 is the near pole of the outer shell.
  const span = radius * 1.4;
  const t = Math.max(0, Math.min(1, (span - z2) / (2 * span)));
  const focal = radius * 4.5;
  const f = focal / (focal + (span - z2));
  const sx = ((viewport.width * 0.5) / radius) * cam.zoom;
  const sYy = ((viewport.height * 0.5) / radius) * cam.zoom;
  return { x: viewport.width / 2 + x1 * f * sx, y: viewport.height / 2 + y2 * f * sYy, t };
}

/** The yaw that brings a point to the front, facing the viewer. */
export function yawToFace(v: Vec3): number {
  // After the yaw rotation z' = x·sin(yaw) + z·cos(yaw), which peaks at atan2(x, z).
  return Math.atan2(v.x, v.z);
}

/** Shortest signed distance from yaw a to yaw b. */
export function yawDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export type MouseEvent =
  | { type: "press"; button: number; col: number; row: number }
  | { type: "drag"; button: number; col: number; row: number }
  | { type: "release"; button: number; col: number; row: number }
  | { type: "wheel"; delta: -1 | 1; col: number; row: number };

/**
 * SGR mouse reporting (mode 1006): `ESC [ < b ; x ; y M` for a press or
 * motion, `m` for a release. Bit 5 of b marks motion, bit 6 the wheel.
 * Coordinates are 1-based; returned 0-based.
 */
export function parseMouse(key: string): MouseEvent | null {
  const m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(key);
  if (!m) return null;
  const b = Number(m[1]);
  const col = Number(m[2]) - 1;
  const row = Number(m[3]) - 1;
  if (b & 64) return { type: "wheel", delta: (b & 1) === 0 ? -1 : 1, col, row };
  const button = b & 3;
  if (m[4] === "m") return { type: "release", button, col, row };
  if (b & 32) return { type: "drag", button, col, row };
  return { type: "press", button, col, row };
}

export const MOUSE_ON = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
export const MOUSE_OFF = "\x1b[?1006l\x1b[?1002l\x1b[?1000l";
