import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { z } from "zod";
import { materializedPath } from "./codex-threads.js";
import { atomicInPrivateDir, BridgeError, object, objects, provider, sessionId, type Json, type Provider, type Target } from "./protocol.js";
import { transcriptPath, unwrapPastedContent } from "./transcripts.js";

/** A delivery the agent's turn ended without: the reason the phone shows. */
export const TURN_ENDED_WITHOUT_IT = "The agent finished its turn without taking the message.";

export type DeliveryOutcome = "delivered" | "pending";
/** What a phone message is known to have become. `queued`: typed into the
 * pane and held by the agent until its turn ends. `failed` carries a reason
 * and may still turn `delivered` if the agent takes it late. */
export type DeliveryState = "queued" | "delivered" | "failed";
/** A transcript row carrying a message's words: its byte offset, and whether the agent fires UserPromptSubmit for it (a user row does; a mid-turn queue removal does not). */
/** A transcript row with a message's words: its byte offset, whether it is a user row, when it was stamped, and
 * the row's own id where the harness writes one (Claude's `uuid`). */
export interface TranscriptEntry { offset: number; hook: boolean; at?: number; uuid?: string;
  /** The row the conversation stream shows for this one, when that is another (a Codex rollout's user item). */
  shown?: number }
export type TrackedState = DeliveryState | "unknown";
/** The transcript row a delivered message landed as: the line the conversation stream numbers it by (`Entry.line`,
 * 0-based) and, for Claude, the row's `uuid`. A phone matches its pending send to that row, not to its text. */
export interface LandedRow { line: number; uuid?: string }
export interface DeliveryStatus { state: TrackedState; reason?: string; session?: string; landed?: LandedRow }

/** A message is kept this long, by its id, so a late status or a retry still
 * finds it: a busy Codex turn can run far past the old ten minutes. */
export const DELIVERY_RETENTION_MS = 24 * 3_600_000;
/** An agent that ended its turn after the message was typed and then stayed
 * idle this long without taking it has dropped it. */
export const DELIVERY_GIVE_UP_MS = 30_000;
const MAX_RECORDS = 512;
/** How often a message still held by a working agent is looked for in its transcript. */
const LANDED_CHECK_MS = 3_000;
/** The transcript scan starts this long before a message was typed (clock skew), so entries up to this far back may belong to an earlier message. */
const ENTRY_SLACK_MS = 5_000;
/** A transcript is read from its last this many bytes: older rows are out of sight. */
const TRANSCRIPT_TAIL_BYTES = 524_288;
/** Claude writes a submitted row after its hooks return; a message its hook settled claims only a row stamped within this long of that. */
const HOOK_ROW_MS = 30_000;
/** How long after a phone message settled its row's line is still looked for. */
const LOCATE_FOR_MS = 5 * 60_000;
/** Typed text holds its pane (nothing more is typed there) at most this long when the pane sends no
 * UserPromptSubmit or Stop to settle it: a message such an agent took or dropped never settles. */
export const IN_FLIGHT_MS = 45_000;

/** What the agent hands its UserPromptSubmit hook is the terminal's pasted
 * form of what Phren typed; compare the words, not the wrapping. Claude Code
 * also takes each attached picture's path line out of the text and puts an
 * "[Image #N]" label at the front, so neither side keeps picture paths or
 * labels. */
export function promptKey(text: string): string {
  return unwrapPastedContent(text).split("\n").filter(line => !PICTURE_PATH_LINE.test(line)).join("\n")
    .replace(/\[Image #\d+\]/g, " ").replace(/\s+/g, " ").trim();
}
const PICTURE_PATH_LINE = /^\s*\/.*\.(?:png|jpe?g|gif|webp)\s*$/i;
export const promptHash = (text: string) => createHash("sha256").update(promptKey(text)).digest("hex");
/** A submitted prompt is searched for held messages joined into it over at most this many of its lines. */
const JOINED_MAX_LINES = 64;
/** Of the open messages in a pane, at most this many are matched against a joined prompt's lines. */
const JOINED_MAX_OPEN = 32;
/** The line runs hashed for one joined prompt come to at most this many characters. */
const JOINED_MAX_CHARS = 1_048_576;

const recordSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(), hash: z.string().regex(/^[0-9a-f]{64}$/),
  server: z.string().min(1).max(200), pane: z.string().min(1).max(200), source: provider, session: z.string().min(1).max(200),
  terminal: z.string().max(200).optional(), state: z.enum(["typed", "queued", "delivered", "failed"]),
  reason: z.string().max(500).optional(), at: z.number(), settledAt: z.number().optional(), stoppedAt: z.number().optional(),
  /** The transcript entry (byte offset) that settled it, so no other message claims the same one. */
  entry: z.number().optional(),
  /** Whether that entry is a user row (one its agent's UserPromptSubmit fired for), not a mid-turn queue removal. */
  entryHook: z.boolean().optional(),
  /** From a joined prompt (`settleJoined`): "part", a message settled inside it, claims no row of its own (the turn's
   * row carries other words); "turn", the joined words themselves, no message of anyone's, claims that row. */
  joined: z.enum(["part", "turn"]).optional(),
  /** Claude/Codex: the transcript's size in bytes when the message was registered. Only a row at or past it is
   * the message's own: position, not the clock, orders rows, and a row without a timestamp too. */
  cursor: z.number().int().nonnegative().optional(),
}).strict();
/** In memory only: `hookClaim`, a UserPromptSubmit came for these words before any row was readable, so the
 * row (in the callback's conversation, now the record's) may settle it when it appears, even once failed; `seenRow`, a user row a working check saw in a pane that has sent no
 * callbacks, settled at the next check if no hook claimed it meanwhile; `awaitingRow`, a message its hook settled
 * before its row was written (Codex, or a Claude phone message), which claims that row when it appears (for
 * `HOOK_ROW_MS`); `entryLate`, that claim was a Claude phone message's, made only to name its row, which a later
 * identical message's hook does not wait on (`submitted`).
 * Kept in `<file>.landed.json` beside the records, not in them, so an older Hook still reads every record: the row
 * a phone message landed as (`landed`), as `entryLine` (0-based, as the conversation stream numbers rows),
 * `entryUuid` (Claude's row id) and `entryShown`, the offset of the row the stream shows for it when that is not
 * the claimed entry (a Codex rollout's user item, written beside the event that is the turn). */
type Record = z.infer<typeof recordSchema> & { idleSince?: number; checkedAt?: number; hookClaim?: boolean; seenRow?: number; awaitingRow?: boolean;
  entryLate?: boolean; entryLine?: number; entryUuid?: string; entryShown?: number;
  /** The Claude queue enqueue occurrence this phone message was typed as, and the queue rows that
   * took it: the byte offset of each. The transcript's own queue rows carry no phone id, so the
   * binding is what gives the enqueue, its removal and its submitted turn one identity. */
  queueOffset?: number; queueAt?: number; queueKey?: string; queueEnd?: "consumed" | "returned"; queueRemoveOffset?: number; queueUserOffset?: number; queueDequeueOffset?: number };
const landedFile = (file: string) => `${file}.landed.json`;
const landedSchema = z.object({ line: z.number().int().nonnegative().optional(), uuid: z.string().min(1).max(100).optional(),
  shown: z.number().int().nonnegative().optional(), late: z.literal(true).optional() }).strict();
const queueBindingsFile = (file: string) => `${file}.queue.json`;
const queueBindingSchema = z.object({ offset: z.number().int().nonnegative().optional(), at: z.number().optional(),
  key: z.string().regex(/^[0-9a-f]{64}$/).optional(), end: z.enum(["consumed", "returned"]).optional(),
  remove: z.number().int().nonnegative().optional(), user: z.number().int().nonnegative().optional(),
  dequeue: z.number().int().nonnegative().optional() }).strict();
/** One raw Claude transcript row and the byte offset it starts at: the queue rows a phone message's
 * identity is read from. */
export interface ClaudeQueueRow { offset: number; raw: Json }
interface Waiter { resolve?: (outcome: DeliveryOutcome) => void; timer?: ReturnType<typeof setTimeout>; late?: (outcome: DeliveryOutcome) => void }

/** One message per record, bound to the pane it was typed into (server, pane,
 * agent kind), not to the conversation: a Codex thread or a Claude /clear can
 * replace the conversation while the agent still holds the typed text, and
 * the conversation that submits it is the one it reached. Records hold a hash
 * of the words, never the text, and those with a phone id are written to
 * `file` so a Hook restart keeps their state. */
export class PromptDeliveries {
  private records: Record[] = [];
  private waiters = new Map<Record, Waiter>();
  private writing: Promise<void> = Promise.resolve();
  /** Panes (server, pane, agent) that sent a UserPromptSubmit or Stop since the Hook started. */
  private hookPanes = new Set<string>();
  /** When each pane (server, pane, agent) last sent a Stop since the Hook started. */
  private lastStop = new Map<string, number>();
  private paneKey(target: Pick<Target, "server" | "pane" | "source">) { return [target.server, target.pane, target.source].join("|"); }
  private static open(record: Record) { return record.state === "typed" || record.state === "queued"; }
  /** Open, or failed with its own hook's claim still waiting for its row (a late delivery). */
  private static claimable(record: Record) { return PromptDeliveries.open(record) || (record.state === "failed" && !!record.hookClaim); }

  /** The queue bindings last read from each Claude conversation, and the transcript revision they describe. */
  private queueCache = new Map<string, { signature: string; size: number; mtimeMs: number; bindings: Map<number, string> }>();

  /** Messages whose `cursor` is still being read. */
  private cursors = new Map<Record, Promise<void>>();
  /** The size of a conversation's transcript: 0 before it has one, undefined when it cannot be read. */
  private size: (record: { source: Provider; session: string }) => Promise<number | undefined>;

  /** The line (0-based) of the row at a byte offset in a conversation's transcript, when one still starts there
   * (and carries `uuid`, when given). */
  private lineOf: (record: { source: Provider; session: string }, offset: number, uuid?: string) => Promise<number | undefined>;

  constructor(private file?: string, private now: () => number = Date.now,
    private landed: (record: { source: Provider; session: string; hash: string; at: number }) => Promise<TranscriptEntry[]> = transcriptEntries,
    size?: (record: { source: Provider; session: string }) => Promise<number | undefined>,
    lineOf?: (record: { source: Provider; session: string }, offset: number, uuid?: string) => Promise<number | undefined>) {
    // A store reading other transcripts than the agents' own has no sizes or lines for them.
    this.size = size ?? (landed === transcriptEntries ? transcriptSize : async () => undefined);
    this.lineOf = lineOf ?? (landed === transcriptEntries ? transcriptLine : async () => undefined);
    if (!file) return;
    try {
      for (const row of objects(object(JSON.parse(readFileSync(file, "utf8"))).records)) {
        const parsed = recordSchema.safeParse(row);
        // A message the Hook was typing when it stopped is in the pane or
        // nowhere: wait for the agent, and give up as for any other.
        if (parsed.success) this.records.push({ ...parsed.data, state: parsed.data.state === "typed" ? "queued" : parsed.data.state });
      }
    } catch { /* No file yet, or an unreadable one: start empty. */ }
    try {
      for (const [id, row] of Object.entries(object(JSON.parse(readFileSync(landedFile(file), "utf8"))))) {
        const parsed = landedSchema.safeParse(row), record = this.byId(id);
        if (!parsed.success || !record || record.entry === undefined) continue;
        if (parsed.data.line !== undefined) record.entryLine = parsed.data.line;
        if (parsed.data.uuid) record.entryUuid = parsed.data.uuid;
        if (parsed.data.shown !== undefined) record.entryShown = parsed.data.shown;
        if (parsed.data.late) record.entryLate = true;
      }
    } catch { /* None yet: rows found before this version, or none. */ }
    try {
      // The queue occurrence each phone message was bound to, apart from the records an older Hook
      // reads strictly. Keyed by phone id, so a record it no longer keeps is simply not found.
      for (const [id, row] of Object.entries(object(JSON.parse(readFileSync(queueBindingsFile(file), "utf8"))))) {
        const parsed = queueBindingSchema.safeParse(row), record = this.byId(id);
        if (!parsed.success || !record) continue;
        if (parsed.data.offset !== undefined) record.queueOffset = parsed.data.offset;
        if (parsed.data.at !== undefined) record.queueAt = parsed.data.at;
        if (parsed.data.key !== undefined) record.queueKey = parsed.data.key;
        if (parsed.data.end !== undefined) record.queueEnd = parsed.data.end;
        if (parsed.data.remove !== undefined) record.queueRemoveOffset = parsed.data.remove;
        if (parsed.data.user !== undefined) record.queueUserOffset = parsed.data.user;
        if (parsed.data.dequeue !== undefined) record.queueDequeueOffset = parsed.data.dequeue;
      }
    } catch { /* None yet: no message of this Hook's has been bound to a queue row. */ }
    this.prune();
  }

  private samePane(record: Record, target: Pick<Target, "server" | "pane" | "source">) {
    return record.server === target.server && record.pane === target.pane && record.source === target.source;
  }
  private byId(id: string) { return this.records.find(record => record.id === id); }
  private prune() {
    const cutoff = this.now() - DELIVERY_RETENTION_MS;
    this.records = this.records.filter(record => record.at >= cutoff || this.waiters.has(record));
    while (this.records.length > MAX_RECORDS) this.records.shift();
    while (this.queueCache.size > 64) this.queueCache.delete(this.queueCache.keys().next().value!);
  }
  private save() {
    if (!this.file) return;
    // A record without a phone id is kept once it claimed a transcript row, so after a restart that row is not offered to another message.
    const kept = this.records.filter(record => record.id || record.entry !== undefined || record.joined === "turn");
    const rows = kept.map(({ idleSince: _, checkedAt: __, hookClaim: ___, seenRow: ____, awaitingRow: _____, entryLate: _a, entryLine: _b, entryUuid: _c, entryShown: _d,
      queueOffset: _e, queueAt: _f, queueRemoveOffset: _g, queueUserOffset: _h, queueDequeueOffset: _i, queueKey: _j, queueEnd: _k, ...row }) => row);
    // The rows phone messages landed as, apart from the records an older Hook reads strictly.
    const landed: Json = {};
    for (const record of kept) if (record.id && record.entry !== undefined && (record.entryLine !== undefined || record.entryUuid || record.entryShown !== undefined || record.entryLate)) {
      landed[record.id] = { ...(record.entryLine !== undefined ? { line: record.entryLine } : {}), ...(record.entryUuid ? { uuid: record.entryUuid } : {}),
        ...(record.entryShown !== undefined ? { shown: record.entryShown } : {}), ...(record.entryLate ? { late: true } : {}) };
    }
    // The Claude queue occurrence each phone message was typed as, beside the records for the same reason.
    const queue: Json = {};
    for (const record of kept) if (record.id && (record.queueOffset !== undefined || record.queueRemoveOffset !== undefined)) {
      queue[record.id] = { ...(record.queueOffset !== undefined ? { offset: record.queueOffset } : {}), ...(record.queueAt !== undefined ? { at: record.queueAt } : {}),
        ...(record.queueKey !== undefined ? { key: record.queueKey } : {}), ...(record.queueEnd !== undefined ? { end: record.queueEnd } : {}),
        ...(record.queueRemoveOffset !== undefined ? { remove: record.queueRemoveOffset } : {}),
        ...(record.queueUserOffset !== undefined ? { user: record.queueUserOffset } : {}),
        ...(record.queueDequeueOffset !== undefined ? { dequeue: record.queueDequeueOffset } : {}) };
    }
    const file = this.file;
    this.writing = this.writing.then(async () => {
      await atomicInPrivateDir(file, { records: rows });
      await atomicInPrivateDir(landedFile(file), landed);
      await atomicInPrivateDir(queueBindingsFile(file), queue);
    }).catch(() => undefined);
  }
  /** Settled writes, for tests and an orderly shutdown. */
  flush(): Promise<void> { return this.writing; }

  /** Register a message about to be typed into `target`'s pane. Settles
   * "delivered" once a conversation in that pane submits the words, or
   * "pending" after `waitMs`; the record outlives the wait. A retry of a
   * failed id replaces its record. Aborting (the terminal refused before
   * writing) drops it. */
  expect(target: Target, text: string, waitMs: number, signal?: AbortSignal, id?: string, terminal?: string): Promise<DeliveryOutcome> {
    if (!promptKey(text) || signal?.aborted) return Promise.resolve("pending");
    this.prune();
    if (id) this.records = this.records.filter(record => record.id !== id);
    const record: Record = { ...(id ? { id } : {}), hash: promptHash(text), server: target.server, pane: target.pane, source: target.source,
      session: target.session, ...(typeof terminal === "string" ? { terminal } : {}), state: "typed", at: this.now() };
    this.records.push(record);
    this.save();
    // Started before the caller types the message (a stat, against typing, then the agent's own write), so
    // the row it makes lands past the cursor; a row stamped after registration counts too (`codexRowIsOwn`).
    if (record.source === "codex" || record.source === "claude") {
      // The cursor is this conversation's size before anything is typed. A queued row (an
      // enqueue, or a removal whose enqueue scrolled out of the tail) must start at or past
      // it to be this message's; an identical row already there is an earlier turn's.
      const session = record.session;
      this.cursors.set(record, this.size(record).then(size => { if (size !== undefined && record.session === session) { record.cursor = size; this.save(); } }, () => undefined)
        .finally(() => this.cursors.delete(record)));
    }
    return new Promise<DeliveryOutcome>(resolve => {
      const timer = setTimeout(() => this.release(record, "pending"), waitMs);
      timer.unref?.();
      this.waiters.set(record, { resolve, timer });
      signal?.addEventListener("abort", () => {
        this.release(record, "pending");
        if (record.state === "typed") { this.records = this.records.filter(entry => entry !== record); this.save(); }
      }, { once: true });
    });
  }
  private release(record: Record, outcome: DeliveryOutcome) {
    const waiter = this.waiters.get(record);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    waiter.resolve?.(outcome); waiter.resolve = undefined;
    if (outcome !== "pending") waiter.late?.(outcome);
    if (outcome !== "pending" || !waiter.late) this.waiters.delete(record);
  }

  private open(target: Target, text: string) {
    const hash = promptHash(text);
    return this.records.find(record => record.hash === hash && this.samePane(record, target) && (record.state === "typed" || record.state === "queued"));
  }
  /** A message Phren typed into `target`'s pane that no conversation there has submitted yet. */
  pending(target: Target, text: string, id?: string): boolean {
    if (!id) return !!this.open(target, text);
    const record = this.find(id, target);
    return !!record && PromptDeliveries.open(record) && record.session === target.session && record.hash === promptHash(text);
  }
  /** Whether `record` still holds its pane: open, and either young or in a pane whose hooks will settle it. */
  private inFlight(record: Record): boolean {
    return PromptDeliveries.open(record) && (this.now() - record.at < IN_FLIGHT_MS || this.hookPanes.has(this.paneKey(record)));
  }
  /** Whether any message typed into `target`'s pane is still waiting to be taken or refused.
   * A pre-typing guard can exclude only its own freshly registered reservation by id. */
  holding(target: Pick<Target, "server" | "pane" | "source">, exceptId?: string): boolean { return this.records.some(record => (exceptId === undefined || record.id !== exceptId) && this.samePane(record, target) && this.inFlight(record)); }
  /** Whether phone message `id` may still be taken: held by the agent, and in flight as `holding` counts it. */
  held(id: string, target: Pick<Target, "server" | "pane" | "source">): boolean { const record = this.find(id, target); return !!record && this.inFlight(record); }
  /** Wait again for a message `expect` reported pending, after a second Enter. */
  awaitLate(target: Target, text: string, waitMs = 2_500): Promise<DeliveryOutcome> {
    const record = this.open(target, text);
    if (!record) return Promise.resolve("pending");
    return new Promise<DeliveryOutcome>(resolve => {
      const waiter = this.waiters.get(record) ?? {};
      const timer = setTimeout(() => { waiter.late = undefined; if (!waiter.resolve) this.waiters.delete(record); resolve("pending"); }, waitMs);
      timer.unref?.();
      waiter.late = outcome => { clearTimeout(timer); waiter.late = undefined; resolve(outcome); };
      this.waiters.set(record, waiter);
    });
  }

  private find(id: string, target: Pick<Target, "server" | "pane" | "source">) {
    const record = this.byId(id);
    return record && this.samePane(record, target) && this.now() - record.at <= DELIVERY_RETENTION_MS ? record : undefined;
  }
  /** The Hook answered `id` as typed and held by the agent. */
  queue(id: string, target: Target): void {
    const record = this.find(id, target);
    if (record?.state === "typed") { record.state = "queued"; this.save(); }
  }
  /** Delivered without a hook: an app-server turn or a served OpenCode prompt. */
  delivered(id: string | undefined, target: Target, text: string): void {
    if (!id) return;
    this.records = this.records.filter(record => record.id !== id);
    this.records.push({ id, hash: promptHash(text), server: target.server, pane: target.pane, source: target.source, session: target.session,
      state: "delivered", at: this.now(), settledAt: this.now() });
    this.save();
  }
  /** The message did not reach the agent, and why. It stays matchable, so a
   * late submission still turns it delivered. */
  fail(id: string | undefined, target: Target, reason: string): void {
    const record = id ? this.find(id, target) : undefined;
    if (!record || record.state === "delivered") return;
    record.state = "failed"; record.reason = reason.slice(0, 500); record.settledAt = this.now(); this.save();
  }
  /** The pane's Codex server moved to another thread (/new, /resume):
   * input still pending on the old one stays there, out of the pane's view.
   * Fails loudly; a late UserPromptSubmit from the old thread still settles it. */
  threadChanged(previous: Target): void {
    let changed = false;
    for (const record of this.records) if ((record.state === "typed" || record.state === "queued") && this.samePane(record, previous) && record.session === previous.session) {
      record.state = "failed"; record.settledAt = this.now(); changed = true;
      record.reason = "The pane moved to another Codex conversation before the agent took the message.";
    }
    if (changed) this.save();
  }
  /** False when `id` names another message: other words or another pane. */
  sameMessage(id: string, target: Pick<Target, "server" | "pane" | "source">, text: string): boolean {
    const record = this.byId(id);
    return !record || (this.samePane(record, target) && record.hash === promptHash(text));
  }
  /** What became of phone message `id` in `target`'s pane. `unknown` while the
   * Hook has not answered it, for another pane, or past retention. */
  status(id: string, target: Pick<Target, "server" | "pane" | "source">): DeliveryStatus {
    const record = this.find(id, target);
    if (!record || record.state === "typed") return { state: "unknown" };
    // Once delivered and its row is known: the transcript row it landed as, to match a pending send by.
    const landed = record.state === "delivered" && record.entryLine !== undefined
      ? { line: record.entryLine, ...(record.entryUuid ? { uuid: record.entryUuid } : {}) } : undefined;
    return { state: record.state, ...(record.reason && record.state === "failed" ? { reason: record.reason } : {}), session: record.session, ...(landed ? { landed } : {}) };
  }
  /** Every known phone message in `target`'s pane, for its conversation's stream. */
  forPane(target: Pick<Target, "server" | "pane" | "source">): ({ deliveryId: string } & DeliveryStatus)[] {
    return this.records.filter(record => record.id && this.samePane(record, target)).map(record => ({ deliveryId: record.id!, ...this.status(record.id!, target) }))
      .filter(item => item.state !== "unknown");
  }

  /** The phone delivery each of a Claude conversation's queue rows belongs to, by byte offset: the
   * enqueue a message was typed as, the `remove`/`popAll` that took it back, the prompt turn that
   * delivered it, and the `dequeue` that handed it to the model. Reads the transcript tail, binds
   * any occurrence not bound yet, and keeps the binding in `<file>.queue.json`, so a reopened chat,
   * a reconnect snapshot or a Hook restart gives the same row the same phone id. */
  async claudeQueueBindings(target: Pick<Target, "server" | "pane" | "source" | "session">, file: string): Promise<Map<number, string> | undefined> {
    if (target.source !== "claude") return undefined;
    const signature = () => this.records.filter(record => record.id && this.samePane(record, target) && record.session === target.session)
      .map(record => `${record.id}:${record.queueKey ?? ""}:${record.queueEnd ?? ""}:${record.cursor ?? ""}:${record.entry ?? ""}:${record.queueOffset ?? ""}:${record.queueRemoveOffset ?? ""}:${record.queueUserOffset ?? ""}:${record.queueDequeueOffset ?? ""}`).join(",");
    if (!signature()) return undefined;
    let info;
    try { info = await stat(file); } catch { return undefined; }
    const key = `${this.paneKey(target)}\0${target.session}\0${file}`, before = signature();
    const cached = this.queueCache.get(key);
    if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs && cached.signature === before) return cached.bindings;
    const rows = await claudeQueueRows(file);
    const bindings = await this.bindClaudeQueueRows(target, rows);
    this.queueCache.set(key, { signature: signature(), size: info.size, mtimeMs: info.mtimeMs, bindings });
    return bindings;
  }

  /** Bind parsed Claude queue rows (with their byte offsets) to the phone messages tracked in
   * `target`, oldest occurrence first, per pane and conversation. A message binds at most one
   * enqueue, one removal, one submitted turn and one dequeue; a repeated identical enqueue takes
   * the next unbound message, never the same occurrence twice. Only rows after the cursor captured
   * before the send was typed can be its own, so an earlier identical turn keeps its own identity.
   * Only bindings are recorded here: an enqueue is still held, never taken, and a cancellation or
   * `popAll` is not a delivery. */
  async bindClaudeQueueRows(target: Pick<Target, "server" | "pane" | "source" | "session">, rows: ClaudeQueueRow[]): Promise<Map<number, string>> {
    const bindings = new Map<number, string>();
    const relevant = this.records.filter(record => record.id && this.samePane(record, target) && record.session === target.session);
    if (target.source !== "claude" || !relevant.length) return bindings;
    // A Claude cursor is this conversation's size when the message was registered. Wait for it
    // before deciding which occurrence is new: a row already in the transcript is an earlier turn's.
    await Promise.all(relevant.map(record => this.cursors.get(record)).filter((promise): promise is Promise<void> => !!promise));
    let changed = false;
    const ordered = [...rows].sort((a, b) => a.offset - b.offset);
    const byOffset = new Map(ordered.map(({ offset, raw }): [number, Json] => [offset, raw]));
    const queueKey = (content: string) => createHash("sha256").update(unwrapPastedContent(content)).digest("hex");
    const consumed = (row: Json) => row.operation === "remove" && (row.reason === "absorbed_mid_turn" || row.reason === "delivered_to_agent");
    const canReplace = (record: Record, offset: number) => (record.queueEnd !== "returned" && (record.queueRemoveOffset === undefined || record.queueEnd === "consumed"))
      || (record.entryHook === true && record.entry === offset);
    const eligible = (row: Json | undefined) => row === undefined || (row.isSidechain !== true && row.isMeta !== true
      && (typeof row.sessionId !== "string" || row.sessionId === target.session));
    const exclusive = (record: Record, offset: number) => !this.records.some(other => other !== record && this.samePane(other, target)
      && other.session === target.session && (other.queueUserOffset === offset || other.entry === offset));
    // Reconstruct every association already recorded, validating a row still at that offset and,
    // for the submitted turn, that it follows the enqueue. An append or restart must not lose it.
    for (const record of relevant) {
      if (record.queueOffset !== undefined) {
        const row = byOffset.get(record.queueOffset);
        const still = eligible(row) && (row === undefined || (row.type === "queue-operation" && row.operation === "enqueue"
          && typeof row.content === "string" && promptHash(row.content) === record.hash
          && (record.queueKey === undefined || queueKey(row.content) === record.queueKey)
          && (record.cursor === undefined || record.queueOffset >= record.cursor)));
        if (still) {
          bindings.set(record.queueOffset, record.id!);
          if (row && record.queueKey === undefined) { record.queueKey = queueKey(String(row.content)); changed = true; }
        } else { delete record.queueOffset; delete record.queueAt; delete record.queueKey; delete record.queueEnd; delete record.queueRemoveOffset; delete record.queueUserOffset; delete record.queueDequeueOffset; changed = true; }
      }
      if (record.queueRemoveOffset !== undefined) {
        const row = byOffset.get(record.queueRemoveOffset);
        const still = eligible(row) && (row === undefined || (row.type === "queue-operation" && (row.operation === "remove" || row.operation === "popAll")
          && typeof row.content === "string" && (record.queueKey === undefined || queueKey(row.content) === record.queueKey)
          && (record.cursor === undefined || record.queueRemoveOffset >= record.cursor)));
        if (still) {
          bindings.set(record.queueRemoveOffset, record.id!);
          if (row) {
            const end = consumed(row) ? "consumed" : "returned";
            if (record.queueEnd !== end) { record.queueEnd = end; changed = true; }
          }
        } else { delete record.queueRemoveOffset; if (record.queueDequeueOffset === undefined) delete record.queueEnd; changed = true; }
      }
      if (record.queueUserOffset !== undefined) {
        const row = byOffset.get(record.queueUserOffset);
        const text = row === undefined ? undefined : claudeUserText(row);
        const still = eligible(row) && canReplace(record, record.queueUserOffset) && exclusive(record, record.queueUserOffset)
          && (!record.entryHook || record.entry === undefined || record.entry === record.queueUserOffset)
          && (row === undefined || (text !== undefined && promptHash(text) === record.hash
          && record.queueOffset !== undefined && record.queueUserOffset > record.queueOffset));
        if (still) bindings.set(record.queueUserOffset, record.id!);
        else { delete record.queueUserOffset; changed = true; }
      }
      if (record.queueDequeueOffset !== undefined) {
        const row = byOffset.get(record.queueDequeueOffset);
        const still = eligible(row) && (row === undefined || (row.type === "queue-operation" && row.operation === "dequeue" && row.isSidechain !== true));
        if (still) bindings.set(record.queueDequeueOffset, record.id!);
        else { delete record.queueDequeueOffset; changed = true; }
      }
    }
    // Replay every occurrence, including unowned messages: an ordinary queue head must
    // consume its own dequeue rather than handing it to a later phone send.
    const pending: { offset: number; key: string }[] = [];
    for (const { offset, raw } of ordered) {
      if (raw.isSidechain === true || (typeof raw.sessionId === "string" && raw.sessionId !== target.session)) continue;
      if (raw.type === "queue-operation" && raw.isSidechain !== true) {
        // A content-free dequeue is the queue head handed to a turn. Its own line names the
        // occurrence even when a page does not also carry the prompt turn it delivered.
        if (raw.operation === "dequeue") {
          const head = pending.shift();
          const record = head && relevant.find(candidate => candidate.queueOffset === head.offset);
          if (record && record.queueDequeueOffset === undefined && !bindings.has(offset)) {
            record.queueDequeueOffset = offset; record.queueEnd = "consumed";
            bindings.set(offset, record.id!); changed = true;
          }
          continue;
        }
        if (typeof raw.content !== "string") continue;
        const hash = promptHash(raw.content), key = queueKey(raw.content);
        // Private harness entries still occupy the queue. Count them for FIFO without
        // ever binding their payload to a phone message.
        if (raw.operation === "enqueue") pending.push({ offset, key });
        const index = raw.operation === "remove" || raw.operation === "popAll" ? pending.findIndex(item => item.key === key) : -1;
        const occurrence = index < 0 ? undefined : pending.splice(index, 1)[0];
        const unwrapped = unwrapPastedContent(raw.content);
        if (raw.isMeta === true || !unwrapped.trim() || unwrapped.trimStart().startsWith("<")) continue;
        if (raw.operation === "enqueue") {
          if (bindings.has(offset)) continue;
          const at = Date.parse(String(raw.timestamp ?? "")), rowAt = Number.isFinite(at) ? at : undefined;
          const record = relevant.filter(candidate => candidate.id && candidate.hash === hash && candidate.queueOffset === undefined
            && candidate.cursor !== undefined && offset >= candidate.cursor
            && (!candidate.entryHook || candidate.entry === undefined || candidate.entry > offset)
            && (rowAt === undefined || candidate.at <= rowAt + ENTRY_SLACK_MS)
            && (rowAt === undefined || rowAt >= candidate.at - ENTRY_SLACK_MS))
            .sort((a, b) => a.at - b.at)[0];
          if (!record) continue;
          record.queueOffset = offset; record.queueKey = key;
          if (rowAt !== undefined) record.queueAt = rowAt;
          if (record.state === "typed") record.state = "queued";
          bindings.set(offset, record.id!); changed = true;
          continue;
        }
        if (raw.operation === "remove" || raw.operation === "popAll") {
          if (bindings.has(offset)) continue;
          // Removal uses the exact unwrapped queue content, not the phone's normalized
          // words. A persisted key also identifies an enqueue outside the read tail.
          const record = relevant.filter(candidate => candidate.id && candidate.queueOffset !== undefined
            && candidate.cursor !== undefined && offset >= candidate.cursor
            && (occurrence ? candidate.queueOffset === occurrence.offset : candidate.queueKey === key)
            && candidate.queueDequeueOffset === undefined
            && candidate.queueOffset < offset && (candidate.queueRemoveOffset === undefined || candidate.queueRemoveOffset === offset))
            .sort((a, b) => a.queueOffset! - b.queueOffset!)[0];
          if (!record) continue;
          if (record.queueRemoveOffset === undefined) { record.queueRemoveOffset = offset; changed = true; }
          record.queueEnd = consumed(raw) ? "consumed" : "returned";
          bindings.set(offset, record.id!);
        }
        continue;
      }
      const text = claudeUserText(raw);
      if (text === undefined || bindings.has(offset)) continue;
      const hash = promptHash(text);
      const at = Date.parse(String(raw.timestamp ?? "")), rowAt = Number.isFinite(at) ? at : undefined;
      // A submitted turn replaces the enqueue only when it follows it, and never when another
      // message already landed as that row. The delivery's own landed reference wins.
      const record = relevant.filter(candidate => candidate.id && candidate.hash === hash && candidate.queueOffset !== undefined
        && canReplace(candidate, offset) && candidate.queueUserOffset === undefined && (candidate.cursor === undefined || offset >= candidate.cursor)
        && offset > candidate.queueOffset
        && (!candidate.entryHook || candidate.entry === undefined || candidate.entry === offset)
        && (rowAt === undefined || rowAt >= candidate.at - ENTRY_SLACK_MS) && exclusive(candidate, offset))
        .sort((a, b) => (a.entry === offset ? 0 : 1) - (b.entry === offset ? 0 : 1) || a.queueOffset! - b.queueOffset!)[0];
      if (!record) continue;
      record.queueUserOffset = offset;
      bindings.set(offset, record.id!);
      changed = true;
    }
    if (changed) this.save();
    return bindings;
  }

  /** Conversation `target` just submitted `prompt`. Its own record wins, then
   * the oldest open one in the same pane: the agent kept the text across a
   * conversation change, and the conversation now in the pane is where it
   * went. A prompt nothing matches was typed locally. Never refused.
   * For Claude the transcript is consulted first and the submission claims
   * the earliest unclaimed user row with these words, through the same
   * `settle` and the same table of claimed entries the idle check uses: a
   * callback for a row already claimed (the idle check settled it, the hook
   * came late) settles nothing more. */
  async submitted(target: Target, prompt: string): Promise<void> {
    await this.refreshClaudeQueue(target);
    const hash = promptHash(prompt);
    this.hookPanes.add(this.paneKey(target));
    // A failed message stays matchable for a late take only until the pane's next Stop: a turn that ended
    // without it means a later identical prompt is a new one.
    const stop = this.lastStop.get(this.paneKey(target)) ?? -Infinity;
    const pick = () => {
      const open = this.records.filter(record => record.hash === hash && this.samePane(record, target) && record.state !== "delivered" && record.queueEnd !== "returned"
        && (record.state !== "failed" || (record.settledAt ?? record.at) >= stop));
      return open.find(entry => entry.session === target.session) ?? open[0];
    };
    let record = pick();
    if (!record) {
      // A prompt that is one known message's own words (a late hook for a message already settled) is not a join.
      // Records from an earlier join never get a hook of their own, so they do not count.
      if (!this.records.some(other => other.hash === hash && this.samePane(other, target) && other.joined === undefined) && this.settleJoined(target, prompt)) this.save();
      return;
    }
    let entry: TranscriptEntry | undefined;
    if (target.source === "claude") {
      // A hook settles a message only by claiming a row for it: rows all claimed by earlier messages is a
      // callback for a turn already accounted for. No row yet (not written or not readable, or a transcript
      // that cannot be read) settles nothing now: the claim waits on the record for its row to appear.
      let rows: TranscriptEntry[] | undefined;
      try { rows = (await this.landed({ source: target.source, session: target.session, hash, at: record.at })).filter(row => row.hook); } catch { rows = undefined; }
      record = pick();
      if (!record) return;
      // Claims are per conversation: another conversation's rows can sit at the same byte offset.
      // Only user rows count: a mid-turn queue removal never had a hook, so it says nothing about this callback.
      const claimers = this.records.filter(other => other.hash === hash && this.samePane(other, target) && other.session === target.session && other.entry !== undefined && other.entryHook !== false);
      const claimed = new Set(claimers.map(other => other.entry));
      // A row an earlier message took only to name it in its receipt (`entryLate`) is never offered again, but it
      // says nothing about this callback: that message's hook already came, so this one is not it, late.
      const waitedOn = claimers.filter(other => !other.entryLate).length;
      const free = rows?.filter(row => !claimed.has(row.offset)).sort((a, b) => a.offset - b.offset)[0];
      // Claude writes the submitted row only after its UserPromptSubmit hooks return, and this callback is one
      // of them: the row for this submission is never readable yet. So no free row (or a transcript that cannot
      // be read) settles on the hook's word at once, as the agent took it and started its turn. The row it
      // writes next stays this message's (`taken` counts hook-settled messages first). Only when a message
      // with these words already claimed a row in this conversation may the callback be that message's, late:
      // then it waits for a row of its own, looked for in the conversation that made the claim.
      if (!free && !waitedOn) {
        this.settle(record, target.session);
        // A phone message claims the row Claude writes next, so its receipt can name it (`claimClaudeRow`).
        if (record.id) record.awaitingRow = true;
        this.save(); return;
      }
      if (!free) { if (!rows?.length) { record.hookClaim = true; record.session = target.session; } return; }
      entry = free;
    }
    this.settle(record, target.session);
    if (entry) this.claim(record, entry, true);
    this.save();
    if (target.source === "codex") {
      // Its row is its own from now on, so a later message with these words never takes it, even once the
      // row has left the scanned tail. Codex writes the row after its hooks return, and this callback is one
      // of them: not awaited (the agent waits on its answer), and claimed by the next ticks when the row appears.
      record.awaitingRow = true;
      void this.claimCodexRow(record).catch(() => undefined);
    }
  }
  /** Claude submits the messages it held while busy as one turn, joined by newlines, so no single message's
   * hash matches the prompt. Each open message in the pane whose words are a run of whole lines of it settles,
   * the longest run first at each line and the oldest of identical messages first, so "yes" never settles
   * inside "yes, but later". Only hashes of the line runs are compared, never stored. Only messages still held
   * (typed or queued) are matched: a failed one could take the lines of messages that are held, and a late
   * take of a failed message stays its own hook's to report. */
  private settleJoined(target: Target, prompt: string): boolean {
    const candidates = this.records.filter(record => this.samePane(record, target) && record.queueEnd !== "returned" && PromptDeliveries.open(record))
      .sort((a, b) => a.at - b.at).slice(0, JOINED_MAX_OPEN);
    if (!candidates.length) return false;
    const lines = unwrapPastedContent(prompt).split("\n").filter(line => !PICTURE_PATH_LINE.test(line));
    if (lines.length < 2 || lines.length > JOINED_MAX_LINES) return false;
    const matched: Record[] = [];
    let budget = JOINED_MAX_CHARS;
    for (let start = 0; start < lines.length;) {
      let next = start + 1;
      for (let end = lines.length; end > start; end--) {
        const run = lines.slice(start, end).join("\n");
        if ((budget -= run.length) < 0) break;
        if (!promptKey(run)) continue;
        const hash = promptHash(run), same = candidates.filter(record => record.hash === hash && !matched.includes(record));
        const record = same.find(entry => entry.session === target.session) ?? same[0];
        if (record) { matched.push(record); next = end; break; }
      }
      start = next;
    }
    if (!matched.length) return false;
    for (const record of matched) { record.joined = "part"; this.settle(record, target.session); }
    // The turn's row carries the joined words: a hook-settled record of them (no phone id) claims it as
    // `taken` lets any hook-settled message, so a later message with the same words cannot take it.
    this.records.push({ hash: promptHash(prompt), server: target.server, pane: target.pane, source: target.source, session: target.session,
      state: "delivered", at: this.now(), settledAt: this.now(), joined: "turn" });
    return true;
  }
  /** `record` takes transcript row `row` as its own: the entry no other message with these words may take, and,
   * for a phone message, the row its receipt names (`landed`), whose line is counted in the background. */
  private claim(record: Record, row: TranscriptEntry, hook = row.hook, late = false) {
    record.entry = row.offset; record.entryHook = hook; delete record.entryLine;
    if (late) record.entryLate = true; else delete record.entryLate;
    if (row.uuid) record.entryUuid = row.uuid; else delete record.entryUuid;
    if (row.shown !== undefined) record.entryShown = row.shown; else delete record.entryShown;
    if (record.id) void this.locate(record).catch(() => undefined);
  }
  /** Phone messages whose row's line is being counted. */
  private locating = new Set<Record>();
  /** Counts the line of the row the stream shows for a phone message's claimed entry, once, and keeps it.
   * In the background: a long transcript is read from its start. */
  private async locate(record: Record): Promise<void> {
    const entry = record.entry, session = record.session;
    if (entry === undefined || record.entryLine !== undefined || this.locating.has(record)) return;
    this.locating.add(record);
    try {
      const line = await this.lineOf(record, record.entryShown ?? entry, record.entryUuid);
      // Claimed again, or moved to another conversation, while the transcript was read: that answer is not this row's.
      if (line === undefined || record.entry !== entry || record.session !== session) return;
      record.entryLine = line; this.save();
    } finally { this.locating.delete(record); }
  }
  /** Marks `record` delivered, in `session` when given. */
  private settle(record: Record, session?: string) {
    record.state = "delivered"; record.settledAt = this.now(); delete record.reason; delete record.hookClaim; delete record.seenRow;
    // A cursor is a position in one conversation's transcript.
    if (session && session !== record.session) delete record.cursor;
    if (session) record.session = session;
    this.release(record, "delivered");
  }
  /** Settlement needs the same occurrence ownership as a transcript read, even if no
   * client has opened that conversation. Custom transcript readers supply their own bindings. */
  private async refreshClaudeQueue(target: Pick<Target, "server" | "pane" | "source" | "session">): Promise<void> {
    if (target.source !== "claude" || this.landed !== transcriptEntries) return;
    try { await this.claudeQueueBindings(target, await transcriptPath("claude", target.session)); } catch { /* Transcript not readable yet. */ }
  }
  /** Whether the transcript shows the agent took `record`'s message, claiming the entry it settled with.
   * An entry settles one message: the table of records' `entry` offsets (per conversation) is the only
   * state, so neither this path nor the hook's can settle two messages with one turn. A user row is a
   * turn start whose UserPromptSubmit hook settles the message itself, so while the agent works only a
   * mid-turn queue removal (no hook fires for it) settles from the transcript; once the agent is idle
   * (`working` false) a user row settles too, for a hook that never came. Of several identical open
   * messages the oldest take the entries. `pass` carries the entries still unclaimed within one observe. */
  private async taken(record: Record, pass: Map<string, TranscriptEntry[]>, working = false): Promise<boolean> {
    if (record.source !== "claude") return this.takenCodex(record);
    await this.refreshClaudeQueue(record);
    if (record.queueEnd === "returned") return false;
    const same = (other: Record) => other.hash === record.hash && other.server === record.server && other.pane === record.pane && other.session === record.session;
    const open = this.records.filter(other => same(other) && other.queueEnd !== "returned" && PromptDeliveries.claimable(other)).sort((a, b) => a.at - b.at);
    if (open[0] !== record && record.queueOffset === undefined && record.queueRemoveOffset === undefined) return false;
    const key = [record.hash, record.server, record.pane, record.session, working].join("|");
    let free = pass.get(key);
    if (!free) {
      // A message the agent's hook settled before its row was written took that row without recording it: the
      // scan reaches back to it, and it claims (and keeps) the earliest unclaimed user row stamped after it was
      // typed and soon after its hook, oldest first, before any open message is offered a row.
      // One settled inside a joined prompt took that prompt's row, which carries other words: it has none to claim.
      const hooked = this.records.filter(other => same(other) && other.state === "delivered" && other.entry === undefined && other.joined !== "part")
        .sort((a, b) => (a.settledAt ?? a.at) - (b.settledAt ?? b.at));
      const from = Math.min(record.at, ...hooked.map(other => other.at));
      const found = (await this.landed({ ...record, at: from }).catch(() => [] as TranscriptEntry[])).sort((a, b) => a.offset - b.offset);
      const used = new Set(this.records.filter(other => same(other) && other.entry !== undefined).map(other => other.entry));
      let claimedRows = false;
      for (const other of hooked) {
        if (other.entry !== undefined) continue;
        const row = found.find(entry => entry.hook && !used.has(entry.offset)
          && (entry.at === undefined || (entry.at >= other.at - ENTRY_SLACK_MS && entry.at <= (other.settledAt ?? other.at) + HOOK_ROW_MS)));
        if (!row) continue;
        this.claim(other, row, true); used.add(row.offset); claimedRows = true;
      }
      if (claimedRows) this.save();
      const unclaimed = found.filter(entry => !used.has(entry.offset) && (entry.at === undefined || entry.at >= record.at - ENTRY_SLACK_MS));
      if (working) {
        // A user row is its hook's to settle, unless that hook already came (before the row could be read), or
        // the pane sends no callbacks at all: then a row two checks in a row saw unclaimed settles it.
        const row = unclaimed.find(entry => entry.hook);
        const hookless = !this.hookPanes.has(this.paneKey(record));
        const own = row && (record.hookClaim || (hookless && record.seenRow === row.offset));
        if (row && hookless && !own) record.seenRow = row.offset;
        free = unclaimed.filter(entry => !entry.hook || (own && entry === row));
      } else free = unclaimed;
    }
    // The record may have settled (its hook claimed a row) while the transcript was read.
    if (!PromptDeliveries.claimable(record)) return false;
    const index = free.findIndex(row => {
      const owner = this.records.find(other => this.samePane(other, record) && other.session === record.session
        && (row.hook ? other.queueUserOffset === row.offset : other.queueRemoveOffset === row.offset));
      if (owner && owner !== record) return false;
      if (record.queueOffset === undefined && record.queueRemoveOffset === undefined) return true;
      return row.hook ? record.queueUserOffset === row.offset : record.queueRemoveOffset === row.offset;
    });
    const entry = index < 0 ? undefined : free.splice(index, 1)[0];
    pass.set(key, free);
    if (entry === undefined) return false;
    this.claim(record, entry);
    return true;
  }
  /** Whether a Codex transcript row can be `record`'s own: written after it was registered. A row at or past
   * its cursor was; one before it only if stamped after registration (written while the cursor was read),
   * which a row without a timestamp never is. A materialized Codex 0.155 thread's copy is append-only, so a row
   * past the cursor was copied after registration, but not necessarily created after it: an older item the copy
   * had not reached yet lands there too. Its rows are stamped with when the item was created (codex-threads.ts),
   * and the scan drops any row stamped more than `ENTRY_SLACK_MS` before registration, which is what keeps an
   * earlier identical message from being taken for this one. */
  private static codexRowIsOwn(record: Record, row: TranscriptEntry): boolean {
    return (record.cursor !== undefined && row.offset >= record.cursor) || (row.at !== undefined && row.at >= record.at);
  }
  /** Rows of `record`'s words in its conversation, oldest first, and where the scan of them began: rows
   * before `start` are out of sight, so whether they exist cannot be told. */
  private async codexRows(record: Record): Promise<{ rows: TranscriptEntry[]; start?: number }> {
    await this.cursors.get(record);
    const rows = [...await this.landed(record).catch(() => [] as TranscriptEntry[])].sort((a, b) => a.offset - b.offset);
    // Read after the scan: a transcript that grew meanwhile puts `start` later than the scan's, never earlier.
    const size = await this.size(record).catch(() => undefined);
    return { rows, ...(size !== undefined ? { start: Math.max(0, size - TRANSCRIPT_TAIL_BYTES) } : {}) };
  }
  /** Rows with `record`'s words in its conversation claimed by other messages. */
  private codexClaimed(record: Record): Set<number> {
    return new Set(this.records.filter(other => other !== record && other.hash === record.hash && this.samePane(other, record)
      && other.session === record.session && other.entry !== undefined).map(other => other.entry!));
  }
  /** A Claude phone message its hook settled before its row was written takes the row once it appears: the first
   * unclaimed user row with its words stamped from when it was typed to `HOOK_ROW_MS` after its hook, the rule
   * `taken` applies to hook-settled messages. Only the receipt's `landed` depends on it. */
  private async claimClaudeRow(record: Record): Promise<void> {
    const session = record.session;
    const rows = (await this.landed(record).catch(() => [] as TranscriptEntry[])).filter(row => row.hook).sort((a, b) => a.offset - b.offset);
    // Another path (`taken` for an identical message) may have given it its row meanwhile.
    if (record.entry !== undefined) { delete record.awaitingRow; return; }
    if (!record.awaitingRow || record.session !== session) return;
    const used = new Set(this.records.filter(other => other !== record && other.hash === record.hash && this.samePane(other, record)
      && other.session === record.session && other.entry !== undefined).map(other => other.entry!));
    const row = rows.find(row => !used.has(row.offset)
      && (row.at === undefined || (row.at >= record.at - ENTRY_SLACK_MS && row.at <= (record.settledAt ?? record.at) + HOOK_ROW_MS)));
    if (!row) return;
    this.claim(record, row, true, true); delete record.awaitingRow;
    this.save();
  }
  /** A Codex message its hook settled takes the first free row written after it was registered. */
  private async claimCodexRow(record: Record): Promise<void> {
    const { rows, start } = await this.codexRows(record);
    if (!record.awaitingRow || record.entry !== undefined) return;
    // Rows written after it have left the scanned tail: its own may be one of them, so it takes none of those left.
    if (record.cursor !== undefined && start !== undefined && record.cursor < start) { delete record.awaitingRow; return; }
    const used = this.codexClaimed(record);
    const row = rows.find(row => !used.has(row.offset) && PromptDeliveries.codexRowIsOwn(record, row));
    if (!row) return;
    this.claim(record, row); delete record.awaitingRow;
    this.save();
  }
  /** Whether Codex took `record`'s message: a row written after it was registered (`codexRowIsOwn`) that no
   * other message with these words claimed. An earlier message its hook settled whose row was not yet
   * claimed holds the first such row of its own first, but only when everything written after it is still
   * in the scanned tail: otherwise its row may be gone, and the row that is left is this message's. */
  private async takenCodex(record: Record): Promise<boolean> {
    const { rows, start } = await this.codexRows(record);
    const used = this.codexClaimed(record);
    let claimed = false;
    for (const other of this.records.filter(other => other !== record && other.hash === record.hash && this.samePane(other, record) && other.session === record.session
      && other.awaitingRow && other.entry === undefined && other.at < record.at).sort((a, b) => a.at - b.at)) {
      if (other.cursor === undefined || start === undefined || other.cursor < start) continue;
      const row = rows.find(row => !used.has(row.offset) && PromptDeliveries.codexRowIsOwn(other, row));
      if (!row) continue;
      this.claim(other, row); delete other.awaitingRow; used.add(row.offset); claimed = true;
    }
    if (claimed) this.save();
    const entry = rows.find(row => !used.has(row.offset) && PromptDeliveries.codexRowIsOwn(record, row));
    // The record may have settled (its hook came) while the transcript was read.
    if (!entry || !PromptDeliveries.claimable(record)) return false;
    this.claim(record, entry);
    return true;
  }
  /** A turn in `target`'s pane ended: the agent now takes held input or never will. */
  stopped(target: Target): void {
    const at = this.now();
    this.hookPanes.add(this.paneKey(target));
    this.lastStop.set(this.paneKey(target), at);
    let marked = false;
    for (const record of this.records) if (this.samePane(record, target) && (record.state === "typed" || record.state === "queued") && record.at < at) { record.stoppedAt = at; marked = true; }
    // Persisted: after a restart an idle pane's message is still failed or settled by its Stop.
    if (marked) this.save();
  }

  /** Called on the Hook's activity tick with a server's panes. A message
   * still held fails loudly when its pane closed, its agent restarted, or the
   * agent ended a turn and stayed idle without taking it (unless its
   * transcript shows it after all). */
  async observe(server: string, panes: Json[]): Promise<void> {
    const now = this.now();
    let changed = false;
    const pass = new Map<string, TranscriptEntry[]>();
    for (const record of this.records) {
      if (record.server !== server) continue;
      // A message its hook settled claims its row once written (a Codex one before a later identical one is
      // checked; a Claude phone message for its receipt's `landed`).
      if (record.awaitingRow) {
        if (now - (record.settledAt ?? record.at) > HOOK_ROW_MS) delete record.awaitingRow;
        else if (record.checkedAt === undefined || now - record.checkedAt >= LANDED_CHECK_MS) { record.checkedAt = now; await (record.source === "claude" ? this.claimClaudeRow(record) : this.claimCodexRow(record)); }
        continue;
      }
      // A phone message's row whose line could not be counted yet (a Hook restart, a transcript being rewritten)
      // is counted again for a few minutes after it settled.
      if (record.id && record.state === "delivered" && record.entry !== undefined && record.entryLine === undefined
        && now - (record.settledAt ?? record.at) <= LOCATE_FOR_MS) {
        if (record.checkedAt === undefined || now - record.checkedAt >= LANDED_CHECK_MS) { record.checkedAt = now; void this.locate(record).catch(() => undefined); }
        continue;
      }
      // A failed message whose own hook came late, before its row: settled when the row appears.
      if (record.state === "failed" && record.hookClaim) {
        if (record.source === "claude" && (record.checkedAt === undefined || now - record.checkedAt >= LANDED_CHECK_MS)) {
          record.checkedAt = now;
          if (await this.taken(record, pass, true)) { this.settle(record); changed = true; }
        }
        continue;
      }
      if (record.state !== "typed" && record.state !== "queued") continue;
      const pane = panes.find(entry => entry.pane_id === record.pane);
      if (!pane || (record.terminal && pane.terminal_id !== record.terminal) || (pane.agent && pane.agent !== record.source)) {
        if (await this.taken(record, pass)) { this.settle(record); changed = true; continue; }
        if (!PromptDeliveries.open(record)) continue;
        record.state = "failed"; record.settledAt = now; changed = true;
        record.reason = pane ? "The agent in this pane restarted before it took the message." : "The agent's pane closed before it took the message.";
        continue;
      }
      if (!["idle", "done"].includes(String(pane.agent_status))) {
        record.idleSince = undefined;
        // A message the agent took into its running turn (Claude's mid-turn steer) never reaches
        // its UserPromptSubmit hook; its transcript is the only place that says so.
        if (record.source === "claude" && (record.checkedAt === undefined || now - record.checkedAt >= LANDED_CHECK_MS)) {
          record.checkedAt = now;
          if (await this.taken(record, pass, true)) { this.settle(record); changed = true; }
        }
        continue;
      }
      record.idleSince ??= now;
      if (record.stoppedAt === undefined || now - Math.max(record.idleSince, record.stoppedAt) < DELIVERY_GIVE_UP_MS) continue;
      if (await this.taken(record, pass)) { this.settle(record); changed = true; continue; }
      // Settled delivered by its hook while the transcript was read: never downgraded.
      if (!PromptDeliveries.open(record)) continue;
      record.state = "failed"; record.settledAt = now; changed = true;
      record.reason = TURN_ENDED_WITHOUT_IT;
    }
    if (changed) this.save();
  }
}

/** The byte offsets of the user rows with these words that reached the conversation's transcript
 * after the message was typed: the agent took it without its hook saying so
 * (a mid-turn steer). Reads at most the last 512 KiB. */
/** The byte offsets (in the file, `start` being the buffer's own offset) of the rows in `buffer`
 * whose user text has `record`'s words, newest first. One offset per row. */
export function matchingOffsets(buffer: Buffer, start: number, record: { hash: string; at: number }): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [], items: TranscriptEntry[] = [];
  // A Codex rollout writes each user turn twice, as a `user_message` event and a user `response_item`:
  // the event alone is the turn. Only a thread materialized from Codex 0.155's history has items without events.
  let events = false;
  const lines = buffer.toString("utf8").split("\n");
  let offset = start + buffer.length;
  // A materialized Codex thread writes input the agent holds in its queue as a `phrenQueued` row, and a content-free
  // `phren_queue_consumed` row with the same key once the agent takes it. The scan runs newest first, so a queued
  // row's marker, written after it, is seen before it: only a queued row whose marker came counts as taken.
  const consumed = new Set<string>();
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    offset -= Buffer.byteLength(line) + (index < lines.length - 1 ? 1 : 0);
    if (line.includes('"phren_queue_consumed"')) {
      try { const marker = object(JSON.parse(line)); if (marker.type === "phren_queue_consumed" && typeof marker.key === "string") consumed.add(marker.key); } catch { /* a cut line */ }
      continue;
    }
    // Only a row that can carry user text is parsed: the scan reads the whole tail now, not just its newest rows.
    if (!line.includes('"user') && !line.includes("queue-operation")) continue;
    let row: Json;
    try { row = object(JSON.parse(line)); } catch { continue; }
    if (row.phrenQueued === true && row.type === "response_item" && !(typeof row.phrenQueueKey === "string" && consumed.has(row.phrenQueueKey))) continue;
    // Rows are not in time order: Claude writes a queued message's attachment rows, stamped when it was
    // typed, after the queue removal that took it. An older row is skipped, never the end of the scan,
    // or a message typed after an earlier queued one is never found (seen 2026-10-17: taken, reported failed).
    const payload = object(row.payload), item = row.type === "response_item" && payload.type === "message";
    if (row.type === "event_msg" && payload.type === "user_message") events = true;
    const stamp = Date.parse(String(row.timestamp ?? ""));
    if (Number.isFinite(stamp) && stamp < record.at - 5_000) continue;
    // One entry per row, even when its content repeats the words.
    if (userTexts(row).some(text => promptHash(text) === record.hash)) (item ? items : entries).push({ offset, hook: row.type === "user", ...(Number.isFinite(stamp) ? { at: stamp } : {}),
      ...(typeof row.uuid === "string" && row.uuid && row.uuid.length <= 100 ? { uuid: row.uuid } : {}) });
  }
  if (!events) return [...entries, ...items].sort((a, b) => b.offset - a.offset);
  // The event is the turn, but the conversation stream shows the user item Codex wrote just before it (the event is
  // not shown): each event names, as `shown`, the nearest earlier item with these words no later event took.
  const taken = new Set<number>();
  return entries.map(entry => {
    const item = items.filter(candidate => candidate.offset < entry.offset && !taken.has(candidate.offset)).sort((a, b) => b.offset - a.offset)[0];
    if (!item) return entry;
    taken.add(item.offset);
    return { ...entry, shown: item.offset };
  });
}

export async function transcriptSize(record: { source: Provider; session: string }): Promise<number | undefined> {
  // A Codex 0.155 thread's copy is read as it stands: finding the transcript first appends what the thread store
  // holds now, which may already be this message, and a failed append must not read as an empty conversation.
  const copy = record.source === "codex" && sessionId.safeParse(record.session).success
    ? await stat(materializedPath(record.session)).catch(() => undefined) : undefined;
  if (copy) return copy.size;
  try {
    const file = await transcriptPath(record.source, record.session);
    // Its copy made just now holds both older messages and maybe this one: no position tells them apart,
    // so only a row stamped after registration (a user row with its creation time) can confirm it.
    return file === materializedPath(record.session) ? undefined : (await stat(file)).size;
  } catch (error) {
    // A conversation not written yet (a new Codex thread) has nothing before its first row.
    return error instanceof BridgeError && object(error.details).code === "transcript-unavailable" ? 0 : undefined;
  }
}

/** The 0-based line of the row starting at byte `offset`: the newlines before it, as the transcript index counts
 * rows (transcript-index.ts), so it is the `line` the conversation stream gives that row. */
export async function transcriptLine(record: { source: Provider; session: string }, offset: number, uuid?: string): Promise<number | undefined> {
  const file = await open(await transcriptPath(record.source, record.session), "r");
  try {
    if ((await file.stat()).size <= offset) return undefined;
    // The file may have been replaced since the row was claimed (a copy made again): a row must still start at the
    // offset, and be the claimed one when its id is known, or the count would name some other row.
    const head = Buffer.alloc(Math.min(4_096, offset + 1));
    const { bytesRead } = await file.read(head, 0, head.length, offset + 1 - head.length);
    if (offset > 0 && head[bytesRead - 2] !== 10) return undefined;
    if (uuid) {
      // Claude writes `uuid` after `message`, so the row is read whole, within a bound no typed message reaches.
      const row = Buffer.alloc(2 * 1024 * 1024), read = (await file.read(row, 0, row.length, offset)).bytesRead;
      const text = row.subarray(0, read).toString("utf8"), end = text.indexOf("\n");
      if (!(end < 0 ? text : text.slice(0, end)).includes(`"uuid":"${uuid}"`)) return undefined;
    }
    const buffer = Buffer.alloc(65_536);
    let line = 0, position = 0;
    while (position < offset) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, offset - position), position);
      if (!bytesRead) return undefined;
      for (let index = buffer.indexOf(10); index >= 0 && index < bytesRead; index = buffer.indexOf(10, index + 1)) line++;
      position += bytesRead;
    }
    return line;
  } finally { await file.close(); }
}

/** The last `TRANSCRIPT_TAIL_BYTES` of a Claude transcript, parsed into the queue and user rows a
 * phone message's identity can be read from, each with the byte offset it starts at. */
async function claudeQueueRows(file: string): Promise<ClaudeQueueRow[]> {
  const handle = await open(file, "r");
  try {
    const size = (await handle.stat()).size, start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
    if (size === start) return [];
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    let base = start, text = buffer.toString("utf8");
    // Read from the first whole line: a byte split would decode as another character.
    if (start > 0) {
      const newline = buffer.indexOf(10);
      if (newline < 0) return [];
      base = start + newline + 1;
      text = buffer.subarray(newline + 1).toString("utf8");
    }
    const rows: ClaudeQueueRow[] = [];
    let offset = base;
    for (const line of text.split("\n")) {
      const bytes = Buffer.byteLength(line);
      if (line && (line.includes('"queue-operation"') || line.includes('"user"'))) {
        try { rows.push({ offset, raw: object(JSON.parse(line)) }); } catch { /* malformed or cut row */ }
      }
      offset += bytes + 1;
    }
    return rows;
  } finally { await handle.close(); }
}

/** The words of a user turn: what a phone message submitted as that turn matches by. */
function claudeUserText(raw: Json): string | undefined {
  if (raw.type !== "user" || raw.isMeta === true || raw.isSidechain === true) return undefined;
  const content = object(raw.message).content;
  const text = typeof content === "string" ? content
    : objects(content).filter(block => block.type === "text" && typeof block.text === "string").map(block => String(block.text)).join("\n");
  return promptKey(text) ? text : undefined;
}

async function transcriptEntries(record: { source: Provider; session: string; hash: string; at: number }): Promise<TranscriptEntry[]> {
  const file = await open(await transcriptPath(record.source, record.session), "r");
  try {
    const size = (await file.stat()).size, start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES), buffer = Buffer.alloc(size - start);
    await file.read(buffer, 0, buffer.length, start);
    return matchingOffsets(buffer, start, record);
  } finally { await file.close(); }
}

/** A transcript row's user-typed text: Claude's user rows, Codex's
 * user_message events and user response items. */
export function userTexts(row: Json): string[] {
  const texts: string[] = [];
  const blocks = (content: unknown) => {
    if (typeof content === "string") texts.push(content);
    else for (const block of objects(content)) if (typeof block.text === "string") texts.push(block.text);
  };
  if (row.type === "user" && !row.isMeta) blocks(object(row.message).content);
  // Claude Code takes a message typed mid-turn out of its queue into the running turn:
  // `enqueue` when typed, then `remove` (not `dequeue`, which starts a turn of its own) with the same words.
  // A `remove` also drops input without the agent seeing it (reason "cleared_on_cancel"): only these reasons mean it was taken.
  if (row.type === "queue-operation" && row.operation === "remove" && typeof row.content === "string"
    && (row.reason === "absorbed_mid_turn" || row.reason === "delivered_to_agent")) texts.push(row.content);
  const payload = object(row.payload);
  if (payload.type === "user_message" && typeof payload.message === "string") texts.push(payload.message);
  if (payload.type === "message" && payload.role === "user") blocks(payload.content);
  return texts;
}
