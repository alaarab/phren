/**
 * Pure graph model logic shared by the browser 3D viewer and the terminal
 * graph view. Every function here takes its context explicitly (no module
 * singletons), so hosts can hold whatever state shape suits them.
 *
 * Must stay free of DOM, node builtins, and imports outside `src/graph-core/`.
 */
import type { NodeDetail, NodeHealth, NodeKind, RawLink, RawNode, RuntimeNode, ScoreEntry } from "./types.js";
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
export declare class StoreColorAssigner {
    private readonly assigned;
    color(storeName?: string): string | null;
}
export declare function clamp(value: number, min: number, max: number): number;
export declare function hashString(value: string): number;
/** Deterministic pseudo-random in [0, 1) derived from a value + salt. */
export declare function seeded(value: string, salt: string): number;
export declare function deriveKind(node: RawNode): NodeKind;
export declare function topicColor(slug?: string): string;
export declare function scoreForNode(node: RawNode, scores: ScoreMap): ScoreEntry | undefined;
export declare function inferHealth(score?: ScoreEntry, now?: number): NodeHealth;
export declare function qualityScore(node: RawNode, scores: ScoreMap): number | null;
export declare function baseColorForNode(node: RawNode, storeColor: StoreColorFn): string;
export declare function sizeForNode(node: RawNode, scores: ScoreMap): number;
export declare function nodeRadius(node: RuntimeNode): number;
export declare function searchTextForNode(node: RawNode): string;
export declare function normalizeNode(node: RawNode, scores: ScoreMap, storeColor: StoreColorFn): RuntimeNode;
/** Undirected adjacency over every node/link, ignoring links to unknown ids. */
export declare function buildFullAdjacency(nodes: RuntimeNode[], links: RawLink[]): Map<string, Set<string>>;
export declare function connectionCounts(model: Pick<GraphModel, "fullAdjacency" | "nodeById">, nodeId: string): NodeDetail["connections"];
/** Check if a node is in a project's direct network (1-hop neighbors). */
export declare function isInProjectNetwork(visibleAdjacency: Map<string, Set<string>>, nodeId: string, projectId: string): boolean;
export declare function nodeDetail(model: Pick<GraphModel, "fullAdjacency" | "nodeById" | "scores">, nodeId: string): NodeDetail | null;
/**
 * Structural filters only. The search query deliberately does NOT remove
 * nodes — search dims non-matches instead, so the graph keeps its shape
 * while matches light up.
 */
export declare function nodeMatchesFilters(node: RuntimeNode, filters: GraphFilters): boolean;
export declare function nodeRank(node: RuntimeNode, filters: GraphFilters, scores: ScoreMap): number;
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
export declare function buildVisibleData(model: Pick<GraphModel, "rawNodes" | "rawLinks" | "scores">, filters: GraphFilters, selectedId: string | null): VisibleData;
/** Score a match the way Enter-to-fly ranks: label prefix > substring > deep text. */
export declare function matchRank(node: RuntimeNode, query: string, filters: GraphFilters, scores: ScoreMap): number;
export interface SearchMatches {
    matchIds: Set<string>;
    /** Matches ordered best→worst. */
    results: RuntimeNode[];
}
/** Recompute the set of visible nodes matching a search query. */
export declare function recomputeSearchMatches(visibleNodes: RuntimeNode[], query: string, filters: GraphFilters, scores: ScoreMap): SearchMatches;
/** The best search hit for Enter-to-fly: first of the ranked results. */
export declare function bestSearchMatch(results: RuntimeNode[]): RuntimeNode | null;
/**
 * The dossier's ranked walk through one project: findings newest date first
 * (payload order breaks ties), then tasks in payload order. That is the order
 * the Memory list shows rows for the project, so Previous/Next and the
 * keyboard arrows land where a reader scrolling the list would.
 */
export declare function rankedProjectIds(nodes: readonly RawNode[], project: string): string[];
/**
 * Previous/next id in a ranked list, wrapping at both ends. The list is the
 * host's own order (the Memory list, the contents pane); `delta` is -1 or +1.
 * Returns null for an empty list or an id that is not in it.
 */
export declare function stepRanked(rankedIds: readonly string[], currentId: string, delta: number): string | null;
