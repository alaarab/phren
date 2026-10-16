import type { IncomingMessage } from "node:http";
import type { Json } from "./protocol.js";

/** Owner phone/desktop gateways and the owner's local CLI carry no agent or
 * peer origin. Peer keys are forced through the peer scope, which rebuilds
 * the request with its own origin header; MCP calls carry an agent origin. */
export function ownerRequest(request: Pick<IncomingMessage, "headers">, data: Json): boolean {
  return request.headers?.["x-phren-origin"] === undefined && data.origin === undefined;
}

export interface PeerIdentity { name?: string; id?: string; fingerprint: string }
export function requestPeer(request: Pick<IncomingMessage, "headers">): PeerIdentity | undefined {
  if (request.headers?.["x-phren-origin"] !== "peer") return undefined;
  const encoded = request.headers?.["x-phren-peer"];
  if (typeof encoded !== "string") return undefined;
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!/^[a-f0-9]{64}$/.test(value.fingerprint) || value.id !== undefined && !/^[a-f0-9-]{36}$/i.test(value.id)) return undefined;
    if (value.name !== undefined && (typeof value.name !== "string" || !/^[A-Za-z0-9_.-]{1,253}$/.test(value.name))) return undefined;
    if (value.name === undefined && value.id === undefined) return undefined;
    return { ...(value.name ? { name: value.name } : {}), ...(value.id ? { id: value.id } : {}), fingerprint: value.fingerprint };
  } catch { return undefined; }
}
