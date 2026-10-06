import { z } from "zod";
import { type FanoutManifest } from "./fanouts.js";
import { type Target } from "./protocol.js";
import { type ChildAgentRelation } from "./transcripts.js";
export declare const fanoutMessageSchema: z.ZodObject<{
    target: z.ZodObject<{
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
    }, z.core.$strip>;
    child: z.ZodString;
    text: z.ZodString;
}, z.core.$strict>;
declare const receiptSchema: z.ZodObject<{
    id: z.ZodString;
    text: z.ZodString;
    status: z.ZodEnum<{
        completed: "completed";
        failed: "failed";
        queued: "queued";
        running: "running";
    }>;
    createdAt: z.ZodString;
}, z.core.$strip>;
export type FanoutMessage = z.infer<typeof receiptSchema>;
interface Job {
    directory: string;
    manifest: FanoutManifest;
}
interface Dependencies {
    validate: (target: Target) => Promise<unknown>;
    tree: (target: Target) => Promise<ChildAgentRelation[]>;
    run?: (job: Job, text: string) => Promise<number>;
}
/** Durable per-job messages. A running receipt is never replayed after a Hook restart. */
export declare class FanoutMessages {
    private readonly env;
    private readonly deps;
    private timer?;
    private ticking;
    constructor(env: NodeJS.ProcessEnv, deps: Dependencies);
    start(): void;
    close(): void;
    private jobs;
    private selected;
    send(input: unknown): Promise<{
        ok: true;
        message: FanoutMessage;
    }>;
    /** Archive every finished worker of one live parent now, instead of after
     * the sweep's 24 hours. The sweep's own checks apply: a job without an exit
     * stamp, with a message lock or with queued messages stays put. */
    archiveFinished(input: unknown): Promise<{
        ok: true;
        archived: number;
    }>;
    list(targetValue: unknown, childValue: unknown): Promise<{
        messages: FanoutMessage[];
    }>;
    private messageDirectory;
    private records;
    tick(): Promise<void>;
    private drain;
}
export {};
