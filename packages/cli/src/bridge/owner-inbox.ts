import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { atomicInPrivateDir, BridgeError, bridgeRoot, type Json, targetSchema, startingTargetSchema, computerName } from "./protocol.js";
import { tryFileLock } from "../governance/locks.js";
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
export interface InboxSnapshot { sources: InboxSource[]; unavailableDispatches?: string[] }

// Prompt prose, counters and timestamps are observations, not identities.
function sourceKey(row: Pick<InboxItem, "target" | "actionId" | "source" | "computer" | "dispatch">): string | undefined {
  const t = row.target;
  return t ? JSON.stringify([row.computer ?? "local", t.server, t.workspace, t.tab, t.pane, t.source,
    "session" in t ? t.session : t.startingToken, row.actionId ?? "waiting"])
    : row.dispatch ? `dispatch:${row.dispatch}:${row.actionId ?? "waiting"}` : row.source;
}

/** Reconcile automatic work against current sources; manual work is owner-owned.
 * The first reconciliation also migrates old stale/duplicate automatic rows. */
export class OwnerInbox {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly sources: () => Promise<InboxSource[] | InboxSnapshot> = async () => [], private readonly file = path.join(bridgeRoot(), "owner-inbox.json")) {}
  private async read(): Promise<InboxItem[]> {
    const info = await lstat(this.file).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    if (!info) return [];
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new BridgeError(409, "The owner inbox cannot be read safely.");
    return z.array(itemSchema).max(10000).parse(JSON.parse(await readFile(this.file, "utf8")));
  }
  run(input: unknown): Promise<Json> {
    const run = this.pending.then(async () => {
      const data = ownerInboxSchema.parse(input);
      // Wait asynchronously: another instance in this process must be able to
      // finish its write while we contend, just like another CLI process.
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const deadline = Date.now() + 30_000;
      let release = tryFileLock(this.file);
      while (!release) {
        if (Date.now() >= deadline) throw new BridgeError(503, "The owner inbox is busy; retry the operation.");
        await new Promise(resolve => setTimeout(resolve, 20));
        release = tryFileLock(this.file);
      }
      try {
        const rows = await this.read(), at = new Date().toISOString();
        let changed = false;
        // Manual adds/resolves must work even when source discovery is offline.
        if (data.action === "list") {
          const observed = await this.sources();
          const { sources, unavailableDispatches = [] } = Array.isArray(observed) ? { sources: observed } : observed;
          const active = new Map(sources.map(source => [sourceKey(source)!, source]));
          const retained = new Set<string>();
          const resolve = (row: InboxItem, reason: string) => {
            row.state = "resolved"; row.live = false; row.resolvedAt = at; row.updatedAt = at; row.resolution = reason; changed = true;
          };
          for (const row of rows) {
            if (row.kind === "manual") continue;
            // Retired history cannot suppress a later wait on the same pane.
            // An owner dismissal remains live until its current wait ends.
            if (row.state === "resolved" && !row.live) continue;
            const key = sourceKey(row), source = key ? active.get(key) : undefined;
            const unavailable = !!row.dispatch && unavailableDispatches.includes(row.dispatch);
            const live = !!source && !retained.has(key!);
            if (row.live !== live) { row.live = live; row.updatedAt = at; changed = true; }
            if (!source) {
              if (row.state === "open" && !unavailable) resolve(row, "stale: source gone");
              continue;
            }
            if (retained.has(key!)) {
              if (row.state === "open") resolve(row, "duplicate: source");
              continue;
            }
            retained.add(key!);
            if (row.state === "open" && JSON.stringify({ ...row, ...source }) !== JSON.stringify(row)) {
              Object.assign(row, source, { updatedAt: at }); changed = true;
            }
          }
          for (const [key, source] of active) {
            if (retained.has(key)) continue;
            if (rows.length >= 10000) throw new BridgeError(409, "The owner inbox is full.");
            rows.push(itemSchema.parse({ ...source, id: randomUUID(), state: "open", live: true, createdAt: at, updatedAt: at })); changed = true;
          }
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
        return { ok: true, items: rows.filter(row => data.includeResolved || (row.state === "open" && (row.kind === "manual" || row.live === true))).sort((a, b) => a.createdAt.localeCompare(b.createdAt)) };
      } finally { release(); }
    });
    this.pending = run.catch(() => {}); return run;
  }
  async tick(): Promise<void> { await this.run({ action: "list" }); }
}
