import * as THREE from "three";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import type { FGNode } from "./types.js";
import { esc, focusMode, nodeRadius, state } from "./state.js";

// DOM labels via CSS2DRenderer: crisp at any zoom, CSP-safe in both hosts
// (pure DOM + CSS transforms — no workers, no eval). Projects get an eager
// always-on label; findings/tasks/refs draw from a fixed pool assigned by
// camera distance so "zoom in to read" is a real interaction with a hard
// cap on live DOM nodes.

const POOL_SIZE = 40;
const LABEL_DIST = 400;
const LABEL_DIST_SQ = LABEL_DIST * LABEL_DIST;
const LOD_INTERVAL = 0.15;

type PoolEntry = { obj: CSS2DObject; el: HTMLDivElement; nodeId: string | null };

const pool: PoolEntry[] = [];
let lodClock = 0;

// Bare floating text — no pills, no borders. The GraphRAG look: tiny mono
// labels that sit in space, readable via a dark text-shadow halo.
const LABEL_CSS = `
.phren-label{
  font:500 9.5px/1.3 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color:#c4d2f0;background:none;border:none;padding:0;max-width:220px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  letter-spacing:0.02em;pointer-events:none;
  text-shadow:0 0 6px rgba(3,5,12,0.95),0 1px 3px rgba(3,5,12,0.95),0 0 2px rgba(3,5,12,1);
  opacity:0;transition:opacity 0.2s ease;
}
.phren-label.in{opacity:0.92}
.phren-label.dim{opacity:0.12}
.phren-label.occluded{opacity:0!important}
.phren-label--project{
  font-weight:700;font-size:11px;color:var(--pc,#e9eeff);
  text-transform:uppercase;letter-spacing:0.11em;max-width:240px;
  text-shadow:0 0 9px rgba(3,5,12,0.98),0 0 4px var(--pg,rgba(120,150,220,0.5));
}
.phren-label--project .phren-label-meta{
  font-weight:500;color:#8b96c9;text-transform:none;letter-spacing:0.04em;margin-left:5px;
}
.phren-label--project .phren-label-dot{
  display:inline-block;width:6px;height:6px;border-radius:50%;
  background:var(--pc,#7c9cff);margin-right:6px;vertical-align:middle;
  box-shadow:0 0 7px var(--pc,#7c9cff);
}
.phren-label--entity{color:#9fd6f0}
.phren-label--task{color:#b7ecc9}
`;

export function injectLabelCss(): void {
  if (document.getElementById("phren-graph-label-css")) return;
  const style = document.createElement("style");
  style.id = "phren-graph-label-css";
  style.textContent = LABEL_CSS;
  document.head.appendChild(style);
}

export function createLabelRenderer(): CSS2DRenderer {
  const renderer = new CSS2DRenderer();
  renderer.domElement.style.position = "absolute";
  renderer.domElement.style.top = "0";
  renderer.domElement.style.left = "0";
  renderer.domElement.style.pointerEvents = "none";
  renderer.domElement.style.zIndex = "5";
  return renderer;
}

function fadeIn(el: HTMLElement): void {
  el.classList.remove("in");
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("in")));
}

/** Always-on label for projects (and heavily-referenced entities). */
export function attachEagerLabel(fgNode: FGNode): void {
  const node = fgNode.raw;
  if (!node.forceLabel || !fgNode.__group || fgNode.__labelObj) return;
  const el = document.createElement("div");
  el.className = `phren-label phren-label--${node.kind}`;
  if (node.kind === "project") {
    el.style.setProperty("--pc", node.baseColor);
    const count = typeof node.findingCount === "number" ? node.findingCount : "";
    el.innerHTML = `<span class="phren-label-dot"></span>${esc(node.label)}${count !== "" ? `<span class="phren-label-meta">${esc(String(count))}</span>` : ""}`;
  } else {
    el.textContent = node.label;
    el.style.color = node.baseColor;
  }
  const obj = new CSS2DObject(el);
  obj.position.set(0, nodeRadius(node) + 7, 0);
  fgNode.__group.add(obj);
  fgNode.__labelObj = obj;
  fgNode.__labelEl = el;
  fadeIn(el);
}

/** Refresh an eager label after updateNode. */
export function updateEagerLabelText(fgNode: FGNode): void {
  if (!fgNode.__labelEl) return;
  const node = fgNode.raw;
  if (node.kind !== "project") {
    fgNode.__labelEl.textContent = node.label;
    fgNode.__labelEl.style.color = node.baseColor;
  }
}

function poolEntry(index: number): PoolEntry {
  let entry = pool[index];
  if (!entry) {
    const el = document.createElement("div");
    el.className = "phren-label";
    entry = { obj: new CSS2DObject(el), el, nodeId: null };
    pool[index] = entry;
  }
  return entry;
}

function detachEntry(entry: PoolEntry): void {
  entry.obj.parent?.remove(entry.obj);
  entry.el.classList.remove("in");
  entry.nodeId = null;
}

function labelTextFor(fgNode: FGNode): string {
  const text = (fgNode.raw.fullLabel || fgNode.raw.label || "").replace(/\s+/g, " ").trim();
  return text.length > 64 ? `${text.slice(0, 64)}…` : text;
}

function assignEntry(entry: PoolEntry, fgNode: FGNode): void {
  if (entry.nodeId === fgNode.id) {
    entry.el.classList.toggle("dim", (fgNode.__intTarget ?? 1) < 1);
    return;
  }
  if (entry.nodeId) detachEntry(entry);
  if (!fgNode.__group) return;
  entry.el.className = `phren-label phren-label--${fgNode.raw.kind}`;
  entry.el.textContent = labelTextFor(fgNode);
  if (fgNode.raw.kind !== "finding") entry.el.style.color = fgNode.raw.baseColor;
  else entry.el.style.color = "";
  entry.el.classList.toggle("dim", (fgNode.__intTarget ?? 1) < 1);
  entry.obj.position.set(0, nodeRadius(fgNode.raw) + 5, 0);
  fgNode.__group.add(entry.obj);
  entry.nodeId = fgNode.id;
  fadeIn(entry.el);
}

/**
 * Assign the label pool: focus set first (hovered/selected + neighbors,
 * search matches), then nearest-to-camera within LABEL_DIST.
 */
function runLabelPass(): void {
  if (!state.fg) return;
  const camera = state.fg.camera();
  if (!camera) return;
  const mode = focusMode();
  const focus = state.hoveredNodeId || state.selectedNodeId;
  const neighbors = focus ? state.visibleAdjacency.get(focus) : null;

  type Candidate = { fgNode: FGNode; priority: number; distSq: number };
  const candidates: Candidate[] = [];
  const cam = camera.position;

  state.fgNodeById.forEach((fgNode, id) => {
    if (!state.visibleIds.has(id)) return;
    if (fgNode.raw.forceLabel) return; // eager label already attached
    if (fgNode.x == null || !fgNode.__group) return;
    const dx = (fgNode.x || 0) - cam.x;
    const dy = (fgNode.y || 0) - cam.y;
    const dz = (fgNode.z || 0) - cam.z;
    const distSq = dx * dx + dy * dy + dz * dz;
    let priority = 0;
    if (mode === "hover" || mode === "selected") {
      if (id === focus) priority = 3;
      else if (neighbors?.has(id)) priority = 2;
    } else if (mode === "project") {
      if (state.visibleAdjacency.get(state.focusedProjectId!)?.has(id)) priority = 2;
    } else if (mode === "search" && state.searchMatchIds.has(id)) {
      priority = 2;
    }
    if (priority === 0 && distSq > LABEL_DIST_SQ) return;
    candidates.push({ fgNode, priority, distSq });
  });

  candidates.sort((a, b) => b.priority - a.priority || a.distSq - b.distSq);

  const used = new Map<string, FGNode>();
  for (const candidate of candidates) {
    if (used.size >= POOL_SIZE) break;
    used.set(candidate.fgNode.id, candidate.fgNode);
  }

  // Keep stable assignments where possible, reuse freed entries for new ids.
  const wanted = new Set(used.keys());
  const free: PoolEntry[] = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    const entry = poolEntry(i);
    if (entry.nodeId && wanted.has(entry.nodeId)) {
      const fgNode = used.get(entry.nodeId)!;
      assignEntry(entry, fgNode);
      used.delete(entry.nodeId);
    } else {
      if (entry.nodeId) detachEntry(entry);
      free.push(entry);
    }
  }
  for (const fgNode of used.values()) {
    const entry = free.pop();
    if (!entry) break;
    assignEntry(entry, fgNode);
  }

  declutterLabels();
}

// ── Screen-space declutter ────────────────────────────────────────────────
// GraphRAG shows only the handful of labels that don't collide — never a
// wall of overlapping text. After the pool is assigned, project every live
// label to screen space and greedily hide any whose box overlaps a
// higher-priority one already placed (projects beat findings, near beats
// far, focused beats everything). Occluded labels stay in the DOM at
// opacity 0 so the pool/eager bookkeeping is untouched.
const _proj = new THREE.Vector3();

type LabelBox = { el: HTMLElement; x0: number; y0: number; x1: number; y1: number; priority: number; distSq: number };

function declutterLabels(): void {
  if (!state.fg) return;
  const camera = state.fg.camera();
  const container = state.container;
  if (!camera || !container) return;
  const W = container.clientWidth || 1;
  const H = container.clientHeight || 1;
  const cam = camera.position;
  const focus = state.hoveredNodeId || state.selectedNodeId;
  const neighbors = focus ? state.visibleAdjacency.get(focus) : null;

  const boxes: LabelBox[] = [];
  const hidden: HTMLElement[] = [];

  const consider = (fgNode: FGNode | undefined, el: HTMLElement, base: number): void => {
    if (!fgNode || fgNode.x == null) { hidden.push(el); return; }
    _proj.set(fgNode.x, fgNode.y || 0, fgNode.z || 0);
    const dx = _proj.x - cam.x, dy = _proj.y - cam.y, dz = _proj.z - cam.z;
    const distSq = dx * dx + dy * dy + dz * dz;
    _proj.project(camera);
    if (_proj.z >= 1 || _proj.x < -1.25 || _proj.x > 1.25 || _proj.y < -1.3 || _proj.y > 1.3) { hidden.push(el); return; }
    const sx = (_proj.x * 0.5 + 0.5) * W;
    const sy = (-_proj.y * 0.5 + 0.5) * H;
    const w = (el.offsetWidth || 90) + 8;
    const h = (el.offsetHeight || 12) + 5;
    let priority = base;
    if (fgNode.id === focus) priority += 6;
    else if (neighbors?.has(fgNode.id)) priority += 2;
    boxes.push({ el, x0: sx - w / 2, y0: sy - h / 2, x1: sx + w / 2, y1: sy + h / 2, priority, distSq });
  };

  // Eager labels (projects = 10, high-ref entities = 5) then pooled findings (0).
  state.fgNodeById.forEach((fgNode, id) => {
    const el = fgNode.__labelEl;
    if (!el || !fgNode.raw.forceLabel) return;
    if (!state.visibleIds.has(id)) { hidden.push(el); return; }
    consider(fgNode, el, fgNode.raw.kind === "project" ? 10 : 5);
  });
  for (const entry of pool) {
    if (!entry || !entry.nodeId) continue;
    consider(state.fgNodeById.get(entry.nodeId), entry.el, 0);
  }

  boxes.sort((a, b) => b.priority - a.priority || a.distSq - b.distSq);
  const placed: LabelBox[] = [];
  for (const box of boxes) {
    let hit = false;
    for (const p of placed) {
      if (box.x0 < p.x1 && box.x1 > p.x0 && box.y0 < p.y1 && box.y1 > p.y0) { hit = true; break; }
    }
    if (hit) hidden.push(box.el);
    else { box.el.classList.remove("occluded"); placed.push(box); }
  }
  for (const el of hidden) el.classList.add("occluded");
}

/** Throttled per-frame hook (ambient loop). */
export function labelTick(dt: number): void {
  lodClock += dt;
  if (lodClock < LOD_INTERVAL) return;
  lodClock = 0;
  runLabelPass();
}

/** Immediate reassign — call when focus state changes. */
export function refreshLabels(): void {
  lodClock = 0;
  runLabelPass();
}

/** Drop every pooled label (mount/remount/destroy). */
export function resetLabels(): void {
  for (const entry of pool) {
    if (entry) detachEntry(entry);
  }
}
