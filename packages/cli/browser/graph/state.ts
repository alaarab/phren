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
import { KIND_COLORS, STORE_COLORS, TOPIC_COLORS } from "./types.js";

let _storeColorMap: Map<string, string> | null = null;
export function storeColor(storeName?: string): string | null {
  if (!storeName || storeName === "primary") return null;
  if (!_storeColorMap) _storeColorMap = new Map();
  if (_storeColorMap.has(storeName)) return _storeColorMap.get(storeName)!;
  const idx = (_storeColorMap.size + 1) % STORE_COLORS.length;
  _storeColorMap.set(storeName, STORE_COLORS[idx]);
  return STORE_COLORS[idx];
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
  nodeSelectCallbacks: [] as SelectCallback[],
  selectionClearCallbacks: [] as ClearCallback[],
  rightClickCallbacks: [] as Array<(node: NodeDetail, x: number, y: number) => void>,
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
  nodeLimit: 2000,
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

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function currentTheme(): "dark" | "light" {
  const theme = document.documentElement.getAttribute("data-theme");
  return theme === "light" ? "light" : "dark";
}

export function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function seeded(value: string, salt: string): number {
  return (hashString(`${salt}:${value}`) % 10000) / 10000;
}

export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function deriveKind(node: RawNode): RuntimeNode["kind"] {
  if (node.group === "project") return "project";
  if (node.group === "entity") return "entity";
  if (node.group === "reference") return "reference";
  if (node.group.startsWith("task-")) return "task";
  if (node.group.startsWith("topic:")) return "finding";
  return "other";
}

export function topicColor(slug?: string): string {
  if (!slug) return KIND_COLORS.other;
  return TOPIC_COLORS[slug] || TOPIC_COLORS.general;
}

export function scoreForNode(node: RawNode): ScoreEntry | undefined {
  const scores = state.payload?.scores || {};
  if (node.scoreKey && scores[node.scoreKey]) return scores[node.scoreKey];
  if (node.scoreKeys) {
    for (const key of node.scoreKeys) {
      if (scores[key]) return scores[key];
    }
  }
  if (node.refDocs) {
    for (const ref of node.refDocs) {
      if (ref.scoreKey && scores[ref.scoreKey]) return scores[ref.scoreKey];
    }
  }
  return undefined;
}

export function inferHealth(score?: ScoreEntry): RuntimeNode["health"] {
  if (!score || !score.lastUsedAt) return "healthy";
  const ageMs = Date.now() - new Date(score.lastUsedAt).getTime();
  const ageDays = Number.isFinite(ageMs) ? ageMs / 86400000 : 0;
  const penalties = (score.repromptPenalty || 0) + (score.regressionPenalty || 0) * 2;
  if (ageDays > 150 || penalties >= 4) return "stale";
  if (ageDays > 60 || penalties >= 2) return "decaying";
  return "healthy";
}

export function qualityScore(node: RawNode): number | null {
  const score = scoreForNode(node);
  if (!score) return null;
  const helpful = score.helpful || 0;
  const impressions = score.impressions || 0;
  const penalties = (score.repromptPenalty || 0) + (score.regressionPenalty || 0) * 2;
  const raw = 0.55 + helpful * 0.1 + Math.min(0.2, impressions * 0.02) - penalties * 0.08;
  return clamp(raw, 0.1, 1);
}

export function baseColorForNode(node: RawNode): string {
  const kind = deriveKind(node);
  if (kind === "finding") return topicColor(node.topicSlug || node.group.slice(6));
  if (kind === "task") {
    if (node.section === "Done" || node.group === "task-done") return KIND_COLORS["task-done"];
    if (node.section === "Active" || node.group === "task-active") return KIND_COLORS["task-active"];
    return KIND_COLORS["task-queue"];
  }
  if (kind === "project") return storeColor(node.store) || KIND_COLORS.project;
  if (kind === "entity") return KIND_COLORS.entity;
  if (kind === "reference") return KIND_COLORS.reference;
  return KIND_COLORS.other;
}

export function sizeForNode(node: RawNode): number {
  const kind = deriveKind(node);
  const refCount = Math.max(0, node.refCount || 0);
  const score = scoreForNode(node);
  const helpful = Math.max(0, score?.helpful || 0);
  if (kind === "project") return clamp(20 + Math.sqrt(refCount + 4) * 4, 24, 38);
  if (kind === "entity") return clamp(8 + Math.sqrt(refCount + 1) * 2.3, 10, 22);
  if (kind === "finding") return clamp(7.5 + Math.sqrt(helpful + 1) * 1.8 + (node.tagged ? 1.4 : 0), 9, 18);
  if (kind === "task") return clamp(8 + (node.section === "Active" ? 2 : 0) + (node.priority === "high" ? 1 : 0), 8, 15);
  if (kind === "reference") return clamp(7 + Math.sqrt(refCount + 1) * 1.2, 7, 12);
  return 9;
}

export function nodeRadius(node: RuntimeNode): number {
  return clamp(node.size * 0.5, 4, 18);
}

export function searchTextForNode(node: RawNode): string {
  return [
    node.label,
    node.fullLabel,
    node.project,
    node.entityType,
    node.section,
    node.priority,
    node.topicSlug,
    node.topicLabel,
    ...(node.connectedProjects || []),
    ...(node.refDocs || []).map((ref) => ref.doc),
  ].join(" ").toLowerCase();
}

export function normalizeNode(node: RawNode): RuntimeNode {
  const score = scoreForNode(node);
  const kind = deriveKind(node);
  return {
    ...node,
    kind,
    searchText: searchTextForNode(node),
    health: inferHealth(score),
    baseColor: baseColorForNode(node),
    size: sizeForNode(node),
    forceLabel: kind === "project" || (kind === "entity" && (node.refCount || 0) >= 12),
  };
}

export function ensureTopicFilters(): void {
  const next: Record<string, boolean> = {};
  for (const topic of state.topics) next[topic.slug] = state.filterTopics[topic.slug] !== false;
  state.filterTopics = next;
}

export function buildFullAdjacency(): void {
  state.fullAdjacency = new Map();
  for (const node of state.rawNodes) state.fullAdjacency.set(node.id, new Set());
  for (const link of state.rawLinks) {
    if (!state.fullAdjacency.has(link.source) || !state.fullAdjacency.has(link.target)) continue;
    state.fullAdjacency.get(link.source)!.add(link.target);
    state.fullAdjacency.get(link.target)!.add(link.source);
  }
}

export function connectionCounts(nodeId: string): NodeDetail["connections"] {
  const counts = { total: 0, projects: 0, findings: 0, tasks: 0, entities: 0, references: 0 };
  const adjacency = state.fullAdjacency.get(nodeId);
  if (!adjacency) return counts;
  counts.total = adjacency.size;
  adjacency.forEach((neighborId) => {
    const neighbor = state.nodeById.get(neighborId);
    if (!neighbor) return;
    if (neighbor.kind === "project") counts.projects++;
    else if (neighbor.kind === "finding") counts.findings++;
    else if (neighbor.kind === "task") counts.tasks++;
    else if (neighbor.kind === "entity") counts.entities++;
    else if (neighbor.kind === "reference") counts.references++;
  });
  return counts;
}

/** Check if a node is in a project's direct network (1-hop neighbors). */
export function isInProjectNetwork(nodeId: string, projectId: string): boolean {
  if (nodeId === projectId) return true;
  const neighbors = state.visibleAdjacency.get(projectId);
  if (neighbors?.has(nodeId)) return true;
  const nodeNeighbors = state.visibleAdjacency.get(nodeId);
  if (nodeNeighbors) {
    for (const nn of nodeNeighbors) {
      if (neighbors?.has(nn)) return true;
    }
  }
  return false;
}

export function nodeDetail(nodeId: string): NodeDetail | null {
  const node = state.nodeById.get(nodeId);
  if (!node) return null;
  return {
    ...node,
    displayLabel: node.label,
    tooltipLabel: node.fullLabel || node.label,
    text: node.fullLabel || node.label,
    docs: (node.refDocs || []).map((ref) => ref.doc),
    projectName: node.project || "",
    qualityScore: qualityScore(node),
    connections: connectionCounts(nodeId),
    score: scoreForNode(node),
  };
}

/**
 * Structural filters only. The search query deliberately does NOT remove
 * nodes — search dims non-matches instead (focus mode "search"), so the
 * graph keeps its shape while matches light up.
 */
export function nodeMatchesFilters(node: RuntimeNode): boolean {
  if (!state.filterTypes[node.kind]) return false;
  if (node.kind === "finding" && node.topicSlug && state.filterTopics[node.topicSlug] === false) return false;
  if (state.filterHealth !== "all" && node.health !== state.filterHealth) return false;
  if (state.filterStore !== "all" && node.store && node.store !== state.filterStore) return false;

  if (state.filterProject !== "all") {
    const project = state.filterProject;
    const connectedProjects = new Set<string>();
    if (node.project) connectedProjects.add(node.project);
    (node.connectedProjects || []).forEach((name) => connectedProjects.add(name));
    (node.refDocs || []).forEach((ref) => {
      if (ref.project) connectedProjects.add(ref.project);
      else if (ref.doc.includes("/")) connectedProjects.add(ref.doc.slice(0, ref.doc.indexOf("/")));
    });
    if (node.kind === "project") {
      if ((node.project || "") !== project) return false;
    } else if (!connectedProjects.has(project)) {
      return false;
    }
  }
  return true;
}

export function nodeRank(node: RuntimeNode): number {
  let rank = 0;
  if (node.kind === "project") rank += 2000;
  if (node.kind === "entity") rank += 800 + (node.refCount || 0) * 8;
  if (node.kind === "finding") rank += 600 + (scoreForNode(node)?.helpful || 0) * 14 + (node.tagged ? 45 : 0);
  if (node.kind === "task") rank += node.section === "Active" ? 540 : 470;
  if (node.kind === "reference") rank += 180 + (node.refCount || 0) * 3;
  if (node.priority === "high") rank += 60;
  if (node.health === "healthy") rank += 24;
  if (node.health === "decaying") rank -= 12;
  if (node.health === "stale") rank -= 25;
  if (state.filterProject !== "all" && node.project === state.filterProject) rank += 80;
  if (state.filterStore !== "all" && node.store === state.filterStore) rank += 40;
  if (state.searchQuery && node.searchText.includes(state.searchQuery.toLowerCase())) rank += 120;
  return rank;
}

export function buildVisibleData(): { nodes: RuntimeNode[]; links: RawLink[] } {
  const filteredNodes = state.rawNodes.filter(nodeMatchesFilters);
  const selectedId = state.selectedNodeId;
  let limitedNodes = filteredNodes.slice();
  if (limitedNodes.length > state.nodeLimit) {
    const sorted = limitedNodes.slice().sort((a, b) => nodeRank(b) - nodeRank(a));
    const keepIds = new Set<string>();
    for (const node of sorted) {
      if (keepIds.size >= state.nodeLimit) break;
      keepIds.add(node.id);
    }
    state.rawNodes.forEach((node) => {
      if (node.kind === "project") keepIds.add(node.id);
    });
    if (selectedId) keepIds.add(selectedId);
    limitedNodes = filteredNodes.filter((node) => keepIds.has(node.id));
  }

  const visibleIds = new Set(limitedNodes.map((node) => node.id));
  const visibleLinks = state.rawLinks.filter((link) => visibleIds.has(link.source) && visibleIds.has(link.target));

  state.visibleAdjacency = new Map();
  limitedNodes.forEach((node) => state.visibleAdjacency.set(node.id, new Set()));
  visibleLinks.forEach((link) => {
    state.visibleAdjacency.get(link.source)!.add(link.target);
    state.visibleAdjacency.get(link.target)!.add(link.source);
  });

  const connectedIds = new Set<string>();
  visibleLinks.forEach((link) => {
    connectedIds.add(link.source);
    connectedIds.add(link.target);
  });
  const prunedNodes = limitedNodes.filter((node) =>
    node.kind !== "project" || connectedIds.has(node.id) || (node.project || "") === state.filterProject || state.filterTypes.project
  );
  return { nodes: prunedNodes, links: visibleLinks };
}

export function rebuildHostNodes(): void {
  state.hostNodes = state.visibleNodes
    .map((node) => nodeDetail(node.id))
    .filter((node): node is NodeDetail => Boolean(node));
}

/** Recompute the set of visible nodes matching the current search query. */
export function recomputeSearchMatches(): void {
  state.searchMatchIds = new Set();
  const query = state.searchQuery.trim().toLowerCase();
  if (!query) return;
  for (const node of state.visibleNodes) {
    if (node.searchText.includes(query)) state.searchMatchIds.add(node.id);
  }
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
  const query = state.searchQuery.trim().toLowerCase();
  if (!query) return null;
  let best: RuntimeNode | null = null;
  let bestScore = -1;
  for (const node of state.visibleNodes) {
    if (!state.searchMatchIds.has(node.id)) continue;
    const label = node.label.toLowerCase();
    let score = 0;
    if (label.startsWith(query)) score = 3;
    else if (label.includes(query)) score = 2;
    else score = 1;
    const rank = score * 100000 + nodeRank(node);
    if (rank > bestScore) {
      bestScore = rank;
      best = node;
    }
  }
  return best;
}
