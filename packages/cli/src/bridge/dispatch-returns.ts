import { createHash } from "node:crypto";
import { z } from "zod";
import { arrivalOf, dispatchStatus, updateReceipt, type OriginPane, type Receipt, type WorkerState } from "./dispatch.js";
import { briefArrival, briefId, type BriefArrival } from "./launch-brief.js";
import { findPane, paneIdentity, sharedSnapshot } from "./herdr.js";
import { handOff } from "./hand-off.js";
import { hookPeers, peerRequest, type HookPeer } from "./peers.js";
import { isLocalComputer } from "./dispatch-hosts.js";
import { objects, startingTargetSchema, targetSchema, type Json, type Provider, type Target } from "./protocol.js";
import { ownerQuestion, readFinalTurn, type FinalTurn } from "./schedule-watch.js";
import { terminalProvider } from "./terminal.js";
import { opencodeTurn, readTurn, TURN_REPLY_LIMIT, truncateUtf8, turnPhase, type TurnRecord } from "./turn-records.js";

export { truncateUtf8 } from "./turn-records.js";

/**
 * The conductor's returns loop. The worker's computer answers what its
 * dispatched panes are doing (`workerStates`): from the turn record its
 * agent's own hooks wrote (turn-records.ts) when there is one, else from the
 * Herdr snapshot its Hook already shares and the transcript. The dispatching
 * Hook asks each peer once per poll for all of its open dispatches, records
 * transitions in the receipts, and tells an idle dispatching agent that
 * returns are waiting (`DispatchReturns`).
 */

/** Longest final reply kept in a receipt, in UTF-8 bytes. */
export const REPLY_LIMIT = TURN_REPLY_LIMIT;
/** How often the dispatching Hook asks peers about open dispatches. */
export const POLL_MS = 15_000;
/** Shortest gap between two notices typed into the same dispatching pane. */
export const NOTICE_MS = 120_000;
/** Receipts older than this are no longer watched. */
export const WATCH_MS = 24 * 60 * 60 * 1000;
/** How long a stopped worker whose harness still runs background tasks is
 * waited on before it counts as done anyway. Measured from the latest Stop,
 * and every task that finishes wakes the worker (a new prompt, a new Stop), so
 * it only elapses when no background task has finished for two hours: a dev
 * server the worker left running. It is then reported done with the count
 * still running. */
export const BACKGROUND_WAIT_MS = 2 * 60 * 60 * 1000;
/** How old a shared Herdr snapshot may be when answering a peer. */
const SNAPSHOT_AGE_MS = 5_000;

// `dispatch` names the receipt, which is the worker's PHREN_DISPATCH_ID. An
// older Hook's target schema strips it, so it is safe to send to any peer.
const workerTarget = z.union([targetSchema.extend({ dispatch: briefId.optional() }), startingTargetSchema.extend({ dispatch: briefId.optional() })]);
export const workerRequestSchema = z.object({ targets: z.array(workerTarget).min(1).max(64) }).strict();

/** What a worker pane shows right now, as its own computer reads it. */
export interface WorkerObservation {
  /** Herdr's status for the pane, or gone when the pane or its conversation is no longer there. */
  state: "working" | "idle" | "done" | "blocked" | "unknown" | "gone" | "unavailable";
  session?: string;
  completed?: boolean;
  reply?: string;
  truncated?: boolean;
  /** The error the harness ended the turn on (Codex's usage limit). */
  error?: string;
  /** The state comes from the agent's own turn events, not from how the pane looks. */
  hook?: true;
  /** When the turn's Stop arrived, on the worker's clock; names the turn. */
  endedAt?: string;
  /** Background tasks the harness still runs: waited on while `working`,
   * left running when `done` after BACKGROUND_WAIT_MS. */
  background?: number;
  /** The owner stopped the turn in the worker's terminal. */
  interrupted?: true;
}

export interface WorkerReaders {
  snapshot: (server: string) => Promise<Json>;
  identity: (server: string, pane: Json) => Promise<string | undefined>;
  finalTurn: (source: Provider, session: string) => Promise<FinalTurn | undefined>;
  /** The turn record the pane's agent reported through its hooks (or OpenCode's plugin). */
  turn?: (server: string, pane: Json, source: Provider) => Promise<TurnRecord | undefined>;
  now?: () => number;
}

async function paneTurn(server: string, pane: Json, source: Provider): Promise<TurnRecord | undefined> {
  if (source !== "opencode") return readTurn(server, String(pane.pane_id));
  if (typeof pane.terminal_id !== "string") return undefined;
  return opencodeTurn((await terminalProvider().processes(server, String(pane.pane_id))).foregroundPids, pane.terminal_id);
}

const defaultReaders: WorkerReaders = {
  snapshot: server => sharedSnapshot(server, SNAPSHOT_AGE_MS),
  identity: (server, pane) => paneIdentity(server, pane),
  finalTurn: (source, session) => source === "codex" || source === "claude" || source === "opencode" ? readFinalTurn(source, session) : Promise.resolve(undefined),
  turn: paneTurn,
};

function replyFields(text: string | undefined, truncated?: boolean): Pick<WorkerObservation, "reply" | "truncated"> {
  if (!text) return {};
  const reply = truncateUtf8(text);
  return { reply: reply.text, ...(reply.truncated || truncated ? { truncated: true } : {}) };
}

/** A worker's state from its own turn events. Done means a Stop arrived after
 * the last submitted prompt with no background work left (or it has waited
 * BACKGROUND_WAIT_MS); a prompt with no Stop is still working, unless the
 * pane is idle and the transcript shows the owner interrupted it (no Stop
 * comes then) or a finished turn whose Stop the Hook never received. */
async function fromTurn(record: TurnRecord, session: string, status: string, source: Provider, readers: WorkerReaders): Promise<WorkerObservation> {
  const base = { session, hook: true as const };
  if (status === "blocked") return { state: "blocked", ...base };
  const phase = turnPhase(record);
  if (phase.phase === "unprompted") return { state: "idle", ...base, completed: false };
  const idle = status === "idle" || status === "done";
  if (phase.phase === "working" && !idle) return { state: "working", ...base };
  const final = await readers.finalTurn(source, session).catch(() => undefined);
  if (phase.phase === "working") {
    if (final?.interrupted) return { state: "done", ...base, completed: true, interrupted: true };
    if (!final?.completed || final.background) return { state: "working", ...base };
    return { state: "done", ...base, completed: true, ...(final.error ? { error: final.error } : {}), ...replyFields(final.lastAssistant) };
  }
  const background = phase.background ?? (final?.completed ? final.background : undefined);
  const now = (readers.now ?? Date.now)();
  if (background && now - Date.parse(phase.at) < BACKGROUND_WAIT_MS) return { state: "working", ...base, background };
  return { state: "done", ...base, completed: true, endedAt: phase.at, ...(background ? { background } : {}),
    ...(final?.completed && final.error ? { error: final.error } : {}),
    ...(phase.reply ? replyFields(phase.reply, phase.truncated) : replyFields(final?.lastAssistant)) };
}

/** Receiving side: the state of each dispatched pane, from its agent's turn
 * record when its hooks wrote one, else from the shared snapshot and, once
 * the agent has stopped, the final reply in its transcript. */
export async function workerStates(input: unknown, readers: WorkerReaders = defaultReaders): Promise<{ workers: WorkerObservation[] }> {
  const { targets } = workerRequestSchema.parse(input);
  const snapshots = new Map<string, Promise<Json>>();
  const workers = await Promise.all(targets.map(async (target): Promise<WorkerObservation> => {
    let s: Json;
    try {
      if (!snapshots.has(target.server)) snapshots.set(target.server, readers.snapshot(target.server));
      s = await snapshots.get(target.server)!;
    } catch { return { state: "unavailable" }; }
    const pane = findPane(s, target);
    if (!pane) return { state: "gone" };
    const current = await readers.identity(target.server, pane).catch(() => undefined);
    const expected = "session" in target ? target.session : undefined;
    // Another conversation in the same pane means the worker is gone.
    if (expected && current && current !== expected) return { state: "gone" };
    const status = String(pane.agent_status);
    // The record counts only for the conversation this dispatch started, in
    // the terminal still there, and never for another dispatch's worker.
    const record = await readers.turn?.(target.server, pane, target.source).catch(() => undefined);
    const own = record && record.terminal === pane.terminal_id && record.source === target.source
      && record.session === (expected ?? current ?? record.session)
      && !(target.dispatch && record.dispatch && target.dispatch !== record.dispatch) ? record : undefined;
    if (own) return fromTurn(own, own.session, status, target.source, readers);
    const session = expected ?? current;
    const state = (["working", "idle", "done", "blocked"] as const).find(value => value === status) ?? "unknown";
    if ((state !== "idle" && state !== "done") || !session) return { state, ...(session ? { session } : {}) };
    const turn = await readers.finalTurn(target.source, session).catch(() => undefined);
    // A finished turn that left background work is still the worker's turn (no record to time the wait from).
    if (turn?.completed && turn.background) return { state: "working", session, background: turn.background };
    return { state, session, completed: turn?.completed === true, ...(turn?.error ? { error: turn.error } : {}),
      ...(turn?.interrupted ? { interrupted: true as const } : {}), ...replyFields(turn?.lastAssistant) };
  }));
  return { workers };
}

const observationSchema = z.object({
  state: z.enum(["working", "idle", "done", "blocked", "unknown", "gone", "unavailable"]),
  session: z.string().max(200).optional(), completed: z.boolean().optional(),
  reply: z.string().max(REPLY_LIMIT).optional(), truncated: z.boolean().optional(), error: z.string().max(500).optional(),
  hook: z.boolean().optional(), endedAt: z.string().max(40).optional(), background: z.number().int().min(0).max(999).optional(),
  interrupted: z.boolean().optional(),
}).passthrough();

/** What the owner is told when the worker's turn was interrupted in its terminal. */
export const INTERRUPTED = "The worker's turn was interrupted in its terminal before it finished.";

function turnKey(value: string | undefined): string | undefined {
  return value ? createHash("sha256").update(value).digest("hex").slice(0, 16) : undefined;
}

/** Apply one observation to a receipt. Returns true when the receipt changed. */
export function observe(receipt: Receipt, value: unknown, now: number): boolean {
  const parsed = observationSchema.safeParse(value);
  if (!parsed.success || parsed.data.state === "unavailable" || parsed.data.state === "unknown") return false;
  const seen = parsed.data, at = new Date(now).toISOString();
  let changed = false;
  // A worker that started without a conversation id gets its full target once one exists.
  if (seen.session && receipt.target && !("session" in receipt.target)) {
    const full = targetSchema.safeParse({ server: receipt.target.server, workspace: receipt.target.workspace, tab: receipt.target.tab,
      pane: receipt.target.pane, source: receipt.target.source, session: seen.session });
    if (full.success) { receipt.target = full.data; changed = true; }
  }
  // The most background work seen while the worker was working: what the
  // dispatcher is told it waited on when the worker finally returns.
  // A worker that took new work after returning starts the count again.
  const carried = seen.state === "working" && receipt.worker && receipt.worker.state !== "working" ? 0 : receipt.worker?.background ?? 0;
  const background = seen.state === "working" && seen.background ? Math.max(carried, seen.background) : carried;
  const sawWorking = receipt.worker?.sawWorking === true || seen.state === "working" || seen.state === "blocked";
  const stopped = seen.state === "idle" || seen.state === "done";
  // A turn the harness ended on an error (a usage limit) failed, reply or not,
  // and so did one the owner interrupted in the worker's terminal.
  const failed = stopped && seen.completed && seen.error ? seen.error : stopped && seen.interrupted ? INTERRUPTED : undefined;
  const question = seen.completed && seen.reply && !failed ? ownerQuestion(seen.reply) : undefined;
  let next: WorkerState;
  if (seen.state === "gone") next = "gone";
  else if (seen.state === "working") next = "working";
  else if (seen.state === "blocked") next = "blocked";
  else if (failed) next = "failed";
  else if (seen.completed) next = question ? "needs-you" : "done";
  // The worker's own hooks say no turn has ended: it has not taken its
  // brief yet. Without them, idle after being seen working is the only sign.
  else next = !seen.hook && sawWorking ? "done" : "working";
  // A Stop's time names its turn; without one, the final reply does.
  const turn = next === "done" || next === "needs-you" || next === "failed"
    ? turnKey(seen.endedAt ? `${seen.endedAt}\n${failed ?? ""}` : next === "failed" ? failed : seen.reply) : undefined;
  const previous = receipt.worker?.state;
  // The same finished state with a different final reply is a new turn: the
  // worker took more work (a hand_off) and finished again between two polls.
  const repeated = previous === next && !(turn && receipt.returned?.turn && turn !== receipt.returned.turn);
  if (repeated) {
    if (receipt.worker && receipt.worker.sawWorking !== sawWorking) { receipt.worker.sawWorking = sawWorking; changed = true; }
    if (receipt.worker && background > (receipt.worker.background ?? 0)) { receipt.worker.background = background; changed = true; }
    return changed;
  }
  receipt.worker = { state: next, since: at, checkedAt: at, sawWorking, ...(background ? { background } : {}) };
  if (next !== "working") {
    receipt.returned = { state: next, at, read: false,
      ...(seen.reply && (next === "done" || next === "needs-you") ? { reply: seen.reply, ...(seen.truncated ? { truncated: true } : {}) } : {}),
      ...(failed ? { error: failed } : {}), ...(question ? { question } : {}), ...(turn ? { turn } : {}),
      ...((next === "done" || next === "needs-you") && seen.background ? { background: seen.background } : {}),
      // Nothing still running: say what it waited on.
      ...((next === "done" || next === "needs-you") && !seen.background && background ? { waited: background } : {}) };
  }
  return true;
}

/** One line for the dispatching agent: who returned, how, and where to read it. */
export function noticeLine(receipts: readonly Receipt[]): string {
  const clean = (value: string, max: number) => value.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  const word = { "done": "done", "needs-you": "needs you", "failed": "failed", "blocked": "blocked", "gone": "gone" } as const;
  const describe = (receipt: Receipt, room: number) => {
    const returned = receipt.returned!;
    const detail = returned.state === "needs-you" ? returned.question : returned.state === "failed" ? returned.error
      : returned.state === "done" ? returned.reply?.split("\n").find(line => line.trim()) : undefined;
    const excerpt = detail ? clean(detail.replace(/[*_`#>]+/g, ""), room) : "";
    const tasks = (count: number) => `${count} background task${count === 1 ? "" : "s"}`;
    const left = returned.background ? ` (${tasks(returned.background)} still running)` : returned.waited ? ` (after ${tasks(returned.waited)} finished)` : "";
    return `${clean(receipt.computer, 60)} ${clean(receipt.label, 80)} ${word[returned.state]}${left}${excerpt ? `, ${excerpt}` : ""}`;
  };
  if (receipts.length === 1) return `Return: ${describe(receipts[0], 100)} (dispatch ${receipts[0].id}). Call dispatch_returns.`;
  const items = receipts.slice(0, 4).map(receipt => describe(receipt, 40)).join("; ");
  return `Returns: ${receipts.length} dispatches (${items}${receipts.length > 4 ? "; more" : ""}). Call dispatch_returns.`;
}

/** What `dispatch_returns` lists for one unread return. */
export function returnRow(receipt: Receipt): Json {
  const returned = receipt.returned!;
  return { id: receipt.id, computer: receipt.computer, project: receipt.project, label: receipt.label, harness: receipt.harness,
    state: returned.state, at: returned.at, ...(returned.reply !== undefined ? { reply: returned.reply } : {}),
    ...(returned.truncated ? { truncated: true } : {}), ...(returned.error ? { error: returned.error } : {}), ...(returned.question ? { question: returned.question } : {}),
    ...(returned.background ? { background: returned.background } : {}),
    ...(returned.waited && !returned.background ? { waited: returned.waited } : {}),
    ...(receipt.target ? { target: receipt.target } : {}) };
}

export interface DispatchReturnsOptions {
  peers?: () => Promise<HookPeer[]>;
  request?: typeof peerRequest;
  /** Worker states on this computer, for dispatches placed here without SSH. */
  localWorkers?: (input: Json) => Promise<{ workers: unknown[] }>;
  isLocal?: (computer: string) => boolean;
  /** A recent Herdr snapshot of a local server, to see whether the dispatching agent is idle. */
  snapshot?: (server: string) => Promise<Json>;
  identity?: (server: string, pane: Json) => Promise<string | undefined>;
  /** Types the notice into the dispatching agent, through the ordinary hand-off
   * path; the same notice keeps one delivery id, so a retry is never typed twice. */
  deliver?: (target: Target, text: string, deliveryId: string) => Promise<{ delivered: boolean }>;
  /** What a worker's hooks reported for a brief launched on this computer. */
  localArrival?: (id: string) => Promise<BriefArrival | undefined>;
  now?: () => number;
}

const originKey = (origin: OriginPane & { terminal: string }) => JSON.stringify([origin.server, origin.workspace, origin.tab, origin.pane, origin.terminal]);

/** One notice's delivery id, named by what it reports: the same returns keep the same id on a retry. */
export function noticeDeliveryId(receipts: readonly Receipt[]): string {
  return `notice-${createHash("sha256").update(receipts.map(receipt => `${receipt.id}@${receipt.returned!.at}`).sort().join(",")).digest("hex").slice(0, 32)}`;
}

/** Dispatching side: follows open dispatches and delivers their returns. */
export class DispatchReturns {
  private readonly peers: () => Promise<HookPeer[]>;
  private readonly request: typeof peerRequest;
  private readonly localWorkers: (input: Json) => Promise<{ workers: unknown[] }>;
  private readonly isLocal: (computer: string) => boolean;
  private readonly snapshot: (server: string) => Promise<Json>;
  private readonly identity: (server: string, pane: Json) => Promise<string | undefined>;
  private readonly deliver: (target: Target, text: string, deliveryId: string) => Promise<{ delivered: boolean }>;
  private readonly localArrival: (id: string) => Promise<BriefArrival | undefined>;
  private readonly now: () => number;
  private lastPoll = -Infinity;
  private readonly lastNotice = new Map<string, number>();
  /** A return is waiting for a dispatching agent that was busy: try again on
   * the next tick instead of the next poll. */
  private noticesDue = false;
  private running?: Promise<void>;

  constructor(options: DispatchReturnsOptions = {}) {
    this.peers = options.peers ?? hookPeers;
    this.request = options.request ?? peerRequest;
    this.localWorkers = options.localWorkers ?? (input => workerStates(input));
    this.isLocal = options.isLocal ?? (computer => isLocalComputer(computer));
    this.snapshot = options.snapshot ?? (server => sharedSnapshot(server, SNAPSHOT_AGE_MS));
    this.identity = options.identity ?? ((server, pane) => paneIdentity(server, pane));
    this.deliver = options.deliver ?? ((target, text, deliveryId) => handOff({ target, text }, { deliveryId }));
    this.localArrival = options.localArrival ?? briefArrival;
    this.now = options.now ?? Date.now;
  }

  /** Called from the Hook's activity tick. Polls peers at most every POLL_MS;
   * a return waiting for its notice is tried on every tick, so one recorded
   * while the dispatching agent was busy reaches it as soon as it stops. */
  tick(): Promise<void> {
    if (this.running) return this.running;
    const poll = this.now() - this.lastPoll >= POLL_MS;
    if (!poll && !this.noticesDue) return Promise.resolve();
    if (poll) this.lastPoll = this.now();
    this.running = (async () => { if (poll) await this.poll(); await this.notify(); })()
      .catch(() => {}).finally(() => { this.running = undefined; });
    return this.running;
  }

  /**
   * A brief that went with the launch but was not confirmed while the dispatch
   * was placed (a startup screen held it, the agent was slow): ask the
   * worker's computer whether its hook has confirmed it since.
   */
  async confirmArrivals(peers: HookPeer[]): Promise<void> {
    const now = this.now();
    const unconfirmed = (await dispatchStatus()).filter(receipt => receipt.state === "uncertain" && receipt.brief === "launch"
      && now - Date.parse(receipt.createdAt) < WATCH_MS).slice(0, 64);
    for (const receipt of unconfirmed) {
      const peer = peers.find(candidate => candidate.name === receipt.computer);
      if (!peer && !this.isLocal(receipt.computer)) continue;
      const arrival = await (peer ? arrivalOf({ request: route => this.request(peer, route) }, receipt.id) : this.localArrival(receipt.id)).catch(() => undefined);
      if (!arrival?.accepted) continue;
      const named = arrival.accepted.target;
      await updateReceipt(receipt.id, current => {
        if (current.state !== "uncertain") return false;
        current.state = "accepted"; delete current.error;
        if (named.source === current.harness) current.target = named;
        return true;
      }).catch(() => undefined);
    }
  }

  /** Ask each peer, once, about every open dispatch placed on it. */
  async poll(): Promise<void> {
    await this.confirmArrivals(await this.peers().catch(() => [] as HookPeer[]));
    const now = this.now();
    const open = (await dispatchStatus()).filter(receipt => (receipt.state === "accepted" || receipt.state === "uncertain")
      && receipt.target && receipt.worker?.state !== "gone" && now - Date.parse(receipt.createdAt) < WATCH_MS);
    if (!open.length) return;
    const peers = await this.peers().catch(() => [] as HookPeer[]);
    const byComputer = new Map<string, Receipt[]>();
    for (const receipt of open) byComputer.set(receipt.computer, [...byComputer.get(receipt.computer) ?? [], receipt]);
    await Promise.all([...byComputer].map(async ([computer, receipts]) => {
      // A dispatch placed on this computer is read here, without SSH.
      const peer = peers.find(candidate => candidate.name === computer);
      const local = !peer && this.isLocal(computer);
      if (!peer && !local) return;
      for (let start = 0; start < receipts.length; start += 64) {
        const batch = receipts.slice(start, start + 64);
        const input = { targets: batch.map(receipt => ({ ...receipt.target!, dispatch: receipt.id })) };
        // An unreachable peer records nothing: silence is not a transition.
        const answer: Json | undefined = await (peer ? this.request(peer, "/v1/dispatch/workers", input) : this.localWorkers(input) as Promise<Json>).catch(() => undefined);
        const workers = objects(answer?.workers);
        if (workers.length !== batch.length) continue;
        for (const [index, receipt] of batch.entries()) {
          await updateReceipt(receipt.id, current => observe(current, workers[index], this.now())).catch(() => undefined);
        }
      }
    }));
  }

  /** Type one line into each idle dispatching agent that has returns it was
   * not told about. A pane still working is tried again on the next tick. */
  async notify(): Promise<void> {
    const waiting = (await dispatchStatus()).filter(receipt => receipt.origin && receipt.returned && !receipt.returned.read && !receipt.returned.notifiedAt);
    let busy = false;
    const byOrigin = new Map<string, Receipt[]>();
    for (const receipt of waiting) byOrigin.set(originKey(receipt.origin!), [...byOrigin.get(originKey(receipt.origin!)) ?? [], receipt]);
    for (const [key, receipts] of byOrigin) {
      if (this.now() - (this.lastNotice.get(key) ?? -Infinity) < NOTICE_MS) continue;
      const origin = receipts[0].origin!;
      const pane = findPane(await this.snapshot(origin.server).catch(() => ({})), { ...origin, source: origin.agent });
      // Never interrupt: only an agent that has stopped, in the same terminal, gets a notice.
      if (!pane || pane.terminal_id !== origin.terminal) continue;
      if (!["idle", "done"].includes(String(pane.agent_status))) { busy = true; continue; }
      const session = await this.identity(origin.server, pane).catch(() => undefined);
      const target = targetSchema.safeParse({ server: origin.server, workspace: origin.workspace, tab: origin.tab, pane: origin.pane, source: origin.agent, session });
      if (!target.success) continue;
      this.lastNotice.set(key, this.now());
      const sent = await this.deliver(target.data, noticeLine(receipts), noticeDeliveryId(receipts)).catch(() => ({ delivered: false }));
      if (!sent.delivered) continue;
      const at = new Date(this.now()).toISOString();
      for (const receipt of receipts) {
        await updateReceipt(receipt.id, current => {
          if (!current.returned || current.returned.read || current.returned.at !== receipt.returned!.at) return false;
          current.returned.notifiedAt = at; return true;
        }).catch(() => undefined);
      }
    }
    this.noticesDue = busy;
  }

  /** Every unread return, oldest first, marked read as it is handed over. */
  async take(): Promise<Json[]> {
    const unread = (await dispatchStatus()).filter(receipt => receipt.returned && !receipt.returned.read)
      .sort((a, b) => a.returned!.at.localeCompare(b.returned!.at));
    const rows: Json[] = [];
    for (const receipt of unread) {
      let marked = false;
      const current = await updateReceipt(receipt.id, value => {
        if (!value.returned || value.returned.read) return false;
        value.returned.read = true; marked = true; return true;
      }).catch(() => undefined);
      // A concurrent take already handed this one over.
      if (marked && current?.returned) rows.push(returnRow(current));
    }
    return rows;
  }
}
