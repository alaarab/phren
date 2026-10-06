import { type OpenCodePermission, type OpenCodeQuestion, type PaneClient, type PaneServerEntry, type PromptOptions } from "./opencode-pane-server.js";
/** Set in a served pane's environment: the port its TUI listens on. The
 * OpenCode plugin leaves permission asks to the Hook's HTTP client when its
 * own process was started with this port. */
export declare const PANE_PORT_ENV = "PHREN_OPENCODE_PORT";
export declare function paneServersDir(): string;
/** The live server entry for a pane, if the Hook started its OpenCode. */
export declare function servedPane(server: string, pane: string): PaneServerEntry | undefined;
export declare function servedPanes(): PaneServerEntry[];
export declare function forgetServedPane(server: string, pane: string): void;
export declare function paneClient(entry: PaneServerEntry): PaneClient;
/** For tests: build clients against a fake server; returns the restore. */
export declare function setPaneClientFactory(factory: (entry: PaneServerEntry) => PaneClient): () => void;
export interface ServedLaunch {
    port: number;
    password: string;
    args: string[];
    env: Record<string, string>;
}
/** The port, password, extra arguments and pane variables for one launch. */
export declare function prepareServedLaunch(): Promise<ServedLaunch>;
/** `--port N` or `--port=N` in a command line. */
export declare function listensOn(command: string, port: number): boolean;
declare function processTable(): Promise<Array<{
    pid: number;
    command: string;
}>>;
/** The OpenCode process serving `port` in the pane: a foreground process of
 * the pane whose command line carries that port, else any process that does
 * (a launcher shim can hold the pane's foreground). The newest wins, which is
 * the real binary under a shim. */
export declare function servingPid(server: string, pane: string, port: number, table?: typeof processTable): Promise<number | undefined>;
/**
 * Registers a pane whose OpenCode the Hook just started with `launch`, once
 * its server answers. Undefined when it never did: the pane then keeps the
 * typed path, exactly like one started by hand.
 */
export declare function registerServedPane(server: string, pane: string, directory: string, launch: ServedLaunch, options?: {
    readyMs?: number;
    defaults?: PaneServerEntry["defaults"];
    table?: () => Promise<Array<{
        pid: number;
        command: string;
    }>>;
}): Promise<PaneServerEntry | undefined>;
export type ServedPrompt = {
    sent: false;
    reason: string;
} | {
    sent: true;
    delivered: boolean;
    session: string;
};
/**
 * Moves the TUI onto `session`, whose first turn is `text`. A TUI that has
 * only just started answers HTTP before it listens for its own navigation
 * events and drops the first request (seen live on 1.18.31), so the request
 * is repeated until the pane draws that turn. False when it never did: the
 * conversation is still real, only not on screen.
 */
export declare function showSession(entry: PaneServerEntry, client: PaneClient, session: string, text: string, options?: {
    timeoutMs?: number;
    intervalMs?: number;
    shows?: (text: string) => Promise<boolean>;
}): Promise<boolean>;
/**
 * Sends `text` into the session a served TUI shows. `session` is the
 * conversation the phone means and must be a root session of this server; with
 * none (a TUI still on its home screen) a new session is created, and once the
 * prompt is in, the TUI is moved onto it so the owner sees it there.
 * `sent: false` means nothing reached OpenCode, so the caller may type it.
 */
export declare function sendServedPrompt(entry: PaneServerEntry, session: string | undefined, text: string, options?: PromptOptions): Promise<ServedPrompt>;
/** A launch brief sent over HTTP: into a new session the TUI shows. */
export declare function sendServedBrief(entry: PaneServerEntry, text: string, options?: PromptOptions): Promise<ServedPrompt>;
/** The root of a (possibly subagent) session: the conversation the pane shows. */
export declare function rootSession(client: PaneClient, session: string): Promise<string>;
export interface PaneAsks {
    permissions: OpenCodePermission[];
    questions: OpenCodeQuestion[];
}
/** Where the watcher reports what each served pane is asking. `asks` is the
 * whole current set for that pane; `gone` means the pane's entry is gone. */
export interface PaneAskSink {
    asks(entry: PaneServerEntry, client: PaneClient, asks: PaneAsks): Promise<void>;
    gone(key: string): void;
}
export declare const paneKey: (entry: {
    server: string;
    pane: string;
}) => string;
/**
 * One event subscription per served pane. On every (re)connect and on each
 * permission or question event it lists the pane's pending asks and hands the
 * whole set to the sink, so an ask answered in the TUI disappears too. A
 * dropped stream reconnects with backoff; `tick` stops panes whose entry is
 * gone (the process exited) and starts new ones.
 */
export declare class PaneServerWatcher {
    private sink;
    private list;
    private minBackoffMs;
    private live;
    private closed;
    constructor(sink: PaneAskSink, list?: () => PaneServerEntry[], minBackoffMs?: number);
    tick(): void;
    watching(): string[];
    close(): void;
    private follow;
}
export {};
