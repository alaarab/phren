import type {
  ClearCallback,
  FGNode,
  GraphPayload,
  NodeDetail,
  RawLink,
  RawTopic,
  RuntimeNode,
  RawNode,
  ScoreEntry,
  SelectCallback,
} from "./types.js";
import * as core from "../../src/graph-core/model.js";

// Pure, context-free helpers are shared verbatim with the terminal graph view.
export {
  clamp,
  hashString,
  seeded,
  deriveKind,
  topicColor,
  inferHealth,
  searchTextForNode,
  nodeRadius,
} from "../../src/graph-core/model.js";

const storeColors = new core.StoreColorAssigner();
export function storeColor(storeName?: string): string | null {
  return storeColors.color(storeName);
}

export type FocusMode = "idle" | "hover" | "selected" | "project" | "search";

export const state = {
  payload: null as GraphPayload | null,
  rawNodes: [] as RuntimeNode[],
  rawLinks: [] as RawLink[],
  topics: [] as RawTopic[],
  nodeById: new Map<string, RuntimeNode>(),
  fullAdjacency: new Map<string, Set<string>>(),
  visibleAdjacency: new Map<string, Set<string>>(),
  visibleNodes: [] as RuntimeNode[],
  visibleLinks: [] as RawLink[],
  visibleIds: new Set<string>(),
  hostNodes: [] as NodeDetail[],
  fg: null as any,
  fgNodeById: new Map<string, FGNode>(),
  container: null as HTMLElement | null,
  tooltip: null as HTMLElement | null,
  selectedNodeId: null as string | null,
  hoveredNodeId: null as string | null,
  focusedProjectId: null as string | null,
  searchMatchIds: new Set<string>(),
  /** Search matches ordered best→worst; mirrors searchMatchIds. */
  searchResults: [] as RuntimeNode[],
  /** Cursor into searchResults for next/prev cycling; -1 = no active match. */
  currentMatchIndex: -1,
  nodeSelectCallbacks: [] as SelectCallback[],
  selectionClearCallbacks: [] as ClearCallback[],
  rightClickCallbacks: [] as Array<(node: NodeDetail, x: number, y: number) => void>,
  /** Host handlers for row actions (e.g. delete) fired from the contents pane. */
  itemActionCallbacks: [] as Array<(node: NodeDetail | NodeDetail[], action: string) => void>,
  filterTypes: {
    project: true,
    finding: true,
    task: true,
    entity: true,
    reference: true,
  },
  filterTopics: {} as Record<string, boolean>,
  filterHealth: "all",
  filterProject: "all",
  filterStore: "all",
  searchQuery: "",
  nodeLimit: 4000,
  theme: "dark" as "dark" | "light",
  lastMouse: { x: 0, y: 0 },
  firstSettle: true,
  introPlayed: false,
  /** True while per-node dim intensities are lerping toward their targets. */
  dimAnimating: false,
  /** Wall-clock ms of the last user pointer/wheel interaction (idle-orbit resume). */
  lastInteractionAt: 0,
  /** Effects toggle: data-fx="off" on #graph-canvas disables the bloom composer. */
  fxOff: false,
  ambientRafId: 0,
  themeObserver: null as MutationObserver | null,
  resizeObserver: null as ResizeObserver | null,
  cleanupFns: [] as Array<() => void>,
};

/** The shared-model view of the browser state (the `state` object already satisfies `GraphFilters`). */
function scores(): core.ScoreMap {
  return state.payload?.scores || {};
}
function model(): core.GraphModel {
  return {
    rawNodes: state.rawNodes,
    rawLinks: state.rawLinks,
    nodeById: state.nodeById,
    fullAdjacency: state.fullAdjacency,
    visibleAdjacency: state.visibleAdjacency,
    scores: scores(),
  };
}

export function currentTheme(): "dark" | "light" {
  const theme = document.documentElement.getAttribute("data-theme");
  return theme === "light" ? "light" : "dark";
}

export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function scoreForNode(node: RawNode): ScoreEntry | undefined {
  return core.scoreForNode(node, scores());
}

export function qualityScore(node: RawNode): number | null {
  return core.qualityScore(node, scores());
}

export function baseColorForNode(node: RawNode): string {
  return core.baseColorForNode(node, storeColor);
}

export function sizeForNode(node: RawNode): number {
  return core.sizeForNode(node, scores());
}

export function normalizeNode(node: RawNode): RuntimeNode {
  return core.normalizeNode(node, scores(), storeColor);
}

export function ensureTopicFilters(): void {
  const next: Record<string, boolean> = {};
  for (const topic of state.topics) next[topic.slug] = state.filterTopics[topic.slug] !== false;
  state.filterTopics = next;
}

export function buildFullAdjacency(): void {
  state.fullAdjacency = core.buildFullAdjacency(state.rawNodes, state.rawLinks);
}

export function connectionCounts(nodeId: string): NodeDetail["connections"] {
  return core.connectionCounts(state, nodeId);
}

/** Check if a node is in a project's direct network (1-hop neighbors). */
export function isInProjectNetwork(nodeId: string, projectId: string): boolean {
  return core.isInProjectNetwork(state.visibleAdjacency, nodeId, projectId);
}

export function nodeDetail(nodeId: string): NodeDetail | null {
  return core.nodeDetail(model(), nodeId);
}

/**
 * Structural filters only. The search query deliberately does NOT remove
 * nodes — search dims non-matches instead (focus mode "search"), so the
 * graph keeps its shape while matches light up.
 */
export function nodeMatchesFilters(node: RuntimeNode): boolean {
  return core.nodeMatchesFilters(node, state);
}

export function nodeRank(node: RuntimeNode): number {
  return core.nodeRank(node, state, scores());
}

export function buildVisibleData(): { nodes: RuntimeNode[]; links: RawLink[] } {
  const visible = core.buildVisibleData(model(), state, state.selectedNodeId);
  state.visibleAdjacency = visible.visibleAdjacency;
  return { nodes: visible.nodes, links: visible.links };
}

export function rebuildHostNodes(): void {
  state.hostNodes = state.visibleNodes
    .map((node) => nodeDetail(node.id))
    .filter((node): node is NodeDetail => Boolean(node));
}

/** Recompute the set of visible nodes matching the current search query. */
export function recomputeSearchMatches(): void {
  const matches = core.recomputeSearchMatches(state.visibleNodes, state.searchQuery, state, scores());
  state.searchMatchIds = matches.matchIds;
  state.searchResults = matches.results;
}

/** The active focus mode, in priority order. */
export function focusMode(): FocusMode {
  if (state.focusedProjectId) return "project";
  if (state.hoveredNodeId || state.selectedNodeId) return state.selectedNodeId && !state.hoveredNodeId ? "selected" : "hover";
  if (state.searchQuery.trim()) return "search";
  return "idle";
}

/**
 * Pick the best search hit for Enter-to-fly: label prefix beats label
 * substring beats deep-text substring; nodeRank breaks ties.
 */
export function bestSearchMatch(): RuntimeNode | null {
  return core.bestSearchMatch(state.searchResults);
}
