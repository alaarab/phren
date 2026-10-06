/**
 * Live coding agents on the knowledge graph.
 *
 * Watch mode shows what phren's memory is doing; this shows who is doing it.
 * Agents are transient runtime state rather than memory, so they decorate the
 * project nodes they are working in instead of becoming graph nodes of their
 * own — the same shape `GraphWatch` uses, and it keeps `graph-core` (which is
 * bundled for the browser) untouched.
 */
import type { JoinedAgent } from "../../agents/types.js";
export interface GraphAgentsOptions {
    pollMs?: number;
    /** Injected in tests so nothing shells out and no timer runs. */
    collect?: () => JoinedAgent[];
    runFocus?: (argv: string[]) => boolean;
    enabled?: boolean;
}
/** Run a provider-supplied focus command. Never throws. */
export declare function runFocusCommand(argv: string[]): boolean;
export declare class GraphAgents {
    readonly phrenPath: string;
    readonly profile: string;
    agents: JoinedAgent[];
    /** Index into `agents`; -1 when nothing is highlighted. */
    highlighted: number;
    enabled: boolean;
    private timer;
    private onUpdate;
    private readonly pollMs;
    private readonly collectFn;
    private readonly runFocus;
    constructor(phrenPath: string, profile: string, opts?: GraphAgentsOptions);
    get running(): boolean;
    private polledOnce;
    /**
     * Is there anything to show, without turning the overlay on? Used to offer
     * the feature when agents are actually running, rather than leaving it as a
     * key nobody presses.
     */
    hasSomethingToShow(): boolean;
    start(onUpdate: () => void): void;
    stop(): void;
    toggle(): boolean;
    /** Refresh the list. Never throws; a failing provider just yields nothing. */
    poll(): JoinedAgent[];
    /** Agents grouped by the project they are working in. */
    byProject(): Map<string, JoinedAgent[]>;
    get current(): JoinedAgent | null;
    /** Move the highlight; wraps, and starts from the first agent. */
    cycle(delta: number): JoinedAgent | null;
    clearHighlight(): void;
    /** Bring the highlighted agent to the front in whatever is hosting it. */
    focusCurrent(): JoinedAgent | null;
}
