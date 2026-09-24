import { createHash } from "node:crypto";
import { z } from "zod";
import { dispatchStatus, updateReceipt, type OriginPane, type Receipt, type WorkerState } from "./dispatch.js";
import { findPane, paneIdentity, sharedSnapshot } from "./herdr.js";
import { handOff } from "./hand-off.js";
import { hookPeers, peerRequest, type HookPeer } from "./peers.js";
import { isLocalComputer } from "./dispatch-hosts.js";
import { objects, startingTargetSchema, targetSchema, type Json, type Provider, type Target } from "./protocol.js";
import { ownerQuestion, readFinalTurn, type FinalTurn } from "./schedule-watch.js";

/**
 * The conductor's returns loop. The worker's computer answers what its
 * dispatched panes are doing from the Herdr snapshot its Hook already shares
 * (`workerStates`); the dispatching Hook asks each peer once per poll for all
 * of its open dispatches, records transitions in the receipts, and tells an
 * idle dispatching agent that returns are waiting (`DispatchReturns`).
 */

/** Longest final reply kept in a receipt, in UTF-8 bytes. */
export const REPLY_LIMIT = 4000;
/** How often the dispatching Hook asks peers about open dispatches. */
export const POLL_MS = 15_000;
/** Shortest gap between two notices typed into the same dispatching pane. */
export const NOTICE_MS = 120_000;
/** Receipts older than this are no longer watched. */
export const WATCH_MS = 24 * 60 * 60 * 1000;
/** An idle worker that was never seen working and has no finished turn is
 * counted as done after this long: the prompt may never have been taken. */
export const IDLE_GRACE_MS = 5 * 60 * 1000;
/** How old a shared Herdr snapshot may be when answering a peer. */
const SNAPSHOT_AGE_MS = 5_000;

const workerTarget = z.union([targetSchema, startingTargetSchema]);
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
}

export interface WorkerReaders {
  snapshot: (server: string) => Promise<Json>;
  identity: (server: string, pane: Json) => Promise<string | undefined>;
  finalTurn: (source: Provider, session: string) => Promise<FinalTurn | undefined>;
}

const defaultReaders: WorkerReaders = {
  snapshot: server => sharedSnapshot(server, SNAPSHOT_AGE_MS),
  identity: (server, pane) => paneIdentity(server, pane),
  finalTurn: (source, session) => source === "codex" || source === "claude" || source === "opencode" ? readFinalTurn(source, session) : Promise.resolve(undefined),
};

/** `value` cut to at most `limit` UTF-8 bytes on a character boundary. */
export function truncateUtf8(value: string, limit = REPLY_LIMIT): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value);
  if (bytes.length <= limit) return { text: value, truncated: false };
  let end = limit;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

/** Receiving side: the state of each dispatched pane, from the shared snapshot
 * and, once the agent has stopped, the final reply in its transcript. */
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
    const session = expected ?? current;
    const status = String(pane.agent_status);
    const state = (["working", "idle", "done", "blocked"] as const).find(value => value === status) ?? "unknown";
    if ((state !== "idle" && state !== "done") || !session) return { state, ...(session ? { session } : {}) };
    const turn = await readers.finalTurn(target.source, session).catch(() => undefined);
    const reply = turn?.lastAssistant ? truncateUtf8(turn.lastAssistant) : undefined;
    return { state, session, completed: turn?.completed === true, ...(turn?.error ? { error: turn.error } : {}),
      ...(reply ? { reply: reply.text, ...(reply.truncated ? { truncated: true } : {}) } : {}) };
  }));
  return { workers };
}

const observationSchema = z.object({
  state: z.enum(["working", "idle", "done", "blocked", "unknown", "gone", "unavailable"]),
  session: z.string().max(200).optional(), completed: z.boolean().optional(),
  reply: z.string().max(REPLY_LIMIT).optional(), truncated: z.boolean().optional(), error: z.string().max(500).optional(),
}).passthrough();

function turnKey(reply: string | undefined): string | undefined {
  return reply ? createHash("sha256").update(reply).digest("hex").slice(0, 16) : undefined;
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
  const sawWorking = receipt.worker?.sawWorking === true || seen.state === "working" || seen.state === "blocked";
  // A turn the harness ended on an error (a usage limit) failed, reply or not.
  const failed = seen.completed && seen.error ? seen.error : undefined;
  const question = seen.completed && seen.reply && !failed ? ownerQuestion(seen.reply) : undefined;
  let next: WorkerState;
  if (seen.state === "gone") next = "gone";
  else if (seen.state === "working") next = "working";
  else if (seen.state === "blocked") next = "blocked";
  else if (failed) next = "failed";
  else if (seen.completed) next = question ? "needs-you" : "done";
  else next = sawWorking || now - Date.parse(receipt.createdAt) > IDLE_GRACE_MS ? "done" : "working";
  const turn = next === "done" || next === "needs-you" ? turnKey(seen.reply) : next === "failed" ? turnKey(failed) : undefined;
  const previous = receipt.worker?.state;
  // The same finished state with a different final reply is a new turn: the
  // worker took more work (a hand_off) and finished again between two polls.
  const repeated = previous === next && !(turn && receipt.returned?.turn && turn !== receipt.returned.turn);
  if (repeated) {
    if (receipt.worker && receipt.worker.sawWorking !== sawWorking) { receipt.worker.sawWorking = sawWorking; changed = true; }
    return changed;
  }
  receipt.worker = { state: next, since: at, checkedAt: at, sawWorking };
  if (next !== "working") {
    receipt.returned = { state: next, at, read: false,
      ...(seen.reply && (next === "done" || next === "needs-you") ? { reply: seen.reply, ...(seen.truncated ? { truncated: true } : {}) } : {}),
      ...(failed ? { error: failed } : {}), ...(question ? { question } : {}), ...(turn ? { turn } : {}) };
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
    return `${clean(receipt.computer, 60)} ${clean(receipt.label, 80)} ${word[returned.state]}${excerpt ? `, ${excerpt}` : ""}`;
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
  /** Types the notice into the dispatching agent, through the ordinary hand-off path. */
  deliver?: (target: Target, text: string) => Promise<{ delivered: boolean }>;
  now?: () => number;
}

const originKey = (origin: OriginPane & { terminal: string }) => JSON.stringify([origin.server, origin.workspace, origin.tab, origin.pane, origin.terminal]);

/** Dispatching side: follows open dispatches and delivers their returns. */
export class DispatchReturns {
  private readonly peers: () => Promise<HookPeer[]>;
  private readonly request: typeof peerRequest;
  private readonly localWorkers: (input: Json) => Promise<{ workers: unknown[] }>;
  private readonly isLocal: (computer: string) => boolean;
  private readonly snapshot: (server: string) => Promise<Json>;
  private readonly identity: (server: string, pane: Json) => Promise<string | undefined>;
  private readonly deliver: (target: Target, text: string) => Promise<{ delivered: boolean }>;
  private readonly now: () => number;
  private lastPoll = -Infinity;
  private readonly lastNotice = new Map<string, number>();
  private running?: Promise<void>;

  constructor(options: DispatchReturnsOptions = {}) {
    this.peers = options.peers ?? hookPeers;
    this.request = options.request ?? peerRequest;
    this.localWorkers = options.localWorkers ?? (input => workerStates(input));
    this.isLocal = options.isLocal ?? (computer => isLocalComputer(computer));
    this.snapshot = options.snapshot ?? (server => sharedSnapshot(server, SNAPSHOT_AGE_MS));
    this.identity = options.identity ?? ((server, pane) => paneIdentity(server, pane));
    this.deliver = options.deliver ?? ((target, text) => handOff({ target, text }));
    this.now = options.now ?? Date.now;
  }

  /** Called from the Hook's activity tick; polls and notifies at most every POLL_MS. */
  tick(): Promise<void> {
    if (this.running || this.now() - this.lastPoll < POLL_MS) return this.running ?? Promise.resolve();
    this.lastPoll = this.now();
    this.running = (async () => { await this.poll(); await this.notify(); })().catch(() => {}).finally(() => { this.running = undefined; });
    return this.running;
  }

  /** Ask each peer, once, about every open dispatch placed on it. */
  async poll(): Promise<void> {
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
        const input = { targets: batch.map(receipt => receipt.target!) };
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

  /** Type one line into each idle dispatching agent that has returns it was not told about. */
  async notify(): Promise<void> {
    const waiting = (await dispatchStatus()).filter(receipt => receipt.origin && receipt.returned && !receipt.returned.read && !receipt.returned.notifiedAt);
    const byOrigin = new Map<string, Receipt[]>();
    for (const receipt of waiting) byOrigin.set(originKey(receipt.origin!), [...byOrigin.get(originKey(receipt.origin!)) ?? [], receipt]);
    for (const [key, receipts] of byOrigin) {
      if (this.now() - (this.lastNotice.get(key) ?? -Infinity) < NOTICE_MS) continue;
      const origin = receipts[0].origin!;
      const pane = findPane(await this.snapshot(origin.server).catch(() => ({})), { ...origin, source: origin.agent });
      // Never interrupt: only an agent that has stopped, in the same terminal, gets a notice.
      if (!pane || pane.terminal_id !== origin.terminal || !["idle", "done"].includes(String(pane.agent_status))) continue;
      const session = await this.identity(origin.server, pane).catch(() => undefined);
      const target = targetSchema.safeParse({ server: origin.server, workspace: origin.workspace, tab: origin.tab, pane: origin.pane, source: origin.agent, session });
      if (!target.success) continue;
      this.lastNotice.set(key, this.now());
      const sent = await this.deliver(target.data, noticeLine(receipts)).catch(() => ({ delivered: false }));
      if (!sent.delivered) continue;
      const at = new Date(this.now()).toISOString();
      for (const receipt of receipts) {
        await updateReceipt(receipt.id, current => {
          if (!current.returned || current.returned.read || current.returned.at !== receipt.returned!.at) return false;
          current.returned.notifiedAt = at; return true;
        }).catch(() => undefined);
      }
    }
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
