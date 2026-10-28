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
export interface TranscriptEntry { offset: number; hook: boolean; at?: number }
export type TrackedState = DeliveryState | "unknown";
export interface DeliveryStatus { state: TrackedState; reason?: string; session?: string }

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
  /** Codex: the transcript's size in bytes when the message was registered. Only a row at or past it is
   * the message's own: position, not the clock, orders rows, and a row without a timestamp too. */
  cursor: z.number().int().nonnegative().optional(),
}).strict();
/** In memory only: `hookClaim`, a UserPromptSubmit came for these words before any row was readable, so the
 * row (in the callback's conversation, now the record's) may settle it when it appears, even once failed; `seenRow`, a user row a working check saw in a pane that has sent no
 * callbacks, settled at the next check if no hook claimed it meanwhile; `awaitingRow`, a Codex message its hook settled
 * before its row was written, which claims that row when it appears (for `HOOK_ROW_MS`). */
type Record = z.infer<typeof recordSchema> & { idleSince?: number; checkedAt?: number; hookClaim?: boolean; seenRow?: number; awaitingRow?: boolean };
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

  /** Codex messages whose `cursor` is still being read. */
  private cursors = new Map<Record, Promise<void>>();
  /** The size of a conversation's transcript: 0 before it has one, undefined when it cannot be read. */
  private size: (record: { source: Provider; session: string }) => Promise<number | undefined>;

  constructor(private file?: string, private now: () => number = Date.now,
    private landed: (record: { source: Provider; session: string; hash: string; at: number }) => Promise<TranscriptEntry[]> = transcriptEntries,
    size?: (record: { source: Provider; session: string }) => Promise<number | undefined>) {
    // A store reading other transcripts than the agents' own has no sizes for them.
    this.size = size ?? (landed === transcriptEntries ? transcriptSize : async () => undefined);
    if (!file) return;
    try {
      for (const row of objects(object(JSON.parse(readFileSync(file, "utf8"))).records)) {
        const parsed = recordSchema.safeParse(row);
        // A message the Hook was typing when it stopped is in the pane or
        // nowhere: wait for the agent, and give up as for any other.
        if (parsed.success) this.records.push({ ...parsed.data, state: parsed.data.state === "typed" ? "queued" : parsed.data.state });
      }
    } catch { /* No file yet, or an unreadable one: start empty. */ }
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
  }
  private save() {
    if (!this.file) return;
    // A record without a phone id is kept once it claimed a transcript row, so after a restart that row is not offered to another message.
    const rows = this.records.filter(record => record.id || record.entry !== undefined || record.joined === "turn").map(({ idleSince: _, checkedAt: __, hookClaim: ___, seenRow: ____, awaitingRow: _____, ...row }) => row);
    const file = this.file;
    this.writing = this.writing.then(() => atomicInPrivateDir(file, { records: rows })).catch(() => undefined);
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
    if (record.source === "codex") {
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
  pending(target: Target, text: string): boolean { return !!this.open(target, text); }
  /** Whether `record` still holds its pane: open, and either young or in a pane whose hooks will settle it. */
  private inFlight(record: Record): boolean {
    return PromptDeliveries.open(record) && (this.now() - record.at < IN_FLIGHT_MS || this.hookPanes.has(this.paneKey(record)));
  }
  /** Whether any message typed into `target`'s pane is still waiting to be taken or refused. */
  holding(target: Pick<Target, "server" | "pane" | "source">): boolean { return this.records.some(record => this.samePane(record, target) && this.inFlight(record)); }
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
    return { state: record.state, ...(record.reason && record.state === "failed" ? { reason: record.reason } : {}), session: record.session };
  }
  /** Every known phone message in `target`'s pane, for its conversation's stream. */
  forPane(target: Pick<Target, "server" | "pane" | "source">): ({ deliveryId: string } & DeliveryStatus)[] {
    return this.records.filter(record => record.id && this.samePane(record, target)).map(record => ({ deliveryId: record.id!, ...this.status(record.id!, target) }))
      .filter(item => item.state !== "unknown");
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
    const hash = promptHash(prompt);
    this.hookPanes.add(this.paneKey(target));
    // A failed message stays matchable for a late take only until the pane's next Stop: a turn that ended
    // without it means a later identical prompt is a new one.
    const stop = this.lastStop.get(this.paneKey(target)) ?? -Infinity;
    const pick = () => {
      const open = this.records.filter(record => record.hash === hash && this.samePane(record, target) && record.state !== "delivered"
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
    let entry: number | undefined;
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
      const claimed = new Set(this.records.filter(other => other.hash === hash && this.samePane(other, target) && other.session === target.session && other.entry !== undefined && other.entryHook !== false).map(other => other.entry));
      const free = rows?.filter(row => !claimed.has(row.offset)).sort((a, b) => a.offset - b.offset)[0];
      // Claude writes the submitted row only after its UserPromptSubmit hooks return, and this callback is one
      // of them: the row for this submission is never readable yet. So no free row (or a transcript that cannot
      // be read) settles on the hook's word at once, as the agent took it and started its turn. The row it
      // writes next stays this message's (`taken` counts hook-settled messages first). Only when a message
      // with these words already claimed a row in this conversation may the callback be that message's, late:
      // then it waits for a row of its own, looked for in the conversation that made the claim.
      if (!free && !claimed.size) { this.settle(record, undefined, target.session); this.save(); return; }
      if (!free) { if (!rows?.length) { record.hookClaim = true; record.session = target.session; } return; }
      entry = free.offset;
    }
    this.settle(record, entry, target.session, entry !== undefined ? true : undefined);
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
    const candidates = this.records.filter(record => this.samePane(record, target) && PromptDeliveries.open(record))
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
    for (const record of matched) { record.joined = "part"; this.settle(record, undefined, target.session); }
    // The turn's row carries the joined words: a hook-settled record of them (no phone id) claims it as
    // `taken` lets any hook-settled message, so a later message with the same words cannot take it.
    this.records.push({ hash: promptHash(prompt), server: target.server, pane: target.pane, source: target.source, session: target.session,
      state: "delivered", at: this.now(), settledAt: this.now(), joined: "turn" });
    return true;
  }
  /** Marks `record` delivered, with the transcript entry that settled it when known. */
  private settle(record: Record, entry?: number, session?: string, hook?: boolean) {
    record.state = "delivered"; record.settledAt = this.now(); delete record.reason; delete record.hookClaim; delete record.seenRow;
    // A cursor is a position in one conversation's transcript.
    if (session && session !== record.session) delete record.cursor;
    if (session) record.session = session;
    if (entry !== undefined) record.entry = entry;
    if (hook !== undefined) record.entryHook = hook;
    this.release(record, "delivered");
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
    const same = (other: Record) => other.hash === record.hash && other.server === record.server && other.pane === record.pane && other.session === record.session;
    const open = this.records.filter(other => same(other) && PromptDeliveries.claimable(other)).sort((a, b) => a.at - b.at);
    if (open[0] !== record) return false;
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
        other.entry = row.offset; other.entryHook = true; used.add(row.offset); claimedRows = true;
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
    const entry = free.shift();
    pass.set(key, free);
    if (entry === undefined) return false;
    record.entry = entry.offset; record.entryHook = entry.hook;
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
  /** A Codex message its hook settled takes the first free row written after it was registered. */
  private async claimCodexRow(record: Record): Promise<void> {
    const { rows, start } = await this.codexRows(record);
    if (!record.awaitingRow || record.entry !== undefined) return;
    // Rows written after it have left the scanned tail: its own may be one of them, so it takes none of those left.
    if (record.cursor !== undefined && start !== undefined && record.cursor < start) { delete record.awaitingRow; return; }
    const used = this.codexClaimed(record);
    const row = rows.find(row => !used.has(row.offset) && PromptDeliveries.codexRowIsOwn(record, row));
    if (!row) return;
    record.entry = row.offset; record.entryHook = row.hook; delete record.awaitingRow;
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
      other.entry = row.offset; other.entryHook = row.hook; delete other.awaitingRow; used.add(row.offset); claimed = true;
    }
    if (claimed) this.save();
    const entry = rows.find(row => !used.has(row.offset) && PromptDeliveries.codexRowIsOwn(record, row));
    // The record may have settled (its hook came) while the transcript was read.
    if (!entry || !PromptDeliveries.claimable(record)) return false;
    record.entry = entry.offset; record.entryHook = entry.hook;
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
      // A Codex message its hook settled claims its row once written, before a later identical one is checked.
      if (record.awaitingRow) {
        if (now - (record.settledAt ?? record.at) > HOOK_ROW_MS) delete record.awaitingRow;
        else if (record.checkedAt === undefined || now - record.checkedAt >= LANDED_CHECK_MS) { record.checkedAt = now; await this.claimCodexRow(record); }
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
    if (userTexts(row).some(text => promptHash(text) === record.hash)) (item ? items : entries).push({ offset, hook: row.type === "user", ...(Number.isFinite(stamp) ? { at: stamp } : {}) });
  }
  return events ? entries : [...entries, ...items].sort((a, b) => b.offset - a.offset);
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
