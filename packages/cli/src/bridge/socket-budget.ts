import type { IncomingMessage } from "node:http";
import { requestPeer } from "./request-origin.js";

/** Sockets one identity may hold per client kind, and in all. */
export const SOCKETS_PER_KIND = 16;
export const SOCKETS_PER_IDENTITY = 32;
/** Every identity together; the backstop if identities themselves multiply. */
export const SOCKETS_TOTAL = 128;

/**
 * Who a WebSocket belongs to, from what the Hook itself trusts rather than a
 * client hint: a peer key's gateway rebuilds its request with `x-phren-origin:
 * peer` and the peer's fingerprint, so that is its own identity; everything
 * else arrives on the owner's local socket or the owner's SSH pipe and is the
 * owner. `x-phren-client` only picks a sub-pool inside the identity.
 */
export function socketIdentity(request: Pick<IncomingMessage, "headers">): string {
  const peer = requestPeer(request);
  return peer ? `peer:${peer.fingerprint}` : "owner";
}

export const socketKind = (request: Pick<IncomingMessage, "headers">): string =>
  request.headers["x-phren-client"] === "desktop" ? "desktop" : "default";

interface Entry<S> { socket: S; identity: string; kind: string }

/** Admits sockets oldest-first under the per-kind, per-identity and total caps. */
export class SocketBudget<S> {
  private readonly entries = new Set<Entry<S>>();
  constructor(private readonly limits = { kind: SOCKETS_PER_KIND, identity: SOCKETS_PER_IDENTITY, total: SOCKETS_TOTAL }) {}

  /** Register a socket; returns the sockets to close to stay inside the caps. */
  add(socket: S, identity: string, kind: string): S[] {
    const entry = { socket, identity, kind };
    this.entries.add(entry);
    const evicted: S[] = [];
    const drop = (match: (e: Entry<S>) => boolean) => {
      const oldest = [...this.entries].find(match);
      if (!oldest) return;
      this.entries.delete(oldest); evicted.push(oldest.socket);
    };
    while ([...this.entries].filter(e => e.identity === identity && e.kind === kind).length > this.limits.kind) drop(e => e.identity === identity && e.kind === kind);
    while ([...this.entries].filter(e => e.identity === identity).length > this.limits.identity) drop(e => e.identity === identity);
    while (this.entries.size > this.limits.total) {
      const counts = new Map<string, number>();
      for (const e of this.entries) counts.set(e.identity, (counts.get(e.identity) ?? 0) + 1);
      // Ties go against a peer identity, so forged peer budgets never push out the owner's own devices first.
      const [heaviest] = [...counts].sort((a, b) => b[1] - a[1] || Number(a[0] === "owner") - Number(b[0] === "owner"))[0];
      drop(e => e.identity === heaviest);
    }
    return evicted;
  }

  remove(socket: S): void {
    for (const e of this.entries) if (e.socket === socket) { this.entries.delete(e); return; }
  }

  count(identity?: string): number {
    return identity === undefined ? this.entries.size : [...this.entries].filter(e => e.identity === identity).length;
  }
}
