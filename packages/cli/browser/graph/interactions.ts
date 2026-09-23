import * as THREE from "three";
import type { FGNode, NodeDetail } from "./types.js";
import { focusMode, nodeDetail, nodeRadius, state } from "./state.js";
import { applyHighlight, startIntroStagger } from "./nodes.js";
import { mascotMoveTo, spawnLookupPulse } from "./mascot.js";
import { syncProjectNavActive } from "./project-nav.js";
import { refreshProjectPanel } from "./project-panel.js";
import { anchorCamera, followLayout, frameSelection, moveCamera, restoreSelectionCamera } from "./selection-camera.js";

let projectPaneTimer: ReturnType<typeof setTimeout> | null = null;

function cancelProjectPaneReveal(): void {
  if (projectPaneTimer) clearTimeout(projectPaneTimer);
  projectPaneTimer = null;
}

export function containerSize(): { w: number; h: number } {
  const w = state.container?.clientWidth || 800;
  const h = state.container?.clientHeight || 600;
  return { w: Math.max(1, w), h: Math.max(1, h) };
}

// ── Hover ───────────────────────────────────────────────────────────────

export function onHover(fgNode: FGNode | null): void {
  state.hoveredNodeId = fgNode ? fgNode.id : null;
  if (state.container) state.container.style.cursor = fgNode ? "pointer" : "default";
  applyHighlight();
}

// ── Camera ──────────────────────────────────────────────────────────────

/** Fly the camera toward a node along its current view direction. */
export function flyToNode(fgNode: FGNode, duration: number): void {
  if (!state.fg || fgNode.x == null) return;
  const nodePos = new THREE.Vector3(fgNode.x || 0, fgNode.y || 0, fgNode.z || 0);
  const camera = state.fg.camera();
  const distance = 140 + nodeRadius(fgNode.raw) * 8;
  const dir = new THREE.Vector3().subVectors(camera.position, nodePos);
  if (dir.lengthSq() < 1) dir.set(0.4, 0.35, 1);
  dir.normalize().multiplyScalar(distance);
  const camPos = nodePos.clone().add(dir);
  anchorCamera(fgNode.id);
  moveCamera(camPos, nodePos, duration);
}

/**
 * The layout was recomputed for a new node set (a Focus neighbourhood, a
 * refresh, a filter or a delete), which moves nodes. Keep the camera on the
 * node it was sent to rather than on the spot where that node used to be.
 */
export function followLayoutChange(): void {
  const id = followLayout();
  const fgNode = id ? state.fgNodeById.get(id) : null;
  if (fgNode) flyToNode(fgNode, 500);
}

export function screenPosFor(nodeId: string): { x: number; y: number } | null {
  const fgNode = state.fgNodeById.get(nodeId);
  if (!fgNode || !state.fg || fgNode.x == null) return null;
  try {
    const coords = state.fg.graph2ScreenCoords(fgNode.x, fgNode.y || 0, fgNode.z || 0);
    return { x: coords.x, y: coords.y };
  } catch {
    return null;
  }
}

// ── Selection ───────────────────────────────────────────────────────────

export function notifySelection(nodeId: string): void {
  const detail = nodeDetail(nodeId);
  const position = screenPosFor(nodeId) || { x: state.lastMouse.x, y: state.lastMouse.y };
  if (!detail) return;
  state.nodeSelectCallbacks.forEach((callback) => callback(detail, position.x, position.y));
}

export function notifyClear(): void {
  restoreSelectionCamera();
  state.selectionClearCallbacks.forEach((callback) => callback());
}

/**
 * A tap or click on the canvas. force-graph reports the object it last
 * hovered, but it refreshes hover on a throttled render tick, and a touch
 * moves no pointer before it lands, so a tap resolved to the node under the
 * previous tap. Pick at the event's own position instead.
 */
export function onCanvasClick(event: MouseEvent | undefined, hovered: FGNode | null): void {
  const rect = event && state.container?.getBoundingClientRect();
  const id = rect ? getNodeAt(event.clientX - rect.left, event.clientY - rect.top)?.id ?? null : hovered?.id ?? null;
  if (id && state.fgNodeById.has(id)) selectNode(id);
  else if (state.selectedNodeId || state.focusedProjectId) clearSelection();
}

export function onNodeRightClick(fgNode: FGNode, event: MouseEvent): void {
  event.preventDefault();
  const detail = nodeDetail(fgNode.id);
  if (!detail) return;
  const rect = state.container?.getBoundingClientRect();
  const x = rect ? event.clientX - rect.left : event.clientX;
  const y = rect ? event.clientY - rect.top : event.clientY;
  state.rightClickCallbacks.forEach((cb) => cb(detail, x, y));
}

export function clearSelection(): void {
  if (!state.selectedNodeId && !state.focusedProjectId) return;
  cancelProjectPaneReveal();
  state.selectedNodeId = null;
  state.focusedProjectId = null;
  state.hoveredNodeId = null;
  applyHighlight();
  syncProjectNavActive();
  refreshProjectPanel();
  notifyClear();
}

export function selectNode(nodeId: string): boolean {
  const fgNode = state.fgNodeById.get(nodeId);
  if (!fgNode) return false;
  const node = state.nodeById.get(nodeId);

  if (node?.kind === "project") {
    if (state.focusedProjectId === nodeId) {
      clearSelection();
      return true;
    }
    state.focusedProjectId = nodeId;
    state.selectedNodeId = null;
    state.hoveredNodeId = null;
    applyHighlight();
    syncProjectNavActive();
    // Keep the graph readable during the camera move, then slide the project's
    // contents in once the destination has settled. A project click is an
    // explicit request to see that pane, so it also overrides a stale
    // persisted collapsed state.
    cancelProjectPaneReveal();
    refreshProjectPanel({ transitioning: true });
    const framed = frameSelection(nodeId);
    if (!framed) flyToNode(fgNode, 900);
    projectPaneTimer = setTimeout(() => {
      projectPaneTimer = null;
      if (state.focusedProjectId === nodeId) refreshProjectPanel({ forceOpen: true });
    }, 900);
    // Notify hosts right away — the docked dossier doesn't wait on the
    // camera, and delaying was a flake source under load. The short defer
    // just lets the fly-to start before the host re-renders.
    if (framed) notifySelection(nodeId);
    else setTimeout(() => {
      if (state.focusedProjectId === nodeId) notifySelection(nodeId);
    }, 120);
    mascotMoveTo(nodeId, true);
    return true;
  }

  state.focusedProjectId = null;
  cancelProjectPaneReveal();
  state.selectedNodeId = nodeId;
  state.hoveredNodeId = nodeId;
  applyHighlight();
  syncProjectNavActive();
  refreshProjectPanel();
  if (frameSelection(nodeId)) {
    notifySelection(nodeId);
    mascotMoveTo(nodeId, true);
    return true;
  }
  flyToNode(fgNode, 800);
  // The node's screen position changes throughout the camera flight. Re-anchor
  // the contextual pane after the camera settles so it cannot end up covering
  // the newly selected finding/task/fragment.
  cancelProjectPaneReveal();
  projectPaneTimer = setTimeout(() => {
    projectPaneTimer = null;
    if (state.selectedNodeId === nodeId) {
      refreshProjectPanel();
      notifySelection(nodeId);
    }
  }, 800);
  mascotMoveTo(nodeId, true);
  return true;
}

/**
 * Fly the camera to a node and pulse it WITHOUT changing the selection — a
 * lightweight "show me where this is" that leaves the dossier alone.
 */
export function peekNode(nodeId: string): void {
  const fgNode = state.fgNodeById.get(nodeId);
  if (!fgNode) return;
  flyToNode(fgNode, 700);
  const reducedMotion = typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reducedMotion) spawnLookupPulse(nodeId);
}

export function getNodeAt(x: number, y: number): NodeDetail | null {
  if (!state.fg) return null;
  const size = containerSize();
  const ndc = new THREE.Vector2((x / size.w) * 2 - 1, -(y / size.h) * 2 + 1);
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndc, state.fg.camera());
  const hits = raycaster.intersectObjects(state.fg.scene().children, true);
  // Dot sprites are square quads larger than the glow they draw, so a nearer
  // neighbour's quad can cover the dot under the finger. Of the nodes hit,
  // take the one whose centre is closest to the point on screen.
  let best: { id: string; distance: number } | null = null;
  for (const hit of hits) {
    let obj: THREE.Object3D | null = hit.object;
    while (obj) {
      const id = obj.userData?.phrenNodeId;
      if (typeof id === "string") {
        const at = screenPosFor(id);
        const distance = at ? Math.hypot(at.x - x, at.y - y) : Infinity;
        if (!best || distance < best.distance) best = { id, distance };
        break;
      }
      obj = obj.parent;
    }
  }
  return best ? nodeDetail(best.id) : null;
}

// ── Intro sequence ──────────────────────────────────────────────────────
// First engine settle: snap-fit, jump the camera out to 2.6× with a little
// elevation, dolly back in over 1.6s while nodes stagger-fade in behind a
// 500ms cover fade. Honors prefers-reduced-motion.

/**
 * Camera position that frames the whole graph. Deterministic box-fit: unlike
 * zoomToFit (which fits the bounding SPHERE to the frame height and leaves a
 * wide-and-flat graph filling only ~20% of the viewport), this fits the
 * projected box silhouette — width against the HORIZONTAL fov, height against
 * the vertical — so the horizontal store row actually fills the frame. A slice
 * of depth is folded in as slack so the 3/4 view never clips near/far faces.
 */
function computeFitCamera(): { pos: THREE.Vector3; target: THREE.Vector3 } | null {
  const fg = state.fg;
  if (!fg) return null;
  const bbox = fg.getGraphBbox?.();
  if (!bbox) return null;
  const center = new THREE.Vector3(
    (bbox.x[0] + bbox.x[1]) / 2,
    (bbox.y[0] + bbox.y[1]) / 2,
    (bbox.z[0] + bbox.z[1]) / 2,
  );
  const w = bbox.x[1] - bbox.x[0];
  const h = bbox.y[1] - bbox.y[0];
  const d = bbox.z[1] - bbox.z[0];
  const camera = fg.camera();
  const vfov = ((camera.fov || 50) * Math.PI) / 180;
  const size = containerSize();
  const aspect = size.w / size.h;
  const halfH = h / 2 + d * 0.28;
  const halfW = w / 2 + d * 0.28;
  const distH = halfH / Math.tan(vfov / 2);
  const distW = halfW / (Math.tan(vfov / 2) * aspect);
  const distance = Math.max(distH, distW, 80) * 1.1 + 30;
  const dir = camera.position.clone().sub(center);
  if (dir.lengthSq() < 1) dir.set(0.42, 0.32, 1);
  dir.normalize();
  return { pos: center.clone().add(dir.multiplyScalar(distance)), target: center };
}

// Screen padding for the zoomToFit fallback when the bbox isn't ready yet.
const FIT_PADDING = 48;

export function fitCameraToGraph(duration: number): void {
  const fg = state.fg;
  if (!fg) return;
  anchorCamera(null);
  const fit = computeFitCamera();
  if (!fit) {
    fg.zoomToFit(duration, FIT_PADDING);
    return;
  }
  moveCamera(fit.pos, fit.target, duration);
}

export function runIntro(): void {
  const fg = state.fg;
  if (!fg) return;
  if (state.introPlayed) {
    fitCameraToGraph(700);
    return;
  }
  state.introPlayed = true;

  const reducedMotion = typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reducedMotion) {
    fitCameraToGraph(0);
    return;
  }

  const cover = document.createElement("div");
  cover.className = "phren-intro-cover";
  cover.setAttribute("aria-hidden", "true");
  cover.style.cssText =
    "position:absolute;inset:0;background:#05060f;z-index:6;pointer-events:none;opacity:1;transition:opacity 0.5s ease;";
  state.container?.appendChild(cover);

  // Snap-fit, stagger the nodes in, then ease the box-fit again next frame in
  // case node objects finished syncing after the first call.
  fitCameraToGraph(0);
  startIntroStagger();
  const interactionAt = state.lastInteractionAt;
  requestAnimationFrame(() => {
    if (!state.selectedNodeId && !state.focusedProjectId && state.lastInteractionAt === interactionAt) fitCameraToGraph(1400);
    cover.style.opacity = "0";
  });
  setTimeout(() => cover.remove(), 900);
}

// ── Idle auto-orbit ─────────────────────────────────────────────────────

export function noteInteraction(): void {
  state.lastInteractionAt = performance.now();
  if (state.fg?.controls()) state.fg.controls().autoRotate = false;
}

/** Resume the slow orbit after 18s of stillness with nothing selected. */
export function tickIdleResume(now: number): void {
  const controls = state.fg?.controls();
  if (!controls || controls.autoRotate) return;
  if (state.selectedNodeId || state.focusedProjectId || state.hoveredNodeId) return;
  if (focusMode() !== "idle") return;
  if (now - state.lastInteractionAt > 18_000) controls.autoRotate = true;
}
