import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import type { FGNode } from "./types.js";
import { esc, focusMode, nodeRadius, state } from "./state.js";

// DOM labels via CSS2DRenderer: crisp at any zoom, CSP-safe in both hosts
// (pure DOM + CSS transforms — no workers, no eval). Projects get an eager
// always-on label; findings/tasks/refs draw from a fixed pool assigned by
// camera distance so "zoom in to read" is a real interaction with a hard
// cap on live DOM nodes.

const POOL_SIZE = 40;
const LABEL_DIST = 520;
const LABEL_DIST_SQ = LABEL_DIST * LABEL_DIST;
const LOD_INTERVAL = 0.15;

type PoolEntry = { obj: CSS2DObject; el: HTMLDivElement; nodeId: string | null };

const pool: PoolEntry[] = [];
let lodClock = 0;

const LABEL_CSS = `
.phren-label{
  font:500 10.5px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color:#dbe4ff;background:rgba(6,8,18,0.82);
  border:1px solid rgba(103,232,249,0.14);border-left:2px solid #67e8f9;
  padding:3px 8px;border-radius:4px;max-width:230px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  letter-spacing:0.02em;pointer-events:none;
  opacity:0;transition:opacity 0.2s ease;
}
.phren-label.in{opacity:1}
.phren-label.dim{opacity:0.05}
.phren-label--project{
  font-weight:700;font-size:11.5px;color:#ffe9c4;border-left-color:#f5b342;
  text-transform:uppercase;letter-spacing:0.09em;max-width:260px;
}
.phren-label--project .phren-label-meta{
  display:block;font-weight:500;font-size:9px;color:#8b96c9;
  text-transform:none;letter-spacing:0.04em;margin-top:1px;
}
.phren-label--entity{color:#a8ecff}
.phren-label--task{color:#c9f4d8}
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
    const counts: string[] = [];
    if (typeof node.findingCount === "number") counts.push(`${node.findingCount} findings`);
    if (typeof node.taskCount === "number" && node.taskCount > 0) counts.push(`${node.taskCount} tasks`);
    el.innerHTML = `<span>${esc(node.label)}</span>${counts.length ? `<span class="phren-label-meta">${esc(counts.join(" · "))}</span>` : ""}`;
  } else {
    el.textContent = node.label;
    el.style.borderLeftColor = node.baseColor;
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
    fgNode.__labelEl.style.borderLeftColor = node.baseColor;
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
  entry.el.style.borderLeftColor = fgNode.raw.baseColor;
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
