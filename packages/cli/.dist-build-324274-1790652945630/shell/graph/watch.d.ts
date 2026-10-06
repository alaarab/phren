/**
 * Watch mode for the terminal graph.
 *
 * Every memory phren lands on — an MCP `search_knowledge` hit, a memory a
 * hook injected before a prompt, a finding just written — is appended to
 * `.runtime/lookup-events.jsonl`. Watch mode tails that log so a graph open
 * in one terminal lights up as an agent works in another: the node pulses,
 * the camera flies to it, and the finding's full text lands in the pane.
 *
 * This module owns the event plumbing only. Drawing lives in graph-view.ts
 * and camera/selection in controller.ts.
 */
import { type LookupEvent } from "../../governance/activity.js";
/** How long a touched node stays lit, in ms. */
export declare const HEAT_MS = 6000;
/** Events kept for the activity feed. */
export declare const ACTIVITY_LIMIT = 60;
export interface ActivityItem {
    event: LookupEvent;
    /** Wall-clock ms when this arrived; drives heat decay and the feed's age column. */
    seenAt: number;
    /** Graph node this event points at, when resolvable. */
    nodeId?: string;
    /** True for rows loaded as history rather than seen live. */
    historical: boolean;
}
export interface GraphWatchOptions {
    pollMs?: number;
    /** Injected in tests so no real file or timer is needed. */
    tail?: {
        poll: () => LookupEvent[];
    };
    backfill?: (phrenPath: string, limit: number) => LookupEvent[];
    now?: () => number;
}
export declare class GraphWatch {
    readonly phrenPath: string;
    /** Newest first. */
    activity: ActivityItem[];
    private heat;
    private tail;
    private timer;
    private onEvents;
    private readonly pollMs;
    private readonly injectedTail?;
    private readonly backfillFn;
    private readonly now;
    constructor(phrenPath: string, opts?: GraphWatchOptions);
    get running(): boolean;
    /**
     * Begin tailing. Recent history is loaded into the feed immediately but is
     * never treated as live: it does not pulse and never moves the camera.
     */
    start(onEvents: (items: ActivityItem[]) => void): void;
    stop(): void;
    /** Drain the log. Returns the new items, newest last, and lights their nodes. */
    poll(): ActivityItem[];
    /** 1 right after a node was touched, easing to 0 over HEAT_MS. */
    heatOf(nodeId: string): number;
    /** True while any node is still lit, so the host keeps animating. */
    get hot(): boolean;
    clearActivity(): void;
}
/**
 * The graph node an event points at. Findings carry a precomputed `nodeId`
 * (the same id `buildGraph` assigns); everything else falls back to the
 * project node, whose id is the project name.
 */
export declare function targetNodeId(event: LookupEvent): string | undefined;
/** "just now", "4s", "2m" — the feed's age column. */
export declare function formatAge(ms: number): string;
