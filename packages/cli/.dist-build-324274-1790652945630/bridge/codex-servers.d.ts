import { z } from "zod";
import { type AppServerRequestId, type AppServerTurnInput, connectAppServer, type PendingServerRequest, spawnAppServer } from "./codex-app-server.js";
import { type Json, type Target } from "./protocol.js";
declare const entrySchema: z.ZodObject<{
    id: z.ZodString;
    server: z.ZodString;
    workspace: z.ZodString;
    tab: z.ZodString;
    pane: z.ZodString;
    socket: z.ZodString;
    pid: z.ZodNumber;
    threadId: z.ZodOptional<z.ZodString>;
    cwd: z.ZodString;
    startedAt: z.ZodString;
    dispatchId: z.ZodOptional<z.ZodString>;
    activeTurn: z.ZodOptional<z.ZodString>;
    lastTurn: z.ZodOptional<z.ZodObject<{
        id: z.ZodString;
        status: z.ZodString;
        at: z.ZodString;
    }, z.core.$strip>>;
    nextTurn: z.ZodOptional<z.ZodObject<{
        model: z.ZodOptional<z.ZodString>;
        effort: z.ZodOptional<z.ZodString>;
        approvalPolicy: z.ZodOptional<z.ZodEnum<{
            never: "never";
            "on-request": "on-request";
            untrusted: "untrusted";
        }>>;
        approvalsReviewer: z.ZodOptional<z.ZodEnum<{
            auto_review: "auto_review";
            user: "user";
        }>>;
        sandboxPolicy: z.ZodOptional<z.ZodObject<{
            type: z.ZodEnum<{
                dangerFullAccess: "dangerFullAccess";
                readOnly: "readOnly";
                workspaceWrite: "workspaceWrite";
            }>;
        }, z.core.$strict>>;
        collaborationMode: z.ZodOptional<z.ZodObject<{
            mode: z.ZodEnum<{
                default: "default";
                plan: "plan";
            }>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type CodexServerEntry = z.infer<typeof entrySchema>;
export type CodexNextTurn = NonNullable<CodexServerEntry["nextTurn"]>;
/** Where the Hook's approval cards come from and go: every server request of
 * a registered thread is offered here with the function that answers it, and
 * withdrawn once any client (the pane's TUI, or this one) answered it. */
export interface CodexApprovalSink {
    request(target: Target, request: PendingServerRequest, answer: (result: Json) => void): void;
    resolved(target: Target, requestId: AppServerRequestId): void;
}
export interface CodexServerDeps {
    spawn: typeof spawnAppServer;
    connect: typeof connectAppServer;
    /** True while `pid` is a running process. */
    alive(pid: number): boolean;
    kill(pid: number): void;
}
/** `PHREN_CODEX_APP_SERVER=off` keeps every Codex launch on the typed path. */
export declare function codexAppServerEnabled(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): boolean;
/** A question on a Hook-run pane reaches the phone as a card either way, but
 * only the blocking `request_user_input` holds the turn until someone answers:
 * an async question (`request_user_input_async`) lets the worker carry on
 * without the answer, and a plain-text question never becomes a card at all.
 * Codex 0.157 offers the blocking tool outside plan mode only behind
 * `features.default_mode_request_user_input`, and a short developer
 * instruction steers the model to it (as T3 Code's CodexDeveloperInstructions
 * does). `PHREN_CODEX_BLOCKING_QUESTIONS=off` leaves both out. */
export declare const BLOCKING_QUESTION_INSTRUCTIONS: string;
export declare function serverConfig(env?: NodeJS.ProcessEnv): string[];
/** The variable that tells a hook it runs inside the Hook's own app-server
 * for one pane, so the pane variables it carries are that pane's. */
export declare const CODEX_SERVER_ENV = "PHREN_CODEX_SERVER";
export declare const codexServerId: z.ZodString;
/** The server's environment: the Hook's own, minus the variables that name
 * the Hook's terminal, plus the pane's (so the hooks Codex runs inside the
 * server report this pane) and the caller's. */
export declare function serverEnvironment(base: NodeJS.ProcessEnv, extra: Record<string, string>): NodeJS.ProcessEnv;
export declare function codexServersRoot(): string;
/** Nothing was sent: the server could not be reached. */
export declare class CodexServerUnavailable extends Error {
    constructor(message: string);
}
export interface LaunchPlace {
    server: string;
    workspace: string;
    tab: string;
    pane: string;
}
export interface LaunchOptions {
    cwd: string;
    model?: string;
    effort?: string;
    /** Layered over the Hook's environment for the server and its hooks. */
    env?: Record<string, string>;
    dispatchId?: string;
}
export declare class CodexServers {
    private deps;
    private live;
    private sink?;
    private closed;
    constructor(deps?: CodexServerDeps);
    setDeps(deps: Partial<CodexServerDeps>): () => void;
    private readonly saving;
    setSink(sink: CodexApprovalSink | undefined): void;
    entries(): CodexServerEntry[];
    forPane(server: string, pane: string): CodexServerEntry | undefined;
    forThread(threadId: string): CodexServerEntry | undefined;
    /** The server behind a Codex target, when the target is exactly its pane and thread. */
    forTarget(target: Target): CodexServerEntry | undefined;
    /** A new server for a pane the Hook just created, and the arguments the
     * pane's `codex` joins it with. With `startThread` (a launch that carries a
     * brief) the Hook starts the thread and the pane resumes it:
     * `codex resume <threadId> --remote unix://<socket>`. Codex cannot resume a
     * thread with no turn yet, so without one the pane's TUI starts the thread
     * (`codex --remote unix://<socket>`, with the model and effort as its own
     * flags) and the Hook learns it from `thread/started` (`awaitThread`). The
     * caller `stop`s the server if the pane cannot start. */
    launch(place: LaunchPlace, options: LaunchOptions & {
        startThread?: boolean;
    }): Promise<{
        entry: CodexServerEntry;
        args: string[];
    }>;
    /** The pane's thread once its TUI has started it; undefined after `timeoutMs`. */
    awaitThread(entry: CodexServerEntry, timeoutMs?: number): Promise<string | undefined>;
    /** On Hook start: every registered server still running is reconnected
     * and its thread followed again (its pending approvals are replayed to
     * the new client); the rest are forgotten. */
    adopt(): Promise<void>;
    /** `turn/start` on the pane's thread; resolves with the turn id the server
     * acknowledged. Nothing is typed into the pane. */
    prompt(entry: CodexServerEntry, text: string): Promise<{
        turnId: string;
    }>;
    /** Holds a model and effort for the pane's next Hook-sent turn. Nothing is
     * typed into the TUI and a running turn is not disturbed. */
    setNextTurn(entry: CodexServerEntry, model: string, effort?: string): void;
    /** Holds permission and plan settings the same way, next to a pending model. */
    holdSettings(entry: CodexServerEntry, settings: Omit<CodexNextTurn, "model" | "effort">): void;
    /** Merges into what is pending: a later choice replaces its own fields only. */
    private hold;
    /** Input for the thread's running turn (`turn/steer`, as the TUI sends an
     * async question's answer), or a new turn when none is running or the one
     * it knew has ended. A refused steer sent nothing, so starting is safe. */
    steer(entry: CodexServerEntry, text: string, extra?: AppServerTurnInput[]): Promise<{
        turnId: string;
    }>;
    /** The thread's parked questions: `item/tool/requestUserInput` and MCP
     * elicitations, which wait for an answer from any client. */
    questions(entry: CodexServerEntry): PendingServerRequest[];
    /** Answers one parked question; false when no client still waits on it. */
    answerQuestion(entry: CodexServerEntry, requestId: AppServerRequestId, result: Json): boolean;
    /** One proactive refresh of the shared Codex sign-in (codex-auth-refresh.ts)
     * through Codex's own flow: on a running server's connection, or on a
     * short-lived server when none runs. */
    refreshAuth(): Promise<void>;
    /** Interrupt the running turn, declining the thread's parked server
     * requests first. False when no turn is known to be running. */
    interrupt(entry: CodexServerEntry): Promise<boolean>;
    /** The last finished turn of a registered thread and the running one, for
     * the returns loop. */
    turnState(threadId: string): {
        activeTurn?: string;
        lastTurn?: CodexServerEntry["lastTurn"];
    } | undefined;
    /** One Hook tick for `server`: forget servers whose process ended, stop
     * servers whose pane closed (or has shown no Codex for two minutes), and
     * reconnect a client that dropped. */
    reap(server: string, snapshot: Json, now?: number): Promise<void>;
    /** Servers whose terminal server is no longer running at all (a stopped
     * Herdr session takes its panes with it): forgotten once dead, stopped
     * after the same two minutes a pane without Codex gets. */
    sweep(running: string[], now?: number): Promise<void>;
    /** The pane's TUI moved to `threadId` (`/new`, `/resume`), as its
     * SessionStart hook reports: follow it, so prompts, approvals and Escape
     * go where the TUI is. False when the pane has no registered server. */
    follow(server: string, pane: string, threadId: string): boolean;
    private rebind;
    /** Ends the server and forgets it. */
    stop(entry: CodexServerEntry): Promise<void>;
    /** Close every client; the servers keep running for the next Hook. */
    close(): void;
    /** For tests: forget everything without touching processes. */
    reset(): void;
    /** Resolves once every registry write started so far has finished. */
    saved(): Promise<void>;
    private target;
    /** Rejoin the thread: its history is skipped, its pending server requests
     * come again as requests. */
    private subscribe;
    private client;
    private connect;
    private listen;
    private drop;
    private forget;
    private read;
    /** One server's registry writes run in order, each with the entry as it is
     * then, so an earlier write that finishes late never lands over a newer one. */
    private save;
}
/** The Hook's servers: launch, prompt and keys routes, identity and the
 * approval store all see the same registry. */
export declare const codexServers: CodexServers;
export {};
