import { type Json } from "./protocol.js";
import type { WorkspacesReader } from "./server-routes.js";
/**
 * The `/v1/overview` WebSocket: the same overview `GET /v1/workspaces`
 * answers, pushed to the phone when it changes, so a phone keeps one socket
 * per computer open instead of polling. Each tick reads the shared Herdr
 * snapshot at most one tick old: the activity timer takes one every five
 * seconds (and open chats every 2.5), so a connected phone adds no Herdr
 * snapshots of its own, and a status change reaches it within one tick. The
 * overview is rebuilt when that snapshot changed or `OVERVIEW_REFRESH_MS` has
 * passed (branches, models and steps live outside the snapshot), and sent
 * only when it differs from the last one sent. With nothing to send, a heartbeat every
 * `OVERVIEW_HEARTBEAT_MS` carries the Hook's info and tells the phone the
 * overview it holds is still current.
 *
 * Frames: `{ type: "overview", ...workspaces, phren }` and
 * `{ type: "heartbeat", phren }`. A phone that asks with `resources=1` also
 * gets `{ type: "resources", resources }` after the first overview, then at
 * `OVERVIEW_RESOURCES_MS` intervals (an older phone never asks, so never meets it).
 */
export declare const OVERVIEW_TICK_MS: number;
export declare const OVERVIEW_REFRESH_MS: number;
export declare const OVERVIEW_HEARTBEAT_MS: number;
export declare const OVERVIEW_RESOURCES_MS: number;
export interface OverviewStreamOptions {
    read: WorkspacesReader;
    /** The Hook's info, as `/v1/health` reports it. */
    info: () => Json;
    /** Renews the approval watch lease `watchApprovals=1` asks for. */
    renew: (server: string) => void;
    /** This computer's resources (`GET /v1/resources`), for phones that ask. */
    resources?: () => Promise<unknown>;
    snapshot?: (server: string, maxAgeMs: number) => Promise<Json>;
    now?: () => number;
    tickMs?: number;
    refreshMs?: number;
    heartbeatMs?: number;
    resourcesMs?: number;
}
/** A socket-like peer: the `ws` client, or a test double. */
export interface OverviewClient {
    readonly readyState: number;
    readonly bufferedAmount: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    once(event: "close" | "error", listener: () => void): unknown;
}
export declare function overviewStream(options: OverviewStreamOptions): (client: OverviewClient, server: string, watchApprovals: boolean, withResources?: boolean, typedMux?: boolean) => {
    tick: () => Promise<void>;
    stop: () => void;
};
