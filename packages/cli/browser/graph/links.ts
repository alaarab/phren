import type { FGLink } from "./types.js";
import { focusMode, isInProjectNetwork, state } from "./state.js";

// Links render as THREE.Line primitives (linkWidth 0). Idle links are a
// uniform pale filament web — the GraphRAG look — not per-edge color blends.
// Emphasis (amber) appears only on the focused node's edges.

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

const FILAMENT = "rgba(190,210,240,0.10)";
const FILAMENT_ENTITY = "rgba(170,195,235,0.06)";
const DIM_LINK = "rgba(120,140,180,0.025)";

function isEntityLink(link: FGLink): boolean {
  const s = state.nodeById.get(linkEndpointId(link.source));
  const t = state.nodeById.get(linkEndpointId(link.target));
  return s?.kind === "entity" || t?.kind === "entity";
}

export function linkColor(link: FGLink): string {
  if (linkIsFocused(link)) return "rgba(255,209,102,0.8)";
  const mode = focusMode();
  if (mode === "project") {
    const s = linkEndpointId(link.source);
    const t = linkEndpointId(link.target);
    const projectId = state.focusedProjectId!;
    if (isInProjectNetwork(s, projectId) && isInProjectNetwork(t, projectId)) {
      return "rgba(200,220,248,0.28)";
    }
    return DIM_LINK;
  }
  if (mode === "hover" || mode === "selected") return DIM_LINK;
  if (mode === "search") {
    const s = linkEndpointId(link.source);
    const t = linkEndpointId(link.target);
    if (state.searchMatchIds.has(s) && state.searchMatchIds.has(t)) {
      return "rgba(200,220,248,0.24)";
    }
    return DIM_LINK;
  }
  return isEntityLink(link) ? FILAMENT_ENTITY : FILAMENT;
}

export function linkWidth(): number {
  return 0;
}

export function linkParticles(link: FGLink): number {
  return linkIsFocused(link) ? 2 : 0;
}
