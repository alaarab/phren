import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { atomicInPrivateDir, BridgeError, bridgeRoot, type Json, targetSchema, startingTargetSchema, computerName } from "./protocol.js";
import { dispatchStatus } from "./dispatch.js";
const title = z.string().trim().min(1).max(500).refine(s => !/[\x00-\x1f\x7f]/.test(s));
export const inboxTargetSchema = z.union([targetSchema, startingTargetSchema]);
const itemSchema = z.object({
  id: z.string().uuid(), kind: z.enum(["manual", "needs-you", "blocked"]), title,
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), state: z.enum(["open", "resolved"]),
  resolvedAt: z.string().datetime().optional(), resolution: z.string().max(2000).optional(),
  project: z.string().max(200).optional(), computer: z.string().max(253).optional(),
  target: inboxTargetSchema.optional(), dispatch: z.string().uuid().optional(), actionId: z.string().max(200).optional(),
  source: z.string().max(500).optional(), live: z.boolean().optional(),
}).strict();
export type InboxItem = z.infer<typeof itemSchema>;
export const ownerInboxSchema = z.object({
  action: z.enum(["add", "list", "resolve"]).default("list"),
  title: title.optional(), project: z.string().max(200).optional(),
  id: z.string().uuid().optional(), resolution: z.string().max(2000).optional(),
  includeResolved: z.boolean().optional(), computer: computerName.optional(),
}).strict();
export interface InboxSource { source: string; kind: "needs-you" | "blocked"; title: string; project?: string; computer?: string; target?: z.infer<typeof inboxTargetSchema>; dispatch?: string; actionId?: string }
const uuidOf = (source: string) => { const h = createHash("sha256").update(source).digest("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };

/** Hook-owned inbox. Return reads do not resolve owner work. Live sources
 * disappearing are retained as no-longer-live until explicitly resolved. */
export class OwnerInbox {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly sources: () => Promise<InboxSource[]> = async () => [], private readonly file = path.join(bridgeRoot(), "owner-inbox.json")) {}
  private async read(): Promise<InboxItem[]> {
    const info = await lstat(this.file).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    if (!info) return [];
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new BridgeError(409, "The owner inbox cannot be read safely.");
    return z.array(itemSchema).max(10000).parse(JSON.parse(await readFile(this.file, "utf8")));
  }
  run(input: unknown): Promise<Json> {
    const run = this.pending.then(async () => {
      const data = ownerInboxSchema.parse(input), rows = await this.read(), at = new Date().toISOString();
      const sources: InboxSource[] = [];
      for (const receipt of await dispatchStatus()) {
        const returned = receipt.returned;
        if (receipt.closedAt || !returned || !["needs-you", "blocked"].includes(returned.state)) continue;
        if (receipt.worker && receipt.worker.state !== returned.state && !receipt.approval) continue;
        const actionId = receipt.approval?.actionId;
        sources.push({ source: `dispatch:${receipt.id}:${actionId ?? returned.at}`, kind: returned.state as "needs-you" | "blocked",
          title: (receipt.approval?.request ?? returned.question ?? returned.reply ?? `${receipt.label} needs input`).replace(/[\x00-\x1f\x7f]+/g, " ").slice(0, 500),
          project: receipt.project, computer: receipt.computer, ...("session" in (receipt.target ?? {}) ? { target: receipt.target as z.infer<typeof targetSchema> } : {}), dispatch: receipt.id, ...(actionId ? { actionId } : {}) });
      }
      for (const source of await this.sources()) {
        if (source.actionId && sources.some(other => other.actionId === source.actionId && JSON.stringify(other.target) === JSON.stringify(source.target))) continue;
        sources.push(source);
      }
      let changed = false;
      const live = new Set(sources.map(s => s.source));
      for (const row of rows) if (row.source && row.live !== live.has(row.source)) { row.live = live.has(row.source); row.updatedAt = at; changed = true; }
      for (const source of sources) {
        const existing = rows.find(row => row.source === source.source);
        if (existing) continue; // Resolved sources do not resurrect on a poll.
        if (rows.length >= 10000) throw new BridgeError(409, "The owner inbox is full.");
        rows.push(itemSchema.parse({ ...source, id: uuidOf(source.source), state: "open", live: true, createdAt: at, updatedAt: at })); changed = true;
      }
      if (data.action === "add") {
        if (!data.title) throw new BridgeError(400, "Name the owner inbox item.");
        const item = itemSchema.parse({ id: data.id ?? randomUUID(), kind: "manual", title: data.title, state: "open", createdAt: at, updatedAt: at, ...(data.project ? { project: data.project } : {}) });
        const prior = rows.find(row => row.id === item.id);
        if (prior && (prior.title !== item.title || prior.project !== item.project || prior.kind !== "manual")) throw new BridgeError(409, "This inbox id names another item.");
        if (!prior) { if (rows.length >= 10000) throw new BridgeError(409, "The owner inbox is full."); rows.push(item); changed = true; }
        if (changed) await atomicInPrivateDir(this.file, rows);
        return { ok: true, item: prior ?? item };
      }
      if (data.action === "resolve") {
        const item = rows.find(row => row.id === data.id);
        if (!item) throw new BridgeError(404, "No owner inbox item with that id.");
        if (item.state !== "resolved") { item.state = "resolved"; item.resolvedAt = at; item.updatedAt = at; item.resolution = data.resolution; changed = true; }
        if (changed) await atomicInPrivateDir(this.file, rows);
        return { ok: true, item };
      }
      if (changed) await atomicInPrivateDir(this.file, rows);
      return { ok: true, items: rows.filter(row => data.includeResolved || row.state === "open").sort((a, b) => a.createdAt.localeCompare(b.createdAt)) };
    });
    this.pending = run.catch(() => {}); return run;
  }
  async tick(): Promise<void> { await this.run({ action: "list" }); }
}
