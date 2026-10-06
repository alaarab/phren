import type { AccountRef } from "./claude-accounts.js";
import { BridgeError, type Json, type Target, type StartingTarget } from "./protocol.js";
export declare function herdrRoot(): string;
/** Where Herdr's socket for `server` lives. */
export declare function herdrSocketPath(server: string): string;
/** The Herdr pane this process runs in, from the variables Herdr sets for
 * every pane: the server its socket belongs to plus the pane's ids. */
export declare function herdrPaneFromEnv(env?: NodeJS.ProcessEnv): {
    server: string;
    workspace: string;
    tab: string;
    pane: string;
} | undefined;
/** A socket failure keeps its errno so "not running", "stale socket" and "permissions" stay distinct. */
export declare function herdrSocketError(error: Error): BridgeError;
/**
 * For pane reads whose callers treat text as optional: the caller still gets
 * nothing, but the reason is logged once per target (again only if it changes).
 */
export declare function noteOptionalReadFailure(what: string, key: string, error: unknown): void;
/** Herdr's documented newline JSON socket API. No shell, UI focus, or inherited caller context. */
export declare function rpc(server: string, method: string, params?: Json, signal?: AbortSignal, timeoutMs?: number): Promise<Json>;
/** How long the activity timer reuses the list of running Herdr servers
 * before pinging every server directory again. */
export declare const SERVER_LIST_REUSE_MS: number;
/** The running servers, reusing a list at most `maxAgeMs` old. For
 * background work only: a route that answers the phone calls `servers()`. */
export declare function recentServers(maxAgeMs?: number): Promise<Json[]>;
export declare function servers(): Promise<Json[]>;
/** How old a shared `session.snapshot` may be for readers that poll: open
 * chat and status streams and the activity timer. The overview and every
 * action take a fresh one, which the pollers then reuse. */
export declare const SNAPSHOT_SHARE_MS: number;
/** A fresh snapshot. Its answer also becomes the shared one, so pollers reuse it. */
export declare function snapshot(server: string): Promise<Json>;
/**
 * One `session.snapshot` per server shared by every poller: an answer less
 * than `maxAgeMs` old is reused and concurrent callers join the request in
 * flight, so N open chats cost one snapshot per window, not one each, and
 * reuse the overview's when it is recent enough. A pane that disappears or changes identity shows in the next
 * snapshot, at most `maxAgeMs` after the change. Failures are never kept.
 * Anything about to act on a pane (a send, a key, a launch) calls `snapshot`.
 */
export declare function sharedSnapshot(server: string, maxAgeMs?: number): Promise<Json>;
/**
 * Every pane on the running servers, from snapshots already held and no older
 * than `maxAgeMs`, without asking Herdr; undefined unless the server list is
 * known and every listed server has such a snapshot.
 */
export declare function knownPanes(maxAgeMs: number): Json[] | undefined;
/** For tests: forget every shared snapshot and the server list. */
export declare function resetSharedHerdrState(): void;
/** The agent's Herdr name. Newer Herdr keeps it in `agents[].name` rather
 * than on the pane (`agent_name`); read either. */
export declare function paneAgentName(s: Json, pane: Json | undefined): string | undefined;
/** Every agent name in use on a server, in either Herdr shape. */
export declare function agentNames(s: Json): Set<string>;
/** A pane's place in a snapshot, and optionally the agent that must be running in it. */
export interface PaneAddress {
    workspace: string;
    tab: string;
    pane: string;
    source?: string;
}
/** The snapshot's pane at `address`; with a `source`, only while that agent runs there. */
export declare function findPane(s: Json, address: PaneAddress): Json | undefined;
/** A conductor's Herdr name: "conductor", or "conductor-" plus its label. */
export declare function isConductorName(name: string | undefined): boolean;
export declare function workspaceSnapshot(s: Json, contextUsedPercent?: ReadonlyMap<Json, number>, approvalPanes?: ReadonlySet<string>, lastChanged?: ReadonlyMap<string, string>): Json;
export declare function paneIdentity(server: string, pane: Json, fresh?: boolean): Promise<string | undefined>;
/** Copilot CLI changes conversation inside one process (/new, /clear,
 * /resume) and runs its sessionStart hook only once that conversation's first
 * prompt is submitted. Until then Herdr's reported session and the recorded
 * binding still name the previous conversation, so a phone send aimed there
 * lands in the new one and its UserPromptSubmit check refuses it, every time.
 * The process log Copilot names by PID records each switch as it happens. */
export declare function copilotForegroundSession(pids: number[], home?: string): Promise<string | undefined>;
/** The conversation phren's OpenCode plugin says this process shows (it
 * records it by PID on each prompt), when its transcript exists. Herdr's own
 * OpenCode integration may be missing; this does not depend on it. */
export declare function opencodePidSession(pids: number[], root?: string): Promise<string | undefined>;
/** The Codex pane that shows `session`, for a lifecycle callback that ran
 * inside a Codex daemon and so cannot name its pane. Falls back to the only
 * Codex pane in the callback's folder while that pane shows no conversation. */
export declare function paneForCodexSession(server: string, session: string, cwd?: string): Promise<Json | undefined>;
/** Bind first-send permission to the actual terminal/process, never a cwd or
 * a guessed conversation. Tokens expire naturally when the Hook/process restarts. */
export declare function paneChatState(server: string, pane: Json, options?: {
    tokenWhenIdentified?: boolean;
}): Promise<Json>;
/** `{ account }` for a Claude pane whose account is known, else nothing. */
export declare function paneAccountField(server: string, pane: Json): {
    account?: AccountRef;
};
export declare function panes(server: string, workspace: string, tab: string): Promise<Json>;
/** The pane a starting target names, if its terminal/process binding still
 * holds. Status is not checked here: a starting agent's first prompt (folder
 * trust, a login) is exactly what the phone answers with a key. */
export declare function startingPane(target: StartingTarget): Promise<Json>;
export declare function validateStartingTarget(target: StartingTarget): Promise<Json>;
/**
 * The target's pane, only while it still runs the target's conversation.
 * `sharedWithinMs` lets a poller (a stream tick) accept a shared snapshot up
 * to that old; sends, keys and every other mutation keep a fresh one.
 */
export declare function validateTarget(target: Target, sending?: boolean, refreshIdentity?: boolean, sharedWithinMs?: number): Promise<Json>;
export declare function trustedDirectory(pane: Json): Promise<string>;
