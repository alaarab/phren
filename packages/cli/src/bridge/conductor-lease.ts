import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import type { IncomingHttpHeaders } from "node:http";
import { z } from "zod";
import { tryFileLock } from "../governance/locks.js";
import { permissionDeniedError } from "../governance/rbac.js";
import { registeredStoreIdentity } from "../store-registry.js";
import { atomicInPrivateDir, bridgeRoot, BridgeError, id, object, provider, serverName, type Json } from "./protocol.js";
import { optionalHookPeers, peerRequest } from "./peers.js";
import { phrenStoreRoot } from "./transcripts.js";
import { findPane, paneIdentity, snapshot } from "./herdr.js";
import { recordConductor, runsAgent } from "./conductor-role.js";
import { requireOwnerControl } from "./harness/owner-controls.js";

const configSchema = z.object({ version: z.literal(1), storeId: z.string().regex(/^[a-f0-9]{8}$/), authorityComputerId: z.string().uuid() }).strict();
const placeSchema = z.object({ server: serverName, pane: id, terminal: z.string().min(1).max(200), source: provider,
  session: z.string().min(1).max(200).optional() }).strict();
const holderSchema = z.object({ computerId: z.string().uuid(), claimId: z.string().uuid(), since: z.string().datetime(), place: placeSchema.optional() }).strict();
const stateSchema = z.object({ version: z.literal(1), storeId: z.string().regex(/^[a-f0-9]{8}$/), authorityComputerId: z.string().uuid(),
  generation: z.number().int().nonnegative(), holder: holderSchema.nullable() }).strict();
type State = z.infer<typeof stateSchema>;
type Config = z.infer<typeof configSchema>;
export type LeaseClaim = z.infer<typeof holderSchema>;
const takeoverPlaceSchema = placeSchema.extend({ source: z.enum(["claude", "codex", "opencode"]), session: z.string().min(1).max(200) });
const revokeSchema = z.object({ expectedGeneration: z.number().int().nonnegative(), holder: holderSchema, confirm: z.literal(true) }).strict();
const takeoverSchema = revokeSchema.extend({ computerId: z.string().uuid(), place: takeoverPlaceSchema }).strict();
const ownerRequestSchema = z.object({ route: z.enum(["/v1/conductor/lease/revoke", "/v1/conductor/lease/takeover"]), body: z.record(z.string(), z.unknown()),
  headers: z.object({ "x-phren-owner-time": z.string(), "x-phren-owner-nonce": z.string(), "x-phren-owner-key": z.string(), "x-phren-owner-signature": z.string() }).strict() }).strict();
type OwnerRequest = z.infer<typeof ownerRequestSchema>;
function ownerRequest(route: OwnerRequest["route"], body: Json, headers: IncomingHttpHeaders): OwnerRequest {
  const scalar = (name: string) => typeof headers[name] === "string" ? headers[name] as string : "";
  return { route, body, headers: { "x-phren-owner-time": scalar("x-phren-owner-time"), "x-phren-owner-nonce": scalar("x-phren-owner-nonce"),
    "x-phren-owner-key": scalar("x-phren-owner-key"), "x-phren-owner-signature": scalar("x-phren-owner-signature") } };
}
function sameHolder(a: LeaseClaim | null, b: LeaseClaim): boolean {
  return !!a && a.computerId === b.computerId && a.claimId === b.claimId && a.since === b.since
    && samePlace(a.place, b.place);
}
function samePlace(a: LeaseClaim["place"], b: LeaseClaim["place"]): boolean {
  return (!a && !b) || (!!a && !!b && a.server === b.server && a.pane === b.pane
    && a.terminal === b.terminal && a.source === b.source && a.session === b.session);
}
async function liveTakeoverPane(place: z.infer<typeof takeoverPlaceSchema>) {
  const pane = findPane(await snapshot(place.server), { pane: place.pane });
  if (!runsAgent(pane) || pane.terminal_id !== place.terminal || pane.agent !== place.source || await paneIdentity(place.server, pane, true) !== place.session) {
    throw new BridgeError(409, "The replacement conductor's exact local pane, terminal or session changed.", { code: "lease-target-changed" });
  }
  return pane;
}
const configFile = (store: string) => path.join(store, ".config", "conductor-authority.json");
const stateFile = (store: string) => path.join(store, ".runtime", "conductor-lease.json");
const claimFile = (store: string) => path.join(store, ".runtime", "conductor-claim.json");

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
  const input = z.object({ storeId: z.string().regex(/^[a-f0-9]{8}$/), operation: z.enum(["read", "claim", "bind", "release", "takeover", "validate-place"]),
    claim: holderSchema.optional(), expectedGeneration: z.number().int().nonnegative().optional(), holder: holderSchema.optional(),
    ownerRequest: ownerRequestSchema.optional(), place: takeoverPlaceSchema.optional(), computerId: z.string().uuid().optional() }).strict().parse(raw);
  const config = await conductorLeaseConfig(store);
  const computerId = await localId();
  if (!config || input.storeId !== config.storeId) throw new BridgeError(409, "This Hook has no matching configured store authority.");
  // Read-only pinned-Hook evidence for the authority; never grants a role or changes a lease.
  if (input.operation === "validate-place") {
    if (input.computerId !== computerId || !input.place) throw new BridgeError(409, "The replacement computer identity changed.");
    await liveTakeoverPane(input.place);
    return { ok: true, computerId, place: input.place };
  }
  if (config.authorityComputerId !== computerId) throw new BridgeError(409, "This Hook is not the configured authority for this store.");
  if (input.operation === "release" || input.operation === "takeover") {
    const proof = input.ownerRequest;
    const route = input.operation === "release" ? "/v1/conductor/lease/revoke" : "/v1/conductor/lease/takeover";
    if (!proof || proof.route !== route) throw new BridgeError(403, "Lease changes require an authenticated explicit owner decision.");
    requireOwner(store, proof.body);
    const reviewed = input.operation === "release" ? revokeSchema.parse(proof.body) : takeoverSchema.parse(proof.body);
    const previous = input.operation === "release" ? input.claim : input.holder;
    if (!previous || !sameHolder(previous, reviewed.holder) || input.expectedGeneration !== reviewed.expectedGeneration) throw new BridgeError(403, "The lease operation differs from the signed owner review.");
    if (input.operation === "takeover") {
      const replacement = takeoverSchema.parse(proof.body), claim = input.claim;
      if (!claim || !sameHolder(claim, { ...claim, computerId: replacement.computerId, place: replacement.place })) throw new BridgeError(403, "The replacement differs from the signed owner target.");
    }
    // The original native body/path is verified at the fixed authority, even when relayed by a computer.
    await requireOwnerControl(proof.headers, "POST", proof.route, proof.body);
    if (input.operation === "takeover") {
      const replacement = takeoverSchema.parse(proof.body);
      if (replacement.computerId === computerId) await liveTakeoverPane(replacement.place);
      else {
        const reply = await peerRequest(await authorityPeer(replacement.computerId), "/v1/conductor/lease/authority",
          { storeId: config.storeId, operation: "validate-place", computerId: replacement.computerId, place: replacement.place }, 15000);
        const verifiedPlace = takeoverPlaceSchema.safeParse(reply.place);
        if (reply.computerId !== replacement.computerId || !verifiedPlace.success || !samePlace(verifiedPlace.data, replacement.place)) throw new BridgeError(409, "The replacement Hook did not verify the exact owner target.");
      }
    }
  }
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
    } else {
      if ((input.operation !== "takeover" && !same) || input.expectedGeneration !== state.generation) throw new BridgeError(409, "Conductor lease changed since it was reviewed.", { lease: state });
      if (input.operation === "takeover") {
        if (!input.holder || !sameHolder(state.holder, input.holder) || !claim.place) throw new BridgeError(409, "The exact conductor identity changed since review.", { lease: state });
        state.holder = claim;
      } else if (input.operation === "bind") {
        if (!claim.place) throw new BridgeError(400, "Binding requires the exact conductor pane identity.");
        if (state.holder!.since !== claim.since || (state.holder!.place && !sameHolder(state.holder, claim))) throw new BridgeError(409, "An existing conductor binding requires explicit owner takeover.");
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

async function requestAuthority(store: string, operation: "read" | "claim" | "bind" | "release" | "takeover", claim?: LeaseClaim, expectedGeneration?: number, proof?: OwnerRequest, holder?: LeaseClaim): Promise<State> {
  const config = await conductorLeaseConfig(store);
  if (!config) throw new BridgeError(409, "Configure this store's fixed conductor authority before starting or assigning a conductor.");
  const input = { storeId: config.storeId, operation, ...(proof ? { ownerRequest: proof } : {}), ...(holder ? { holder } : {}), ...(claim ? { claim } : {}), ...(expectedGeneration === undefined ? {} : { expectedGeneration }) };
  const reply = config.authorityComputerId === await localId() ? await conductorLeaseAuthority(store, input)
    : await peerRequest(await authorityPeer(config.authorityComputerId), "/v1/conductor/lease/authority", input, 15000);
  const state = stateSchema.parse(reply.state);
  if (state.authorityComputerId !== config.authorityComputerId || state.storeId !== config.storeId) throw new BridgeError(409, "Conductor authority replied for a different identity.");
  if (["claim", "bind", "takeover"].includes(operation) && (!claim || !sameHolder(state.holder, claim))) throw new BridgeError(409, "The authority did not retain the exact requested conductor claim. Review the reservation before any owner retry.", { lease: state });
  if (operation === "release" && state.holder !== null) throw new BridgeError(409, "The authority did not confirm revocation of the reviewed holder.", { lease: state });
  return state;
}
export async function readConductorLease(store: string) {
  const config = await conductorLeaseConfig(store);
  return { ok: true, config: config ?? null, state: config ? await requestAuthority(store, "read") : null };
}
export async function requireAvailableConductorAuthority(store = phrenStoreRoot()): Promise<void> {
  if (await conductorLeaseConfig(store)) await requestAuthority(store, "read");
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
export async function revokeConductorLease(store: string, raw: unknown, headers: IncomingHttpHeaders = {}) {
  requireOwner(store, raw);
  const input = revokeSchema.parse(raw);
  const state = await requestAuthority(store, "read");
  if (!sameHolder(state.holder, input.holder) || state.generation !== input.expectedGeneration) throw new BridgeError(409, "The exact conductor identity changed since review.");
  return { ok: true, state: await requestAuthority(store, "release", input.holder, input.expectedGeneration,
    ownerRequest("/v1/conductor/lease/revoke", object(raw), headers)), existingWorkPreserved: true };
}
export async function takeoverConductorLease(store: string, raw: unknown, headers: IncomingHttpHeaders) {
  requireOwner(store, raw);
  const input = takeoverSchema.parse(raw);
  if (input.computerId !== await localId()) throw new BridgeError(409, "Send takeover to the reviewed replacement computer's paired Hook.");
  await liveTakeoverPane(input.place);
  const claim: LeaseClaim = { computerId: input.computerId, claimId: randomUUID(), since: new Date().toISOString(), place: input.place };
  const state = await requestAuthority(store, "takeover", claim, input.expectedGeneration,
    ownerRequest("/v1/conductor/lease/takeover", object(raw), headers), input.holder);
  // An uncertain reply or local persistence failure leaves the authority's reservation intact.
  try {
    await atomicInPrivateDir(claimFile(store), claim);
    const pane = await liveTakeoverPane(input.place);
    await recordConductor(input.place.server, pane, "owner", input.place.session);
  } catch {
    throw new BridgeError(409, "The lease was replaced, but local conductor adoption is incomplete. Review the authority before another explicit owner decision.",
      { code: "lease-adoption-incomplete", state, existingWorkPreserved: true });
  }
  return { ok: true, state, existingWorkPreserved: true };
}
export async function requireConductorLease(place: { server: string; pane: string; terminal?: string; source?: string }, store = phrenStoreRoot()) {
  // Existing conductors keep their work during deliberate configuration migration.
  if (!await conductorLeaseConfig(store)) return;
  const claim = holderSchema.parse(await readPrivate(claimFile(store)));
  const state = await requestAuthority(store, "read");
  if (!sameHolder(state.holder, claim) || state.holder?.computerId !== await localId()
    || state.holder.place?.server !== place.server || state.holder.place?.pane !== place.pane
    || state.holder.place.terminal !== place.terminal || state.holder.place.source !== place.source) throw new BridgeError(409, "This conductor no longer holds the store lease. Existing work is preserved; new dispatches are blocked.");
  if (state.holder.place.session) await liveTakeoverPane(takeoverPlaceSchema.parse(state.holder.place));
}
