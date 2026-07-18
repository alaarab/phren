import * as THREE from "three";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import type { CageSpec } from "./layout.js";

// Store + project cages as anti-aliased fat lines (LineSegments2). Unlike 1px
// THREE.Line, these render as shader-AA quads — clean edges at any zoom, with
// controllable thickness and opacity (both are tuning knobs for later).

type Cage = { seg: LineSegments2; mat: LineMaterial; spec: CageSpec };
let cages: Cage[] = [];
let galaxy: THREE.Points | null = null;

// dimness knobs (exposed for tuning)
const STORE_OPACITY = 0.1;
const STORE_OPACITY_DIM = 0.05;
const PROJECT_OPACITY = 0.22;
const PROJECT_OPACITY_DIM = 0.08;
const PROJECT_OPACITY_FOCUS = 0.6;
const STORE_WIDTH = 1.0;
const PROJECT_WIDTH = 1.3;

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

export function buildCages(scene: THREE.Scene, specs: CageSpec[], size: { w: number; h: number }): void {
  disposeCages(scene);
  for (const spec of specs) {
    const geom = new LineSegmentsGeometry();
    geom.setPositions(boxEdges(spec.min, spec.max));
    const isStore = spec.kind === "store";
    const mat = new LineMaterial({
      color: new THREE.Color(spec.color).getHex(),
      linewidth: isStore ? STORE_WIDTH : PROJECT_WIDTH,
      transparent: true,
      opacity: isStore ? STORE_OPACITY : PROJECT_OPACITY,
      depthWrite: false,
      worldUnits: false,
      blending: THREE.AdditiveBlending,
    });
    mat.resolution.set(size.w, size.h);
    const seg = new LineSegments2(geom, mat);
    seg.renderOrder = isStore ? 1 : 2;
    seg.userData.cageId = spec.id;
    scene.add(seg);
    cages.push({ seg, mat, spec });
  }
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

/** Dim every cage except the focused project's cage (and its store). */
export function refreshCageFocus(focusProjectId: string | null, focusStore: string | null): void {
  for (const { mat, spec } of cages) {
    if (spec.kind === "store") {
      const lit = !focusStore || spec.label === focusStore;
      mat.opacity = lit ? STORE_OPACITY : STORE_OPACITY_DIM;
    } else {
      const lit = !focusProjectId;
      const focused = spec.id === focusProjectId;
      mat.opacity = focused ? PROJECT_OPACITY_FOCUS : lit ? PROJECT_OPACITY : PROJECT_OPACITY_DIM;
    }
  }
}

export function setCageResolution(w: number, h: number): void {
  for (const { mat } of cages) mat.resolution.set(w, h);
}

export function disposeCages(scene: THREE.Scene): void {
  for (const { seg, mat } of cages) { scene.remove(seg); seg.geometry.dispose(); mat.dispose(); }
  cages = [];
  if (galaxy) { scene.remove(galaxy); galaxy.geometry.dispose(); (galaxy.material as THREE.Material).dispose(); galaxy = null; }
}
