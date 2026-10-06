/**
 * Deterministic 2D force layout for the terminal graph view.
 *
 * The web viewer leans on 3d-force-graph; in the terminal we want something
 * dependency-free, fast enough for a few hundred nodes, and — above all —
 * deterministic, so the same store draws the same map every time the view
 * opens. All jitter is derived from node ids via `seeded()`; nothing here
 * calls Math.random.
 *
 * The store's topology is a star (project → findings/tasks/fragments/refs),
 * so the simulation adds a gentle pull toward each node's home project. That
 * keeps clusters readable instead of letting repulsion smear everything into
 * one ring.
 */
import type { NodeKind, RawLink } from "../../graph-core/types.js";
export interface LayoutNode {
    id: string;
    kind: NodeKind;
    /** Owning project name, for the cluster pull. Projects own themselves. */
    project?: string;
    /** Visual size from `sizeForNode`; drives repulsion mass. */
    size: number;
}
export interface Point {
    x: number;
    y: number;
}
/** Ideal edge length in world units. Everything else is scaled off this. */
export declare const IDEAL_DISTANCE = 12;
/**
 * A terminal canvas is far wider than it is tall. A layout that settles into a
 * circle therefore strands most of the screen, so the simulation is told the
 * canvas aspect and lays the graph out as a matching ellipse: the project ring
 * is stretched horizontally and vertical drift is damped by the same factor.
 */
export declare const DEFAULT_ASPECT = 2.4;
export declare function normalizeAspect(aspect: number | undefined): number;
/** Project ids in stable order plus, for every node, the project(s) it hangs off. */
export declare function homes(nodes: LayoutNode[], links: RawLink[]): {
    projects: LayoutNode[];
    homeOf: Map<string, string[]>;
};
/**
 * Starting positions: projects on a ring, leaves in a jittered blob around
 * their home project, multi-home fragments at the centroid of their homes,
 * orphans on an outer ring.
 */
export declare function seedPositions(nodes: LayoutNode[], links: RawLink[], aspect?: number): Map<string, Point>;
export declare class ForceSim {
    readonly positions: Map<string, Point>;
    private readonly ids;
    private readonly index;
    private readonly mass;
    private readonly anchors;
    private readonly isProject;
    private readonly links;
    private temperature;
    private readonly startTemperature;
    private readonly aspect;
    /** How far apart projects push each other; scaled to the clusters they carry. */
    private readonly projectCutoff;
    /**
     * The ring radius each project should sit at, measured in aspect-corrected
     * space. Seeding a packed ring is not enough on its own: mutual repulsion
     * between many projects expands it again, which is how a forty-project store
     * ended up sprawling to nearly twice its seeded size. A radial spring holds
     * each project at the radius the packing chose.
     */
    private readonly targetRadius;
    constructor(nodes: LayoutNode[], links: RawLink[], seed?: Map<string, Point>, aspect?: number);
    /** 1 at the start, 0 when settled; mirrors d3's `alpha` for hosts that animate. */
    get alpha(): number;
    get settled(): boolean;
    /**
     * Reuse a previous layout's positions for nodes that survived a data
     * refresh, and reheat only mildly so the map shifts instead of scrambling.
     */
    warmStart(previous: Map<string, Point>): void;
    /** Reheat to the initial temperature (e.g. the `r` relayout key). */
    reheat(): void;
    tick(count?: number): void;
    /** Run until settled or the tick budget is spent. */
    settle(maxTicks?: number): void;
    private step;
}
/** Axis-aligned bounds of a position set; null when empty. */
export declare function bounds(positions: Iterable<Point>): {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
} | null;
