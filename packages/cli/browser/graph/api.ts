import * as THREE from "three";
import type { ClearCallback, FGNode, GraphPayload, NodeDetail, SelectCallback } from "./types.js";
import { ROOT } from "./types.js";
import {
  baseColorForNode,
  buildFullAdjacency,
  ensureTopicFilters,
  nodeDetail,
  normalizeNode,
  searchTextForNode,
  state,
} from "./state.js";
import { applyHighlight } from "./nodes.js";
import { resetLabels, refreshLabels, updateEagerLabelText } from "./labels.js";
import { applyFilters, disposeScene, setupForceGraph } from "./scene.js";
import { buildFilterBar, buildHudOverlays } from "./hud.js";
import { clearSelection, getNodeAt, hideTooltip, runIntro, selectNode } from "./interactions.js";
import { disposePulses, mascot, startMascot, stopMascot, walkTo } from "./mascot.js";

function mount(payload: GraphPayload): void {
  state.container = document.getElementById("graph-canvas");
  state.tooltip = document.getElementById("graph-tooltip");
  if (!state.container) {
    console.error("[phrenGraph] #graph-canvas not found");
    return;
  }

  if (state.tooltip) {
    Object.assign(state.tooltip.style, {
      position: "absolute",
      pointerEvents: "none",
      zIndex: "1000",
      maxWidth: "320px",
      padding: "9px 12px",
      borderRadius: "6px",
      fontSize: "12px",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      backgroundColor: "rgba(8,10,22,0.92)",
      color: "#dbe4ff",
      border: "1px solid rgba(103,232,249,0.25)",
      boxShadow: "0 4px 18px rgba(0,0,0,0.5), 0 0 14px rgba(103,232,249,0.08)",
      opacity: "0",
      transition: "opacity 150ms ease-in-out",
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
      lineHeight: "1.5",
      letterSpacing: "0.01em",
    });
    state.tooltip.classList.add("graph-tooltip");
  }

  state.payload = payload || {};
  state.rawNodes = (payload.nodes || []).map(normalizeNode);
  state.rawLinks = (payload.links || []).slice();
  state.topics = (payload.topics && payload.topics.length
    ? payload.topics
    : Array.from(new Map(
      state.rawNodes
        .filter((node) => node.kind === "finding" && node.topicSlug)
        .map((node) => [node.topicSlug!, { slug: node.topicSlug!, label: node.topicLabel || node.topicSlug! }]),
    ).values())
  ).sort((a, b) => a.label.localeCompare(b.label));
  ensureTopicFilters();

  state.nodeById = new Map();
  state.rawNodes.forEach((node) => state.nodeById.set(node.id, node));

  // Rebuild from scratch so node meshes reflect the fresh payload — three-forcegraph
  // keys its cached objects off the node reference, so new payloads need new objects.
  resetLabels();
  state.fgNodeById.forEach(disposeNodeObject);
  state.fgNodeById.clear();

  buildFullAdjacency();
  buildFilterBar();
  setupForceGraph();
  buildHudOverlays();
  state.firstSettle = true;
  applyFilters({ resetCamera: true, emitSelection: Boolean(state.selectedNodeId) });
  startMascot();

  // Software GL can take many seconds to finish the cooldown ticks that
  // fire onEngineStop — don't leave the camera parked wide. Warmup already
  // ran 60 ticks, so positions are respectable; whichever trigger fires
  // first wins via the firstSettle flag.
  setTimeout(() => {
    if (state.firstSettle) {
      state.firstSettle = false;
      runIntro();
    }
  }, 2600);
}

function disposeNodeObject(fgNode: FGNode): void {
  if (fgNode.__core) (fgNode.__core.material as THREE.Material).dispose();
  if (fgNode.__shell) (fgNode.__shell.material as THREE.Material).dispose();
  if (fgNode.__wire) (fgNode.__wire.material as THREE.Material).dispose();
  if (fgNode.__ring) (fgNode.__ring.material as THREE.Material).dispose();
  if (fgNode.__halo) (fgNode.__halo.material as THREE.SpriteMaterial).dispose();
  if (fgNode.__labelEl) fgNode.__labelEl.remove();
  fgNode.__group = undefined;
  fgNode.__core = undefined;
  fgNode.__shell = undefined;
  fgNode.__wire = undefined;
  fgNode.__ring = undefined;
  fgNode.__halo = undefined;
  fgNode.__labelObj = undefined;
  fgNode.__labelEl = undefined;
}

function updateNode(
  nodeId: string,
  changes: {
    label?: string;
    fullLabel?: string;
    text?: string;
    section?: string;
    priority?: string;
    topicSlug?: string;
    topicLabel?: string;
    color?: string;
  },
): boolean {
  const node = state.nodeById.get(nodeId);
  if (!node) return false;

  if (typeof changes.section === "string") node.section = changes.section;
  if (typeof changes.priority === "string") node.priority = changes.priority;
  if (typeof changes.topicSlug === "string") node.topicSlug = changes.topicSlug;
  if (typeof changes.topicLabel === "string") node.topicLabel = changes.topicLabel;
  if (typeof changes.text === "string") {
    node.fullLabel = changes.text;
    if (!changes.label) node.label = changes.text.slice(0, 40) + (changes.text.length > 40 ? "…" : "");
  }
  if (typeof changes.fullLabel === "string") node.fullLabel = changes.fullLabel;
  if (typeof changes.label === "string") node.label = changes.label;

  node.baseColor = changes.color || baseColorForNode(node);
  node.searchText = searchTextForNode(node);

  const hostEntry = state.hostNodes.find((host) => host.id === nodeId);
  if (hostEntry) {
    Object.assign(hostEntry, {
      section: node.section,
      priority: node.priority,
      topicSlug: node.topicSlug,
      topicLabel: node.topicLabel,
      label: node.label,
      fullLabel: node.fullLabel,
      baseColor: node.baseColor,
    });
  }

  const fgNode = state.fgNodeById.get(nodeId);
  if (fgNode?.__core) {
    const color = new THREE.Color(node.baseColor);
    (fgNode.__core.material as THREE.MeshBasicMaterial).color.copy(
      color.clone().lerp(new THREE.Color("#ffffff"), node.kind === "project" ? 0.55 : 0.25),
    );
    if (fgNode.__halo) (fgNode.__halo.material as THREE.SpriteMaterial).color.copy(color);
    if (fgNode.__shell) {
      const mat = fgNode.__shell.material as THREE.ShaderMaterial;
      if (mat.uniforms?.uColor) mat.uniforms.uColor.value.set(node.baseColor);
      else (fgNode.__shell.material as THREE.MeshBasicMaterial).color?.set(node.baseColor);
    }
    if (fgNode.__wire) (fgNode.__wire.material as THREE.MeshBasicMaterial).color.set(node.baseColor);
    if (fgNode.__ring) (fgNode.__ring.material as THREE.MeshBasicMaterial).color.set(node.baseColor);
    updateEagerLabelText(fgNode);
  }
  refreshLabels();
  return true;
}

function removeNode(nodeId: string, opts?: { animate?: boolean }): boolean {
  const fgNode = state.fgNodeById.get(nodeId);
  if (!state.nodeById.has(nodeId) && !fgNode) return false;

  const wasSelected = state.selectedNodeId === nodeId;
  const reducedMotion = typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const animate = opts?.animate !== false && !reducedMotion && Boolean(fgNode?.__group);

  const finalize = () => {
    state.rawNodes = state.rawNodes.filter((node) => node.id !== nodeId);
    state.rawLinks = state.rawLinks.filter((link) => link.source !== nodeId && link.target !== nodeId);
    state.nodeById.delete(nodeId);
    if (state.selectedNodeId === nodeId) state.selectedNodeId = null;
    if (state.hoveredNodeId === nodeId) state.hoveredNodeId = null;
    if (state.focusedProjectId === nodeId) state.focusedProjectId = null;
    if (fgNode) {
      disposeNodeObject(fgNode);
      state.fgNodeById.delete(nodeId);
    }
    if (mascot.currentNodeId === nodeId) mascot.currentNodeId = null;
    if (mascot.targetNodeId === nodeId) mascot.targetNodeId = null;
    buildFullAdjacency();
    hideTooltip();
    applyFilters({ resetCamera: false, emitSelection: false });
    if (wasSelected) notifyClearOnce();
  };

  const notifyClearOnce = () => {
    state.selectionClearCallbacks.forEach((callback) => callback());
  };

  if (!animate || !fgNode?.__group) {
    finalize();
    return true;
  }

  if (wasSelected) clearSelection();
  hideTooltip();
  const duration = 280;
  const start = performance.now();
  let finalized = false;
  const finalizeOnce = () => {
    if (finalized) return;
    finalized = true;
    finalize();
  };
  const step = (now: number) => {
    if (finalized) return;
    const t = Math.min(1, (now - start) / duration);
    const scale = (1 - t) * (1 - t) * (1 - t);
    // Breathing renders __focusScale each frame, so shrink via that.
    fgNode.__focusScale = Math.max(0.01, scale);
    if (t < 1) requestAnimationFrame(step);
    else finalizeOnce();
  };
  requestAnimationFrame(step);
  // rAF cadence collapses under load (software GL, tracing) — a wall-clock
  // backstop keeps the data-layer removal on schedule regardless of fps.
  setTimeout(finalizeOnce, duration + 40);
  return true;
}

function destroy(): void {
  stopMascot();
  disposePulses();
  hideTooltip();
  if (state.ambientRafId) cancelAnimationFrame(state.ambientRafId);
  state.ambientRafId = 0;
  state.themeObserver?.disconnect();
  state.themeObserver = null;
  state.resizeObserver?.disconnect();
  state.resizeObserver = null;
  state.cleanupFns.forEach((fn) => fn());
  state.cleanupFns = [];
  resetLabels();
  state.fgNodeById.forEach(disposeNodeObject);
  state.fgNodeById.clear();
  disposeScene();
  if (state.fg) {
    try { state.fg._destructor?.(); } catch { /* ignore */ }
  }
  state.fg = null;
  state.container = null;
  state.tooltip = null;
}

// ── Window globals ──────────────────────────────────────────────────────

ROOT.graphZoom = function graphZoom(factor: number): void {
  if (!state.fg) return;
  const camera = state.fg.camera();
  const target = state.fg.controls()?.target || new THREE.Vector3();
  const dir = new THREE.Vector3().subVectors(camera.position, target);
  dir.multiplyScalar(1 / Math.max(factor, 0.05));
  const next = new THREE.Vector3().addVectors(target, dir);
  state.fg.cameraPosition({ x: next.x, y: next.y, z: next.z }, undefined, 160);
};

ROOT.graphReset = function graphReset(): void {
  state.fg?.zoomToFit(500, 40);
};

ROOT.graphResetLayout = function graphResetLayout(): void {
  if (!state.fg) return;
  state.fgNodeById.forEach((fgNode) => {
    fgNode.fx = undefined;
    fgNode.fy = undefined;
    fgNode.fz = undefined;
  });
  state.firstSettle = true;
  state.fg.d3ReheatSimulation();
};

ROOT.graphClearSelection = function graphClearSelection(): void {
  clearSelection();
};

ROOT.phrenGraph = {
  __renderer: "three",
  mount,
  onNodeSelect(callback: SelectCallback) {
    state.nodeSelectCallbacks.push(callback);
  },
  onSelectionClear(callback: ClearCallback) {
    state.selectionClearCallbacks.push(callback);
  },
  onRightClick(callback: (node: NodeDetail, x: number, y: number) => void) {
    state.rightClickCallbacks.push(callback);
  },
  clearSelection,
  selectNode,
  focusNode: selectNode,
  walkTo,
  getNodeAt,
  getNodeDetail: nodeDetail,
  getData() {
    return {
      nodes: state.hostNodes.slice(),
      links: state.visibleLinks.slice(),
      topics: state.topics.slice(),
      total: state.rawNodes.length,
    };
  },
  removeNode,
  updateNode,
  destroy,
};
