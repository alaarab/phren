import * as THREE from "three";
import type { FGNode } from "./types.js";
import { seeded, state } from "./state.js";

// Deterministic hierarchical layout: STORE ⊃ PROJECT ⊃ findings.
// Replaces the force simulation — positions are computed from the hierarchy so
// the graph never collapses into a hairball and stores/projects stay separated.
// Findings cluster tightly around their project centroid; projects orbit their
// store centroid; stores sit on a wide ring. Every position is seeded off the
// stable node id, so the layout is identical across reloads.

export type CageSpec = {
  id: string;
  kind: "store" | "project";
  min: THREE.Vector3;
  max: THREE.Vector3;
  color: string;
  label: string;
  count: number;
};

const STORE_TINTS: Record<string, string> = {
  primary: "#6076a6",
};
const STORE_FALLBACK = ["#9a6bd0", "#4d9a8f", "#c98a4a", "#5a8fd0", "#cf6b9a"];

function storeTint(name: string, idx: number): string {
  return STORE_TINTS[name] || STORE_FALLBACK[idx % STORE_FALLBACK.length];
}

/**
 * Position every visible node and return the cage volumes to draw. Mutates
 * fgNode.x/y/z and pins via fx/fy/fz so 3d-force-graph leaves them alone.
 */
export function computeHierarchicalLayout(fgNodes: FGNode[]): CageSpec[] {
  // group: store -> project -> members
  const stores = new Map<string, Map<string, FGNode[]>>();
  const projectHub = new Map<string, FGNode>(); // "store project" -> the project node

  const groupOf = (fg: FGNode): { store: string; project: string } => {
    if (fg.raw.kind !== "entity") return { store: fg.raw.store || "primary", project: fg.raw.project || fg.raw.id };
    // An entity bridges several projects. Group it under a project that is
    // actually VISIBLE — otherwise isolating one project scatters its shared
    // entities into phantom cages at the filtered-out projects' old positions.
    const adj = state.fullAdjacency.get(fg.id);
    if (adj) {
      let firstProject: { store: string; project: string } | null = null;
      for (const nid of adj) {
        const n = state.nodeById.get(nid);
        if (n?.kind !== "project") continue;
        const group = { store: n.store || "primary", project: n.project || n.id };
        if (!firstProject) firstProject = group;
        if (state.visibleIds.has(nid)) return group;
      }
      if (firstProject) return firstProject;
    }
    return { store: "primary", project: fg.raw.connectedProjects?.[0] || "shared" };
  };
  for (const fg of fgNodes) {
    const { store, project } = groupOf(fg);
    if (!stores.has(store)) stores.set(store, new Map());
    const projMap = stores.get(store)!;
    if (!projMap.has(project)) projMap.set(project, []);
    if (fg.raw.kind === "project") projectHub.set(`${store} ${project}`, fg);
    else projMap.get(project)!.push(fg);
  }

  const cages: CageSpec[] = [];
  const storeNames = [...stores.keys()].sort((a, b) => (a === "primary" ? -1 : b === "primary" ? 1 : a.localeCompare(b)));
  // Per-store shell radius — how far projects orbit their store centre. Scales
  // gently with count so a 3-project store and a 14-project store both read as
  // one packed mass, not a sparse ring.
  const shellRadiusOf = (name: string): number => {
    const n = stores.get(name)!.size;
    return n <= 1 ? 0 : 40 + Math.sqrt(n) * 24;
  };

  // Lay the stores out as a shallow horizontal ROW: primary anchors the centre,
  // team stores fan out right then left. Side-by-side (not stacked in depth)
  // keeps the whole-graph bbox wide-and-shallow so zoomToFit frames it tight,
  // and each store reads as its own distinct cluster instead of overlapping the
  // primary. Seeded y/z jitter stops the row looking mechanically flat.
  const STORE_GAP = 84;
  const storeCenters = new Map<string, THREE.Vector3>();
  const primaryR = shellRadiusOf(storeNames[0]);
  storeCenters.set(storeNames[0], new THREE.Vector3(0, 0, 0));
  let edgeRight = primaryR;
  let edgeLeft = -primaryR;
  storeNames.slice(1).forEach((name, i) => {
    const r = shellRadiusOf(name);
    const toRight = i % 2 === 0;
    const cx = toRight ? edgeRight + STORE_GAP + r : edgeLeft - STORE_GAP - r;
    if (toRight) edgeRight = cx + r;
    else edgeLeft = cx - r;
    storeCenters.set(name, new THREE.Vector3(
      cx,
      (seeded(name, "sy") - 0.5) * 44,
      (seeded(name, "sz") - 0.5) * 70,
    ));
  });

  storeNames.forEach((storeName, si) => {
    const projMap = stores.get(storeName)!;
    const sc = storeCenters.get(storeName)!;

    const projects = [...projMap.keys()].sort();
    const projCount = projects.length;
    const shellR = shellRadiusOf(storeName);

    const sMin = new THREE.Vector3(Infinity, Infinity, Infinity);
    const sMax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);

    const GA = Math.PI * (3 - Math.sqrt(5)); // golden angle
    projects.forEach((project, pi) => {
      const members = projMap.get(project)!;
      // Fibonacci-sphere shell: full 3D distribution (the old flat ring read
      // as a cheap row of boxes). Radius jitters per project for organiness.
      const t = projCount <= 1 ? 0 : pi / (projCount - 1);
      const y = projCount <= 1 ? 0 : (t * 2 - 1) * 0.85;
      const rxz = Math.sqrt(Math.max(0, 1 - y * y));
      const ang = pi * GA + seeded(project, "pa") * 0.5;
      const r = shellR * (0.55 + seeded(project, "pr") * 0.6);
      const pc = new THREE.Vector3(
        sc.x + Math.cos(ang) * rxz * r,
        sc.y + y * r * 0.9,
        sc.z + Math.sin(ang) * rxz * r,
      );

      const count = Math.max(1, members.length);
      const spread = 10 + Math.sqrt(count) * 3.2;
      const pMin = new THREE.Vector3(Infinity, Infinity, Infinity);
      const pMax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);

      const place = (fg: FGNode, jitter = 1) => {
        const gx = (seeded(fg.id, "x") + seeded(fg.id, "x2") + seeded(fg.id, "x3") - 1.5) / 1.5;
        const gy = (seeded(fg.id, "y") + seeded(fg.id, "y2") + seeded(fg.id, "y3") - 1.5) / 1.5;
        const gz = (seeded(fg.id, "z") + seeded(fg.id, "z2") + seeded(fg.id, "z3") - 1.5) / 1.5;
        const x = pc.x + gx * spread * jitter;
        const y = pc.y + gy * spread * 0.85 * jitter;
        const z = pc.z + gz * spread * jitter;
        fg.x = fg.fx = x; fg.y = fg.fy = y; fg.z = fg.fz = z;
        pMin.min(new THREE.Vector3(x, y, z)); pMax.max(new THREE.Vector3(x, y, z));
      };

      members.forEach((m) => place(m));
      const hub = projectHub.get(`${storeName} ${project}`);
      if (hub) { hub.x = hub.fx = pc.x; hub.y = hub.fy = pc.y; hub.z = hub.fz = pc.z; pMin.min(pc); pMax.max(pc); }

      if (!Number.isFinite(pMin.x)) { pMin.copy(pc).subScalar(5); pMax.copy(pc).addScalar(5); }
      pMin.subScalar(4); pMax.addScalar(4);
      sMin.min(pMin); sMax.max(pMax);

      // Prefer the project hub's colour; when the hub is filtered out fall back
      // to the STORE tint (not a random finding's topic colour, which made cages
      // flicker red/blue/cyan when the Projects type was toggled off).
      const color = hub?.raw.baseColor || storeTint(storeName, si);
      cages.push({ id: `project:${storeName}:${project}`, kind: "project", min: pMin.clone(), max: pMax.clone(), color, label: project, count: members.length });
    });

    if (Number.isFinite(sMin.x)) {
      sMin.subScalar(12); sMax.addScalar(12);
      cages.push({ id: `store:${storeName}`, kind: "store", min: sMin.clone(), max: sMax.clone(), color: storeTint(storeName, si), label: storeName, count: [...projMap.values()].reduce((a, m) => a + m.length, 0) });
    }
  });

  // Existing objects move with the data immediately; the disabled force
  // simulation is not responsible for applying our deterministic layout.
  for (const node of fgNodes) {
    node.__group?.position.set(node.x ?? 0, node.y ?? 0, node.z ?? 0);
  }
  return cages;
}
