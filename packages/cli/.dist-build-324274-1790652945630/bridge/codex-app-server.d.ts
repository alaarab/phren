import { type ChildProcess } from "node:child_process";
import { type Json } from "./protocol.js";
/** JSON-RPC ids are numbers for our own requests and either numbers or strings
 * for server requests (an MCP elicitation uses the elicitation's own id). */
export type AppServerRequestId = number | string;
/** A server request this client has not answered yet. */
export interface PendingServerRequest {
    requestId: AppServerRequestId;
    method: string;
    params: Json;
    threadId?: string;
}
export type AppServerEvent = {
    kind: "notification";
    method: string;
    params: Json;
} | {
    kind: "request";
    requestId: AppServerRequestId;
    method: string;
    params: Json;
    threadId?: string;
} | {
    kind: "resolved";
    requestId: AppServerRequestId;
    threadId?: string;
};
export type AppServerListener = (event: AppServerEvent) => void;
/** A JSON-RPC error reply, carrying the server's `code` beside the message. */
export declare class AppServerRpcError extends Error {
    readonly code: number;
    readonly method: string;
    constructor(code: number, message: string, method: string);
}
/** One user input of a `turn/start`. Shape from the spike transcripts:
 * `{"type":"text","text":"…","text_elements":[]}`. */
export interface AppServerTurnInput {
    type: string;
    text?: string;
    [key: string]: unknown;
}
export interface TurnStartParams {
    threadId: string;
    input: AppServerTurnInput[];
    model?: string;
    effort?: string;
    approvalPolicy?: string;
    sandboxPolicy?: Json;
    approvalsReviewer?: string;
    /** EXPERIMENTAL: plan or default mode. The settings are required and win
     * over `model` and `effort`. */
    collaborationMode?: {
        mode: string;
        settings: {
            model: string;
            reasoning_effort: string | null;
            developer_instructions: string | null;
        };
    };
}
export interface AppServerHandle {
    child: ChildProcess;
    socketPath: string;
    stop(): Promise<void>;
}
export interface AppServerClient {
    /** Server requests awaiting an answer, keyed by request id. */
    readonly pending: ReadonlyMap<AppServerRequestId, PendingServerRequest>;
    request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
    /** `thread/start` (T3 `buildThreadStartParams`: cwd, approvalPolicy, sandbox,
     * approvalsReviewer, model, serviceTier). */
    threadStart(params: Json): Promise<Json>;
    /** `thread/resume`, turning the spike's `excludeTurns: true` on by default
     * (T3 `openCodexThread`; transcript-turn.jsonl id 3). */
    threadResume(params: Json & {
        threadId: string;
    }): Promise<Json>;
    /** `thread/loaded/list` → the thread ids (transcript-observe.jsonl id 2). */
    threadLoadedList(): Promise<string[]>;
    /** `turn/start` → the queued turn's id (transcript-turn.jsonl id 4). */
    turnStart(params: TurnStartParams): Promise<{
        turnId: string;
    }>;
    /** `turn/steer`: input for the running turn `expectedTurnId`, as the TUI
     * sends a message typed mid-turn or the answer to an async question. */
    turnSteer(params: {
        threadId: string;
        expectedTurnId: string;
        input: AppServerTurnInput[];
    }): Promise<{
        turnId: string;
    }>;
    /** `turn/interrupt` (transcript-interrupt.jsonl id 5). */
    turnInterrupt(params: {
        threadId: string;
        turnId: string;
    }): Promise<unknown>;
    /** Decline every pending server request of the thread, then interrupt, so a
     * parked approval cannot block the turn's teardown. */
    interruptTurn(threadId: string, turnId: string): Promise<void>;
    respond(requestId: AppServerRequestId, result: unknown): void;
    respondError(requestId: AppServerRequestId, code: number, message: string): void;
    on(listener: AppServerListener): () => void;
    /** Called once when the connection ends, from either side. */
    onClose(listener: () => void): () => void;
    close(): void;
}
export interface SpawnAppServerOptions {
    codexBin?: string;
    socketPath: string;
    codexHome?: string;
    env?: NodeJS.ProcessEnv;
    /** Use `env` as the whole environment instead of layering it over the
     * Hook's, so variables of the Hook's own terminal cannot leak in. */
    replaceEnv?: boolean;
    cwd: string;
    /** Let the server outlive the Hook (a Hook update must not end a worker the
     * owner is watching in a pane). The caller records the pid to stop it later. */
    detached?: boolean;
    /** Where the server's stderr goes for its whole life. A detached server
     * outlives the Hook's end of a pipe, and a write to a closed pipe could
     * end it, so a long-lived server logs to a file instead. */
    logFile?: string;
    /** Config overrides for every thread the server runs, as `-c key=value`
     * (the value is TOML). */
    config?: string[];
}
/** Start one `codex app-server --listen unix://<socketPath>` and wait until its
 * socket accepts WebSocket connections. The server is the worker's; `stop()`
 * is the only owner. Extra `env` is layered over the current process's. */
export declare function spawnAppServer(options: SpawnAppServerOptions): Promise<AppServerHandle>;
export interface ConnectAppServerOptions {
    clientName: string;
    clientTitle?: string;
    clientVersion?: string;
    timeoutMs?: number;
}
/** Connect and complete `initialize` + `initialized` (spike client.mjs,
 * transcript-turn.jsonl ids 1 and the notification). */
export declare function connectAppServer(socketPath: string, options: ConnectAppServerOptions): Promise<AppServerClient>;
/** The shape that declines one server request so the turn can be torn down.
 * T3 `settlePendingApprovals("cancel")` / `settlePendingUserInputs({})` and the
 * per-method responses in its `handleServerRequest` blocks. */
export declare function declineResult(method: string): Json;
