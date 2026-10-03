import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { lockedState, readPrivateState } from "./harness/private-state.js";
import { permissionDeniedError } from "../governance/rbac.js";
import { registeredStoreIdentity } from "../store-registry.js";
import { atomicInPrivateDir, bridgeRoot, BridgeError, id, object, provider, serverName } from "./protocol.js";
import { optionalHookPeers, peerRequest } from "./peers.js";
import { phrenStoreRoot } from "./transcripts.js";

const configSchema = z.object({ version: z.literal(1), storeId: z.string().regex(/^[a-f0-9]{8}$/), authorityComputerId: z.string().uuid() }).strict();
const placeSchema = z.object({ server: serverName, pane: id, terminal: z.string().min(1).max(200), source: provider,
  session: z.string().min(1).max(200).optional() }).strict();
const holderSchema = z.object({ computerId: z.string().uuid(), claimId: z.string().uuid(), since: z.string().datetime(), launchId: z.string().uuid().optional(), admitted: z.boolean().optional(), place: placeSchema.optional() }).strict();
const stateSchema = z.object({ version: z.literal(1), storeId: z.string().regex(/^[a-f0-9]{8}$/), authorityComputerId: z.string().uuid(),
  generation: z.number().int().nonnegative(), holder: holderSchema.nullable() }).strict();
type State = z.infer<typeof stateSchema>;
type Config = z.infer<typeof configSchema>;
export type LeaseClaim = z.infer<typeof holderSchema>;
const configFile = (store: string) => path.join(store, ".config", "conductor-authority.json");
const stateFile = (store: string) => path.join(store, ".runtime", "conductor-lease.json");
const claimFile = (store: string) => path.join(store, ".runtime", "conductor-claim.json");

async function readPrivate(file: string): Promise<unknown | undefined> {
  const raw = await readPrivateState(file, 16384);
  return raw === undefined ? undefined : JSON.parse(raw);
}
export async function conductorLeaseConfig(store = phrenStoreRoot()): Promise<Config | undefined> {
  // Synced configuration is public identity data: Git may restore mode 0644.
  // It must still be an owner-controlled, bounded regular file.
  const file = configFile(store);
  const stat = await lstat(file).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!stat) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384 || (stat.mode & 0o022)
    || process.getuid && stat.uid !== process.getuid()) throw new BridgeError(409, "Conductor authority configuration is not owner-controlled.");
  const raw = JSON.parse(await readFile(file, "utf8"));
  const config = configSchema.parse(raw);
  if (config.storeId !== registeredStoreIdentity(store)) throw new BridgeError(409, "Conductor authority belongs to another store identity.");
  return config;
}
export async function localConductorComputerId(): Promise<string> { return z.string().uuid().parse((await readFile(path.join(bridgeRoot(), "computer-id"), "utf8")).trim()); }
function requireOwner(store: string, raw: unknown) {
  if (object(raw).origin !== undefined) throw new BridgeError(403, "Only the owner changes conductor authority or revokes a lease.");
  const denied = permissionDeniedError(store, "manage_config"); if (denied) throw new BridgeError(403, denied);
}
async function authorityPeer(computerId: string) {
  const { peers, peerError } = await optionalHookPeers();
  if (peerError) throw new BridgeError(409, peerError);
  const answers = await Promise.all(peers.map(async peer => {
    try { return object((await peerRequest(peer, "/v1/health", undefined, 8000)).computer).id === computerId ? peer : undefined; }
    catch { return undefined; }
  }));
  const matches = answers.filter(peer => peer !== undefined);
  if (matches.length !== 1) throw new BridgeError(409, "The configured conductor authority is offline, unlinked or ambiguous. New conductor work stays blocked; no timeout failover is inferred.");
  return matches[0];
}

/** One explicit coordinator per immutable store; never elected by timeout or
 * rewritten automatically from a machine-local peer name. Distribute this
 * synced configuration before enabling conductor launches on other machines. */
export async function configureConductorLease(store: string, raw: unknown) {
  requireOwner(store, raw);
  const input = z.object({ authorityComputerId: z.string().uuid(), confirm: z.literal(true) }).strict().parse(raw);
  const storeId = registeredStoreIdentity(store);
  if (!storeId) throw new BridgeError(409, "Register this store's portable identity before configuring conductor authority.");
  if (input.authorityComputerId !== await localConductorComputerId()) await authorityPeer(input.authorityComputerId);
  return lockedState(configFile(store), async () => {
    const existing = await conductorLeaseConfig(store);
    if (existing && existing.authorityComputerId !== input.authorityComputerId) throw new BridgeError(409, "This store already has a fixed conductor authority. Recover that authority; automatic coordinator replacement is unsupported.");
    const config: Config = existing ?? { version: 1, storeId, authorityComputerId: input.authorityComputerId };
    if (!existing) await atomicInPrivateDir(configFile(store), config);
    return { ok: true, config, distributionRequired: true };
  });
}

async function readState(store: string, config: Config): Promise<State> {
  const raw = await readPrivate(stateFile(store));
  const state = raw === undefined ? { ...config, generation: 0, holder: null } : stateSchema.parse(raw);
  if (state.storeId !== config.storeId || state.authorityComputerId !== config.authorityComputerId) throw new BridgeError(409, "Conductor lease identity changed; owner review is required.");
  return state;
}

/** Peer requests may read, consume and bind an already owner-granted reservation.
 * They cannot acquire, release or replace the owner of a store. */
export async function conductorLeaseAuthority(store: string, raw: unknown) {
  const input = z.object({ storeId: z.string().regex(/^[a-f0-9]{8}$/), operation: z.enum(["read", "admit", "bind"]),
    claim: holderSchema.optional(), expectedGeneration: z.number().int().nonnegative().optional() }).strict().parse(raw);
  const config = await conductorLeaseConfig(store);
  if (!config || config.authorityComputerId !== await localConductorComputerId() || input.storeId !== config.storeId) throw new BridgeError(409, "This Hook is not the configured authority for this store.");
  return lockedState(stateFile(store), async () => {
    const state = await readState(store, config);
    if (input.operation === "read") return { ok: true, state };
    const claim = input.claim;
    if (!claim || !state.holder || state.holder.claimId !== claim.claimId
      || state.holder.computerId !== claim.computerId || state.holder.launchId !== claim.launchId
      || state.generation !== input.expectedGeneration) throw new BridgeError(409, "Conductor lease changed since it was reviewed.");
    if (input.operation === "admit") {
      if (state.holder.admitted || state.holder.place) throw new BridgeError(409, "This conductor lease was already used; inspect the existing launch before an owner decision.");
      state.holder = { ...state.holder, admitted: true };
    } else {
      if (!claim.place || !state.holder.admitted || !claim.admitted) throw new BridgeError(409, "The conductor must consume its launch admission before binding a pane.");
      if (state.holder.place) throw new BridgeError(409, "This conductor lease is already bound to a pane.");
      state.holder = { ...state.holder, place: claim.place };
    }
    state.generation++;
    await atomicInPrivateDir(stateFile(store), state);
    return { ok: true, state };
  });
}

/** Called only by a route with fresh paired-owner proof, on the authority. */
export async function changeConductorLease(store: string, action: "acquire" | "revoke" | "takeover", raw: unknown) {
  requireOwner(store, raw);
  const input = z.object({ expectedGeneration: z.number().int().nonnegative(),
    expectedClaimId: z.string().uuid().optional(), computerId: z.string().uuid().optional(),
    launchId: z.string().uuid().optional(), confirm: z.literal(true) }).strict().parse(raw);
  const config = await conductorLeaseConfig(store);
  if (!config || config.authorityComputerId !== await localConductorComputerId()) throw new BridgeError(409, "Send this signed owner control to the configured authority computer.");
  return lockedState(stateFile(store), async () => {
    const state = await readState(store, config);
    if (state.generation !== input.expectedGeneration) throw new BridgeError(409, "The conductor lease changed since review.");
    if (action === "acquire" && state.holder) throw new BridgeError(409, "This store already has a conductor reservation.");
    if (action !== "acquire" && (!state.holder || state.holder.claimId !== input.expectedClaimId)) throw new BridgeError(409, "The conductor lease changed since review.");
    if (action !== "revoke" && (!input.computerId || !input.launchId)) throw new BridgeError(400, "Name the intended conductor computerId and launchId.");
    state.holder = action === "revoke" ? null : { computerId: input.computerId!, launchId: input.launchId!,
      claimId: randomUUID(), since: new Date().toISOString() };
    state.generation++;
    await atomicInPrivateDir(stateFile(store), state);
    return { ok: true, state, existingWorkPreserved: true };
  });
}

async function requestAuthority(store: string, operation: "read" | "admit" | "bind", claim?: LeaseClaim, expectedGeneration?: number): Promise<State> {
  const config = await conductorLeaseConfig(store);
  if (!config) throw new BridgeError(409, "Configure this store's fixed conductor authority before starting or assigning a conductor.");
  const input = { storeId: config.storeId, operation, ...(claim ? { claim } : {}), ...(expectedGeneration === undefined ? {} : { expectedGeneration }) };
  const reply = config.authorityComputerId === await localConductorComputerId() ? await conductorLeaseAuthority(store, input)
    : await peerRequest(await authorityPeer(config.authorityComputerId), "/v1/conductor/lease/authority", input, 15000);
  const state = stateSchema.parse(reply.state);
  if (state.authorityComputerId !== config.authorityComputerId || state.storeId !== config.storeId) throw new BridgeError(409, "Conductor authority replied for a different identity.");
  return state;
}
export async function readConductorLease(store: string) {
  const config = await conductorLeaseConfig(store);
  return { ok: true, config: config ?? null, state: config ? await requestAuthority(store, "read") : null };
}

export async function reserveConductorLease(store = phrenStoreRoot(), launchId?: string): Promise<LeaseClaim> {
  const state = await requestAuthority(store, "read"), claim = state.holder;
  if (!claim || !launchId || claim.launchId !== launchId || claim.computerId !== await localConductorComputerId()) {
    throw new BridgeError(409, "A signed owner lease for this conductor launchId is required.");
  }
  // Consume at the fixed authority, not just this checkout: two copies of
  // one registered store on a computer must not admit the same grant twice.
  const admitted = (await requestAuthority(store, "admit", claim, state.generation)).holder!;
  const admission = path.join(store, ".runtime", "conductor-admissions", claim.claimId + ".json");
  await lockedState(admission, async () => {
    if (await readPrivate(admission)) throw new BridgeError(409, "This conductor lease was already used; inspect the existing launch before an owner decision.");
    // A lost response, failed launch or crash retains the reservation.
    await atomicInPrivateDir(admission, { claimId: claim.claimId, launchId, admittedAt: new Date().toISOString() });
    await atomicInPrivateDir(claimFile(store), admitted);
  });
  return admitted;
}
export async function bindConductorLease(claim: LeaseClaim, place: z.infer<typeof placeSchema>, store = phrenStoreRoot()) {
  const state = await requestAuthority(store, "read");
  const bound = { ...claim, place: placeSchema.parse(place) };
  await requestAuthority(store, "bind", bound, state.generation);
  await atomicInPrivateDir(claimFile(store), bound);
}
export async function revokeConductorLease(store: string, raw: unknown) {
  requireOwner(store, raw);
  const input = z.object({ expectedGeneration: z.number().int().nonnegative(), holder: holderSchema, confirm: z.literal(true) }).strict().parse(raw);
  const state = await requestAuthority(store, "read");
  if (JSON.stringify(state.holder) !== JSON.stringify(input.holder) || state.generation !== input.expectedGeneration) throw new BridgeError(409, "The exact conductor identity changed since review.");
  return changeConductorLease(store, "revoke", { expectedGeneration: input.expectedGeneration, expectedClaimId: input.holder.claimId, confirm: true });
}
export async function requireConductorLease(place: { server: string; pane: string; terminal?: string; source?: string }, store = phrenStoreRoot()) {
  // Existing conductors keep their work during deliberate configuration migration.
  if (!await conductorLeaseConfig(store)) return;
  const claim = holderSchema.parse(await readPrivate(claimFile(store)));
  const state = await requestAuthority(store, "read");
  if (state.holder?.claimId !== claim.claimId || state.holder.computerId !== await localConductorComputerId()
    || state.holder.place?.server !== place.server || state.holder.place?.pane !== place.pane
    || state.holder.place.terminal !== place.terminal || state.holder.place.source !== place.source) throw new BridgeError(409, "This conductor no longer holds the store lease. Existing work is preserved; new dispatches are blocked.");
}
