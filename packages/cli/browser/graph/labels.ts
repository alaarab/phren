import * as THREE from "three";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import type { FGNode } from "./types.js";
import type { LabelCandidate, LabelRect } from "../../src/graph-core/labels.js";
import { labelDrawCap, resolveLabelOverlaps } from "../../src/graph-core/labels.js";
import { esc, focusMode, nodeRadius, scoreForNode, state } from "./state.js";

// DOM labels via CSS2DRenderer: crisp at any zoom, CSP-safe in both hosts
// (pure DOM + CSS transforms, no workers, no eval). Projects get an eager
// always-on label; findings/tasks/refs draw from a fixed pool assigned by
// camera distance so "zoom in to read" is a real interaction with a hard
// cap on live DOM nodes. Every frame the shared resolver in graph-core
// projects those labels to screen space: group labels always win, leaves
// rank by priority then stickiness then degree then recency, and hysteresis
// stops marginal overlaps from flickering a label out.
//
// Rects are computed from last frame's camera/transforms: labelTick runs in
// the ambient RAF while CSS2DRenderer writes element transforms in
// force-graph's own render pass, so the hidden set lags the draw by one
// frame under fast camera motion. That lag is accepted; wiring the resolver
// into force-graph's pre-render hook would couple graph-core to the host
// loop for a sub-frame overlap during orbit.

const POOL_SIZE = 40;
const LABEL_DIST = 400;
const LABEL_DIST_SQ = LABEL_DIST * LABEL_DIST;
const LOD_INTERVAL = 0.15;
const FALLBACK_LABEL = { w: 90, h: 12 };

type PoolEntry = { obj: CSS2DObject; el: HTMLDivElement; nodeId: string | null };

const pool: PoolEntry[] = [];
let lodClock = 0;
/**
 * Visible ids last frame (hysteresis input) and a second Set the resolver
 * writes into so the pair can be swapped without allocating at 60fps.
 */
let previousVisible = new Set<string>();
let visibleScratch = new Set<string>();
/** Eager (forceLabel) node ids; avoids an O(all nodes) scan every frame. */
const eagerIds = new Set<string>();
/** Cached text metrics; reading offsetWidth every frame would thrash layout. */
const sizeCache = new WeakMap<HTMLElement, { w: number; h: number }>();
/** Off-DOM box used to measure a label the moment it is assigned. */
let measurer: HTMLDivElement | null = null;

// Per-frame scratch (cleared, not reallocated).
const scratchCandidates: LabelCandidate[] = [];
const scratchElements = new Map<string, HTMLElement>();
const scratchRejected: HTMLElement[] = [];

// Bare floating text, no pills, no borders. The GraphRAG look: tiny mono
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

/**
 * Measure `el` right after its text/class changes and cache the box, so the
 * next declutter does not force layout on a detached or zero-size element.
 * A hidden measurer provides layout for a node CSS2DRenderer has not
 * appended yet; a zero read still caches the fallback (one measure per
 * assignment, not one per frame).
 */
function measureAndCache(el: HTMLElement): void {
  let w = 0;
  let h = 0;
  if (el.isConnected) {
    w = el.offsetWidth;
    h = el.offsetHeight;
  } else {
    if (!measurer) {
      measurer = document.createElement("div");
      measurer.setAttribute("aria-hidden", "true");
      measurer.style.cssText = "position:absolute;left:-99999px;top:0;visibility:hidden;pointer-events:none;";
      document.body.appendChild(measurer);
    }
    measurer.appendChild(el);
    w = el.offsetWidth;
    h = el.offsetHeight;
    el.remove();
  }
  sizeCache.set(el, w > 0 && h > 0 ? { w, h } : { ...FALLBACK_LABEL });
}

function labelSize(el: HTMLElement): { w: number; h: number } {
  const hit = sizeCache.get(el);
  if (hit) return hit;
  measureAndCache(el);
  return sizeCache.get(el) ?? { ...FALLBACK_LABEL };
}

/** Always-on label for projects (and heavily-referenced entities). */
export function attachEagerLabel(fgNode: FGNode): void {
  const node = fgNode.raw;
  if (!node.forceLabel || !fgNode.__group || fgNode.__labelObj) return;
  const el = document.createElement("div");
  el.className = `phren-label phren-label--${node.kind}`;
  if (node.kind === "project") {
    el.style.setProperty("--pc", node.baseColor);
    const count = typeof node.labelCount === "number" ? node.labelCount : typeof node.findingCount === "number" ? node.findingCount : "";
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
  eagerIds.add(fgNode.id);
  measureAndCache(el);
  fadeIn(el);
}

/** Refresh an eager label after updateNode / count changes. */
export function updateEagerLabelText(fgNode: FGNode): void {
  if (!fgNode.__labelEl) return;
  const node = fgNode.raw;
  if (node.kind === "project") {
    const count = typeof node.labelCount === "number" ? node.labelCount : typeof node.findingCount === "number" ? node.findingCount : "";
    fgNode.__labelEl.style.setProperty("--pc", node.baseColor);
    fgNode.__labelEl.innerHTML = `<span class="phren-label-dot"></span>${esc(node.label)}${count !== "" ? `<span class="phren-label-meta">${esc(String(count))}</span>` : ""}`;
  } else {
    fgNode.__labelEl.textContent = node.label;
    fgNode.__labelEl.style.color = node.baseColor;
  }
  measureAndCache(fgNode.__labelEl);
}

/** Drop an eager id when its node object is disposed (remount/delete). */
export function forgetEagerLabel(nodeId: string): void {
  eagerIds.delete(nodeId);
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
  // Measure before CSS2DRenderer's next pass so the first declutter after
  // churn already has a real rect (not the 90x12 fallback for one frame).
  measureAndCache(entry.el);
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
}

// ── Screen-space declutter (each frame) ──────────────────────────────────
// GraphRAG shows only the handful of labels that do not collide. Project
// every live label (the CSS2DObject, not the node centre: the text sits
// above the dot) into screen space and hand the rectangles to graph-core's
// resolver: group labels always win, leaves rank by priority, stickiness,
// degree then recency, hysteresis keeps a shown label through a marginal
// overlap, and the draw cap scales with the viewport. Occluded labels stay
// in the DOM at opacity 0 so pool/eager bookkeeping is untouched.
const _world = new THREE.Vector3();

function recencyOf(fgNode: FGNode): number {
  const node = fgNode.raw;
  if (node.date) {
    const t = Date.parse(node.date);
    if (Number.isFinite(t)) return t;
  }
  const last = scoreForNode(node)?.lastUsedAt;
  if (last) {
    const t = Date.parse(last);
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

/** Degree plus modelled refCount so high-ref entities keep their rank. */
function leafDegree(fgNode: FGNode): number {
  return (state.fullAdjacency.get(fgNode.id)?.size ?? 0) + (fgNode.raw.refCount ?? 0);
}

function declutterLabels(): void {
  if (!state.fg) return;
  const camera = state.fg.camera();
  const container = state.container;
  if (!camera || !container) return;
  const W = container.clientWidth || 1;
  const H = container.clientHeight || 1;
  const mode = focusMode();
  const focus = state.hoveredNodeId || state.selectedNodeId;
  const neighbors = focus ? state.visibleAdjacency.get(focus) : null;

  scratchCandidates.length = 0;
  scratchElements.clear();
  scratchRejected.length = 0;

  const consider = (fgNode: FGNode | undefined, el: HTMLElement, obj: CSS2DObject): void => {
    if (!fgNode || fgNode.x == null || !state.visibleIds.has(fgNode.id)) {
      scratchRejected.push(el);
      return;
    }
    obj.getWorldPosition(_world);
    _world.project(camera);
    if (_world.z < -1 || _world.z > 1) {
      scratchRejected.push(el);
      return;
    }
    const sx = (_world.x * 0.5 + 0.5) * W;
    const sy = (-_world.y * 0.5 + 0.5) * H;
    const { w, h } = labelSize(el);
    const halfW = (w + 8) / 2;
    const halfH = (h + 5) / 2;
    const rect: LabelRect = { x0: sx - halfW, y0: sy - halfH, x1: sx + halfW, y1: sy + halfH };
    // Cull by the full rect against the viewport, not the anchor's NDC:
    // a 220px label half-on-screen still draws, so it still needs a slot.
    if (rect.x1 < 0 || rect.x0 > W || rect.y1 < 0 || rect.y0 > H) {
      scratchRejected.push(el);
      return;
    }
    let priority = 0;
    if (fgNode.id === focus) priority = 6;
    else if (neighbors?.has(fgNode.id)) priority = 2;
    else if (mode === "project" && state.focusedProjectId && state.visibleAdjacency.get(state.focusedProjectId)?.has(fgNode.id)) priority = 2;
    else if (mode === "search" && state.searchMatchIds.has(fgNode.id)) priority = 2;
    scratchCandidates.push({
      id: fgNode.id,
      rect,
      isGroup: fgNode.raw.kind === "project",
      degree: leafDegree(fgNode),
      recency: recencyOf(fgNode),
      priority,
    });
    scratchElements.set(fgNode.id, el);
  };

  // Eager labels only: O(labelled), not O(all nodes).
  for (const id of eagerIds) {
    const fgNode = state.fgNodeById.get(id);
    if (!fgNode || !fgNode.__labelEl || !fgNode.__labelObj) {
      eagerIds.delete(id);
      continue;
    }
    if (!state.visibleIds.has(id)) {
      scratchRejected.push(fgNode.__labelEl);
      continue;
    }
    consider(fgNode, fgNode.__labelEl, fgNode.__labelObj);
  }
  for (const entry of pool) {
    if (!entry || !entry.nodeId) continue;
    consider(state.fgNodeById.get(entry.nodeId), entry.el, entry.obj);
  }

  // Swap the two Sets: previous stays readable while `into` is filled.
  const visible = resolveLabelOverlaps(scratchCandidates, {
    cap: labelDrawCap(W, H),
    previousVisible,
    into: visibleScratch,
    pad: 1,
    hysteresisPx: 3,
  });
  for (const [id, el] of scratchElements) {
    el.classList.toggle("occluded", !visible.has(id));
  }
  for (const el of scratchRejected) el.classList.add("occluded");
  const retired = previousVisible;
  previousVisible = visible;
  visibleScratch = retired;
}

/** Per-frame hook (ambient loop): declutter always, pool reassign on LOD. */
export function labelTick(dt: number): void {
  lodClock += dt;
  if (lodClock >= LOD_INTERVAL) {
    lodClock = 0;
    runLabelPass();
  }
  declutterLabels();
}

/** Immediate reassign: call when focus state changes. */
export function refreshLabels(): void {
  lodClock = 0;
  runLabelPass();
  declutterLabels();
}

/**
 * Time `frames` label ticks end-to-end (pool LOD may or may not fire).
 * Used by apps/ios/scripts/test-graph.mjs for the browser frame budget.
 */
export function benchLabelTick(frames = 60): number {
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) labelTick(1 / 60);
  return performance.now() - t0;
}

/** Drop every pooled label (mount/remount/destroy). */
export function resetLabels(): void {
  for (const entry of pool) {
    if (entry) detachEntry(entry);
  }
  previousVisible = new Set();
  visibleScratch = new Set();
  eagerIds.clear();
}
