import { WebSocket } from "ws";
import { logger } from "../logger.js";
import { sharedSnapshot } from "./herdr.js";
import { intervalFromEnv } from "./limits.js";
import { countTick } from "./metrics.js";
import { muxReplyForClient } from "./mux-wire.js";
import { type Json, MAX_FRAME } from "./protocol.js";
import type { WorkspacesReader } from "./server-routes.js";
import { streamCloseReason } from "./server-stream.js";

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
 * One that asks with `sudo=1` gets `{ type: "sudo", requests }` after the first
 * overview and whenever the pending sudo requests change.
 */
export const OVERVIEW_TICK_MS = intervalFromEnv("PHREN_OVERVIEW_TICK_MS", 5_000, 250, 60_000);
export const OVERVIEW_REFRESH_MS = intervalFromEnv("PHREN_OVERVIEW_REFRESH_MS", 10_000, 1_000, 120_000);
export const OVERVIEW_HEARTBEAT_MS = intervalFromEnv("PHREN_OVERVIEW_HEARTBEAT_MS", 20_000, 1_000, 60_000);
export const OVERVIEW_RESOURCES_MS = intervalFromEnv("PHREN_OVERVIEW_RESOURCES_MS", 12_000, 1_000, 120_000);

export interface OverviewStreamOptions {
  read: WorkspacesReader;
  /** The Hook's info, as `/v1/health` reports it. */
  info: () => Json;
  /** Renews the approval watch lease `watchApprovals=1` asks for. */
  renew: (server: string) => void;
  /** Pending sudo requests (`GET /v1/sudo`), for phones that ask with `sudo=1`. */
  sudo?: { list(): unknown[]; subscribe(listener: (requests: unknown[]) => void): () => void };
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

export function overviewStream(options: OverviewStreamOptions) {
  const snapshot = options.snapshot ?? sharedSnapshot;
  const now = options.now ?? Date.now;
  const tickMs = options.tickMs ?? OVERVIEW_TICK_MS;
  const refreshMs = options.refreshMs ?? OVERVIEW_REFRESH_MS;
  const heartbeatMs = options.heartbeatMs ?? OVERVIEW_HEARTBEAT_MS;
  const resourcesMs = options.resourcesMs ?? OVERVIEW_RESOURCES_MS;

  function send(client: OverviewClient, frame: Json): boolean {
    if (client.readyState !== WebSocket.OPEN) return false;
    const data = JSON.stringify(frame);
    if (Buffer.byteLength(data) > MAX_FRAME || client.bufferedAmount > MAX_FRAME) {
      client.close(1009, "Overview too large; refresh");
      return false;
    }
    client.send(data);
    return true;
  }

  /** Streams one server's overview until the client closes. Returns the
   * tick function, for tests that drive time themselves. */
  return function stream(client: OverviewClient, server: string, watchApprovals: boolean, withResources = false, typedMux = false, withSudo = false) {
    let closed = false, busy = false, resourcesPending = false, first = true, overviewSent = false;
    // Subscribed at once, so the phone counts as able to answer while the first overview builds.
    const unsubscribe = withSudo && options.sudo
      ? options.sudo.subscribe(requests => { if (!closed && overviewSent) send(client, { type: "sudo", requests }); }) : undefined;
    let snapshotKey = "", builtAt = 0, sentKey = "", sentAt = 0, resourcesAt = -Infinity;
    const collectResources = () => {
      const at = now();
      if (!withResources || !options.resources || resourcesPending || at - resourcesAt < resourcesMs) return;
      resourcesPending = true;
      resourcesAt = at;
      void Promise.resolve().then(() => options.resources!()).then(resources => {
        if (!closed && resources) send(client, { type: "resources", resources });
      }).catch(error => {
        logger.warn("stream", `/v1/overview resources read failed: ${streamCloseReason(error)}`);
      }).finally(() => { resourcesPending = false; });
    };
    const tick = async (): Promise<void> => {
      if (busy || closed) return;
      busy = true;
      try {
        countTick("overview-stream");
        const at = now();
        // The first frame reads a fresh snapshot, as a poll would.
        const held = await snapshot(server, first ? 0 : tickMs);
        if (closed) return;
        const key = JSON.stringify(held);
        if (first || key !== snapshotKey || at - builtAt >= refreshMs) {
          snapshotKey = key; builtAt = at;
          const overview = muxReplyForClient(await options.read(server, held, watchApprovals), typedMux);
          if (closed) return;
          const { phren: _phren, ...rows } = overview;
          const rowsKey = JSON.stringify(rows);
          if (first || rowsKey !== sentKey) {
            if (send(client, { type: "overview", ...overview })) {
              sentKey = rowsKey; sentAt = at;
              if (!overviewSent && unsubscribe) send(client, { type: "sudo", requests: options.sudo!.list() });
              overviewSent = true;
            }
            first = false;
            return;
          }
        } else if (watchApprovals) {
          options.renew(server);
        }
        first = false;
        if (at - sentAt >= heartbeatMs && send(client, { type: "heartbeat", phren: options.info() })) sentAt = at;
      } catch (error) {
        const reason = streamCloseReason(error);
        logger.warn("stream", `/v1/overview closed: ${reason}`);
        stop();
        client.close(1011, reason);
      } finally {
        busy = false;
        // Start this separately so ps and pane ownership cannot hold up the overview.
        if (!closed) collectResources();
      }
    };
    const timer = setInterval(() => { void tick(); }, tickMs);
    const stop = () => { closed = true; clearInterval(timer); unsubscribe?.(); };
    client.once("close", stop);
    client.once("error", stop);
    void tick();
    return { tick, stop };
  };
}
