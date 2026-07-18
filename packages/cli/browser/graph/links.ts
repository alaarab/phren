import * as THREE from "three";
import type { FGLink } from "./types.js";
import { focusMode, isInProjectNetwork, state } from "./state.js";

// Links render as THREE.Line primitives (linkWidth 0) — far cheaper than
// the cylinder meshes width>0 forces, and the thin hairline reads better.
// All emphasis comes from per-state alpha, not geometry.

export function linkEndpointId(end: string | FGLink["source"]): string {
  return typeof end === "string" ? end : (end as { id: string }).id;
}

export function linkIsFocused(link: FGLink): boolean {
  const focus = state.hoveredNodeId || state.selectedNodeId;
  if (!focus) return false;
  const s = linkEndpointId(link.source);
  const t = linkEndpointId(link.target);
  return s === focus || t === focus;
}

function endpointLerpColor(link: FGLink, alpha: number): string {
  const s = state.nodeById.get(linkEndpointId(link.source));
  const t = state.nodeById.get(linkEndpointId(link.target));
  if (s && t) {
    const c = new THREE.Color(s.baseColor).lerp(new THREE.Color(t.baseColor), 0.5);
    const r = Math.round(c.r * 255);
    const g = Math.round(c.g * 255);
    const b = Math.round(c.b * 255);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  return `rgba(140,165,210,${alpha})`;
}

const DIM_LINK = "rgba(120,140,180,0.03)";

export function linkColor(link: FGLink): string {
  if (linkIsFocused(link)) return "rgba(255,209,102,0.85)";
  const mode = focusMode();
  if (mode === "project") {
    const s = linkEndpointId(link.source);
    const t = linkEndpointId(link.target);
    const projectId = state.focusedProjectId!;
    if (isInProjectNetwork(s, projectId) && isInProjectNetwork(t, projectId)) {
      return endpointLerpColor(link, 0.55);
    }
    return DIM_LINK;
  }
  if (mode === "hover" || mode === "selected") return DIM_LINK;
  if (mode === "search") {
    const s = linkEndpointId(link.source);
    const t = linkEndpointId(link.target);
    if (state.searchMatchIds.has(s) && state.searchMatchIds.has(t)) {
      return endpointLerpColor(link, 0.3);
    }
    return "rgba(120,140,180,0.05)";
  }
  return endpointLerpColor(link, 0.16);
}

export function linkWidth(): number {
  return 0;
}

export function linkParticles(link: FGLink): number {
  return linkIsFocused(link) ? 2 : 0;
}
