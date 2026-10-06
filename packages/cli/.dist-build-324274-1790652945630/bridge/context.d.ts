import { type Json } from "./protocol.js";
/** A bounded metadata cache avoids decoding unchanged transcripts. Reads
 * inspect at most the final 256 KiB, without building the full chat index. */
export declare class ContextUsageReader {
    private cache;
    read(file: string, session: string): Promise<number | undefined>;
}
/** Resolve only exact foreground identities. A tab with multiple agent panes
 * has no single context percentage, and unsupported providers stay unknown. */
export declare class WorkspaceContextUsage {
    private reader;
    private active?;
    read(server: string, snapshot: Json): Promise<ReadonlyMap<Json, number>>;
}
