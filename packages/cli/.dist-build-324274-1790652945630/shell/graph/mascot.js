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
/** Mascot purple, matching the sprite the web viewer and the splash use. */
export const MASCOT_COLOR = "#9c8ff8";
/** The cyan he sparkles with on arrival, matching the live-pulse accent. */
export const MASCOT_SPARK = "#28d3f2";
/** How long the arrival sparkle lasts. */
const ARRIVAL_MS = 1400;
/** Quiet time before he wanders off on his own. */
const IDLE_AFTER_MS = 12_000;
/** Fraction of the remaining distance covered per frame. */
const EASE = 0.16;
/** Close enough to count as arrived, in world units. */
const ARRIVED = 0.6;
export class GraphMascot {
    /** Where he is, in world coordinates. Null until he first has somewhere to be. */
    pos = null;
    /** The node he is heading for, or sitting at. */
    targetNodeId = null;
    target = null;
    arrivedAt = 0;
    lastEventAt = 0;
    now;
    constructor(now = Date.now) {
        this.now = now;
        this.lastEventAt = now();
    }
    get moving() {
        return this.target !== null;
    }
    /**
     * Send him to a node. `deliberate` marks the visits worth sparkling over —
     * a lookup landing — as opposed to idle wandering.
     */
    walkTo(nodeId, positions, deliberate = true) {
        const to = positions.get(nodeId);
        if (!to)
            return;
        this.targetNodeId = nodeId;
        this.target = { ...to };
        // First appearance: no long walk in from nowhere, just arrive.
        if (!this.pos)
            this.pos = { ...to };
        if (deliberate)
            this.lastEventAt = this.now();
    }
    /** Advance one frame. Returns true while he still has somewhere to be. */
    step() {
        if (!this.pos || !this.target)
            return false;
        const dx = this.target.x - this.pos.x;
        const dy = this.target.y - this.pos.y;
        if (Math.hypot(dx, dy) < ARRIVED) {
            this.pos = { ...this.target };
            this.target = null;
            this.arrivedAt = this.now();
            return false;
        }
        this.pos = { x: this.pos.x + dx * EASE, y: this.pos.y + dy * EASE };
        return true;
    }
    /**
     * After a long enough quiet spell, drift to another node so the graph does
     * not look frozen. Deterministic given the same inputs, so a test can drive
     * it: the destination is chosen by stepping through the candidates.
     */
    maybeWander(candidates, positions) {
        if (this.moving || !candidates.length)
            return false;
        if (this.now() - this.lastEventAt < IDLE_AFTER_MS)
            return false;
        const here = candidates.indexOf(this.targetNodeId ?? "");
        const next = candidates[(here + 1 + candidates.length) % candidates.length];
        if (!next || next === this.targetNodeId)
            return false;
        this.walkTo(next, positions, false);
        this.lastEventAt = this.now();
        return true;
    }
    /** 1 just after arriving, easing to 0 — the sparkle over his head. */
    arrivalGlow() {
        if (!this.arrivedAt)
            return 0;
        const age = this.now() - this.arrivedAt;
        if (age >= ARRIVAL_MS)
            return 0;
        return 1 - age / ARRIVAL_MS;
    }
    /** Forget where he was, so a rebuilt graph does not strand him mid-air. */
    reset() {
        this.pos = null;
        this.target = null;
        this.targetNodeId = null;
        this.arrivedAt = 0;
    }
}
