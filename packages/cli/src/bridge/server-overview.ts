import { WebSocket } from "ws";
import { logger } from "../logger.js";
import { sharedSnapshot, SNAPSHOT_SHARE_MS } from "./herdr.js";
import { intervalFromEnv } from "./limits.js";
import { countTick } from "./metrics.js";
import { type Json, MAX_FRAME } from "./protocol.js";
import type { WorkspacesReader } from "./server-routes.js";
import { streamCloseReason } from "./server-stream.js";

/**
 * The `/v1/overview` WebSocket: the same overview `GET /v1/workspaces`
 * answers, pushed to the phone when it changes, so a phone keeps one socket
 * per computer open instead of polling. Each tick reads the shared Herdr
 * snapshot (the one open chats and the activity timer already take), so a
 * connected phone adds no snapshots of its own. The overview is rebuilt when
 * that snapshot changed or `OVERVIEW_REFRESH_MS` has passed (branches, models
 * and steps live outside the snapshot), and sent only when it differs from
 * the last one sent. With nothing to send, a heartbeat every
 * `OVERVIEW_HEARTBEAT_MS` carries the Hook's info and tells the phone the
 * overview it holds is still current.
 *
 * Frames: `{ type: "overview", ...workspaces, phren }` and
 * `{ type: "heartbeat", phren }`.
 */
export const OVERVIEW_TICK_MS = intervalFromEnv("PHREN_OVERVIEW_TICK_MS", SNAPSHOT_SHARE_MS, 250, 60_000);
export const OVERVIEW_REFRESH_MS = intervalFromEnv("PHREN_OVERVIEW_REFRESH_MS", 10_000, 1_000, 120_000);
export const OVERVIEW_HEARTBEAT_MS = intervalFromEnv("PHREN_OVERVIEW_HEARTBEAT_MS", 20_000, 1_000, 60_000);

export interface OverviewStreamOptions {
  read: WorkspacesReader;
  /** The Hook's info, as `/v1/health` reports it. */
  info: () => Json;
  /** Renews the approval watch lease `watchApprovals=1` asks for. */
  renew: (server: string) => void;
  snapshot?: (server: string, maxAgeMs: number) => Promise<Json>;
  now?: () => number;
  tickMs?: number;
  refreshMs?: number;
  heartbeatMs?: number;
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
  return function stream(client: OverviewClient, server: string, watchApprovals: boolean) {
    let closed = false, busy = false, first = true;
    let snapshotKey = "", builtAt = 0, sentKey = "", sentAt = 0;
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
          const overview = await options.read(server, held, watchApprovals);
          if (closed) return;
          const { phren: _phren, ...rows } = overview;
          const rowsKey = JSON.stringify(rows);
          if (first || rowsKey !== sentKey) {
            if (send(client, { type: "overview", ...overview })) { sentKey = rowsKey; sentAt = at; }
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
      }
    };
    const timer = setInterval(() => { void tick(); }, tickMs);
    const stop = () => { closed = true; clearInterval(timer); };
    client.once("close", stop);
    client.once("error", stop);
    void tick();
    return { tick, stop };
  };
}
