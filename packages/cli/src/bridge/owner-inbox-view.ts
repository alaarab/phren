import { BridgeError, type Json, objects } from "./protocol.js";
import { hookPeers, peerRequest } from "./peers.js";
import { ownerInboxSchema, type OwnerInbox } from "./owner-inbox.js";
import { isLocalComputer } from "./dispatch-hosts.js";

/** Aggregate each Hook's own inbox once, without recursively listing peers.
 * inboxComputer identifies the Hook to send a resolution to; computer on a
 * dispatch row names the worker and can be a different computer. */
export async function ownerInboxView(inbox: OwnerInbox, input: unknown, localOnly = false): Promise<Json> {
  const data = ownerInboxSchema.parse(input);
  const { computer, ...local } = data;
  const peers = await hookPeers().catch(() => []);
  if (computer && computer !== "local" && !isLocalComputer(computer)) {
    const peer = peers.find(peer => peer.name === computer);
    if (!peer) throw new BridgeError(404, "That inbox computer is not linked.");
    return peerRequest(peer, "/v1/owner-inbox", local);
  }
  const result = await inbox.run(local);
  if (data.action !== "list" || localOnly) return result;
  const items = objects(result.items).map(item => ({ ...item, inboxComputer: "local" })), unreachable: Json[] = [];
  await Promise.all(peers.map(async peer => {
    try {
      const view = await peerRequest(peer, `/v1/owner-inbox?local=1${data.includeResolved ? "&includeResolved=true" : ""}`);
      items.push(...objects(view.items).map(item => ({ ...item, inboxComputer: peer.name })));
    } catch (error) { unreachable.push({ computer: peer.name, error: error instanceof Error ? error.message : "Unreachable." }); }
  }));
  return { ok: true, items, unreachable };
}
