import { type AccountRef } from "./claude-accounts.js";
import { type Json, type Provider, type Target } from "./protocol.js";
import { type ChangeLookup } from "./changes.js";
export { isNarration, unwrapPastedContent } from "./transcript-claude.js";
export { codeToolCalls, projectCodexRow, type CodeToolCall } from "./transcript-codex.js";
export interface Entry {
    line: number;
    raw: Json;
}
export interface ChildAgentRelation {
    /** `id` is a parent-scoped public reference; local session and transcript details never leave Hook. */
    id: string;
    session?: string;
    transcript?: string;
    provider: Provider;
    path: string;
    callId: string;
    state: "running" | "completed" | "failed" | "gone" | "unavailable";
    /** Why a fan-out worker did not finish: `blocked: <type> <pattern>`. */
    reason?: string;
    /** Present only when a source supplies a validated worker launch time. */
    startedAt?: string;
    finishedAt?: string;
    /** Fan-out manifests and Claude child transcripts can name a model. */
    model?: string;
    fanout?: {
        resumable: boolean;
    };
    /** Public checkout labels for fan-outs; full paths remain private. */
    worktreeName?: string;
    branch?: string;
    /** The checkout a fan-out worker owns; parent-checkout children omit it. */
    cwd?: string;
    /** Remote rows carry only routing identities, never a local path. */
    computer?: {
        id: string;
        name: string;
    };
    remote?: {
        target: Target;
        child?: string;
    };
    children: ChildAgentRelation[];
}
export interface LocalChildAgentRelation extends ChildAgentRelation {
    session: string;
    transcript: string;
    remote?: undefined;
}
/** Provider-neutral child-agent discovery. Codex currently supplies explicit
 * SubAgentActivity links; other providers return no children until their
 * public transcript format exposes an equivalent relationship. */
export declare function childAgentTree(source: Provider, session: string, depth?: number, seen?: Set<string>, computer?: string): Promise<ChildAgentRelation[]>;
/** Explicit wire projection prevents a provider's private transcript identity
 * from being returned if relation internals grow later. */
export declare function publicChildAgents(tree: ChildAgentRelation[]): Json[];
export declare function childAgent(tree: ChildAgentRelation[], id: string): LocalChildAgentRelation | undefined;
/**
 * The phren store whose `.runtime/sessions` holds phren-agent event logs.
 * `PHREN_PATH` or the shared `~/.phren` root — the two resolutions the CLI's
 * `findPhrenPath` makes without a working directory, which a service has none
 * of. Kept inline rather than importing phren-paths: that module drags in
 * yaml and the data layer, and this bundle is budgeted for cold start.
 */
export declare function phrenStoreRoot(env?: NodeJS.ProcessEnv): string;
/** The account a resolved Claude transcript belongs to, by the home holding it. */
export declare function transcriptAccount(file: string): AccountRef | undefined;
/** A pane's transcript: the pane's known Claude account settles a session id found in more than one home. */
export declare function targetTranscriptPath(target: {
    server: string;
    pane: string;
    source: Provider;
    session: string;
}): Promise<string>;
/** `account` (a Claude home id) settles a session id found in more than one home. */
export declare function transcriptPath(source: Provider, session: string, account?: string): Promise<string>;
/** Keeps a materialized Codex thread current before a read; a no-op for
 * transcripts the agent writes itself. */
export declare function refreshTranscript(file: string, source: Provider, session: string): Promise<void>;
/** Public conversation/tool events and real usage only. Never export private reasoning. */
export declare function visibleEvent(raw: Json, source: Provider, includeSidechain?: boolean, cwd?: string): Json | undefined;
/** Parse only the requested page; shared byte indexes make reopening and
 * backward pagination independent of the amount of already-read history. */
export declare class TranscriptReader {
    readonly file: string;
    readonly source: Provider;
    private readonly imageLine?;
    private readonly changes?;
    private readonly includeSidechain;
    private readonly cwd?;
    private revision?;
    private nextLine;
    constructor(file: string, source: Provider, imageLine?: number | undefined, changes?: ChangeLookup | undefined, includeSidechain?: boolean, cwd?: string | undefined);
    read(before?: number, signal?: AbortSignal): Promise<{
        entries: Entry[];
        totalLines: number;
        startLine: number;
        hasMore: boolean;
        reset: boolean;
    }>;
    /** Resume a fresh live reader after the last raw line the client retained. */
    readAfter(afterLine: number, signal?: AbortSignal): Promise<{
        entries: Entry[];
        totalLines: number;
        startLine: number;
        hasMore: boolean;
        reset: boolean;
    }>;
    private readPage;
}
/** One embedded image: block `block` of the row's content — or, with
 * `inner`, image `inner` inside that block's tool_result content (what a
 * Read of a PNG returns). For Codex, an output row's array is the content. */
export declare function historicalImage(file: string, line: number, block: number, source: Provider, inner?: number): Promise<Buffer>;
/** Derive optional diff scope from local tool-call rows, never phone commands. */
export declare function conversationNamedPaths(file: string, source: Provider, cwd: string, signal?: AbortSignal): Promise<string[]>;
