import { z } from "zod";
import { type Target } from "./protocol.js";
import type { ChildAgentRelation } from "./transcripts.js";
export declare const dispatchParentSchema: z.ZodObject<{
    provider: z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        copilot: "copilot";
        opencode: "opencode";
        phren: "phren";
    }>;
    session: z.ZodUnion<readonly [z.ZodString, z.ZodString]>;
    computer: z.ZodString;
}, z.core.$strict>;
export type DispatchParent = z.infer<typeof dispatchParentSchema>;
export interface DispatchParentInput {
    parent?: unknown;
    parentTarget?: unknown;
}
/** Parent metadata is optional as a pair. When present it must name this Hook
 * and the exact live conversation target the caller supplied. */
export declare function validateDispatchParent(input: DispatchParentInput, localComputer: string, validateTarget: (target: Target) => Promise<unknown>): Promise<{
    parent?: DispatchParent;
    parentTarget?: Target;
}>;
export interface DispatchTreeReceipt {
    readonly id: string;
    readonly computer: string;
    readonly computerId?: string;
    readonly remoteComputer?: unknown;
    readonly label: string;
    readonly model?: string;
    readonly state: string;
    readonly target?: unknown;
    readonly parent?: unknown;
    readonly parentTarget?: unknown;
    readonly status?: string;
    readonly completedAt?: string;
}
export interface RemoteDispatchSnapshot {
    readonly dispatchId?: string;
    readonly available?: boolean;
    readonly state?: "running" | "completed" | "unavailable";
    readonly target?: unknown;
    readonly computer?: unknown;
    readonly agents?: readonly unknown[];
    readonly children?: readonly unknown[];
}
export type RemoteSnapshotReader = (receipt: DispatchTreeReceipt) => RemoteDispatchSnapshot | undefined | Promise<RemoteDispatchSnapshot | undefined>;
export type RemoteSnapshotSource = RemoteSnapshotReader | ReadonlyMap<string, RemoteDispatchSnapshot | undefined> | Readonly<Record<string, RemoteDispatchSnapshot | undefined>> | readonly RemoteDispatchSnapshot[] | RemoteDispatchSnapshot | undefined;
/** Project this conductor's durable outbound receipts into remote work-tree
 * rows. Snapshot readers are GET-only adapters; missing or rejected snapshots
 * keep the lead visible as unavailable. */
export declare function remoteChildren(parentValue: DispatchParent, receipts: readonly DispatchTreeReceipt[], remoteSnapshot: RemoteSnapshotSource): Promise<ChildAgentRelation[]>;
