import { connect } from "node:net";
import { BridgeError } from "./protocol.js";
import type { HookPeer } from "./peers.js";

/**
 * Which peers did not answer, kept in memory by this process. Every peer request reports its outcome here;
 * only reads that poll or fan out (`peerRead`) act on it, so a dispatch, a hand-off or a link still dials.
 *
 * A peer that is off waits out its whole SSH timeout on every request. One linked computer asleep made
 * `/v1/sets` take 12 s and `/v1/computers` 8 s on each of the others (2026-11-19), every time the phone read
 * them. Once a peer is known to be off, reads answer with its last error at once until the wait is over:
 * `PEER_RETRY_FIRST_MS`, doubling per failed check to `PEER_RETRY_MAX_MS`. After the wait, one TCP connect to
 * its SSH port (no login) decides whether the next read dials. Any answer from its Hook forgets it.
 */
export const PEER_RETRY_FIRST_MS = 5_000;
export const PEER_RETRY_MAX_MS = 120_000;
/** How long a read waits on the TCP check once the wait is over: a peer that is back answers in milliseconds. */
const RECHECK_WAIT_MS = 300;
/** How long the TCP check itself runs: long enough for a second SYN over a relayed path. */
const RECHECK_TIMEOUT_MS = 2_500;

interface Offline {
  failures: number;
  retryAt: number;
  error: BridgeError;
  /** The TCP check in flight, shared by every read that arrives while it runs. */
  recheck?: Promise<boolean>;
  /** The SSH port answered: the next read dials, and its outcome decides. */
  open?: boolean;
}

const offline = new Map<string, Offline>();
const classifying = new Set<string>();

/** Reachability is the host and port's; two entries for one address share it. */
const endpoint = (peer: Pick<HookPeer, "address" | "port">) => `${peer.address.toLowerCase()}:${peer.port}`;
const wait = (failures: number) => Math.min(PEER_RETRY_FIRST_MS * 2 ** Math.max(0, failures - 1), PEER_RETRY_MAX_MS);
const copy = (error: BridgeError) => new BridgeError(error.status, error.message, error.details ? { ...error.details } : undefined);

function tcpReachable(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host, port });
    const done = (reachable: boolean) => { clearTimeout(timer); socket.destroy(); resolve(reachable); };
    const timer = setTimeout(() => done(false), timeoutMs);
    timer.unref(); socket.unref();
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** SSH could not reach the peer. Failures inside a running wait are the same outage and do not lengthen it. */
export function peerDidNotAnswer(peer: HookPeer, error: BridgeError, now = Date.now()): void {
  const key = endpoint(peer), seen = offline.get(key);
  if (seen && !seen.open && now < seen.retryAt) { seen.error = error; return; }
  const failures = (seen?.failures ?? 0) + 1;
  offline.set(key, { failures, retryAt: now + wait(failures), error });
}

/** Its Hook answered (with a result or with its own error). */
export function peerAnswered(peer: HookPeer): void { offline.delete(endpoint(peer)); }

/**
 * Our own wait ran out with no word from ssh, which says nothing about the peer: a slow report on a healthy
 * Hook ends the same way. A TCP connect to its SSH port tells the two apart, in the background.
 */
export function peerTimedOut(peer: HookPeer, offlineError: () => BridgeError): void {
  const key = endpoint(peer), seen = offline.get(key);
  if (classifying.has(key) || (seen && !seen.open && Date.now() < seen.retryAt)) return;
  classifying.add(key);
  void tcpReachable(peer.address, peer.port, RECHECK_TIMEOUT_MS).then(reachable => {
    if (!reachable) peerDidNotAnswer(peer, offlineError());
  }, () => undefined).finally(() => { classifying.delete(key); });
}

/**
 * The error a read of this peer should answer with instead of dialing, or nothing when it should dial.
 * Inside the wait: at once. After it: the TCP check runs (once, however many reads arrive) and the read gives
 * it `RECHECK_WAIT_MS`; a peer still off answers with the remembered error and a doubled wait.
 */
export async function knownOffline(peer: HookPeer, now = Date.now()): Promise<BridgeError | undefined> {
  const key = endpoint(peer), seen = offline.get(key);
  if (!seen || seen.open) return undefined;
  if (now >= seen.retryAt && !seen.recheck) {
    seen.recheck = tcpReachable(peer.address, peer.port, RECHECK_TIMEOUT_MS).catch(() => false).then(reachable => {
      seen.recheck = undefined;
      if (offline.get(key) !== seen) return reachable;
      if (reachable) seen.open = true;
      else { seen.failures++; seen.retryAt = Date.now() + wait(seen.failures); }
      return reachable;
    });
  }
  if (seen.recheck) {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), RECHECK_WAIT_MS); timer.unref(); });
    try { if (await Promise.race([seen.recheck, late])) return undefined; } finally { clearTimeout(timer); }
  }
  return copy(seen.error);
}

/** An explicit refresh: every peer is dialed again on its next read. */
export function forgetOfflinePeers(): void { offline.clear(); }
