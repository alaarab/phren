import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { tryFileLock } from "../governance/locks.js";
import { permissionDeniedError } from "../governance/rbac.js";
import { registeredStoreIdentity } from "../store-registry.js";
import { atomicInPrivateDir, bridgeRoot, BridgeError, id, object, objects, provider, serverName, targetSchema } from "./protocol.js";
import { optionalHookPeers, peerRequest } from "./peers.js";
import { phrenStoreRoot } from "./transcripts.js";

const configSchema = z.object({ version: z.literal(1), storeId: z.string().regex(/^[a-f0-9]{8}$/), authorityComputerId: z.string().uuid() }).strict();
const placeSchema = z.object({ server: serverName, pane: id, terminal: z.string().min(1).max(200), source: provider,
  session: z.string().min(1).max(200).optional() }).strict();
const holderSchema = z.object({ computerId: z.string().uuid(), claimId: z.string().uuid(), since: z.string().datetime(), place: placeSchema.optional() }).strict();
const stateSchema = z.object({ version: z.literal(1), storeId: z.string().regex(/^[a-f0-9]{8}$/), authorityComputerId: z.string().uuid(),
  generation: z.number().int().nonnegative(), holder: holderSchema.nullable() }).strict();
type State = z.infer<typeof stateSchema>;
type Config = z.infer<typeof configSchema>;
export type LeaseClaim = z.infer<typeof holderSchema>;
const configFile = (store: string) => path.join(store, ".config", "conductor-authority.json");
const stateFile = (store: string) => path.join(store, ".runtime", "conductor-lease.json");
const claimFile = (store: string) => path.join(store, ".runtime", "conductor-claim.json");
const sameHolder = (left: LeaseClaim | null, right: LeaseClaim) => left !== null && JSON.stringify(holderSchema.parse(left)) === JSON.stringify(holderSchema.parse(right));

async function readPrivate(file: string): Promise<unknown | undefined> {
  const stat = await lstat(file).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!stat) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new BridgeError(409, "Conductor lease data is not a bounded regular file.");
  return JSON.parse(await readFile(file, "utf8"));
}
export async function conductorLeaseConfig(store = phrenStoreRoot()): Promise<Config | undefined> {
  const raw = await readPrivate(configFile(store));
  if (raw === undefined) return undefined;
  const config = configSchema.parse(raw);
  if (config.storeId !== registeredStoreIdentity(store)) throw new BridgeError(409, "Conductor authority belongs to another store identity.");
  return config;
}
async function localId(): Promise<string> { return z.string().uuid().parse((await readFile(path.join(bridgeRoot(), "computer-id"), "utf8")).trim()); }
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
  if (input.authorityComputerId !== await localId()) await authorityPeer(input.authorityComputerId);
  const release = tryFileLock(configFile(store)); if (!release) throw new BridgeError(409, "Conductor authority is being configured.");
  try {
    const existing = await conductorLeaseConfig(store);
    if (existing && existing.authorityComputerId !== input.authorityComputerId) throw new BridgeError(409, "This store already has a fixed conductor authority. Recover that authority; automatic coordinator replacement is unsupported.");
    const config: Config = existing ?? { version: 1, storeId, authorityComputerId: input.authorityComputerId };
    if (!existing) await atomicInPrivateDir(configFile(store), config);
    return { ok: true, config, distributionRequired: true };
  } finally { release(); }
}

async function readState(store: string, config: Config): Promise<State> {
  const raw = await readPrivate(stateFile(store));
  const state = raw === undefined ? { ...config, generation: 0, holder: null } : stateSchema.parse(raw);
  if (state.storeId !== config.storeId || state.authorityComputerId !== config.authorityComputerId) throw new BridgeError(409, "Conductor lease identity changed; owner review is required.");
  return state;
}

/** Called only on the configured authority, through the existing authenticated
 * Hook transport. A lost reply never frees a reservation or starts a second one. */
export async function conductorLeaseAuthority(store: string, raw: unknown) {
  if (["release", "takeover"].includes(String(object(raw).operation))) requireOwner(store, raw);
  const input = z.object({ storeId: z.string().regex(/^[a-f0-9]{8}$/), operation: z.enum(["read", "claim", "bind", "release", "takeover"]),
    claim: holderSchema.optional(), expectedHolder: holderSchema.optional(), expectedGeneration: z.number().int().nonnegative().optional(),
    ownerConfirmedRelease: z.literal(true).optional(), ownerConfirmedTakeover: z.literal(true).optional() }).strict().parse(raw);
  if (input.operation === "release" && input.ownerConfirmedRelease !== true) throw new BridgeError(403, "Lease release requires an explicit owner decision.");
  if (input.operation === "takeover" && input.ownerConfirmedTakeover !== true) throw new BridgeError(403, "Lease takeover requires an explicit owner decision.");
  const config = await conductorLeaseConfig(store);
  if (!config || config.authorityComputerId !== await localId() || input.storeId !== config.storeId) throw new BridgeError(409, "This Hook is not the configured authority for this store.");
  const release = tryFileLock(stateFile(store)); if (!release) throw new BridgeError(409, "Conductor lease is being updated; read its current identity before retrying.");
  try {
    const state = await readState(store, config);
    if (input.operation === "read") return { ok: true, state };
    const claim = input.claim;
    if (!claim) throw new BridgeError(400, "A complete conductor claim is required.");
    const same = state.holder?.claimId === claim.claimId && state.holder?.computerId === claim.computerId;
    if (input.operation === "claim") {
      if (same) return { ok: true, state };
      if (state.holder) throw new BridgeError(409, "This store already has a conductor reservation. An offline holder keeps it until explicit owner revocation.", { lease: state });
      state.holder = claim;
    } else if (input.operation === "takeover") {
      if (!input.expectedHolder || !sameHolder(state.holder, input.expectedHolder) || input.expectedGeneration !== state.generation) {
        throw new BridgeError(409, "The exact conductor identity changed since review.", { lease: state });
      }
      if (!claim.place?.session || !targetSchema.shape.session.safeParse(claim.place.session).success
        || !["claude", "codex", "opencode"].includes(claim.place.source) || claim.claimId === state.holder?.claimId) {
        throw new BridgeError(400, "Takeover requires a distinct claim for an identified replacement conductor session.");
      }
      state.holder = claim;
    } else {
      if (!same || input.expectedGeneration !== state.generation) throw new BridgeError(409, "Conductor lease changed since it was reviewed.", { lease: state });
      if (input.operation === "bind") {
        if (!claim.place) throw new BridgeError(400, "Binding requires the exact conductor pane identity.");
        state.holder = { ...state.holder!, place: claim.place };
      } else {
        if (!sameHolder(state.holder, claim)) throw new BridgeError(409, "The exact conductor identity changed since review.", { lease: state });
        state.holder = null;
      }
    }
    state.generation++;
    await atomicInPrivateDir(stateFile(store), state);
    return { ok: true, state };
  } finally { release(); }
}

async function requestAuthority(store: string, operation: "read" | "claim" | "bind" | "release" | "takeover", claim?: LeaseClaim, expectedGeneration?: number, expectedHolder?: LeaseClaim): Promise<State> {
  const config = await conductorLeaseConfig(store);
  if (!config) throw new BridgeError(409, "Configure this store's fixed conductor authority before starting or assigning a conductor.");
  const input = { storeId: config.storeId, operation, ...(operation === "release" ? { ownerConfirmedRelease: true as const } : {}),
    ...(operation === "takeover" ? { ownerConfirmedTakeover: true as const } : {}), ...(expectedHolder ? { expectedHolder } : {}),
    ...(claim ? { claim } : {}), ...(expectedGeneration === undefined ? {} : { expectedGeneration }) };
  const reply = config.authorityComputerId === await localId() ? await conductorLeaseAuthority(store, input)
    : await peerRequest(await authorityPeer(config.authorityComputerId), "/v1/conductor/lease/authority", input, 15000);
  const state = stateSchema.parse(reply.state);
  if (state.authorityComputerId !== config.authorityComputerId || state.storeId !== config.storeId) throw new BridgeError(409, "Conductor authority replied for a different identity.");
  return state;
}
export async function readConductorLease(store: string) {
  const config = await conductorLeaseConfig(store);
  return { ok: true, config: config ?? null, state: config ? await requestAuthority(store, "read") : null };
}

export async function reserveConductorLease(store = phrenStoreRoot()): Promise<LeaseClaim> {
  const state = await requestAuthority(store, "read");
  if (state.holder) throw new BridgeError(409, "This store already has a conductor reservation. Review its exact identity before explicit owner revocation.", { lease: state });
  const claim: LeaseClaim = { computerId: await localId(), claimId: randomUUID(), since: new Date().toISOString() };
  // Save before sending: a timeout leaves evidence of the uncertain reservation.
  await atomicInPrivateDir(claimFile(store), claim);
  await requestAuthority(store, "claim", claim);
  return claim;
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
  if (!sameHolder(state.holder, input.holder) || state.generation !== input.expectedGeneration) throw new BridgeError(409, "The exact conductor identity changed since review.");
  return { ok: true, state: await requestAuthority(store, "release", input.holder, input.expectedGeneration), existingWorkPreserved: true };
}

/** Explicit transfer to an already running local session. Review includes both
 * identities; it neither launches a process nor stops the previous holder. */
export async function takeoverConductorLease(store: string, raw: unknown) {
  requireOwner(store, raw);
  const input = z.object({ expectedGeneration: z.number().int().nonnegative(), holder: holderSchema,
    newHolder: z.object({ computerId: z.string().uuid(), target: targetSchema, terminal: z.string().min(1).max(200) }).strict(),
    confirm: z.literal(true) }).strict().parse(raw);
  if (input.newHolder.computerId !== await localId()) throw new BridgeError(409, "Confirm takeover on the replacement computer's authenticated Hook.");
  const { target, terminal } = input.newHolder;
  if (!["claude", "codex", "opencode"].includes(target.source)) throw new BridgeError(400, "The selected harness cannot run as a conductor.");
  const { snapshot, paneIdentity } = await import("./herdr.js");
  const { runsAgent, recordConductor } = await import("./conductor-role.js");
  const checkedPane = async () => {
    const pane = objects((await snapshot(target.server)).panes).find(row => row.pane_id === target.pane
      && row.workspace_id === target.workspace && row.tab_id === target.tab && row.terminal_id === terminal && row.agent === target.source);
    if (!runsAgent(pane) || await paneIdentity(target.server, pane, true) !== target.session) throw new BridgeError(409, "The reviewed replacement session changed; no inferred target is allowed.");
    return pane;
  };
  await checkedPane();
  const claim: LeaseClaim = { computerId: input.newHolder.computerId, claimId: randomUUID(), since: new Date().toISOString(),
    place: { server: target.server, pane: target.pane, terminal, source: target.source, session: target.session } };
  // Keep the reviewed identities even if the authority's response is lost.
  // Existing local claim evidence is not replaced until transfer is confirmed.
  await atomicInPrivateDir(path.join(store, ".runtime", "conductor-takeovers", `${claim.claimId}.json`), { ...input, claim });
  const state = await requestAuthority(store, "takeover", claim, input.expectedGeneration, input.holder);
  try {
    await atomicInPrivateDir(claimFile(store), claim);
    const pane = await checkedPane();
    await recordConductor(target.server, pane, "owner", target.session);
  } catch {
    throw new BridgeError(409, "Lease transferred, but the replacement role could not be confirmed. Read the lease and review it explicitly; existing work is preserved and no automatic retry or release occurred.", { lease: state, transferred: true, existingWorkPreserved: true });
  }
  return { ok: true, state, previousHolder: input.holder, existingWorkPreserved: true, launched: false };
}
export async function requireConductorLease(place: { server: string; pane: string; terminal?: string; source?: string }, store = phrenStoreRoot()) {
  // Existing conductors keep their work during deliberate configuration migration.
  if (!await conductorLeaseConfig(store)) return;
  const claim = holderSchema.parse(await readPrivate(claimFile(store)));
  const state = await requestAuthority(store, "read");
  if (state.holder?.claimId !== claim.claimId || state.holder.computerId !== await localId()
    || state.holder.place?.server !== place.server || state.holder.place?.pane !== place.pane
    || state.holder.place.terminal !== place.terminal || state.holder.place.source !== place.source) throw new BridgeError(409, "This conductor no longer holds the store lease. Existing work is preserved; new dispatches are blocked.");
}
