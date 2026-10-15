import type { IncomingMessage } from "node:http";
import type { Json } from "./protocol.js";

/** Owner phone/desktop gateways and the owner's local CLI carry no agent or
 * peer origin. Peer keys are forced through the peer scope, which rebuilds
 * the request with its own origin header; MCP calls carry an agent origin. */
export function ownerRequest(request: Pick<IncomingMessage, "headers">, data: Json): boolean {
  return request.headers?.["x-phren-origin"] === undefined && data.origin === undefined;
}
