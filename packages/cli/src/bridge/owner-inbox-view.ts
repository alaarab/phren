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
  const items: Json[] = objects(result.items).map(item => ({ ...item, inboxComputer: "local" })), unreachable: Json[] = [];
  await Promise.all(peers.map(async peer => {
    try {
      const view = await peerRequest(peer, `/v1/owner-inbox?local=1${data.includeResolved ? "&includeResolved=true" : ""}`);
      items.push(...objects(view.items).map(item => ({ ...item, inboxComputer: peer.name })));
    } catch (error) { unreachable.push({ computer: peer.name, error: error instanceof Error ? error.message : "Unreachable." }); }
  }));
  // Older peers can still send stale automatic rows during a rolling upgrade.
  // A dispatching Hook and the worker's Hook may also describe the same ask.
  const seen = new Set<string>();
  const current = items.filter(item => {
    if (data.includeResolved || item.kind === "manual") return true;
    if (item.live !== true || item.state !== "open") return false;
    const t = item.target as Json | undefined;
    if (!t) return true;
    const computer = String(item.computer ?? item.inboxComputer);
    const key = JSON.stringify([isLocalComputer(computer) ? "local" : computer, t.server, t.workspace, t.tab, t.pane,
      t.source, t.session ?? t.startingToken, item.actionId ?? "waiting"]);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  return { ok: true, items: current, unreachable };
}
