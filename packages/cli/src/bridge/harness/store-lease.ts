import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { hookPeers, peerRequest } from "../peers.js";
import { atomicInPrivateDir, bridgeRoot, BridgeError, computerName, targetSchema, type Json } from "../protocol.js";
import { lockedState, readPrivateState } from "./private-state.js";

const authoritySchema = z.object({ version: z.literal(1), storeId: z.string().regex(/^[a-f0-9]{8}$/), computerId: z.string().uuid(), peerName: computerName.optional(), expectedHostKey: z.string().max(200).optional() }).strict();
const holderSchema = z.object({ leaseId: z.string().uuid(), computerId: z.string().uuid(), launchId: z.string().uuid(), createdAt: z.string().datetime(), target: targetSchema.optional() }).strict();
const stateSchema = z.object({ version: z.literal(1), holder: holderSchema.nullable() }).strict();
const configFile = (store: string) => path.join(store, ".config", "harness-lease-authority.json");
const leaseFile = (store: string) => path.join(store, ".runtime", "harness-conductor-lease.json");
async function authority(store: string) { const raw = await readPrivateState(configFile(store)); return raw ? authoritySchema.parse(JSON.parse(raw)) : undefined; }
async function computerId() { return z.string().uuid().parse((await readFile(path.join(bridgeRoot(), "computer-id"), "utf8")).trim()); }
async function localState(store: string) { const raw = await readPrivateState(leaseFile(store)); return raw ? stateSchema.parse(JSON.parse(raw)) : { version: 1 as const, holder: null }; }

/** The authority is fixed by the owner. Sync timestamps, silence and elapsed time never elect a replacement. */
export async function readStoreLease(store: string, requestedStoreId?: string, authoritativeOnly = false): Promise<Json> {
  const config = await authority(store);
  if (!config) return { version: 1, configured: false, noAutomaticFailover: true };
  if (requestedStoreId && requestedStoreId !== config.storeId) throw new BridgeError(409, "The lease belongs to another store.");
  if (config.computerId !== await computerId()) {
    if (authoritativeOnly) throw new BridgeError(409, "This computer is not the store's lease authority.");
    const peer = (await hookPeers()).find(row => row.name === config.peerName && row.hostKey === config.expectedHostKey);
    if (!peer) throw new BridgeError(409, "The store lease authority has no verified peer pin.", { code: "lease-authority-unverified" });
    const view = await peerRequest(peer, "/v1/harness/lease?authority=1&storeId=" + config.storeId);
    if (view.computerId !== config.computerId || view.storeId !== config.storeId || view.configured !== true || view.authoritative !== true) throw new BridgeError(409, "The store lease authority changed.");
    return view;
  }
  return { ...await localState(store), configured: true, authoritative: true, computerId: config.computerId, storeId: config.storeId, noAutomaticFailover: true };
}

export async function configureStoreLease(store: string, input: unknown) {
  const config = authoritySchema.parse({ ...(input as Json), version: 1 });
  if (config.computerId !== await computerId()) {
    const peer = (await hookPeers()).find(row => row.name === config.peerName && row.hostKey === config.expectedHostKey);
    if (!peer) throw new BridgeError(409, "Choose an already verified authority peer and its unchanged pin.");
    const health = await peerRequest(peer, "/v1/health");
    if ((health.computer as Json)?.id !== config.computerId) throw new BridgeError(409, "The authority computer identity changed.");
  }
  return lockedState(configFile(store), async () => {
    const before = await authority(store);
    if (before && JSON.stringify(before) !== JSON.stringify(config)) throw new BridgeError(409, "An existing lease authority cannot be replaced through launch or failover; explicit owner reconciliation is required.");
    await atomicInPrivateDir(configFile(store), config);
    return { ok: true, authority: config };
  });
}

/** Called only after the route verifies a fresh paired-owner signature. */
export async function changeStoreLease(store: string, action: "acquire" | "revoke" | "takeover", input: Json) {
  const config = await authority(store);
  if (!config || config.computerId !== await computerId()) throw new BridgeError(409, "Send this signed owner control to the configured authority computer.");
  const request = z.object({ expectedLeaseId: z.string().uuid().optional(), computerId: z.string().uuid().optional(), launchId: z.string().uuid().optional(), target: targetSchema.optional() }).strict().parse(input);
  return lockedState(leaseFile(store), async () => {
    const state = await localState(store);
    if (action === "acquire" && state.holder) throw new BridgeError(409, "The store already has a conductor lease; only the owner may revoke or take it over.", { holder: state.holder });
    if (action !== "acquire" && (!state.holder || request.expectedLeaseId !== state.holder.leaseId)) throw new BridgeError(409, "The lease changed; refresh before making an owner decision.");
    if (action !== "revoke" && (!request.computerId || !request.launchId)) throw new BridgeError(400, "Name the intended conductor computerId and launchId.");
    state.holder = action === "revoke" ? null : { leaseId: randomUUID(), computerId: request.computerId!, launchId: request.launchId!, createdAt: new Date().toISOString(), ...(request.target ? { target: request.target } : {}) };
    await atomicInPrivateDir(leaseFile(store), state);
    return { ok: true, ...state, noAutomaticFailover: true };
  });
}

export async function requireLaunchLease(store: string, conductor = false, launchId?: string) {
  const view = await readStoreLease(store); // An offline configured authority blocks every new launch.
  if (!conductor) return;
  if (!view.configured) throw new BridgeError(409, "The owner must configure the store lease authority before starting a new conductor.", { code: "lease-authority-required" });
  const holder = holderSchema.nullable().parse(view.holder);
  if (!holder || holder.computerId !== await computerId() || holder.launchId !== launchId) throw new BridgeError(409, "A signed owner lease for this conductor launchId is required.", { code: "conductor-lease-required", holder });
  const admission = path.join(store, ".runtime", "harness-lease-admissions", holder.leaseId + ".json");
  await lockedState(admission, async () => {
    if (await readPrivateState(admission)) throw new BridgeError(409, "This conductor lease was already used; verify the existing launch before an explicit owner decision.");
    // A crash or failed launch leaves this reservation intact. A fresh owner lease is required.
    await atomicInPrivateDir(admission, { launchId, leaseId: holder.leaseId, admittedAt: new Date().toISOString() });
  });
}
