// The owner's unsent prompts, bound to a pane AND its current conversation.
// Delivery settlement belongs to PromptDeliveries; this file owns admission,
// editing, cancellation and consumption of exactly one item per Stop boundary.
import { readFileSync } from "node:fs";
import { z } from "zod";
import { atomicInPrivateDir, BridgeError, targetSchema, type Target } from "./protocol.js";
import type { DeliveryStatus } from "./prompt-deliveries.js";
import { agentNotReady } from "./terminal.js";
import { turnPhase, type TurnRecord } from "./turn-records.js";

const itemId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const textSchema = z.string().min(1).max(32768).refine(text => !!text.trim() && !/[\x00-\x08\x0b-\x1f\x7f]/.test(text));
const itemSchema = z.object({
  id: itemId, target: targetSchema, terminal: z.string().min(1).max(200), text: textSchema,
  state: z.enum(["queued", "sending", "delivered", "failed", "cancelled", "unknown"]),
  reason: z.enum(["pane-closed", "agent-restarted", "conversation-changed", "delivery-failed"]).optional(),
  detail: z.string().max(500).optional(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
});
export type TurnQueueItem = z.infer<typeof itemSchema>;
const boundarySchema = z.object({ terminal: z.string(), source: z.string(), session: z.string(), stop: z.number(), at: z.string() });
type Boundary = z.infer<typeof boundarySchema>;
const storeSchema = z.object({ items: z.array(itemSchema).max(512), boundaries: z.record(z.string(), boundarySchema).default({}) });
const paneKey = (target: Target) => JSON.stringify([target.server, target.pane]);
const sameTarget = (a: Target, b: Target) => a.server === b.server && a.pane === b.pane && a.source === b.source && a.session === b.session;
const boundary = (record: TurnRecord): Boundary => ({ terminal: record.terminal, source: record.source, session: record.session, stop: record.stop!.seq, at: record.stop!.at });
const RETENTION_MS = 24 * 3_600_000;

export interface TurnQueuePane {
  terminal: string; source: string; session?: string; record?: TurnRecord;
  /** Includes session-activity's awaited shells and running children. */
  background: number; held: boolean; ready: boolean;
}
export interface TurnQueueDeps {
  /** Undefined means confirmed absent; transport/read failures must throw. */
  current(target: Target): Promise<TurnQueuePane | undefined>;
  send(target: Target, text: string, id: string, typing: () => Promise<void>): Promise<Record<string, unknown>>;
  delivery(target: Target, id: string): DeliveryStatus;
  /** During the typing recheck, exclude only this item’s own reservation. */
  holding(target: Target, exceptId?: string): boolean;
}

export class TurnQueue {
  private items: TurnQueueItem[] = [];
  private boundaries: Record<string, Boundary> = {};
  private serial: Promise<unknown> = Promise.resolve();
  private ticking?: Promise<void>;
  constructor(private file: string, private deps: TurnQueueDeps) {
    try {
      const saved = storeSchema.parse(JSON.parse(readFileSync(file, "utf8")));
      this.items = saved.items.map(item => item.state === "sending" ? { ...item, state: "unknown" } : item);
      this.boundaries = saved.boundaries;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  private run<T>(action: () => Promise<T>): Promise<T> {
    const result = this.serial.then(action);
    this.serial = result.catch(() => undefined);
    return result;
  }
  private async save() {
    await atomicInPrivateDir(this.file, { items: this.items, boundaries: this.boundaries });
  }
  private prune() {
    this.items = this.items.filter(item => ["queued", "sending", "unknown"].includes(item.state) || Date.now() - Date.parse(item.updatedAt) < RETENTION_MS);
    // Keep consumed boundaries while any item still belongs to that pane.
    const panes = new Set(this.items.map(item => paneKey(item.target)));
    for (const key of Object.keys(this.boundaries)) if (!panes.has(key)) delete this.boundaries[key];
  }
  count(server: string, pane: string): number { return this.items.filter(item => item.target.server === server && item.target.pane === pane && item.state === "queued").length; }
  list(target: Target): TurnQueueItem[] { return structuredClone(this.items.filter(item => item.target.server === target.server && item.target.pane === target.pane)); }
  private find(target: Target, id: string) {
    const item = this.items.find(item => item.id === id && sameTarget(item.target, target));
    if (!item) throw new BridgeError(404, "No queued prompt with that id belongs to this target.");
    return item;
  }
  enqueue(target: Target, id: string, text: string): Promise<TurnQueueItem> {
    return this.run(async () => {
      this.prune();
      const prior = this.items.find(item => item.id === id);
      if (prior) {
        if (!sameTarget(prior.target, target)) throw new BridgeError(409, "This queue id belongs to another target.");
        return structuredClone(prior);
      }
      if (this.deps.delivery(target, id).state !== "unknown") throw new BridgeError(409, "This id already belongs to a prompt delivery.");
      if (this.items.length >= 512 || this.count(target.server, target.pane) >= 20) throw new BridgeError(409, "The prompt queue is full.");
      const current = await this.deps.current(target);
      if (!current) throw new BridgeError(404, "The pane is closed.");
      if (current.source !== target.source || current.session !== target.session) throw new BridgeError(409, "The conversation changed.");
      const at = new Date().toISOString();
      const item: TurnQueueItem = { id, target, terminal: current.terminal, text, state: "queued", createdAt: at, updatedAt: at };
      this.items.push(item);
      try { await this.save(); } catch (error) { this.items.pop(); throw error; }
      return structuredClone(item);
    });
  }
  change(target: Target, id: string, text?: string): Promise<TurnQueueItem> {
    return this.run(async () => {
      const item = this.find(target, id);
      if (item.state !== "queued") throw new BridgeError(409, "Only a queued prompt can be edited or cancelled.");
      const candidate = { ...item, ...(text === undefined ? { state: "cancelled" as const } : { text }), updatedAt: new Date().toISOString() };
      await atomicInPrivateDir(this.file, { items: this.items.map(row => row === item ? candidate : row), boundaries: this.boundaries });
      Object.assign(item, candidate);
      return structuredClone(item);
    });
  }
  private fail(item: TurnQueueItem, reason: NonNullable<TurnQueueItem["reason"]>, detail?: string) {
    item.state = "failed"; item.reason = reason; item.updatedAt = new Date().toISOString();
    if (detail) item.detail = detail.slice(0, 500);
  }
  private async settle(item: TurnQueueItem): Promise<void> {
    const delivery = this.deps.delivery(item.target, item.id);
    if (delivery.state === "delivered") {
      item.state = "delivered"; item.updatedAt = new Date().toISOString(); delete item.reason; delete item.detail;
      await this.save();
    } else if (delivery.state === "failed" && (item.state !== "failed" || item.detail !== delivery.reason)) {
      this.fail(item, "delivery-failed", delivery.reason); await this.save();
    }
  }
  private eligible(item: TurnQueueItem, current: TurnQueuePane, excludeOwn = false, allowConsumed = false): boolean {
    const record = current.record;
    const previous = this.boundaries[paneKey(item.target)];
    // Duplicate Stop callbacks do not create another turn. Require a prompt
    // after the consumed Stop before releasing another item in this conversation.
    const consumed = previous && record && previous.terminal === record.terminal && previous.source === record.source && previous.session === record.session
      && (!record.prompt || (record.source === "opencode"
        ? Date.parse(record.prompt.at) <= Date.parse(previous.at)
        : record.prompt.seq <= previous.stop));
    return (allowConsumed || !consumed) && !!record && record.terminal === item.terminal && record.source === item.target.source && record.session === item.target.session
      && turnPhase(record).phase === "ended" && !current.background && !current.held && current.ready
      && !this.deps.holding(item.target, excludeOwn ? item.id : undefined);
  }
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.drain().finally(() => { this.ticking = undefined; });
    return this.ticking;
  }
  private reconcilable(item: TurnQueueItem): boolean {
    return ["sending", "unknown"].includes(item.state) || (item.state === "failed" && item.reason === "delivery-failed");
  }
  private async drain(): Promise<void> {
    // Serialise mutations, but never hold the lock across a prompt delivery:
    // hooks must still be able to settle it and clients see sending immediately.
    const panes = new Set(this.items.filter(item => item.state === "queued" || this.reconcilable(item)).map(item => paneKey(item.target)));
    for (const key of panes) {
      try {
        const send = await this.run(async () => {
          for (const item of this.items.filter(item => paneKey(item.target) === key && this.reconcilable(item))) await this.settle(item);
          const queued = this.items.filter(item => paneKey(item.target) === key && item.state === "queued");
          let head: TurnQueueItem | undefined, current: TurnQueuePane | undefined;
          for (const item of queued) {
            current = await this.deps.current(item.target);
            const reason = !current ? "pane-closed" : current.terminal !== item.terminal || current.source !== item.target.source ? "agent-restarted"
              : current.session && current.session !== item.target.session ? "conversation-changed" : undefined;
            if (reason) { this.fail(item, reason); await this.save(); continue; }
            head = item; break;
          }
          if (this.items.some(item => paneKey(item.target) === key && ["sending", "unknown"].includes(item.state))) return;
          if (!head || !current || !this.eligible(head, current)) return;
          return { item: head, text: head.text, boundary: boundary(current.record!) };
        });
        if (!send) continue;
        let attempted = false;
        const previous = this.boundaries[key];
        try {
          const reply = await this.deps.send(send.item.target, send.text, send.item.id, () => this.run(async () => {
            // Recheck after prompt routing's asynchronous identity/model guards.
            const current = await this.deps.current(send.item.target);
            if (send.item.state !== (attempted ? "sending" : "queued") || send.item.text !== send.text || !current || !this.eligible(send.item, current, true, attempted) || JSON.stringify(boundary(current.record!)) !== JSON.stringify(send.boundary)) {
              // A second typing callback is a fallback after the API path
              // confirmed it sent nothing. Refusing it also sends nothing;
              // retain the item for a fresh binding check on the next tick.
              throw new BridgeError(409, "The queued prompt no longer has a safe turn boundary.",
                attempted ? { promptNotSent: true, promptRetry: true } : undefined);
            }
            if (attempted) return; // rechecked a definite-refusal fallback; keep the same consumed boundary
            send.item.state = "sending"; send.item.updatedAt = new Date().toISOString();
            this.boundaries[key] = send.boundary;
            try { await this.save(); } catch (error) {
              send.item.state = "queued";
              if (previous === undefined) delete this.boundaries[key]; else this.boundaries[key] = previous;
              throw error;
            } // write-ahead: no typing unless this succeeds
            attempted = true;
          }));
          await this.run(async () => {
            if (!attempted) return;
            await this.settle(send.item);
            if (send.item.state === "sending" && reply.delivered === true) { send.item.state = "delivered"; send.item.updatedAt = new Date().toISOString(); await this.save(); }
            else if (send.item.state === "sending" && this.deps.delivery(send.item.target, send.item.id).state === "unknown") { send.item.state = "unknown"; send.item.updatedAt = new Date().toISOString(); await this.save(); }
          });
        } catch (error) {
          if (attempted) await this.run(async () => {
            await this.settle(send.item);
            if (send.item.state !== "sending") return;
            if (error instanceof BridgeError && error.details?.promptNotSent === true) {
              // The delivery path aborted its reservation: no bytes reached
              // the agent. This Stop is still available for a later send.
              if (previous === undefined) delete this.boundaries[key]; else this.boundaries[key] = previous;
              if (agentNotReady(error) || error.details.promptRetry === true) { send.item.state = "queued"; send.item.updatedAt = new Date().toISOString(); }
              else this.fail(send.item, "delivery-failed", error.message);
            } else { send.item.state = "unknown"; send.item.updatedAt = new Date().toISOString(); }
            await this.save();
          });
          // Before typing, a busy guard is retried at the next tick. Other
          // definite refusals are visible failures rather than stuck items.
          else if (error instanceof BridgeError && error.status !== 409) await this.run(async () => { this.fail(send.item, "delivery-failed", error.message); await this.save(); });
        }
      } catch { /* Offline or unreadable: preserve the queue and try next tick. */ }
    }
  }
}

/** POST siblings of /v1/prompt, with its full authenticated target contract.
 * Listing/editing/cancelling use the original target even after its pane closes. */
export async function turnQueueRoute(queue: TurnQueue, route: string, data: unknown): Promise<unknown> {
  const input = z.object({ target: targetSchema, id: itemId.optional(), text: textSchema.optional() }).strict().parse(data);
  if (route === "/v1/prompt/after-turn/list") return { items: queue.list(input.target) };
  if (!input.id) throw new BridgeError(400, "Name the queued prompt by id.");
  if (route === "/v1/prompt/after-turn/cancel") return { item: await queue.change(input.target, input.id) };
  if (route !== "/v1/prompt/after-turn" && route !== "/v1/prompt/after-turn/edit") throw new BridgeError(404, "Unknown prompt queue route.");
  if (input.text === undefined) throw new BridgeError(400, "Supply the queued prompt text.");
  return { item: route.endsWith("/edit") ? await queue.change(input.target, input.id, input.text) : await queue.enqueue(input.target, input.id, input.text) };
}
