import * as THREE from "three";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import type { CageSpec } from "./layout.js";

// Store + project "containers" for the thoughts that live inside them. The
// primitive is a tuning knob (CAGE_STYLE): a full wireframe box reads as a CAD
// grid when 20 of them interpenetrate, so we also offer lighter treatments —
// corner brackets (a hi-tech reticle), a geodesic ellipsoid that hugs the
// cluster, and a lines-free haze volume. Fat lines (LineSegments2) render as
// shader-AA quads so edges stay crisp at any zoom.

export type CageStyle = "box" | "brackets" | "ellipsoid" | "haze";
let CAGE_STYLE: CageStyle = "ellipsoid";

type Cage = {
  obj: THREE.Object3D;
  mats: Array<{ opacity: number }>;
  spec: CageSpec;
  base: number;
  dim: number;
  focus: number;
};
let cages: Cage[] = [];
let galaxy: THREE.Points | null = null;

// remembered build context so the style can be swapped live (exploration)
let lastScene: THREE.Scene | null = null;
let lastSpecs: CageSpec[] = [];
let lastSize = { w: 1, h: 1 };

// Per-style, per-kind opacity table [base, dim, focus].
const OPACITY: Record<CageStyle, { store: [number, number, number]; project: [number, number, number] }> = {
  box: { store: [0.1, 0.05, 0.1], project: [0.22, 0.08, 0.6] },
  brackets: { store: [0.22, 0.1, 0.22], project: [0.42, 0.14, 0.85] },
  ellipsoid: { store: [0.075, 0.035, 0.09], project: [0.17, 0.06, 0.5] },
  haze: { store: [0.2, 0.09, 0.22], project: [0.14, 0.06, 0.32] },
};

function boxEdges(min: THREE.Vector3, max: THREE.Vector3): number[] {
  const c = [
    [min.x, min.y, min.z], [max.x, min.y, min.z], [max.x, max.y, min.z], [min.x, max.y, min.z],
    [min.x, min.y, max.z], [max.x, min.y, max.z], [max.x, max.y, max.z], [min.x, max.y, max.z],
  ];
  const E = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
  const out: number[] = [];
  for (const [a, b] of E) { out.push(...c[a], ...c[b]); }
  return out;
}

// 8 corner L-brackets: three short inward segments per corner. Implies the
// volume without the heavy 12-edge grid.
function bracketEdges(min: THREE.Vector3, max: THREE.Vector3): number[] {
  const dx = max.x - min.x, dy = max.y - min.y, dz = max.z - min.z;
  const L = Math.max(2, Math.min(dx, dy, dz) * 0.2);
  const out: number[] = [];
  for (const x of [min.x, max.x]) for (const y of [min.y, max.y]) for (const z of [min.z, max.z]) {
    const sx = x === min.x ? 1 : -1, sy = y === min.y ? 1 : -1, sz = z === min.z ? 1 : -1;
    out.push(x, y, z, x + sx * L, y, z);
    out.push(x, y, z, x, y + sy * L, z);
    out.push(x, y, z, x, y, z + sz * L);
  }
  return out;
}

function fatLine(positions: number[], color: string, width: number, opacity: number, size: { w: number; h: number }): { obj: LineSegments2; mat: LineMaterial } {
  const geom = new LineSegmentsGeometry();
  geom.setPositions(positions);
  const mat = new LineMaterial({
    color: new THREE.Color(color).getHex(),
    linewidth: width,
    transparent: true,
    opacity,
    depthWrite: false,
    worldUnits: false,
    blending: THREE.AdditiveBlending,
  });
  mat.resolution.set(size.w, size.h);
  return { obj: new LineSegments2(geom, mat), mat };
}

// Geodesic ellipsoid wireframe scaled to the cluster's half-extents — an
// organic "containment field" that hugs the point mass instead of boxing it.
let icoWire: number[] | null = null;
function ellipsoidPositions(): number[] {
  if (icoWire) return icoWire;
  const wf = new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(1, 1));
  icoWire = Array.from(wf.attributes.position.array as Float32Array);
  wf.dispose();
  return icoWire;
}

// Soft radial sprite for the haze volume (cached).
let hazeTex: THREE.Texture | null = null;
function hazeTexture(): THREE.Texture {
  if (hazeTex) return hazeTex;
  const s = 128;
  const cv = document.createElement("canvas");
  cv.width = cv.height = s;
  const ctx = cv.getContext("2d")!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, "rgba(255,255,255,0.9)");
  g.addColorStop(0.35, "rgba(255,255,255,0.28)");
  g.addColorStop(0.7, "rgba(255,255,255,0.06)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  hazeTex = new THREE.CanvasTexture(cv);
  return hazeTex;
}

function buildOne(spec: CageSpec, size: { w: number; h: number }): Cage {
  const isStore = spec.kind === "store";
  const [base, dim, focus] = OPACITY[CAGE_STYLE][isStore ? "store" : "project"];
  const width = isStore ? 1.0 : 1.4;
  const center = new THREE.Vector3().addVectors(spec.min, spec.max).multiplyScalar(0.5);
  const half = new THREE.Vector3().subVectors(spec.max, spec.min).multiplyScalar(0.5);

  if (CAGE_STYLE === "haze" && !isStore) {
    // Project = luminous volume; store keeps a faint bracket (built below).
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: hazeTexture(), color: new THREE.Color(spec.color),
      transparent: true, opacity: base, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    sprite.position.copy(center);
    const r = Math.max(half.x, half.y, half.z) * 2.4;
    sprite.scale.set(r, r, 1);
    sprite.renderOrder = 2;
    return { obj: sprite, mats: [sprite.material], spec, base, dim, focus };
  }

  let positions: number[];
  let scale: THREE.Vector3 | null = null;
  if (CAGE_STYLE === "brackets" || (CAGE_STYLE === "haze" && isStore)) {
    positions = bracketEdges(spec.min, spec.max);
  } else if (CAGE_STYLE === "ellipsoid") {
    positions = ellipsoidPositions();
    // Pad the shell just outside the cluster so it reads as a containment
    // field around the points rather than a solid orb skinned onto them.
    const pad = isStore ? 1.05 : 1.12;
    scale = new THREE.Vector3(Math.max(half.x, 1), Math.max(half.y, 1), Math.max(half.z, 1)).multiplyScalar(pad);
  } else {
    positions = boxEdges(spec.min, spec.max);
  }
  const { obj, mat } = fatLine(positions, spec.color, width, base, size);
  if (scale) { obj.position.copy(center); obj.scale.copy(scale); }
  obj.renderOrder = isStore ? 1 : 2;
  obj.userData.cageId = spec.id;
  return { obj, mats: [mat], spec, base, dim, focus };
}

function renderCages(): void {
  if (!lastScene) return;
  for (const c of cages) {
    lastScene.remove(c.obj);
    const o = c.obj as THREE.Mesh & { geometry?: THREE.BufferGeometry; material?: THREE.Material };
    o.geometry?.dispose?.();
    if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
    else o.material?.dispose?.();
  }
  cages = [];
  for (const spec of lastSpecs) {
    const cage = buildOne(spec, lastSize);
    lastScene.add(cage.obj);
    cages.push(cage);
  }
}

export function buildCages(scene: THREE.Scene, specs: CageSpec[], size: { w: number; h: number }): void {
  disposeCages(scene);
  lastScene = scene;
  lastSpecs = specs;
  lastSize = size;
  renderCages();
  if (!galaxy) {
    const n = 900, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const r = 400 + Math.pow(Math.random(), 0.6) * 3200;
      const t = Math.random() * Math.PI * 2, p = Math.acos(2 * Math.random() - 1);
      pos[i * 3] = r * Math.sin(p) * Math.cos(t);
      pos[i * 3 + 1] = r * Math.sin(p) * Math.sin(t);
      pos[i * 3 + 2] = r * Math.cos(p);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    galaxy = new THREE.Points(g, new THREE.PointsMaterial({ color: 0x323e66, size: 2.2, sizeAttenuation: true, transparent: true, opacity: 0.36, depthWrite: false, blending: THREE.AdditiveBlending }));
    galaxy.renderOrder = 0;
    scene.add(galaxy);
  }
}

/** Swap the container primitive live and rebuild (exploration hook). */
export function setCageStyle(style: CageStyle): void {
  if (style === CAGE_STYLE) return;
  CAGE_STYLE = style;
  renderCages();
}

/** Dim every cage except the focused project's cage (and its store). */
export function refreshCageFocus(focusProjectId: string | null, focusStore: string | null): void {
  for (const c of cages) {
    let op: number;
    if (c.spec.kind === "store") op = !focusStore || c.spec.label === focusStore ? c.base : c.dim;
    else op = c.spec.id === focusProjectId ? c.focus : !focusProjectId ? c.base : c.dim;
    for (const m of c.mats) m.opacity = op;
  }
}

export function setCageResolution(w: number, h: number): void {
  lastSize = { w, h };
  for (const c of cages) {
    const mat = (c.obj as LineSegments2).material as LineMaterial | undefined;
    if (mat && (mat as LineMaterial).resolution) (mat as LineMaterial).resolution.set(w, h);
  }
}

export function disposeCages(scene: THREE.Scene): void {
  for (const c of cages) {
    scene.remove(c.obj);
    const o = c.obj as THREE.Mesh & { geometry?: THREE.BufferGeometry; material?: THREE.Material };
    o.geometry?.dispose?.();
    if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
    else o.material?.dispose?.();
  }
  cages = [];
  lastScene = null;
  lastSpecs = [];
  if (galaxy) { scene.remove(galaxy); galaxy.geometry.dispose(); (galaxy.material as THREE.Material).dispose(); galaxy = null; }
}
