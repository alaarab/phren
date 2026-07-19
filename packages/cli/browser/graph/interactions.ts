import * as THREE from "three";
import type { FGNode, NodeDetail, RuntimeNode } from "./types.js";
import { focusMode, nodeDetail, nodeRadius, scoreForNode, state } from "./state.js";
import { applyHighlight, startIntroStagger } from "./nodes.js";
import { mascotMoveTo } from "./mascot.js";
import { syncProjectNavActive } from "./project-nav.js";
import { refreshProjectPanel } from "./project-panel.js";

export function containerSize(): { w: number; h: number } {
  const w = state.container?.clientWidth || 800;
  const h = state.container?.clientHeight || 600;
  return { w: Math.max(1, w), h: Math.max(1, h) };
}

// ── Tooltip ─────────────────────────────────────────────────────────────

export function hideTooltip(): void {
  if (!state.tooltip) return;
  state.tooltip.style.opacity = "0";
  state.tooltip.classList.remove("visible");
  state.tooltip.innerHTML = "";
}

function tooltipText(node: RuntimeNode): string {
  if (node.kind === "finding") {
    const text = node.fullLabel || node.label || "";
    let preview = text.length > 100 ? text.slice(0, 97) + "..." : text;
    const score = scoreForNode(node);
    const rawDate = node.date && node.date !== "unknown" ? node.date : "";
    const dateStr = rawDate || score?.lastUsedAt || "";
    if (dateStr) {
      const d = new Date(dateStr);
      if (!isNaN(d.getTime())) {
        const days = Math.floor((Date.now() - d.getTime()) / 86400000);
        const rel = days < 1 ? "today" : days === 1 ? "yesterday" : days < 30 ? `${days}d ago` : days < 365 ? `${Math.floor(days / 30)}mo ago` : `${Math.floor(days / 365)}y ago`;
        preview += `\n${node.date ? rel : "seen " + rel}`;
      }
    }
    return preview;
  }
  if (node.kind === "task") {
    const line = node.fullLabel || node.label || "";
    const section = node.section ? `[${node.section}]` : "";
    const priority = node.priority ? `${node.priority}◆` : "";
    return `${line}\n${[section, priority].filter(Boolean).join(" ")}`;
  }
  if (node.kind === "entity") {
    return `${node.label}\n${node.refCount || 0} refs • ${node.connectedProjects?.length || 0} projects`;
  }
  if (node.kind === "project") {
    const findings = typeof node.findingCount === "number" ? node.findingCount : state.fullAdjacency.get(node.id)
      ? [...state.fullAdjacency.get(node.id)!].filter((id) => state.nodeById.get(id)?.kind === "finding").length
      : 0;
    const tasks = typeof node.taskCount === "number" ? node.taskCount : state.fullAdjacency.get(node.id)
      ? [...state.fullAdjacency.get(node.id)!].filter((id) => state.nodeById.get(id)?.kind === "task").length
      : 0;
    return `${node.label}\n${findings} findings • ${tasks} tasks`;
  }
  return node.label || node.id;
}

export function onHover(fgNode: FGNode | null): void {
  state.hoveredNodeId = fgNode ? fgNode.id : null;
  if (state.container) state.container.style.cursor = fgNode ? "pointer" : "default";
  if (fgNode && state.tooltip) {
    const text = tooltipText(fgNode.raw);
    if (text) {
      state.tooltip.textContent = text;
      state.tooltip.style.left = state.lastMouse.x + 14 + "px";
      state.tooltip.style.top = state.lastMouse.y + 14 + "px";
      state.tooltip.style.opacity = "1";
      state.tooltip.classList.add("visible");
    }
  } else {
    hideTooltip();
  }
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
  state.fg.cameraPosition(
    { x: camPos.x, y: camPos.y, z: camPos.z },
    { x: nodePos.x, y: nodePos.y, z: nodePos.z },
    duration,
  );
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
  state.selectionClearCallbacks.forEach((callback) => callback());
}

export function onNodeClick(fgNode: FGNode): void {
  selectNode(fgNode.id);
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
  state.selectedNodeId = null;
  state.focusedProjectId = null;
  state.hoveredNodeId = null;
  hideTooltip();
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
    refreshProjectPanel();
    flyToNode(fgNode, 900);
    // Notify hosts right away — the docked dossier doesn't wait on the
    // camera, and delaying was a flake source under load. The short defer
    // just lets the fly-to start before the host re-renders.
    setTimeout(() => notifySelection(nodeId), 120);
    mascotMoveTo(nodeId, true);
    return true;
  }

  state.focusedProjectId = null;
  state.selectedNodeId = nodeId;
  state.hoveredNodeId = nodeId;
  hideTooltip();
  applyHighlight();
  syncProjectNavActive();
  refreshProjectPanel();
  flyToNode(fgNode, 800);
  setTimeout(() => notifySelection(nodeId), 120);
  mascotMoveTo(nodeId, true);
  return true;
}

export function getNodeAt(x: number, y: number): NodeDetail | null {
  if (!state.fg) return null;
  const size = containerSize();
  const ndc = new THREE.Vector2((x / size.w) * 2 - 1, -(y / size.h) * 2 + 1);
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndc, state.fg.camera());
  const hits = raycaster.intersectObjects(state.fg.scene().children, true);
  for (const hit of hits) {
    let obj: THREE.Object3D | null = hit.object;
    while (obj) {
      const id = obj.userData?.phrenNodeId;
      if (typeof id === "string") return nodeDetail(id);
      obj = obj.parent;
    }
  }
  return null;
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
  const fit = computeFitCamera();
  if (!fit) {
    fg.zoomToFit(duration, FIT_PADDING);
    return;
  }
  fg.cameraPosition(
    { x: fit.pos.x, y: fit.pos.y, z: fit.pos.z },
    { x: fit.target.x, y: fit.target.y, z: fit.target.z },
    duration,
  );
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
  requestAnimationFrame(() => {
    fitCameraToGraph(1400);
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
