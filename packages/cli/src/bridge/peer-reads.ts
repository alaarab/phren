import { countPeer } from "./metrics.js";
import { forgetOfflinePeers, knownOffline } from "./peer-reach.js";
import { peerRequest, type HookPeer } from "./peers.js";
import type { Json } from "./protocol.js";

/**
 * Peer reads that poll or fan out: the phone's `/v1/sets`, `/v1/computers`, `/v1/owner-inbox`, health details
 * and the `?peers=1` reports. Each used to be one SSH login per peer per request. The phone reads them from
 * every linked computer at once, so six computers made dozens of logins on each other within seconds, and one
 * computer that was off held every one of those reads for its full timeout.
 *
 * - A peer known to be off answers with its last error at once (peer-reach.ts).
 * - Reads of the same route on the same peer share one login while it runs.
 * - With `ttl`, an answer is reused for that long; with `failTtl`, so is an error (for a read the caller can do without).
 *
 * A write through this Hook to a peer (`peerRequest` with a body) is not tracked here, so keep `ttl` at 0
 * for anything the owner changes and reads straight back.
 */
export const PEER_READ_TTL_MS = 5_000;
/** Kept answers past this are dropped oldest first; routes are the Hook's own, so this is never reached in practice. */
const MAX_KEPT = 256;

interface Flight { answer: Promise<Json>; deadline: number }
const flights = new Map<string, Flight>();
interface Kept { answer?: Json; error?: unknown; at: number }
const kept = new Map<string, Kept>();

export interface PeerReadOptions {
  /** As for `peerRequest`: 15 s when absent. */
  timeout?: number;
  /** How long an answer may be reused. 0 (the default) shares only a login that is still running. */
  ttl?: number;
  /** How long a failure is answered again without a login. 0 (the default) keeps none. */
  failTtl?: number;
}

export async function peerRead(peer: HookPeer, route: string, options: PeerReadOptions = {}): Promise<Json> {
  const timeout = options.timeout ?? 15_000, ttl = options.ttl ?? 0, failTtl = options.failTtl ?? 0, now = Date.now();
  const key = `${peer.username}@${peer.address}:${peer.port}\n${route}`;
  const hit = kept.get(key);
  // Each reader's own `ttl` decides, so a short-lived read never takes an answer a long-lived one kept.
  if (hit && now - hit.at < (hit.answer ? ttl : failTtl)) {
    countPeer("saved.cached");
    if (!hit.answer) throw hit.error;
    return structuredClone(hit.answer);
  }
  // A read joins a login that will answer within its own wait. One with less time than the running read has
  // left dials for itself, as it did before.
  const running = flights.get(key);
  if (running && running.deadline <= now + timeout) { countPeer("saved.shared"); return structuredClone(await running.answer); }
  // Registered before anything is awaited, so reads arriving together find it.
  const flight: Flight = { deadline: now + timeout, answer: (async () => {
    const off = await knownOffline(peer, now);
    if (off) { countPeer("saved.offline"); throw off; }
    // Called as the caller would have: no timeout of its own means `peerRequest`'s default.
    return options.timeout === undefined ? peerRequest(peer, route) : peerRequest(peer, route, undefined, timeout);
  })() };
  flights.set(key, flight);
  try {
    const answer = await flight.answer;
    if (ttl > 0) keep(key, { answer, at: Date.now() });
    else kept.delete(key);
    return structuredClone(answer);
  } catch (error) {
    if (failTtl > 0) keep(key, { error, at: Date.now() });
    else kept.delete(key);
    throw error;
  } finally {
    if (flights.get(key) === flight) flights.delete(key);
  }
}

function keep(key: string, entry: Kept): void {
  if (!kept.has(key) && kept.size >= MAX_KEPT) kept.delete(kept.keys().next().value!);
  kept.set(key, entry);
}

/** `peerRead` in the shape of `peerRequest`, for callers that take either. A body is a write and always dials. */
export function peerReader(ttl = 0): typeof peerRequest {
  return (peer, route, data, timeout) => data === undefined ? peerRead(peer, route, { ...(timeout === undefined ? {} : { timeout }), ttl }) : peerRequest(peer, route, data, timeout);
}

/** An explicit refresh (`?refresh=1`): kept answers and the memory of which peers are off are dropped. */
export function refreshPeerReads(): void { kept.clear(); forgetOfflinePeers(); }
