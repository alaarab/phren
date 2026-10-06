import { z } from "zod";
import { type Receipt } from "./dispatch.js";
import { type BriefArrival } from "./launch-brief.js";
import { peerRequest, type HookPeer } from "./peers.js";
import { type Json, type Provider, type Target } from "./protocol.js";
import { type FinalTurn } from "./schedule-watch.js";
import { type TurnRecord } from "./turn-records.js";
export { truncateUtf8 } from "./turn-records.js";
/**
 * The conductor's returns loop. The worker's computer answers what its
 * dispatched panes are doing (`workerStates`): from the turn record its
 * agent's own hooks wrote (turn-records.ts) when there is one, else from the
 * Herdr snapshot its Hook already shares and the transcript. The dispatching
 * Hook asks each peer once per poll for all of its open dispatches, records
 * transitions in the receipts, and tells an idle dispatching agent that
 * returns are waiting (`DispatchReturns`).
 */
/** Longest final reply kept in a receipt, in UTF-8 bytes. */
export declare const REPLY_LIMIT = 4000;
/** How often the dispatching Hook asks peers about open dispatches. */
export declare const POLL_MS = 15000;
/** Shortest gap between two notices typed into the same dispatching pane. */
export declare const NOTICE_MS = 120000;
/** Receipts older than this are no longer watched. */
export declare const WATCH_MS: number;
/** How long a stopped worker whose harness still runs background tasks is
 * waited on before it counts as done anyway. Measured from the latest Stop,
 * and every task that finishes wakes the worker (a new prompt, a new Stop), so
 * it only elapses when no background task has finished for two hours: a dev
 * server the worker left running. It is then reported done with the count
 * still running. */
export declare const BACKGROUND_WAIT_MS: number;
export declare const workerRequestSchema: z.ZodObject<{
    targets: z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
        server: z.ZodString;
        workspace: z.ZodString;
        tab: z.ZodString;
        pane: z.ZodString;
        source: z.ZodEnum<{
            claude: "claude";
            codex: "codex";
            copilot: "copilot";
            opencode: "opencode";
            phren: "phren";
        }>;
        session: z.ZodUnion<readonly [z.ZodString, z.ZodString]>;
        dispatch: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>, z.ZodObject<{
        server: z.ZodString;
        workspace: z.ZodString;
        tab: z.ZodString;
        pane: z.ZodString;
        source: z.ZodEnum<{
            claude: "claude";
            codex: "codex";
            copilot: "copilot";
            opencode: "opencode";
            phren: "phren";
        }>;
        starting: z.ZodLiteral<true>;
        startingToken: z.ZodString;
        dispatch: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>]>>;
}, z.core.$strict>;
/** What a worker pane shows right now, as its own computer reads it. */
export interface WorkerObservation {
    /** Herdr's status for the pane, or gone when the pane or its conversation is no longer there. */
    state: "working" | "idle" | "done" | "blocked" | "unknown" | "gone" | "unavailable";
    session?: string;
    completed?: boolean;
    reply?: string;
    truncated?: boolean;
    /** The error the harness ended the turn on (Codex's usage limit). */
    error?: string;
    /** The state comes from the agent's own turn events, not from how the pane looks. */
    hook?: true;
    /** When the turn's Stop arrived, on the worker's clock; names the turn. */
    endedAt?: string;
    /** Background tasks the harness still runs: waited on while `working`,
     * left running when `done` after BACKGROUND_WAIT_MS. */
    background?: number;
    /** The owner stopped the turn in the worker's terminal. */
    interrupted?: true;
}
export interface WorkerReaders {
    snapshot: (server: string) => Promise<Json>;
    identity: (server: string, pane: Json) => Promise<string | undefined>;
    finalTurn: (source: Provider, session: string) => Promise<FinalTurn | undefined>;
    /** The turn record the pane's agent reported through its hooks (or OpenCode's plugin). */
    turn?: (server: string, pane: Json, source: Provider) => Promise<TurnRecord | undefined>;
    now?: () => number;
}
/** Receiving side: the state of each dispatched pane, from its agent's turn
 * record when its hooks wrote one, else from the shared snapshot and, once
 * the agent has stopped, the final reply in its transcript. */
export declare function workerStates(input: unknown, readers?: WorkerReaders): Promise<{
    workers: WorkerObservation[];
}>;
/** What the owner is told when the worker's turn was interrupted in its terminal. */
export declare const INTERRUPTED = "The worker's turn was interrupted in its terminal before it finished.";
/** Apply one observation to a receipt. Returns true when the receipt changed. */
export declare function observe(receipt: Receipt, value: unknown, now: number): boolean;
/** One line for the dispatching agent: who returned, how, and where to read it. */
export declare function noticeLine(receipts: readonly Receipt[]): string;
/** What `dispatch_returns` lists for one unread return. */
export declare function returnRow(receipt: Receipt): Json;
export interface DispatchReturnsOptions {
    peers?: () => Promise<HookPeer[]>;
    request?: typeof peerRequest;
    /** Worker states on this computer, for dispatches placed here without SSH. */
    localWorkers?: (input: Json) => Promise<{
        workers: unknown[];
    }>;
    isLocal?: (computer: string) => boolean;
    /** A recent Herdr snapshot of a local server, to see whether the dispatching agent is idle. */
    snapshot?: (server: string) => Promise<Json>;
    identity?: (server: string, pane: Json) => Promise<string | undefined>;
    /** Types the notice into the dispatching agent, through the ordinary hand-off
     * path; the same notice keeps one delivery id, so a retry is never typed twice. */
    deliver?: (target: Target, text: string, deliveryId: string) => Promise<{
        delivered: boolean;
    }>;
    /** What a worker's hooks reported for a brief launched on this computer. */
    localArrival?: (id: string) => Promise<BriefArrival | undefined>;
    now?: () => number;
}
/** One notice's delivery id, named by what it reports: the same returns keep the same id on a retry. */
export declare function noticeDeliveryId(receipts: readonly Receipt[]): string;
/** Dispatching side: follows open dispatches and delivers their returns. */
export declare class DispatchReturns {
    private readonly peers;
    private readonly request;
    private readonly localWorkers;
    private readonly isLocal;
    private readonly snapshot;
    private readonly identity;
    private readonly deliver;
    private readonly localArrival;
    private readonly now;
    private lastPoll;
    private readonly lastNotice;
    /** A return is waiting for a dispatching agent that was busy: try again on
     * the next tick instead of the next poll. */
    private noticesDue;
    private running?;
    constructor(options?: DispatchReturnsOptions);
    /** Called from the Hook's activity tick. Polls peers at most every POLL_MS;
     * a return waiting for its notice is tried on every tick, so one recorded
     * while the dispatching agent was busy reaches it as soon as it stops. */
    tick(): Promise<void>;
    /**
     * A brief that went with the launch but was not confirmed while the dispatch
     * was placed (a startup screen held it, the agent was slow): ask the
     * worker's computer whether its hook has confirmed it since.
     */
    confirmArrivals(peers: HookPeer[]): Promise<void>;
    /** Ask each peer, once, about every open dispatch placed on it. */
    poll(): Promise<void>;
    /** Type one line into each idle dispatching agent that has returns it was
     * not told about. A pane still working is tried again on the next tick. */
    notify(): Promise<void>;
    /** Every unread return, oldest first, marked read as it is handed over. */
    take(): Promise<Json[]>;
}
