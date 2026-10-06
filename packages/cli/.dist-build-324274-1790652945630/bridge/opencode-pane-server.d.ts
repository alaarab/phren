export interface PaneServerEntry {
    server: string;
    pane: string;
    port: number;
    password: string;
    pid: number;
    directory: string;
    createdAt: string;
    /** What the TUI was started with (`--agent`, `--model`, `--variant`), for
     * the first prompt of a session that has no earlier turn to follow. */
    defaults?: {
        agent?: string;
        model?: string;
        variant?: string;
    };
}
export interface OpenCodeSession {
    id: string;
    directory?: string;
    /** Set on a subagent's session; the TUI shows its root session. */
    parentID?: string;
    time?: {
        created?: number;
        updated?: number;
    };
}
export interface OpenCodeMessage {
    info?: {
        id?: string;
        role?: string;
        agent?: string;
        model?: {
            providerID?: string;
            modelID?: string;
            variant?: string;
        };
    };
    parts?: Array<{
        type?: string;
        text?: string;
    }>;
}
export interface OpenCodePermission {
    id: string;
    sessionID?: string;
    permission?: string;
    patterns?: string[];
}
export interface OpenCodeQuestion {
    id: string;
    sessionID?: string;
    questions?: unknown[];
}
/** The prompt never reached the server (refused, or nothing listening), so
 * the caller may still send it another way without a duplicate. */
export declare class PromptNotSent extends Error {
}
export interface PaneEvent {
    type: string;
    properties?: Record<string, unknown>;
}
export type PermissionReply = "once" | "always" | "reject";
export interface PromptOptions {
    /** `provider/model`; split on the first slash. */
    model?: string;
    agent?: string;
    /** A model variant (reasoning effort), as `opencode --variant` takes it. */
    variant?: string;
    /** Without an explicit model or agent, continue with the ones the
     * session's last user turn used, as the TUI would. */
    inherit?: boolean;
    timeoutMs?: number;
}
export type PromptResult = {
    delivered: true;
    messageId: string;
} | {
    delivered: false;
    reason: "timeout";
};
export declare function registerPaneServer(dir: string, entry: PaneServerEntry): string;
export declare function readPaneServer(dir: string, server: string, pane: string): PaneServerEntry | undefined;
/** Every registered pane whose OpenCode process is still running. An entry
 * whose process is gone is removed as it is found. */
export declare function listPaneServers(dir: string): PaneServerEntry[];
export declare function removePaneServer(dir: string, server: string, pane: string): void;
export declare function freePort(): Promise<number>;
export declare function newPassword(): string;
export interface PaneClient {
    /** True once the server answers an authenticated request within `timeoutMs`. */
    ready(timeoutMs?: number): Promise<boolean>;
    sessions(): Promise<OpenCodeSession[]>;
    session(id: string): Promise<OpenCodeSession | undefined>;
    currentSession(): Promise<OpenCodeSession | undefined>;
    /** A new root session in the pane's directory. The TUI does not show it
     * until `selectSession` moves it there. */
    createSession(): Promise<OpenCodeSession>;
    /** Asks the TUI to show `id`. A TUI still starting drops the request, so
     * the caller checks the pane and asks again. */
    selectSession(id: string): Promise<void>;
    prompt(sessionId: string, text: string, opts?: PromptOptions): Promise<PromptResult>;
    permissions(): Promise<OpenCodePermission[]>;
    replyPermission(id: string, reply: PermissionReply, message?: string): Promise<void>;
    questions(): Promise<OpenCodeQuestion[]>;
    replyQuestion(id: string, answers: string[][]): Promise<void>;
    rejectQuestion(id: string): Promise<void>;
    abort(sessionId: string): Promise<boolean>;
    events(signal?: AbortSignal): AsyncGenerator<PaneEvent>;
}
export declare function openPaneClient(entry: PaneServerEntry, fetchImpl?: typeof fetch): PaneClient;
