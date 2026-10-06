import { z } from "zod";
import { type DispatchHost } from "./dispatch-hosts.js";
import { type Json, type Provider, type Target } from "./protocol.js";
import { type BriefArrival } from "./launch-brief.js";
export declare const projectName: z.ZodString;
export declare const dispatchSchema: z.ZodObject<{
    computer: z.ZodUnion<readonly [z.ZodLiteral<"anywhere">, z.ZodString]>;
    project: z.ZodString;
    harness: z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        opencode: "opencode";
    }>;
    model: z.ZodOptional<z.ZodString>;
    effort: z.ZodOptional<z.ZodEnum<{
        high: "high";
        low: "low";
        max: "max";
        medium: "medium";
        minimal: "minimal";
        xhigh: "xhigh";
    }>>;
    account: z.ZodOptional<z.ZodString>;
    prompt: z.ZodString;
    label: z.ZodString;
    parent: z.ZodOptional<z.ZodObject<{
        provider: z.ZodEnum<{
            claude: "claude";
            codex: "codex";
            copilot: "copilot";
            opencode: "opencode";
            phren: "phren";
        }>;
        session: z.ZodUnion<readonly [z.ZodString, z.ZodString]>;
        computer: z.ZodString;
    }, z.core.$strict>>;
    parentTarget: z.ZodOptional<z.ZodObject<{
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
    }, z.core.$strip>>;
}, z.core.$strict>;
export type DispatchInput = z.infer<typeof dispatchSchema>;
/** The local pane that asked for the dispatch, where return notices go. */
export declare const originPaneSchema: z.ZodObject<{
    server: z.ZodString;
    workspace: z.ZodString;
    tab: z.ZodString;
    pane: z.ZodString;
}, z.core.$strict>;
export type OriginPane = z.infer<typeof originPaneSchema>;
export declare const workerStates: readonly ["working", "done", "needs-you", "failed", "blocked", "gone"];
export type WorkerState = typeof workerStates[number];
declare const receiptSchema: z.ZodObject<{
    computer: z.ZodUnion<readonly [z.ZodLiteral<"anywhere">, z.ZodString]>;
    project: z.ZodString;
    harness: z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        opencode: "opencode";
    }>;
    model: z.ZodOptional<z.ZodString>;
    effort: z.ZodOptional<z.ZodEnum<{
        high: "high";
        low: "low";
        max: "max";
        medium: "medium";
        minimal: "minimal";
        xhigh: "xhigh";
    }>>;
    account: z.ZodOptional<z.ZodString>;
    label: z.ZodString;
    parent: z.ZodOptional<z.ZodObject<{
        provider: z.ZodEnum<{
            claude: "claude";
            codex: "codex";
            copilot: "copilot";
            opencode: "opencode";
            phren: "phren";
        }>;
        session: z.ZodUnion<readonly [z.ZodString, z.ZodString]>;
        computer: z.ZodString;
    }, z.core.$strict>>;
    parentTarget: z.ZodOptional<z.ZodObject<{
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
    }, z.core.$strip>>;
    id: z.ZodString;
    createdAt: z.ZodString;
    updatedAt: z.ZodString;
    computerId: z.ZodOptional<z.ZodString>;
    state: z.ZodEnum<{
        accepted: "accepted";
        failed: "failed";
        launching: "launching";
        sending: "sending";
        uncertain: "uncertain";
    }>;
    target: z.ZodOptional<z.ZodUnion<readonly [z.ZodObject<{
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
    }, z.core.$strip>]>>;
    error: z.ZodOptional<z.ZodString>;
    brief: z.ZodOptional<z.ZodEnum<{
        launch: "launch";
        typed: "typed";
    }>>;
    granted: z.ZodOptional<z.ZodString>;
    skipped: z.ZodOptional<z.ZodArray<z.ZodObject<{
        computer: z.ZodString;
        reason: z.ZodString;
    }, z.core.$strict>>>;
    origin: z.ZodOptional<z.ZodObject<{
        server: z.ZodString;
        workspace: z.ZodString;
        tab: z.ZodString;
        pane: z.ZodString;
        agent: z.ZodEnum<{
            claude: "claude";
            codex: "codex";
            copilot: "copilot";
            opencode: "opencode";
            phren: "phren";
        }>;
        terminal: z.ZodString;
    }, z.core.$strict>>;
    worker: z.ZodOptional<z.ZodObject<{
        state: z.ZodEnum<{
            blocked: "blocked";
            done: "done";
            failed: "failed";
            gone: "gone";
            "needs-you": "needs-you";
            working: "working";
        }>;
        since: z.ZodString;
        checkedAt: z.ZodString;
        sawWorking: z.ZodBoolean;
        background: z.ZodOptional<z.ZodNumber>;
        waitingSince: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    returned: z.ZodOptional<z.ZodObject<{
        state: z.ZodEnum<{
            blocked: "blocked";
            done: "done";
            failed: "failed";
            gone: "gone";
            "needs-you": "needs-you";
        }>;
        at: z.ZodString;
        reply: z.ZodOptional<z.ZodString>;
        error: z.ZodOptional<z.ZodString>;
        truncated: z.ZodOptional<z.ZodBoolean>;
        question: z.ZodOptional<z.ZodString>;
        turn: z.ZodOptional<z.ZodString>;
        read: z.ZodBoolean;
        notifiedAt: z.ZodOptional<z.ZodString>;
        background: z.ZodOptional<z.ZodNumber>;
        waited: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type Receipt = z.infer<typeof receiptSchema>;
/**
 * The project's folder on this computer. The store syncs between computers,
 * so its shared `sourcePath` is often another machine's folder: this
 * machine's `sourcePaths` entry wins, as everywhere else in phren. With
 * neither here, a git checkout named after the project in a usual project
 * root is taken (the owner's layout is `~/Projects/<name>` on every computer).
 */
export declare function dispatchProjectDirectory(project: unknown, home?: string): Promise<string>;
/**
 * Change one settled receipt: read it, let `change` edit it, and write it back
 * when `change` returns true. Updates run one at a time in this process, and a
 * receipt still being placed (launching or sending) is never touched.
 */
export declare function updateReceipt(receiptID: string, change: (receipt: Receipt) => boolean): Promise<Receipt | undefined>;
/** One bounded line for a log or a receipt: a Bridge message, an errno code, or the error's first line. */
export declare function failureReason(error: unknown): string;
export declare function dispatchStatus(): Promise<Receipt[]>;
/** What the worker's own hooks reported for a brief that went with its
 * launch, or undefined when the receiving Hook has no such brief. */
export declare function arrivalOf(peer: Pick<DispatchHost, "request">, id: string): Promise<BriefArrival | undefined>;
export interface DispatchIdentity {
    computerID: string;
    validateParentTarget: (target: Target) => Promise<unknown>;
    /** The agent and terminal running in a local pane, or undefined when the pane has no agent. */
    originAgent?: (pane: OriginPane) => Promise<{
        agent: Provider;
        terminal: string;
    } | undefined>;
}
export declare class DispatchService {
    private readonly identity?;
    private readonly local;
    private readonly settleIntervalMs;
    private active;
    /** `local` is this computer as a dispatch destination (its own Hook's
     * socket); tests replace it so they never reach a real Hook. */
    constructor(identity?: DispatchIdentity | undefined, local?: () => DispatchHost, settleIntervalMs?: number);
    /** `originValue` is the local pane the request came from, as its agent's
     * Herdr variables name it; a pane without a running agent is left out. */
    dispatch(input: unknown, originValue?: unknown): Promise<Json>;
    /**
     * A brief that went with the launch: wait for the worker's hook to confirm
     * it by dispatch id. A startup screen (folder trust, sign-in) holds the
     * prompt until the owner answers it, and the harness then submits it by
     * itself, so that is not a failure. Neither confirmed nor held reads
     * uncertain, and the returns loop keeps asking.
     */
    private confirmLaunched;
    private origin;
}
export {};
