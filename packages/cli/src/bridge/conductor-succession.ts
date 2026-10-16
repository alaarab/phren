import type { PeerIdentity } from "./request-origin.js";
import { redactPeerPayload } from "./peer-handoff.js";
import { deliveryIdSchema } from "./prompt-once.js";
import type { OriginPane } from "./dispatch.js";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { conductorPane, readRoleState, resetRoleState, successionSchema, updateConductorAuthority, type ConductorRecord, type ConductorSuccession } from "./conductor-role.js";
import { hookPeers, peerRequest, type HookPeer } from "./peers.js";
import { isLocalComputer, peerFingerprint, type DispatchHost } from "./dispatch-hosts.js";
import { atomicInPrivateDir, BridgeError, object, type Json, type Target } from "./protocol.js";

const actions = z.enum(["dispatch", "hand_off", "returns", "approve", "grants-list", "grants-add", "grants-remove"]);
type Action = z.infer<typeof actions>;
const callSchema = z.object({ id: z.string().uuid(), generation: z.string().uuid(), operationId: z.string().uuid() }).strict();
const computerIdentitySchema = z.object({ id: z.string().uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
const operationSchema = z.object({ action: actions, data: z.record(z.string(), z.unknown()), computerIdentity: computerIdentitySchema.optional() }).strict();
export type ConductorExecutor = (action: Action, data: Json, origin: OriginPane, remote?: boolean) => Promise<Json>;
const samePane = (left: unknown, right: { server: string; pane: string }) => object(left).server === right.server && object(left).pane === right.pane;
const sameTarget = (left: Target | undefined, right: Target | undefined) => !!left && !!right && Object.keys(left).every(key => left[key as keyof Target] === right[key as keyof Target]);
const busy = new Map<string, number>();
const transitions = new Map<string, Promise<unknown>>();
const readOperation = (action: Action, data: Json) => action === "returns" || action === "grants-list" || action === "hand_off" && data.status === true;

const peerData = redactPeerPayload;

interface Options {
  root: string;
  computer: { id: string; name: string };
  peers?: () => Promise<HookPeer[]>;
  request?: typeof peerRequest;
  validate: (target: Target) => Promise<Json>;
  isSuccessor?: (origin: { server: string; pane: string }, id: string) => Promise<boolean>;
  snapshot: (server: string) => Promise<Json>;
  deliver: (target: Target, text: string, deliveryId: string) => Promise<Json>;
  /** All existing worker computers must be reachable before reserving a move. */
  checkWorkers: (from: Target) => Promise<void>;
}

/** Check the original Hook's actual receipts over its own pinned directory,
 * before any role reservation, hand-off or successor launch. */
export async function preflightConductorWorkers(from: Target, computerId: string, peers: () => Promise<HookPeer[]> = hookPeers, request: typeof peerRequest = peerRequest): Promise<void> {
  const { dispatchStatus } = await import("./dispatch.js");
  const directory = await peers().catch(() => []);
  const receipts = (await dispatchStatus()).filter(receipt => receipt.origin?.server === from.server && receipt.origin.pane === from.pane && !receipt.closedAt && (receipt.approval || !receipt.returned?.read || ["working", "blocked", "stalled"].includes(String(receipt.worker?.state))));
  await Promise.all([...new Set(receipts.map(receipt => receipt.computer))].map(async name => {
    const group = receipts.filter(receipt => receipt.computer === name);
    const peer = directory.find(peer => peer.name === name);
    if (group.every(receipt => receipt.computerId === computerId || !peer && !receipt.computerId && !receipt.moves?.some(move => move.to.computer) && isLocalComputer(name))) return;
    if (!peer) throw new BridgeError(409, "A worker computer is not enrolled; the conductor move was refused before changes.");
    let health: Json;
    try { health = await request(peer, "/v1/health", undefined, 5_000); }
    catch { throw new BridgeError(409, "A worker computer is unreachable; the conductor move was refused before changes."); }
    for (const receipt of group) {
      const moved = receipt.moves?.slice().reverse().find(move => move.to.computer);
      const expected = moved?.computerId ?? receipt.computerId;
      if (expected && object(health.computer).id !== expected || moved?.computerFingerprint && peerFingerprint(peer) !== moved.computerFingerprint) throw new BridgeError(409, "A worker computer's identity changed; the conductor move was refused before changes.");
    }
  }));
}

/** A owns the generation and every receipt/approval/grant. B holds only a
 * delegated pane and operation outbox. No login or bearer credential crosses
 * Hooks. Peer writes are authenticated by fetching their intent back over
 * our own enrolled, pinned SSH account, rather than trusting a claimed alias. */
export class ConductorSuccessionService {
  private readonly peers: () => Promise<HookPeer[]>;
  private readonly request: typeof peerRequest;
  private readonly reservedCallers = new Set<string>();
  private readonly operations = new Map<string, Promise<Json>>();
  constructor(private readonly options: Options) {
    this.peers = options.peers ?? (() => hookPeers(options.root));
    this.request = options.request ?? peerRequest;
  }
  /** Synchronous admission also pauses conductor calls during preflight. */
  reserveCaller(target: { server: string; pane: string }): () => void {
    const key = `${target.server}\0${target.pane}`;
    if (this.reservedCallers.has(key)) throw new BridgeError(409, "This session is already being moved.");
    this.reservedCallers.add(key);
    return () => { this.reservedCallers.delete(key); };
  }
  private assertCallerAvailable(origin: unknown): void {
    const value = object(origin);
    if (this.reservedCallers.has(`${value.server}\0${value.pane}`)) throw new BridgeError(409, "The conductor is being moved; new conductor operations are paused.");
  }
  private file(id: string, suffix = "state"): string {
    return path.join(this.options.root, "conductor-moves", z.string().uuid().parse(id), `${suffix}.json`);
  }
  private async save(state: ConductorSuccession): Promise<void> { await atomicInPrivateDir(this.file(state.id), JSON.stringify(state)); }
  async status(id: string): Promise<ConductorSuccession> {
    z.string().uuid().parse(id);
    const current = (await readRoleState(this.options.root))?.succession;
    let state: ConductorSuccession;
    if (current?.id === id) state = current;
    else {
      try { state = successionSchema.parse(JSON.parse(await readFile(this.file(id), "utf8"))); }
      catch { throw new BridgeError(404, "No conductor move with that id is recorded on this Hook."); }
    }
    // Resume data is private to A: it includes unsanitized source labels and
    // paths and must never be copied to B by a status/preparation probe.
    const { resume: _resume, ...publicState } = state;
    return publicState;
  }
  /** Identity is supplied only by the scoped SSH gateway, never the body. */
  async authorize(id: string, caller: PeerIdentity | undefined, preparingOrigin?: string): Promise<void> {
    if (!caller) throw new BridgeError(403, "This route requires an authenticated enrolled computer key. Re-enroll legacy peer keys.");
    let state: ConductorSuccession | undefined;
    try { state = await this.status(id); } catch (error) { if (!(error instanceof BridgeError && error.status === 404 && preparingOrigin)) throw error; }
    if (state) {
      if (caller.name !== undefined && caller.name !== state.connection.name || caller.id !== undefined && caller.id !== state.connection.id || caller.fingerprint !== state.connection.fingerprint) throw new BridgeError(403, "This peer is not the move's recorded counterpart.");
      await this.connection(state);
    } else {
      if (caller.id !== undefined && caller.id !== preparingOrigin) throw new BridgeError(403, "This peer is not the preparing origin.");
      const peers = (await this.peers()).filter(peer => peerFingerprint(peer) === caller.fingerprint && (!caller.name || peer.name === caller.name));
      if (peers.length !== 1 || object((await this.request(peers[0], "/v1/health", undefined, 5_000)).computer).id !== preparingOrigin) throw new BridgeError(403, "The preparing peer is not currently verified.");
    }
  }
  private async workerIdentities(from: Target): Promise<Array<z.infer<typeof computerIdentitySchema>>> {
    const { dispatchStatus } = await import("./dispatch.js");
    const directory = await this.peers();
    const receipts = (await dispatchStatus()).filter(receipt => samePane(receipt.origin, from) && !receipt.closedAt);
    const identities = new Map<string, z.infer<typeof computerIdentitySchema>>();
    for (const receipt of receipts) {
      const peer = directory.find(peer => peer.name === receipt.computer);
      const moved = receipt.moves?.slice().reverse().find(move => move.to.computer);
      if (receipt.computerId === this.options.computer.id || !peer && !moved && isLocalComputer(receipt.computer, [this.options.computer.name])) { identities.set(this.options.computer.id, { id: this.options.computer.id }); continue; }
      if (!peer) throw new BridgeError(409, "A worker computer is not enrolled in the original Hook's directory.");
      const health = await this.request(peer, "/v1/health", undefined, 5_000);
      const id = z.string().uuid().parse(object(health.computer).id), fingerprint = peerFingerprint(peer);
      if ((moved?.computerId ?? receipt.computerId) && (moved?.computerId ?? receipt.computerId) !== id || moved?.computerFingerprint && moved.computerFingerprint !== fingerprint) throw new BridgeError(409, "A worker computer's identity changed.");
      identities.set(`${id}:${fingerprint}`, { id, fingerprint });
    }
    return [...identities.values()];
  }
  private async connection(state: ConductorSuccession): Promise<HookPeer> {
    const peer = (await this.peers()).find(candidate => candidate.name === state.connection.name && candidate.server === state.connection.server && peerFingerprint(candidate) === state.connection.fingerprint);
    if (!peer) throw new BridgeError(409, "The conductor's enrolled connection was removed or changed.");
    const health = await this.request(peer, "/v1/health", undefined, 5_000).catch(() => undefined);
    if (!health || object(health.computer).id !== state.connection.id) throw new BridgeError(409, "The original conductor Hook is unreachable or its identity changed. Conductor operations are unavailable.");
    return peer;
  }
  private async change(id: string, run: (state: ConductorSuccession) => ConductorSuccession): Promise<ConductorSuccession> {
    const saved = await updateConductorAuthority(this.options.root, async role => {
      if (role.succession?.id !== id) throw new BridgeError(409, "The conductor ownership generation changed.");
      return { ...role, succession: run(role.succession) };
    });
    await this.save(saved.succession!);
    return saved.succession!;
  }
  async begin(id: string, expected: ConductorRecord, from: Target, destination: DispatchHost, computerId: string, resume?: Json): Promise<ConductorSuccession> {
    if (busy.get(this.options.root)) throw new BridgeError(409, "The conductor has an operation in flight; try the move again after it completes.");
    await this.options.checkWorkers(from);
    if (!destination.fingerprint) throw new BridgeError(409, "The destination has no pinned identity.");
    const health = await destination.request("/v1/health", undefined, 5_000);
    if (object(health.computer).id !== computerId || object(health.capabilities).moveConductorToComputer !== true) throw new BridgeError(409, `Update ${destination.name}'s Hook to move the conductor`);
    const current = (await readRoleState(this.options.root))?.succession;
    if (current?.id === id) {
      if (current.phase === "aborted") throw new BridgeError(409, "This conductor move was aborted; use a new move id.");
      await this.ensurePrepared(id); return current;
    }
    const workers = await this.workerIdentities(from);
    const transaction: ConductorSuccession = { workers, id, generation: randomUUID(), side: "origin", phase: "preparing", originId: this.options.computer.id, destinationId: computerId,
      previous: expected, from, ...(resume ? { resume } : {}), connection: { name: destination.name, server: destination.server, fingerprint: destination.fingerprint, id: computerId } };
    await updateConductorAuthority(this.options.root, async role => {
      if (busy.get(this.options.root)) throw new BridgeError(409, "The conductor has an operation in flight; try the move again after it completes.");
      if (role.succession && role.succession.phase !== "aborted") throw new BridgeError(409, "A conductor move or delegation is already active.");
      if (JSON.stringify(role.conductor) !== JSON.stringify(expected)) throw new BridgeError(409, "The conductor changed during the move; nothing was transferred.");
      return { ...role, succession: transaction };
    });
    await this.save(transaction);
    try {
      const peer = await this.connection(transaction);
      await this.request(peer, "/v1/conductor/move/prepare", { id, originId: transaction.originId, generation: transaction.generation, workers: transaction.workers ?? [] }, 10_000);
      return transaction;
    } catch (error) { await this.abort(id); throw error; }
  }
  async ensurePrepared(id: string): Promise<void> {
    const state = await this.status(id);
    if (state.side !== "origin" || state.phase === "aborted") throw new BridgeError(409, "The conductor move is no longer preparing.");
    const peer = await this.connection(state);
    await this.request(peer, "/v1/conductor/move/prepare", { id, originId: state.originId, generation: state.generation, workers: state.workers ?? [] }, 10_000);
  }
  async prepare(input: unknown): Promise<Json> {
    const data = z.object({ id: z.string().uuid(), originId: z.string().uuid(), generation: z.string().uuid(), workers: z.array(computerIdentitySchema).default([]) }).strict().parse(input);
    const existing = (await readRoleState(this.options.root))?.succession;
    if (existing?.id === data.id && existing.generation === data.generation) return { ok: true, phase: existing.phase };
    const candidates = await Promise.all((await this.peers()).map(async peer => {
      try {
        const health = await this.request(peer, "/v1/health", undefined, 5_000);
        if (object(health.computer).id !== data.originId) return undefined;
        const state = successionSchema.parse(await this.request(peer, `/v1/conductor/move/status?id=${data.id}`, undefined, 5_000));
        if (state.side !== "origin" || state.phase === "aborted" || state.generation !== data.generation || state.destinationId !== this.options.computer.id) return undefined;
        return { peer, state };
      } catch { return undefined; }
    }));
    const verified = candidates.filter(value => value !== undefined);
    if (verified.length !== 1) throw new BridgeError(403, "No unique pinned origin Hook authorized this conductor prepare.");
    const { peer, state } = verified[0];
    if (JSON.stringify(data.workers) !== JSON.stringify(state.workers ?? [])) throw new BridgeError(403, "The worker preflight does not match the original Hook intent.");
    for (const worker of data.workers) await this.resolveComputer(worker);
    const successor: ConductorSuccession = { ...state, side: "successor", phase: "prepared", connection: { name: peer.name, server: peer.server, fingerprint: peerFingerprint(peer), id: data.originId } };
    // Adopt a legacy named role through the same resolver as the overview,
    // including prefixed names and mux agent-name mappings.
    const snapshot = await this.options.snapshot(state.connection.server);
    await conductorPane(state.connection.server, snapshot, this.options.root);
    await updateConductorAuthority(this.options.root, async role => {
      if (role.conductor || role.succession && role.succession.phase !== "aborted") throw new BridgeError(409, "This Hook already has a conductor or prepared successor.");
      return { ...role, conductor: null, succession: successor };
    });
    await this.save(successor);
    return { ok: true, phase: "prepared" };
  }
  /** The prepared successor pulls the canonical launch over its own pin.
   * An unrelated enrolled peer cannot pre-empt a known move id with a brief. */
  async saveLaunch(id: string, input: Json): Promise<void> {
    const state = await this.status(id);
    if (state.side !== "origin" || state.phase === "aborted") throw new BridgeError(409, "This conductor move is not preparing a launch.");
    await atomicInPrivateDir(this.file(id, "launch"), JSON.stringify(input));
  }
  async launchIntent(id: string): Promise<Json> {
    const state = await this.status(id);
    if (state.side !== "origin" || state.phase === "aborted") throw new BridgeError(409, "This conductor launch is no longer authorized.");
    return JSON.parse(await readFile(this.file(id, "launch"), "utf8"));
  }
  async verifiedLaunch(input: Json): Promise<Json> {
    const state = (await readRoleState(this.options.root))?.succession;
    if (!state || state.side !== "successor" || state.id !== object(input.brief).id) return input;
    if (state.phase === "aborted") throw new BridgeError(409, "This prepared conductor move was aborted.");
    const peer = await this.connection(state);
    const authority = successionSchema.parse(await this.request(peer, `/v1/conductor/move/status?id=${state.id}`, undefined, 5_000));
    if (authority.phase === "aborted" || authority.generation !== state.generation) throw new BridgeError(403, "The conductor launch generation is not authorized.");
    const canonical = await this.request(peer, `/v1/conductor/move/launch?id=${state.id}`, undefined, 5_000);
    if (JSON.stringify(canonical) !== JSON.stringify(input)) throw new BridgeError(403, "This is not the origin Hook's prepared conductor launch.");
    return canonical;
  }
  async prepared(id: string, target: Target): Promise<void> {
    await this.change(id, state => {
      if (state.side !== "origin" || state.phase === "aborted") throw new BridgeError(409, "This conductor move is no longer preparing.");
      if (state.target && !sameTarget(state.target, target)) throw new BridgeError(409, "This move already prepared a different successor.");
      return { ...state, target, phase: state.phase === "committed" ? "committed" : "prepared" };
    });
  }
  async commit(id: string): Promise<ConductorSuccession> {
    const saved = await updateConductorAuthority(this.options.root, async role => {
      const state = role.succession;
      if (!state || state.id !== id || state.side !== "origin" || !state.target) throw new BridgeError(409, "The successor was not prepared and confirmed.");
      if (state.phase === "committed") return role;
      if (state.phase !== "prepared" || JSON.stringify(role.conductor) !== JSON.stringify(state.previous)) throw new BridgeError(409, "The conductor changed during the move; nothing was transferred.");
      return { ...role, conductor: null, succession: { ...state, phase: "committed" } };
    });
    // The ownership write is the commit point. A failed notification or lost
    // acknowledgement never restores the previous generation.
    const state = saved.succession!;
    await this.save(state);
    return state;
  }
  private async transition<T>(id: string, run: () => Promise<T>): Promise<T> {
    const key = this.file(id, "transition");
    const work = (transitions.get(key) ?? Promise.resolve()).catch(() => {}).then(run);
    transitions.set(key, work);
    try { return await work; } finally { if (transitions.get(key) === work) transitions.delete(key); }
  }
  async activate(input: unknown): Promise<Json> {
    const id = z.object({ id: z.string().uuid() }).parse(input).id;
    return this.transition(id, () => this.activateOnce(input));
  }
  private async activateOnce(input: unknown): Promise<Json> {
    const data = z.object({ id: z.string().uuid(), generation: z.string().uuid() }).strict().parse(input);
    const successor = await this.status(data.id);
    if (successor.side !== "successor" || successor.generation !== data.generation) throw new BridgeError(403, "This is not the prepared successor generation.");
    const peer = await this.connection(successor);
    const authority = successionSchema.parse(await this.request(peer, `/v1/conductor/move/status?id=${data.id}`, undefined, 5_000));
    if (authority.phase !== "committed" || authority.generation !== successor.generation || authority.destinationId !== this.options.computer.id || !authority.target) throw new BridgeError(409, "The original Hook has not committed this successor. You are not the conductor.");
    const target = authority.target;
    const pane = await this.options.validate(target);
    if (!pane || !["idle", "working"].includes(String(pane.agent_status))) throw new BridgeError(409, "The prepared successor is not confirmed running.");
    await updateConductorAuthority(this.options.root, async role => {
      if (role.succession?.id !== data.id || role.succession.generation !== data.generation || role.succession.phase === "aborted") throw new BridgeError(409, "The successor generation changed.");
      return { ...role, conductor: { server: target.server, pane: target.pane, workspace: target.workspace, tab: target.tab, source: target.source, session: target.session,
        ...(typeof pane.terminal_id === "string" ? { terminal: pane.terminal_id } : {}), since: successor.previous.since, by: "owner" }, succession: { ...successor, phase: "committed", target } };
    });
    await this.options.deliver(target, "The original Hook committed the hand-over. You are now the conductor. Its receipts, approvals and grants stay there; your conductor operations are forwarded there and fail closed if it is unreachable.", `move-${data.id}-conductor-confirmed`);
    return { ok: true, phase: "committed", target };
  }
  async finish(id: string): Promise<void> { return this.transition(id, () => this.finishOnce(id)); }
  private async finishOnce(id: string): Promise<void> {
    const state = await this.status(id);
    if (state.side !== "origin" || state.phase !== "committed") throw new BridgeError(409, "The origin has not committed this hand-over.");
    if (state.activated) return;
    const peer = await this.connection(state);
    await this.request(peer, "/v1/conductor/move/commit", { id, generation: state.generation }, 10_000);
    await this.options.deliver(state.from, "The conductor role moved to another computer. You are no longer the conductor; conductor operations from this chat are fenced. Keep this chat open as its hand-off record.", `move-${id}-conductor-fenced`);
    await this.change(id, current => ({ ...current, activated: true }));
  }
  /** Explicit owner revocation on A ends delegation without restoring the
   * old chat. This is distinct from rolling back an uncertain commit. */
  async stopOrigin(pane?: unknown): Promise<Json | undefined> {
    const current = (await readRoleState(this.options.root))?.succession;
    if (!current || current.phase === "aborted") return undefined;
    if (current.side !== "origin") throw new BridgeError(409, "Stop this delegated conductor from its original Hook.");
    if (current.phase !== "committed") throw new BridgeError(409, "The conductor is being moved; reconcile the move before stopping it.");
    if (pane !== undefined) throw new BridgeError(409, "The conductor is on another computer. Stop its delegation on the original Hook without a pane id.");
    const state = await updateConductorAuthority(this.options.root, async role => {
      if (busy.get(this.options.root)) throw new BridgeError(409, "The conductor has an operation in flight; try stopping it again after it completes.");
      if (role.succession?.id !== current.id || role.succession.generation !== current.generation || role.succession.phase !== "committed") throw new BridgeError(409, "The conductor generation changed.");
      return { ...role, conductor: null, succession: { ...role.succession, phase: "aborted", revoked: true } };
    });
    await this.save(state.succession!);
    return { ok: true, stopped: true };
  }
  async abort(id: string): Promise<void> {
    // Re-read disk after any uncertain write. A committed generation is never
    // rolled back, even if the acknowledgement or following status write failed.
    resetRoleState();
    const state = await this.status(id);
    if (state.phase === "committed") return;
    const aborted = await updateConductorAuthority(this.options.root, async role => {
      if (role.succession?.id !== id || role.succession.phase === "committed") return role;
      return { ...role, ...(role.succession.side === "successor" ? { conductor: null } : {}), succession: { ...role.succession, phase: "aborted" } };
    });
    if (aborted.succession) await this.save(aborted.succession);
  }
  async call(action: Action, data: Json, origin: unknown, execute: () => Promise<Json>): Promise<Json> {
    this.assertCallerAvailable(origin);
    const role = await readRoleState(this.options.root), state = role?.succession;
    if (state?.revoked && !samePane(origin, role?.conductor ?? { server: "", pane: "" }) && samePane(origin, state.side === "origin" ? state.from : state.target ?? state.from)) throw new BridgeError(409, "This conductor ownership generation is fenced.");
    if (!state || state.phase === "aborted") {
      let held = false;
      await updateConductorAuthority(this.options.root, async current => {
        this.assertCallerAvailable(origin);
        if (current.succession && current.succession.phase !== "aborted") throw new BridgeError(409, "The conductor is being moved; new conductor operations are paused.");
        if (current.conductor && samePane(origin, current.conductor)) { busy.set(this.options.root, (busy.get(this.options.root) ?? 0) + 1); held = true; }
        return current;
      });
      try { return await execute(); } finally { if (held) busy.set(this.options.root, (busy.get(this.options.root) ?? 1) - 1); }
    }
    const local = state.side === "origin" ? state.from : state.target;
    // Prepared successor operations with a live origin are refused until the
    // exact conversation is bound and A's generation commit has been proved.
    if (state.side === "successor" && state.phase !== "committed" && (samePane(origin, state.target ?? { server: "", pane: "" }) || typeof object(origin).server === "string" && typeof object(origin).pane === "string" && await this.options.isSuccessor?.(origin as { server: string; pane: string }, state.id))) throw new BridgeError(409, "This chat is a prepared successor, not the conductor yet.");
    if (!local || !samePane(origin, local)) return execute();
    if (state.side === "origin") throw new BridgeError(409, state.phase === "committed" ? "This chat is no longer the conductor. Its ownership generation is fenced." : "The conductor is being moved; new conductor operations are paused.");
    await this.options.validate(state.target!);
    const peer = await this.connection(state);
    const authority = successionSchema.parse(await this.request(peer, `/v1/conductor/move/status?id=${state.id}`, undefined, 5_000));
    if (authority.phase !== "committed" || authority.generation !== state.generation || !sameTarget(authority.target, state.target)) throw new BridgeError(409, "The original Hook no longer authorizes this conductor generation.");
    const operation = { action, data: peerData(data), ...(["dispatch", "hand_off"].includes(action) && data.computer !== "anywhere" ? { computerIdentity: await this.identifyComputer(data.computer) } : {}) };
    const hash = createHash("sha256").update(JSON.stringify(operation)).digest("hex");
    const key = this.file(state.id, `call-${hash}`);
    const pending = this.operations.get(key);
    if (pending) return pending;
    const work = (async () => {
      let saved: { operationId: string; result?: Json; failed?: boolean; at: number } | undefined;
      try { saved = JSON.parse(await readFile(key, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      // Only an unacknowledged intent is replayed. A successful call starts
      // a fresh intent next time, especially for draining newly arrived returns.
      const operationId = !readOperation(action, data) && saved && !saved.result && !saved.failed ? saved.operationId : randomUUID();
      await atomicInPrivateDir(this.file(state.id, `out-${operationId}`), JSON.stringify(operation));
      await atomicInPrivateDir(key, JSON.stringify({ operationId, at: Date.now() }));
      try {
        const result = await this.request(peer, "/v1/conductor/move/operate", { id: state.id, generation: state.generation, operationId }, 65_000);
        await atomicInPrivateDir(key, JSON.stringify({ operationId, at: Date.now(), result }));
        if (action === "returns") await this.request(peer, "/v1/conductor/move/ack", { id: state.id, generation: state.generation, operationId }, 10_000).catch(() => undefined);
        return result;
      } catch (error) {
        if (error instanceof BridgeError && error.status >= 400 && error.status < 500) await atomicInPrivateDir(key, JSON.stringify({ operationId, at: Date.now(), failed: true }));
        throw error;
      }
    })();
    this.operations.set(key, work);
    try { return await work; } finally { this.operations.delete(key); }
  }
  private async identifyComputer(name: unknown): Promise<z.infer<typeof computerIdentitySchema>> {
    if (name === undefined || typeof name === "string" && isLocalComputer(name, [this.options.computer.name])) return { id: this.options.computer.id };
    const peer = (await this.peers()).find(peer => peer.name === name);
    if (!peer) throw new BridgeError(409, "The selected computer is not in the successor Hook's verified directory.");
    const health = await this.request(peer, "/v1/health", undefined, 5_000);
    return { id: z.string().uuid().parse(object(health.computer).id), fingerprint: peerFingerprint(peer) };
  }
  private async resolveComputer(identity: z.infer<typeof computerIdentitySchema>): Promise<string> {
    if (identity.id === this.options.computer.id) return this.options.computer.name;
    const matches = (await Promise.all((await this.peers()).filter(peer => !identity.fingerprint || peerFingerprint(peer) === identity.fingerprint).map(async peer => {
      const health = await this.request(peer, "/v1/health", undefined, 5_000).catch(() => undefined);
      return object(health?.computer).id === identity.id ? peer.name : undefined;
    }))).filter((name): name is string => !!name);
    if (matches.length !== 1) throw new BridgeError(409, "The selected computer identity is not uniquely enrolled on the original conductor Hook.");
    return matches[0];
  }
  /** Automatic failover has no authority from the fenced old pane. Its
   * generation is checked against the live successor before executing at A. */
  async automatic(action: Action, data: Json, origin: unknown, execute: () => Promise<Json>): Promise<Json> {
    this.assertCallerAvailable(origin);
    const state = (await readRoleState(this.options.root))?.succession;
    if (state?.side !== "origin" || state.phase !== "committed" || !samePane(origin, state.from)) return this.call(action, data, origin, execute);
    const peer = await this.connection(state);
    const successor = await this.request(peer, `/v1/conductor/move/status?id=${state.id}`, undefined, 5_000);
    if (successor.phase !== "committed" || successor.generation !== state.generation || !sameTarget(object(successor.target) as Target, state.target)) throw new BridgeError(409, "The delegated conductor is unavailable; automatic dispatch is paused.");
    await updateConductorAuthority(this.options.root, async role => {
      if (role.succession?.generation !== state.generation || role.succession.phase !== "committed") throw new BridgeError(409, "The conductor generation changed.");
      busy.set(this.options.root, (busy.get(this.options.root) ?? 0) + 1); return role;
    });
    try { return await execute(); } finally { busy.set(this.options.root, (busy.get(this.options.root) ?? 1) - 1); }
  }
  async outgoing(id: string, operationId: string): Promise<Json> {
    const state = await this.status(id);
    if (state.side !== "successor" || state.phase !== "committed") throw new BridgeError(409, "No active successor outbox.");
    return operationSchema.parse(JSON.parse(await readFile(this.file(id, `out-${z.string().uuid().parse(operationId)}`), "utf8")));
  }
  async operate(input: unknown, execute: ConductorExecutor): Promise<Json> {
    const data = callSchema.parse(input), state = await this.status(data.id);
    if (state.side !== "origin" || state.phase !== "committed" || state.generation !== data.generation) throw new BridgeError(403, "The conductor generation is not authorized.");
    const peer = await this.connection(state);
    const operation = operationSchema.parse(await this.request(peer, `/v1/conductor/move/operation?id=${data.id}&operationId=${data.operationId}`, undefined, 5_000));
    const key = this.file(data.id, `result-${data.operationId}`);
    const pending = this.operations.get(key);
    if (pending) return pending;
    const work = (async () => {
      let saved: Json | undefined;
      try { saved = JSON.parse(await readFile(key, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (saved?.result) return peerData(object(saved.result));
      if (saved?.state === "failed") throw new BridgeError(Number(saved.status), String(saved.error));
      if (saved && !readOperation(operation.action, operation.data)) throw new BridgeError(503, "This conductor operation has an uncertain outcome. Inspect its existing receipt; it will not be repeated.");
      await updateConductorAuthority(this.options.root, async role => {
        if (role.succession?.id !== data.id || role.succession.phase !== "committed" || role.succession.generation !== data.generation) throw new BridgeError(403, "The conductor generation was fenced.");
        busy.set(this.options.root, (busy.get(this.options.root) ?? 0) + 1); return role;
      });
      try {
        await atomicInPrivateDir(key, JSON.stringify({ state: "uncertain", operation }));
        const { server, workspace, tab, pane } = state.from;
        const payload = { ...operation.data };
        if (operation.computerIdentity) payload.computer = await this.resolveComputer(operation.computerIdentity);
        const result = peerData(await execute(operation.action, payload, { server, workspace, tab, pane }, true));
        await atomicInPrivateDir(key, JSON.stringify({ state: "done", result, operation }));
        return result;
      } catch (error) {
        if (error instanceof BridgeError && error.status >= 400 && error.status < 500) await atomicInPrivateDir(key, JSON.stringify({ state: "failed", status: error.status, error: error.message }));
        throw error;
      } finally { busy.set(this.options.root, (busy.get(this.options.root) ?? 1) - 1); }
    })();
    this.operations.set(key, work);
    try { return await work; } finally { this.operations.delete(key); }
  }
  async acknowledge(input: unknown, acknowledge: (rows: Json[]) => Promise<void>): Promise<Json> {
    const data = callSchema.parse(input), state = await this.status(data.id);
    if (state.side !== "origin" || state.phase !== "committed" || state.generation !== data.generation) throw new BridgeError(403, "The conductor generation is not authorized.");
    const saved = object(JSON.parse(await readFile(this.file(data.id, `result-${data.operationId}`), "utf8")));
    if (object(saved.operation).action === "returns" && saved.state === "done") await acknowledge((object(saved.result).returns ?? []) as Json[]);
    return { ok: true };
  }
  async forward(origin: unknown, text: string, deliveryId: string): Promise<{ delivered: boolean } | undefined> {
    const state = (await readRoleState(this.options.root))?.succession;
    if (state?.side !== "origin" || !samePane(origin, state.from)) return undefined;
    if (state.phase === "preparing" || state.phase === "prepared") return { delivered: false };
    if (state.phase !== "committed") return undefined;
    const peer = await this.connection(state);
    await atomicInPrivateDir(this.file(state.id, `notice-${deliveryId}`), JSON.stringify(peerData({ text, deliveryId })));
    const sent = await this.request(peer, "/v1/conductor/move/notice", { id: state.id, generation: state.generation, deliveryId }, 10_000);
    const current = (await readRoleState(this.options.root))?.succession;
    if (current?.id !== state.id || current.generation !== state.generation || current.phase !== "committed") return { delivered: false };
    return { delivered: sent.delivered === true || sent.queued === true };
  }
  async notice(input: unknown): Promise<Json> {
    const data = z.object({ id: z.string().uuid(), generation: z.string().uuid(), deliveryId: deliveryIdSchema.unwrap() }).strict().parse(input);
    const state = await this.status(data.id);
    if (state.side !== "successor" || state.phase !== "committed" || state.generation !== data.generation || !state.target) throw new BridgeError(403, "This conductor generation is not active.");
    const peer = await this.connection(state);
    const authority = successionSchema.parse(await this.request(peer, `/v1/conductor/move/status?id=${state.id}`, undefined, 5_000));
    if (authority.phase !== "committed" || authority.generation !== state.generation) throw new BridgeError(403, "The original Hook fenced this conductor generation.");
    await this.options.validate(state.target);
    const notice = await this.request(peer, `/v1/conductor/move/notification?id=${state.id}&deliveryId=${data.deliveryId}`, undefined, 5_000);
    return this.options.deliver(state.target, z.string().max(32768).parse(notice.text), data.deliveryId);
  }
  async notification(id: string, deliveryId: string): Promise<Json> {
    deliveryIdSchema.unwrap().parse(deliveryId);
    await this.status(id);
    return JSON.parse(await readFile(this.file(id, `notice-${deliveryId}`), "utf8"));
  }
  async reconcile(): Promise<void> {
    const state = (await readRoleState(this.options.root))?.succession;
    if (!state || state.phase === "aborted") return;
    if (state.side === "origin" && state.phase === "committed") await this.finish(state.id);
    if (state.side === "successor") {
      const peer = await this.connection(state);
      const authority = successionSchema.parse(await this.request(peer, `/v1/conductor/move/status?id=${state.id}`, undefined, 5_000));
      if (authority.phase === "committed" && state.phase !== "committed") await this.activate({ id: state.id, generation: state.generation });
      if (authority.target && !state.target) await this.change(state.id, current => ({ ...current, target: authority.target }));
      if (authority.phase === "aborted") {
        if (state.phase === "committed") {
          await updateConductorAuthority(this.options.root, async role => role.succession?.id !== state.id ? role : { ...role, conductor: null, succession: { ...role.succession, phase: "aborted", revoked: true } });
        } else await this.abort(state.id);
        const target = authority.target ?? state.target;
        if (target) await this.options.deliver(target, authority.revoked ? "The owner stopped the delegated conductor on the original Hook. You are no longer the conductor." : "The hand-over failed. You are not the conductor; the previous conductor keeps the role.", `move-${state.id}-conductor-failed`);
      }
    }
  }
}
