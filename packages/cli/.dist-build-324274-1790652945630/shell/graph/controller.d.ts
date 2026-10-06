/**
 * State + interaction for the terminal graph view.
 *
 * The controller is the terminal-side analogue of the browser's
 * `browser/graph/state.ts` + `interactions.ts`: it owns the payload built by
 * `buildGraph`, the normalized model from `graph-core`, the force layout, a 2D
 * camera, selection/search/focus, and the key map. Rendering lives in
 * `graph-view.ts`; this module never writes to the terminal.
 */
import type { GraphFilters, GraphModel, VisibleData } from "../../graph-core/model.js";
import type { GraphPayload, NodeDetail, NodeKind, RuntimeNode } from "../../graph-core/types.js";
import { type Point } from "./layout.js";
import { GraphWatch, type ActivityItem } from "./watch.js";
import { GraphAgents } from "./agents.js";
import { GraphMascot } from "./mascot.js";
import type { OrbitCamera } from "./orbit.js";
/** Nodes drawn at once. Terminals have far fewer pixels than a browser tab. */
export declare const TUI_NODE_LIMIT = 350;
export type GraphStatus = "idle" | "loading" | "ready" | "empty" | "error";
export interface FilterPreset {
    name: string;
    types: Partial<Record<NodeKind, boolean>>;
    health: string;
}
export declare const FILTER_PRESETS: FilterPreset[];
export interface Camera {
    /** World coordinates at the centre of the viewport. */
    cx: number;
    cy: number;
    /**
     * Braille dots per world unit, per axis. A terminal canvas is much wider
     * than it is tall, so fitting a roughly round graph to the shorter axis
     * would waste most of the width. The two scales are allowed to diverge up
     * to MAX_STRETCH, which fills the screen while keeping the shape readable.
     */
    scaleX: number;
    scaleY: number;
}
export interface SearchState {
    query: string;
    matchIds: Set<string>;
    results: RuntimeNode[];
    /** Cursor into results; -1 when nothing is active. */
    index: number;
}
/** What the controller needs from the shell when a key lands. */
export interface GraphKeyHost {
    setMessage(msg: string): void;
    startInput(ctx: string, initial: string): void;
}
/** Injected so tests can feed a fixture instead of scanning a store. */
export type GraphBuilder = (phrenPath: string, profile: string) => Promise<GraphPayload>;
export interface GraphControllerOptions {
    builder?: GraphBuilder;
    tokenOf?: (phrenPath: string) => string;
    /** Animation frame period; the tests shrink it. */
    frameMs?: number;
    /** Injected watch, so tests can feed events without a log file or timers. */
    watch?: GraphWatch;
    /** Injected agents poller, so tests never shell out. */
    agents?: GraphAgents;
    /** Start with watch mode off (`--no-live`). */
    watchEnabled?: boolean;
}
declare const DIRECTIONS: Record<string, Point>;
export declare class GraphController {
    readonly phrenPath: string;
    readonly profile: string;
    status: GraphStatus;
    errorText: string;
    /** A rebuild is running while the previous picture stays on screen. */
    get refreshing(): boolean;
    payload: GraphPayload | null;
    model: GraphModel;
    filters: GraphFilters;
    visible: VisibleData;
    /** Project nodes in display order for `[`/`]`. */
    projects: RuntimeNode[];
    presetIndex: number;
    selectedId: string | null;
    search: SearchState;
    camera: Camera;
    private sim;
    private lastPositions;
    private viewport;
    private dataToken;
    private building;
    private repaintHook;
    private timer;
    private cameraTarget;
    /** Re-frame once the intro settle finishes so the whole map is in view. */
    /** Set by pan/zoom; until then a resize re-fits the whole map. */
    private userMoved;
    private readonly builder;
    private readonly tokenOf;
    private readonly frameMs;
    /** Live tail of what phren is landing on, in this or any other terminal. */
    readonly watch: GraphWatch;
    /** Coding agents running on this machine, joined onto their projects. */
    readonly agents: GraphAgents;
    /** phren himself, who walks to whatever the store just touched. */
    readonly mascot: GraphMascot;
    /** Space opens the selected node's full text in a bubble on the canvas. */
    reader: boolean;
    private knowsCache;
    /**
     * The "What phren knows" paragraph for a project, written by
     * `phren maintain summarize`; null until it has run. Read once per project
     * per data load, so the pane can show it on every frame.
     */
    knowsFor(project: string): string | null;
    /**
     * v: the same graph as a sphere. Selection, search, watch mode and the
     * neighbour numbers all keep working; the camera orbits instead of panning.
     */
    orbit: boolean;
    orbitCamera: OrbitCamera;
    private orbitPositions;
    private orbitRadius;
    private orbitYawTarget;
    private lastOrbitTouch;
    private drag;
    /** Where the canvas sits in the terminal, so mouse coordinates can be mapped onto it. */
    canvasOrigin: {
        col: number;
        row: number;
    };
    watchEnabled: boolean;
    /**
     * Wall-clock ms of the last navigation keypress. While the user is driving,
     * incoming events still pulse and feed but do not steal the camera.
     */
    private lastUserInputAt;
    constructor(phrenPath: string, profile: string, opts?: GraphControllerOptions);
    /** Idempotent; called every render so the tail starts with the view. */
    startWatch(): void;
    stopWatch(): void;
    /** Idempotent; the poller only runs while the Graph view is open. */
    startAgents(): void;
    /**
     * The recall that just landed, while it is still fresh enough to show at its
     * node. Watch mode's feed lists everything; this is the one worth pointing at.
     */
    liveRecall(now?: number): {
        nodeId: string;
        item: ActivityItem;
        age: number;
    } | null;
    /**
     * Offer the overlay once per session when agents are actually running but it
     * is switched off. Shipping a feature off by default and never mentioning it
     * is the same as not shipping it.
     */
    agentHint(): string | null;
    private offeredAgents;
    toggleAgents(): boolean;
    toggleWatch(): boolean;
    /** True while the user is actively driving, so the camera is left alone. */
    private get userDriving();
    /**
     * New events landed. Light every node they touch, then follow the newest
     * one that is actually on screen — unless the user is mid-navigation.
     */
    private onWatchEvents;
    /**
     * Let the shell trigger a repaint on its own (settle animation, fly-to,
     * a build finishing). Without it the controller blocks the first render on
     * the build and snaps every camera move.
     */
    setRepaintHook(hook: (() => void) | null): void;
    get positions(): Map<string, Point>;
    private lastToken;
    private lastTokenAt;
    /** The store token, re-read at most every 2s: animation repaints must not stat the whole store. */
    private currentToken;
    /**
     * Make sure a payload matching the store is loaded, or on its way. Blocks
     * only on the very first build when there is no repaint hook to come back
     * through; otherwise the old picture stays up with a refreshing badge.
     */
    ensureData(): Promise<void>;
    private build;
    /** Load a payload directly (tests, or a host that already has one). */
    adopt(payload: GraphPayload): void;
    get preset(): FilterPreset;
    get focusedProject(): string | null;
    private applyFilters;
    private rebuildLayout;
    /**
     * The view reports its canvas size (in dots) before projecting. The first
     * fit happens before any frame is drawn, so a size change re-fits unless
     * the user has taken the camera over.
     */
    setViewport(width: number, height: number): void;
    get viewportSize(): {
        width: number;
        height: number;
    };
    /** The sphere is derived from the settled flat layout, never simulated. */
    private rebuildOrbit;
    /** A node's place on screen, with depth: 0 nearest, 1 farthest, always 0 on the flat map. */
    projectNode(id: string): {
        x: number;
        y: number;
        t: number;
    } | null;
    toggleOrbit(): boolean;
    /** In orbit, the pan keys turn the sphere instead. */
    private turn;
    /** The visible node nearest a dot on the canvas, within a radius. */
    nearestToDot(x: number, y: number, within: number): RuntimeNode | null;
    /**
     * Mouse: wheel zooms in both modes; a left drag turns the sphere or pans
     * the map; a click with no movement selects the node under it.
     */
    private handleMouse;
    /** World → dot coordinates for the current camera. */
    project(p: Point): Point;
    fitAll(): void;
    zoom(factor: number): void;
    pan(direction: keyof typeof DIRECTIONS): void;
    /** Centre the camera on a node, eased when animation is available. */
    flyTo(nodeId: string): void;
    /** Fly only when the node sits outside the middle band of the viewport. */
    private keepInView;
    relayout(): void;
    private startAnimation;
    stopAnimation(): void;
    get animating(): boolean;
    private animationFrame;
    /** Called by the shell when the view changes away or the shell closes. */
    dispose(): void;
    detail(nodeId: string): NodeDetail | null;
    /** Visible neighbours of a node, best first — what the pane numbers 1-9. */
    neighborsOf(nodeId: string): RuntimeNode[];
    select(nodeId: string | null, opts?: {
        fly?: boolean;
    }): void;
    private nearestToCenter;
    /**
     * Arrow-key traversal: prefer a connected neighbour in that direction; if
     * there is none, take the nearest visible node in that half-plane so the
     * walk never dead-ends on a leaf.
     */
    walk(direction: keyof typeof DIRECTIONS): RuntimeNode | null;
    private refreshSearch;
    /** Set the query, light up matches, and fly to the best one. */
    applySearch(query: string): RuntimeNode | null;
    clearSearch(): void;
    stepSearch(delta: number): RuntimeNode | null;
    cyclePreset(delta?: number): FilterPreset;
    /** Focus one project (name) or all (null). */
    focusProject(name: string | null): void;
    cycleProject(delta: number): string | null;
    jumpToNeighbor(n: number): RuntimeNode | null;
    /**
     * Returns true when the key was consumed, undefined to let the shell's
     * generic handler have it (q, :, ?, view shortcuts, final Esc).
     */
    handleKey(rawKey: string, host: GraphKeyHost): true | undefined;
    /** One-line description for the message bar. */
    describe(node: RuntimeNode): string;
}
export {};
