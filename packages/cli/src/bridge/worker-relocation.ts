import { hookRequest } from "./client.js";
import { dispatchStatus } from "./dispatch.js";
import { optionalHookPeers, peerRequest } from "./peers.js";
import { BridgeError, object, type Json, type Target } from "./protocol.js";

/** A worker may only change the receipt protocol after its dispatcher has
 * acknowledged that exact worker. Aliases are never used as identities. */
export async function preflightWorkerRelocation(dispatch: string, target: Target): Promise<void> {
  const query = `/v1/dispatch/relocation?id=${encodeURIComponent(dispatch)}&session=${encodeURIComponent(target.session)}`;
  const { peers } = await optionalHookPeers();
  const probes = [
    async () => ({ health: await hookRequest("/v1/health", undefined, undefined, 5_000), known: await hookRequest(query, undefined, undefined, 5_000) }),
    ...peers.map(peer => async () => ({ health: await peerRequest(peer, "/v1/health", undefined, 5_000), known: await peerRequest(peer, query, undefined, 5_000) })),
  ];
  const answers = await Promise.all(probes.map(probe => probe().catch(() => undefined)));
  const dispatchers = answers.filter(answer => answer?.known.known === true && object(answer.health.capabilities).workerRelocation === 1);
  if (dispatchers.length !== 1) throw new BridgeError(409, "Update the dispatching computer's Phren Hook first");
}

export async function relocationSupport(id: string, session: string): Promise<Json> {
  const known = (await dispatchStatus()).some(receipt => (receipt.id === id || receipt.moves?.some(move => move.id === id)) && receipt.target && "session" in receipt.target && receipt.target.session === session);
  return { known, workerRelocation: 1 };
}
