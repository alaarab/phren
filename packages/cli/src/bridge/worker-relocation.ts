import { continuationPlacement } from "./continuation-launch.js";
import { hookRequest } from "./client.js";
import { dispatchStatus } from "./dispatch.js";
import { optionalHookPeers, peerRequest } from "./peers.js";
import { BridgeError, object, type Json, type Target } from "./protocol.js";

/** Carry the original receipt id so its dispatcher can prove compatibility
 * even before its next poll observes the new session. Aliases have no authority. */
export async function preflightWorkerRelocation(dispatch: string, target: Target): Promise<string> {
  const original = (await continuationPlacement(dispatch))?.workerDispatch ?? dispatch;
  const query = `/v1/dispatch/relocation?id=${encodeURIComponent(original)}&session=${encodeURIComponent(target.session)}`;
  const { peers } = await optionalHookPeers();
  const probes = [
    async () => ({ health: await hookRequest("/v1/health", undefined, undefined, 5_000), known: await hookRequest(query, undefined, undefined, 5_000) }),
    ...peers.map(peer => async () => ({ health: await peerRequest(peer, "/v1/health", undefined, 5_000), known: await peerRequest(peer, query, undefined, 5_000) })),
  ];
  const answers = await Promise.all(probes.map(probe => probe().catch(() => undefined)));
  const ownsReceipt = (answer: NonNullable<typeof answers[number]>) => answer.known.known === true || answer.known.knownDispatch === true;
  const dispatchers = answers.filter(answer => answer && ownsReceipt(answer) && object(answer.health.capabilities).workerRelocation === 1);
  const incompatibleDispatcher = answers.some(answer => answer && ownsReceipt(answer) && object(answer.health.capabilities).workerRelocation !== 1);
  if (dispatchers.length !== 1 || incompatibleDispatcher) throw new BridgeError(409, "Update the dispatching computer's Phren Hook first");
  return original;
}

export async function relocationSupport(id: string, session: string): Promise<Json> {
  const receipts = await dispatchStatus();
  const matched = receipts.filter(receipt => receipt.id === id || receipt.moves?.some(move => move.id === id));
  const known = matched.some(receipt => receipt.target && "session" in receipt.target && receipt.target.session === session);
  // A source move is durable before a worker's receiving Hook may use its id.
  // This also repairs moves launched before workerDispatch was serialized.
  const moved = matched.length ? undefined : await (await import("./session-move.js")).readMove(id).catch(() => undefined);
  const knownDispatch = matched.length > 0 || !!moved?.dispatch && receipts.some(receipt => receipt.id === moved.dispatch) && moved.target && "session" in moved.target && moved.target.session === session;
  return { known, knownDispatch: !!knownDispatch, workerRelocation: 1 };
}
