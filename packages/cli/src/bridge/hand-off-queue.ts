import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { atomicInPrivateDir, BridgeError, bridgeRoot, type Json, type Target, targetSchema, computerName } from "./protocol.js";
import { deliveryIdSchema } from "./prompt-once.js";
import { agentNotReady } from "./terminal.js";

export const queuedHandOffSchema = z.object({
  target: targetSchema, text: z.string().min(1).max(32768).refine(t => !/[\x00-\x08\x0b-\x1f\x7f]/.test(t)),
  deliveryId: deliveryIdSchema, origin: targetSchema.optional(), originComputer: computerName.optional(),
}).strict();
const rowSchema = queuedHandOffSchema.extend({
  deliveryId: deliveryIdSchema.unwrap(), terminal: z.string().min(1).max(200),
  state: z.enum(["queued", "attempting", "delivered", "uncertain", "failed"]),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), error: z.string().max(500).optional(),
  notified: z.boolean().optional(),
});
type Row = z.infer<typeof rowSchema>;
export interface QueueOptions {
  validate: (target: Target) => Promise<Json>;
  send: (target: Target, text: string, deliveryId: string, typing: () => Promise<void>) => Promise<Json>;
  notify?: (target: Target, text: string, deliveryId: string, computer: string) => Promise<Json>;
  now?: () => number;
  root?: string;
}
const sameTarget = (a: Target, b: Target) => ["server", "workspace", "tab", "pane", "source", "session"].every(key => a[key as keyof Target] === b[key as keyof Target]);

/** A durable outbox on the receiving Hook. Persist 'attempting' before input,
 * so a crash in the input/ack gap recovers as uncertain, never as a retry.
 * Tombstones are retained: an old delivery id can never type a second time. */
export class HandOffQueue {
  private pending: Promise<unknown> = Promise.resolve();
  private root: string;
  private now: () => number;
  constructor(private options: QueueOptions) { this.root = options.root ?? path.join(bridgeRoot(), "hand-offs"); this.now = options.now ?? Date.now; }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.pending.then(run); this.pending = result.catch(() => {}); return result;
  }
  private file(id: string) { return path.join(this.root, `${deliveryIdSchema.unwrap().parse(id)}.json`); }
  private async save(row: Row) {
    row.updatedAt = new Date(this.now()).toISOString();
    const file = this.file(row.deliveryId);
    await atomicInPrivateDir(file, rowSchema.parse(row));
    const handle = await open(file, "r"); try { await handle.sync(); } finally { await handle.close(); }
    // Ensure the renamed entry survives a host crash as well as a service restart.
    if (process.platform !== "win32") { const dir = await open(this.root, "r"); try { await dir.sync(); } finally { await dir.close(); } }
  }
  private async read(id: string): Promise<Row | undefined> {
    const file = this.file(id), info = await lstat(file).catch(error => {
      if (error.code === "ENOENT") return undefined; throw error;
    });
    if (!info) return undefined;
    if (!info.isFile() || info.isSymbolicLink() || info.size > 100_000) throw new BridgeError(409, "The hand-off record cannot be read safely.");
    const row = rowSchema.parse(JSON.parse(await readFile(file, "utf8")));
    if (row.state === "attempting") { row.state = "uncertain"; row.error = "The Hook restarted before delivery was confirmed."; await this.save(row); }
    return row;
  }
  private async rows(): Promise<Row[]> {
    const names = await readdir(this.root).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    const rows: Row[] = [];
    for (const name of names.sort()) if (/^[A-Za-z0-9_-]{8,64}\.json$/.test(name)) {
      const row = await this.read(name.slice(0, -5)); if (row) rows.push(row);
    }
    return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.deliveryId.localeCompare(b.deliveryId));
  }
  private reply(row: Row): Json {
    return { ok: row.state === "delivered" || row.state === "queued", delivered: row.state === "delivered", queued: row.state === "queued",
      deliveryId: row.deliveryId, state: row.state, target: row.target,
      ...(row.state === "uncertain" ? { deliveryUncertain: true } : {}), ...(row.error ? { error: row.error } : {}) };
  }
  enqueue(input: unknown): Promise<Json> {
    return this.serial(async () => {
      const data = queuedHandOffSchema.parse(input), id = data.deliveryId ?? randomUUID().replaceAll("-", "");
      const prior = await this.read(id);
      if (prior) {
        if (!sameTarget(prior.target, data.target) || prior.text !== data.text) throw new BridgeError(409, "This message id was already used for a different message.");
        return { ...this.reply(prior), replayed: true };
      }
      const pane = await this.options.validate(data.target);
      if (typeof pane.terminal_id !== "string") throw new BridgeError(409, "This agent has no terminal binding.");
      const at = new Date(this.now()).toISOString();
      const row: Row = { ...data, deliveryId: id, terminal: pane.terminal_id, state: "queued", createdAt: at, updatedAt: at };
      await this.save(row);
      // Older queued messages take precedence even if this one arrives at idle.
      const ahead = (await this.rows()).some(other => other.deliveryId !== id && sameTarget(other.target, row.target) && other.state === "queued");
      if (!ahead) await this.attempt(row, pane);
      return this.reply(row);
    });
  }
  status(id: string, target: Target): Promise<Json> {
    return this.serial(async () => { const row = await this.read(id); if (!row || !sameTarget(row.target, target)) throw new BridgeError(404, "No hand-off with this id and target."); return this.reply(row); });
  }
  private async attempt(row: Row, pane?: Json): Promise<void> {
    try { pane ??= await this.options.validate(row.target); } catch (error) {
      if (error instanceof BridgeError && [404, 409].includes(error.status)) { row.state = "failed"; row.error = error.message.slice(0, 500); await this.save(row); }
      return; // Offline is not gone and does not discard a queued message.
    }
    if (pane.terminal_id !== row.terminal) { row.state = "failed"; row.error = "The worker's terminal changed before delivery."; await this.save(row); return; }
    if (!["idle", "done"].includes(String(pane.agent_status))) return;
    let typed = false;
    try {
      const result = await this.options.send(row.target, row.text, row.deliveryId, async () => {
        row.state = "attempting"; await this.save(row); typed = true;
      });
      row.state = result.delivered === true && result.deliveryUncertain !== true && result.unsubmitted !== true ? "delivered" : "uncertain";
    } catch (error) {
      if (agentNotReady(error) || (error instanceof BridgeError && error.details?.code === "hand-off-busy")) row.state = "queued"; // Herdr guarantees no input was written.
      else if (!typed) {
        if (!(error instanceof BridgeError) || ![404, 409, 422].includes(error.status)) return;
        row.state = "failed";
      } else row.state = "uncertain";
      row.error = (error instanceof Error ? error.message : "Delivery failed.").slice(0, 500);
    }
    if (row.state === "delivered") delete row.error;
    await this.save(row);
  }
  tick(): Promise<void> {
    return this.serial(async () => {
      const rows = await this.rows(), attempted = new Set<string>();
      for (const row of rows) if (row.state === "queued") {
        const key = JSON.stringify(row.target);
        if (attempted.has(key)) continue;
        attempted.add(key); await this.attempt(row);
      }
      for (const row of rows) if (row.origin && !row.notified && ["delivered", "failed", "uncertain"].includes(row.state)) {
        // A notice is itself an idempotent queued hand-off, without an origin.
        const id = `handoff-notice-${createHash("sha256").update(row.deliveryId).digest("hex").slice(0, 40)}`;
        if (row.originComputer) {
          const result = await this.options.notify?.(row.origin, `Hand-off ${row.deliveryId}: ${row.state}.`, id, row.originComputer).catch(() => undefined);
          if (!result || (!result.queued && !result.delivered && !result.deliveryUncertain)) continue;
          row.notified = true; await this.save(row); continue;
        }
        if (!await this.read(id)) {
          const pane = await this.options.validate(row.origin).catch(() => undefined);
          if (!pane || typeof pane.terminal_id !== "string") continue;
          const at = new Date(this.now()).toISOString();
          await this.save({ deliveryId: id, target: row.origin, text: `Hand-off ${row.deliveryId}: ${row.state}.`, terminal: pane.terminal_id,
            state: "queued", createdAt: at, updatedAt: at });
        }
        row.notified = true; await this.save(row);
      }
    });
  }
  hasPending(target: Target): Promise<boolean> { return this.serial(async () => (await this.rows()).some(row => sameTarget(row.target, target) && ["queued", "attempting", "uncertain"].includes(row.state))); }
}
