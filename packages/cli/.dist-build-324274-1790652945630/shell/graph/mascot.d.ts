/**
 * phren, on the graph.
 *
 * The web viewer has had him for a while (browser/graph/mascot.ts): small and
 * calm, perching next to whatever you select, and walking to a memory the
 * moment a lookup lands on it. This is the same behaviour in the terminal —
 * when watch mode says something was read or written, he goes there, so what
 * you are watching has a face rather than being an abstract pulse.
 *
 * Pure movement only: no drawing, no timers. The host steps him each frame.
 */
import type { Point } from "./layout.js";
/** Mascot purple, matching the sprite the web viewer and the splash use. */
export declare const MASCOT_COLOR = "#9c8ff8";
/** The cyan he sparkles with on arrival, matching the live-pulse accent. */
export declare const MASCOT_SPARK = "#28d3f2";
export declare class GraphMascot {
    /** Where he is, in world coordinates. Null until he first has somewhere to be. */
    pos: Point | null;
    /** The node he is heading for, or sitting at. */
    targetNodeId: string | null;
    private target;
    private arrivedAt;
    private lastEventAt;
    private readonly now;
    constructor(now?: () => number);
    get moving(): boolean;
    /**
     * Send him to a node. `deliberate` marks the visits worth sparkling over —
     * a lookup landing — as opposed to idle wandering.
     */
    walkTo(nodeId: string, positions: Map<string, Point>, deliberate?: boolean): void;
    /** Advance one frame. Returns true while he still has somewhere to be. */
    step(): boolean;
    /**
     * After a long enough quiet spell, drift to another node so the graph does
     * not look frozen. Deterministic given the same inputs, so a test can drive
     * it: the destination is chosen by stepping through the candidates.
     */
    maybeWander(candidates: string[], positions: Map<string, Point>): boolean;
    /** 1 just after arriving, easing to 0 — the sparkle over his head. */
    arrivalGlow(): number;
    /** Forget where he was, so a rebuilt graph does not strand him mid-air. */
    reset(): void;
}
