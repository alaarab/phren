import { z } from "zod";
import { BridgeError, type Json } from "../protocol.js";
import { registeredStoreIdentity } from "../../store-registry.js";
import { conductorLeaseConfig, configureConductorLease, readConductorLease, changeConductorLease,
  localConductorComputerId, reserveConductorLease } from "../conductor-lease.js";

// Compatibility surface over the one canonical conductor authority and ledger.
// Harness adapters must never create their own independent lease file.
export async function readStoreLease(store: string, requestedStoreId?: string, authoritativeOnly = false): Promise<Json> {
  const config = await conductorLeaseConfig(store);
  if (!config) return { version: 1, configured: false, noAutomaticFailover: true };
  if (requestedStoreId && requestedStoreId !== config.storeId) throw new BridgeError(409, "The lease belongs to another store.");
  if (authoritativeOnly && config.authorityComputerId !== await localConductorComputerId()) throw new BridgeError(409, "This computer is not the store's lease authority.");
  const { state } = await readConductorLease(store);
  const holder = state?.holder;
  return { version: 1, configured: true, authoritative: true, computerId: config.authorityComputerId,
    storeId: config.storeId, generation: state!.generation, noAutomaticFailover: true,
    holder: holder ? { leaseId: holder.claimId, computerId: holder.computerId, launchId: holder.launchId,
      createdAt: holder.since, admitted: holder.admitted, ...(holder.place ? { place: holder.place } : {}) } : null };
}

export async function configureStoreLease(store: string, input: unknown) {
  const data = z.object({ storeId: z.string().regex(/^[a-f0-9]{8}$/), computerId: z.string().uuid() }).strict().parse(input);
  if (registeredStoreIdentity(store) !== data.storeId) throw new BridgeError(409, "The authority belongs to another registered store identity.");
  return configureConductorLease(store, { authorityComputerId: data.computerId, confirm: true });
}

/** The routing layer verifies fresh paired-owner proof before every mutation. */
export async function changeStoreLease(store: string, action: "acquire" | "revoke" | "takeover", input: Json) {
  const request = z.object({ expectedLeaseId: z.string().uuid().optional(), expectedGeneration: z.number().int().nonnegative(),
    computerId: z.string().uuid().optional(), launchId: z.string().uuid().optional() }).strict().parse(input);
  const changed = await changeConductorLease(store, action, { expectedGeneration: request.expectedGeneration,
    expectedClaimId: request.expectedLeaseId, computerId: request.computerId, launchId: request.launchId, confirm: true });
  return { ok: true, ...await readStoreLease(store), existingWorkPreserved: changed.existingWorkPreserved };
}

export async function requireLaunchLease(store: string, conductor = false, launchId?: string) {
  await readConductorLease(store); // A configured offline authority blocks every new launch.
  if (conductor) await reserveConductorLease(store, launchId);
}
