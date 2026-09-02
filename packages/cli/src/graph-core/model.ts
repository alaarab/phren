/**
 * Pure graph model logic shared by the browser 3D viewer and the terminal
 * graph view. Every function here takes its context explicitly (no module
 * singletons), so hosts can hold whatever state shape suits them.
 *
 * Must stay free of DOM, node builtins, and imports outside `src/graph-core/`.
 */
import type { NodeDetail, NodeHealth, NodeKind, RawLink, RawNode, RuntimeNode, ScoreEntry } from "./types.js";
import { KIND_COLORS, STORE_COLORS, TOPIC_COLORS } from "./types.js";

export type ScoreMap = Record<string, ScoreEntry>;

/** Structural filters a host applies before layout. Search does not remove nodes. */
export interface GraphFilters {
  filterTypes: Partial<Record<NodeKind, boolean>>;
  filterTopics: Record<string, boolean>;
  /** "all", a single health value, or "aging" (= decaying + stale). */
  filterHealth: string;
  filterProject: string;
  filterStore: string;
  searchQuery: string;
  nodeLimit: number;
}

/** The normalized graph a host keeps between renders. */
export interface GraphModel {
  rawNodes: RuntimeNode[];
  rawLinks: RawLink[];
  nodeById: Map<string, RuntimeNode>;
  fullAdjacency: Map<string, Set<string>>;
  visibleAdjacency: Map<string, Set<string>>;
  scores: ScoreMap;
}

export type StoreColorFn = (storeName?: string) => string | null;

/** Hands out a distinct palette colour per non-primary store, first come first served. */
export class StoreColorAssigner {
  private readonly assigned = new Map<string, string>();

  color(storeName?: string): string | null {
    if (!storeName || storeName === "primary") return null;
    const existing = this.assigned.get(storeName);
    if (existing) return existing;
    const idx = (this.assigned.size + 1) % STORE_COLORS.length;
    this.assigned.set(storeName, STORE_COLORS[idx]);
    return STORE_COLORS[idx];
  }
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Deterministic pseudo-random in [0, 1) derived from a value + salt. */
export function seeded(value: string, salt: string): number {
  return (hashString(`${salt}:${value}`) % 10000) / 10000;
}

export function deriveKind(node: RawNode): NodeKind {
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

export function scoreForNode(node: RawNode, scores: ScoreMap): ScoreEntry | undefined {
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

export function inferHealth(score?: ScoreEntry, now: number = Date.now()): NodeHealth {
  if (!score || !score.lastUsedAt) return "healthy";
  const ageMs = now - new Date(score.lastUsedAt).getTime();
  const ageDays = Number.isFinite(ageMs) ? ageMs / 86400000 : 0;
  const penalties = (score.repromptPenalty || 0) + (score.regressionPenalty || 0) * 2;
  if (ageDays > 150 || penalties >= 4) return "stale";
  if (ageDays > 60 || penalties >= 2) return "decaying";
  return "healthy";
}

export function qualityScore(node: RawNode, scores: ScoreMap): number | null {
  const score = scoreForNode(node, scores);
  if (!score) return null;
  const helpful = score.helpful || 0;
  const impressions = score.impressions || 0;
  const penalties = (score.repromptPenalty || 0) + (score.regressionPenalty || 0) * 2;
  const raw = 0.55 + helpful * 0.1 + Math.min(0.2, impressions * 0.02) - penalties * 0.08;
  return clamp(raw, 0.1, 1);
}

export function baseColorForNode(node: RawNode, storeColor: StoreColorFn): string {
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

export function sizeForNode(node: RawNode, scores: ScoreMap): number {
  const kind = deriveKind(node);
  const refCount = Math.max(0, node.refCount || 0);
  const score = scoreForNode(node, scores);
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

export function normalizeNode(node: RawNode, scores: ScoreMap, storeColor: StoreColorFn): RuntimeNode {
  const score = scoreForNode(node, scores);
  const kind = deriveKind(node);
  return {
    ...node,
    kind,
    searchText: searchTextForNode(node),
    health: inferHealth(score),
    baseColor: baseColorForNode(node, storeColor),
    size: sizeForNode(node, scores),
    forceLabel: kind === "project" || (kind === "entity" && (node.refCount || 0) >= 12),
  };
}

/** Undirected adjacency over every node/link, ignoring links to unknown ids. */
export function buildFullAdjacency(nodes: RuntimeNode[], links: RawLink[]): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  for (const node of nodes) adjacency.set(node.id, new Set());
  for (const link of links) {
    if (!adjacency.has(link.source) || !adjacency.has(link.target)) continue;
    adjacency.get(link.source)!.add(link.target);
    adjacency.get(link.target)!.add(link.source);
  }
  return adjacency;
}

export function connectionCounts(model: Pick<GraphModel, "fullAdjacency" | "nodeById">, nodeId: string): NodeDetail["connections"] {
  const counts = { total: 0, projects: 0, findings: 0, tasks: 0, entities: 0, references: 0 };
  const adjacency = model.fullAdjacency.get(nodeId);
  if (!adjacency) return counts;
  counts.total = adjacency.size;
  adjacency.forEach((neighborId) => {
    const neighbor = model.nodeById.get(neighborId);
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
export function isInProjectNetwork(visibleAdjacency: Map<string, Set<string>>, nodeId: string, projectId: string): boolean {
  if (nodeId === projectId) return true;
  const neighbors = visibleAdjacency.get(projectId);
  if (neighbors?.has(nodeId)) return true;
  const nodeNeighbors = visibleAdjacency.get(nodeId);
  if (nodeNeighbors) {
    for (const nn of nodeNeighbors) {
      if (neighbors?.has(nn)) return true;
    }
  }
  return false;
}

export function nodeDetail(model: Pick<GraphModel, "fullAdjacency" | "nodeById" | "scores">, nodeId: string): NodeDetail | null {
  const node = model.nodeById.get(nodeId);
  if (!node) return null;
  return {
    ...node,
    displayLabel: node.label,
    tooltipLabel: node.fullLabel || node.label,
    text: node.fullLabel || node.label,
    docs: (node.refDocs || []).map((ref) => ref.doc),
    projectName: node.project || "",
    qualityScore: qualityScore(node, model.scores),
    connections: connectionCounts(model, nodeId),
    score: scoreForNode(node, model.scores),
  };
}

/**
 * Structural filters only. The search query deliberately does NOT remove
 * nodes — search dims non-matches instead, so the graph keeps its shape
 * while matches light up.
 */
export function nodeMatchesFilters(node: RuntimeNode, filters: GraphFilters): boolean {
  if (!filters.filterTypes[node.kind]) return false;
  if (node.kind === "finding" && node.topicSlug && filters.filterTopics[node.topicSlug] === false) return false;
  if (filters.filterHealth === "aging") {
    if (node.health === "healthy") return false;
  } else if (filters.filterHealth !== "all" && node.health !== filters.filterHealth) {
    return false;
  }
  if (filters.filterStore !== "all" && node.store && node.store !== filters.filterStore) return false;

  if (filters.filterProject !== "all") {
    const project = filters.filterProject;
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

export function nodeRank(node: RuntimeNode, filters: GraphFilters, scores: ScoreMap): number {
  let rank = 0;
  if (node.kind === "project") rank += 2000;
  if (node.kind === "entity") rank += 800 + (node.refCount || 0) * 8;
  if (node.kind === "finding") rank += 600 + (scoreForNode(node, scores)?.helpful || 0) * 14 + (node.tagged ? 45 : 0);
  if (node.kind === "task") rank += node.section === "Active" ? 540 : 470;
  if (node.kind === "reference") rank += 180 + (node.refCount || 0) * 3;
  if (node.priority === "high") rank += 60;
  if (node.health === "healthy") rank += 24;
  if (node.health === "decaying") rank -= 12;
  if (node.health === "stale") rank -= 25;
  if (filters.filterProject !== "all" && node.project === filters.filterProject) rank += 80;
  if (filters.filterStore !== "all" && node.store === filters.filterStore) rank += 40;
  if (filters.searchQuery && node.searchText.includes(filters.searchQuery.toLowerCase())) rank += 120;
  return rank;
}

export interface VisibleData {
  nodes: RuntimeNode[];
  links: RawLink[];
  /** Adjacency restricted to the visible node set (pre-prune, like the browser's `visibleAdjacency`). */
  visibleAdjacency: Map<string, Set<string>>;
}

/**
 * Apply structural filters + the node cap. Projects and the selected node are
 * always kept when the cap trims the list.
 */
export function buildVisibleData(
  model: Pick<GraphModel, "rawNodes" | "rawLinks" | "scores">,
  filters: GraphFilters,
  selectedId: string | null,
): VisibleData {
  const filteredNodes = model.rawNodes.filter((node) => nodeMatchesFilters(node, filters));
  let limitedNodes = filteredNodes.slice();
  if (limitedNodes.length > filters.nodeLimit) {
    const sorted = limitedNodes.slice().sort((a, b) => nodeRank(b, filters, model.scores) - nodeRank(a, filters, model.scores));
    const keepIds = new Set<string>();
    for (const node of sorted) {
      if (keepIds.size >= filters.nodeLimit) break;
      keepIds.add(node.id);
    }
    model.rawNodes.forEach((node) => {
      if (node.kind === "project") keepIds.add(node.id);
    });
    if (selectedId) keepIds.add(selectedId);
    limitedNodes = filteredNodes.filter((node) => keepIds.has(node.id));
  }

  const visibleIds = new Set(limitedNodes.map((node) => node.id));
  const visibleLinks = model.rawLinks.filter((link) => visibleIds.has(link.source) && visibleIds.has(link.target));

  const visibleAdjacency = new Map<string, Set<string>>();
  limitedNodes.forEach((node) => visibleAdjacency.set(node.id, new Set()));
  visibleLinks.forEach((link) => {
    visibleAdjacency.get(link.source)!.add(link.target);
    visibleAdjacency.get(link.target)!.add(link.source);
  });

  const connectedIds = new Set<string>();
  visibleLinks.forEach((link) => {
    connectedIds.add(link.source);
    connectedIds.add(link.target);
  });
  const prunedNodes = limitedNodes.filter((node) =>
    node.kind !== "project" || connectedIds.has(node.id) || (node.project || "") === filters.filterProject || filters.filterTypes.project
  );
  return { nodes: prunedNodes, links: visibleLinks, visibleAdjacency };
}

/** Score a match the way Enter-to-fly ranks: label prefix > substring > deep text. */
export function matchRank(node: RuntimeNode, query: string, filters: GraphFilters, scores: ScoreMap): number {
  const label = node.label.toLowerCase();
  const score = label.startsWith(query) ? 3 : label.includes(query) ? 2 : 1;
  return score * 100000 + nodeRank(node, filters, scores);
}

export interface SearchMatches {
  matchIds: Set<string>;
  /** Matches ordered best→worst. */
  results: RuntimeNode[];
}

/** Recompute the set of visible nodes matching a search query. */
export function recomputeSearchMatches(
  visibleNodes: RuntimeNode[],
  query: string,
  filters: GraphFilters,
  scores: ScoreMap,
): SearchMatches {
  const matchIds = new Set<string>();
  const needle = query.trim().toLowerCase();
  if (!needle) return { matchIds, results: [] };
  const matched: RuntimeNode[] = [];
  for (const node of visibleNodes) {
    if (node.searchText.includes(needle)) {
      matchIds.add(node.id);
      matched.push(node);
    }
  }
  matched.sort((a, b) => matchRank(b, needle, filters, scores) - matchRank(a, needle, filters, scores));
  return { matchIds, results: matched };
}

/** The best search hit for Enter-to-fly: first of the ranked results. */
export function bestSearchMatch(results: RuntimeNode[]): RuntimeNode | null {
  return results.length ? results[0] : null;
}
