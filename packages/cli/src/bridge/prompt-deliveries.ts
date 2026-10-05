import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { z } from "zod";
import { atomicInPrivateDir, object, objects, provider, type Json, type Provider, type Target } from "./protocol.js";
import { transcriptPath, unwrapPastedContent } from "./transcripts.js";

export type DeliveryOutcome = "delivered" | "pending";
/** What a phone message is known to have become. `queued`: typed into the
 * pane and held by the agent until its turn ends. `failed` carries a reason
 * and may still turn `delivered` if the agent takes it late. */
export type DeliveryState = "queued" | "delivered" | "failed";
export type TrackedState = DeliveryState | "unknown";
export interface DeliveryStatus { state: TrackedState; reason?: string; session?: string }

/** A message is kept this long, by its id, so a late status or a retry still
 * finds it: a busy Codex turn can run far past the old ten minutes. */
export const DELIVERY_RETENTION_MS = 24 * 3_600_000;
/** An agent that ended its turn after the message was typed and then stayed
 * idle this long without taking it has dropped it. */
export const DELIVERY_GIVE_UP_MS = 30_000;
const MAX_RECORDS = 512;

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

const recordSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(), hash: z.string().regex(/^[0-9a-f]{64}$/),
  server: z.string().min(1).max(200), pane: z.string().min(1).max(200), source: provider, session: z.string().min(1).max(200),
  terminal: z.string().max(200).optional(), state: z.enum(["typed", "queued", "delivered", "failed"]),
  reason: z.string().max(500).optional(), at: z.number(), settledAt: z.number().optional(), stoppedAt: z.number().optional(),
}).strict();
type Record = z.infer<typeof recordSchema> & { idleSince?: number };
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

  constructor(private file?: string, private now: () => number = Date.now,
    private landed: (record: { source: Provider; session: string; hash: string; at: number }) => Promise<boolean> = transcriptHas) {
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
    const rows = this.records.filter(record => record.id).map(({ idleSince: _, ...row }) => row);
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
   * went. A prompt nothing matches was typed locally. Never refused. */
  submitted(target: Target, prompt: string): void {
    const hash = promptHash(prompt);
    const open = this.records.filter(record => record.hash === hash && this.samePane(record, target) && record.state !== "delivered");
    const record = open.find(entry => entry.session === target.session) ?? open[0];
    if (!record) return;
    record.state = "delivered"; record.session = target.session; record.settledAt = this.now(); delete record.reason;
    this.save();
    this.release(record, "delivered");
  }
  /** A turn in `target`'s pane ended: the agent now takes held input or never will. */
  stopped(target: Target): void {
    const at = this.now();
    for (const record of this.records) if (this.samePane(record, target) && (record.state === "typed" || record.state === "queued") && record.at < at) record.stoppedAt = at;
  }

  /** Called on the Hook's activity tick with a server's panes. A message
   * still held fails loudly when its pane closed, its agent restarted, or the
   * agent ended a turn and stayed idle without taking it (unless its
   * transcript shows it after all). */
  async observe(server: string, panes: Json[]): Promise<void> {
    const now = this.now();
    let changed = false;
    for (const record of this.records) {
      if (record.server !== server || (record.state !== "typed" && record.state !== "queued")) continue;
      const pane = panes.find(entry => entry.pane_id === record.pane);
      if (!pane || (record.terminal && pane.terminal_id !== record.terminal) || (pane.agent && pane.agent !== record.source)) {
        if (await this.landed(record).catch(() => false)) { record.state = "delivered"; record.settledAt = now; changed = true; this.release(record, "delivered"); continue; }
        record.state = "failed"; record.settledAt = now; changed = true;
        record.reason = pane ? "The agent in this pane restarted before it took the message." : "The agent's pane closed before it took the message.";
        continue;
      }
      if (!["idle", "done"].includes(String(pane.agent_status))) { record.idleSince = undefined; continue; }
      record.idleSince ??= now;
      if (record.stoppedAt === undefined || now - Math.max(record.idleSince, record.stoppedAt) < DELIVERY_GIVE_UP_MS) continue;
      if (await this.landed(record).catch(() => false)) { record.state = "delivered"; record.settledAt = now; changed = true; this.release(record, "delivered"); continue; }
      record.state = "failed"; record.settledAt = now; changed = true;
      record.reason = "The agent finished its turn without taking the message.";
    }
    if (changed) this.save();
  }
}

/** Whether a user row with these words reached the conversation's transcript
 * after the message was typed: the agent took it without its hook saying so
 * (a mid-turn steer). Reads at most the last 512 KiB. */
async function transcriptHas(record: { source: Provider; session: string; hash: string; at: number }): Promise<boolean> {
  const file = await open(await transcriptPath(record.source, record.session), "r");
  try {
    const size = (await file.stat()).size, start = Math.max(0, size - 524_288), buffer = Buffer.alloc(size - start);
    await file.read(buffer, 0, buffer.length, start);
    for (const line of buffer.toString("utf8").split("\n").reverse()) {
      let row: Json;
      try { row = object(JSON.parse(line)); } catch { continue; }
      const stamp = Date.parse(String(row.timestamp ?? ""));
      if (Number.isFinite(stamp) && stamp < record.at - 5_000) break;
      for (const text of userTexts(row)) if (promptHash(text) === record.hash) return true;
    }
    return false;
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
  const payload = object(row.payload);
  if (payload.type === "user_message" && typeof payload.message === "string") texts.push(payload.message);
  if (payload.type === "message" && payload.role === "user") blocks(payload.content);
  return texts;
}
