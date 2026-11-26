import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { parseForgeUrl } from "../task/work.js";
import { atomicInPrivateDir, BridgeError, bridgeRoot, type Json, targetSchema, startingTargetSchema, computerName } from "./protocol.js";
import { tryFileLock } from "../governance/locks.js";
const title = z.string().trim().min(1).max(500).refine(s => !/[\x00-\x1f\x7f]/.test(s));
/** A paste-able shell command for the owner; phren never runs it. \n and \t
 * survive a terminal paste, other control characters do not, and twenty
 * lines is the most one paste should carry. */
const command = z.string().min(1).max(4000).refine(s => !/[\x00-\x08\x0b-\x1f\x7f]/.test(s)).refine(s => s.split("\n").length <= 20);
const taskRef = z.string().regex(/^bid:[a-f0-9]{8}$/);
const prRef = z.string().max(1000).refine(s => parseForgeUrl(s)?.kind === "pull");
const dedupeKey = z.string().min(1).max(200).regex(/^[A-Za-z0-9:_./#@-]+$/);
export const inboxTargetSchema = z.union([targetSchema, startingTargetSchema]);
const itemSchema = z.object({
  id: z.string().uuid(), kind: z.enum(["manual", "needs-you", "blocked"]), title,
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), state: z.enum(["open", "resolved"]),
  resolvedAt: z.string().datetime().optional(), resolution: z.string().max(2000).optional(),
  project: z.string().max(200).optional(), computer: z.string().max(253).optional(),
  target: inboxTargetSchema.optional(), dispatch: z.string().uuid().optional(), actionId: z.string().max(200).optional(),
  source: z.string().max(500).optional(), live: z.boolean().optional(),
  // Manual extras: what the owner should run, and the task and pull request it links.
  command: command.optional(), task: taskRef.optional(), pr: prRef.optional(), key: dedupeKey.optional(),
}).strict();
export type InboxItem = z.infer<typeof itemSchema>;
export const ownerInboxSchema = z.object({
  action: z.enum(["add", "list", "resolve"]).default("list"),
  title: title.optional(), project: z.string().max(200).optional(),
  id: z.string().uuid().optional(), resolution: z.string().max(2000).optional(),
  includeResolved: z.boolean().optional(), computer: computerName.optional(),
  command: command.optional(), task: taskRef.optional(), pr: prRef.optional(), key: dedupeKey.optional(),
}).strict();
export interface InboxSource { source: string; kind: "needs-you" | "blocked"; title: string; project?: string; computer?: string; target?: z.infer<typeof inboxTargetSchema>; dispatch?: string; actionId?: string; task?: string }
export interface InboxSnapshot { sources: InboxSource[]; unavailableDispatches?: string[] }

/** The paste the owner runs: the command, then the resolve that closes the
 * item. A one-line command chains with `&&`; a multi-line one ends with the
 * resolve on its own line so the whole paste stays one runnable block. */
export function pasteCommand(item: { id: string; command: string }, inboxComputer?: string): string {
  const resolve = `phren owner-inbox resolve ${item.id} --resolution done${inboxComputer && inboxComputer !== "local" ? ` --computer ${inboxComputer}` : ""}`;
  return item.command.includes("\n") ? `${item.command}\n${resolve}` : `${item.command} && ${resolve}`;
}

/** `paste` is computed on the way out, never stored. */
const withPaste = (item: InboxItem): Json => item.command
  ? { ...item, paste: pasteCommand({ id: item.id, command: item.command }) }
  : item;

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
  /** `done` reports the open manual items whose linked action happened (item
   * id → resolution), so a list can resolve them without the owner. */
  constructor(private readonly sources: () => Promise<InboxSource[] | InboxSnapshot> = async () => [],
    private readonly file = path.join(bridgeRoot(), "owner-inbox.json"),
    private readonly done?: (items: InboxItem[]) => Promise<Map<string, string>>) {}
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
          // Once the automatic rows are settled, ask whether each open manual
          // item's linked action happened; a failing probe never blocks a read.
          if (this.done) {
            const manual = rows.filter(row => row.kind === "manual" && row.state === "open");
            if (manual.length) {
              const resolutions = await this.done(manual).catch(() => undefined);
              for (const [id, resolution] of resolutions ?? []) {
                const row = rows.find(candidate => candidate.id === id);
                if (row?.kind === "manual" && row.state === "open") {
                  row.state = "resolved"; row.resolvedAt = at; row.updatedAt = at; row.resolution = resolution; changed = true;
                }
              }
            }
          }
        }
        if (data.action === "add") {
          if (!data.title) throw new BridgeError(400, "Name the owner inbox item.");
          // The schema guarantees a pr parses as a pull request; store its normalized url.
          const pr = data.pr ? parseForgeUrl(data.pr) : undefined;
          // Unset fields are left out, not stored as undefined.
          const fields = { project: data.project, command: data.command, task: data.task, pr: pr?.url, key: data.key };
          const next = { title: data.title, ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) } as Pick<InboxItem, "title" | "project" | "command" | "task" | "pr" | "key">;
          const differs = (row: InboxItem) => row.title !== next.title || row.project !== next.project || row.command !== next.command
            || row.task !== next.task || row.pr !== next.pr || row.key !== next.key;
          const apply = (row: InboxItem): void => {
            row.title = next.title; row.updatedAt = at;
            for (const name of ["project", "command", "task", "pr", "key"] as const) {
              if (next[name] === undefined) delete row[name]; else row[name] = next[name];
            }
          };
          // An explicit key, or the default `pr:` one, upserts the open item carrying it.
          const effective = next.key ?? (next.pr ? `pr:${next.pr}` : undefined);
          const prior = data.id ? rows.find(row => row.id === data.id) : undefined;
          if (prior && prior.kind !== "manual") throw new BridgeError(409, "This inbox id names another item.");
          if (prior && prior.state === "resolved") {
            // An identical retry is idempotent; changed fields reopen the item,
            // so a daily alert can reuse a weekly id with new text.
            if (differs(prior)) {
              apply(prior); prior.state = "open"; delete prior.resolvedAt; delete prior.resolution;
              await atomicInPrivateDir(this.file, rows);
              return { ok: true, item: withPaste(prior), reopened: true };
            }
            return { ok: true, item: withPaste(prior) };
          }
          const keyed = effective ? rows.find(row => row.kind === "manual" && row.state === "open"
            && (row.key ?? (row.pr ? `pr:${row.pr}` : undefined)) === effective) : undefined;
          const target = prior ?? keyed;
          if (target) {
            if (differs(target)) {
              apply(target);
              await atomicInPrivateDir(this.file, rows);
              return { ok: true, item: withPaste(target), updated: true };
            }
            return { ok: true, item: withPaste(target) };
          }
          if (rows.length >= 10000) throw new BridgeError(409, "The owner inbox is full.");
          const item = itemSchema.parse({ id: data.id ?? randomUUID(), kind: "manual", ...next, state: "open", createdAt: at, updatedAt: at });
          rows.push(item);
          await atomicInPrivateDir(this.file, rows);
          return { ok: true, item: withPaste(item) };
        }
        if (data.action === "resolve") {
          const item = rows.find(row => row.id === data.id);
          if (!item) throw new BridgeError(404, "No owner inbox item with that id.");
          if (item.state !== "resolved") { item.state = "resolved"; item.resolvedAt = at; item.updatedAt = at; item.resolution = data.resolution; changed = true; }
          if (changed) await atomicInPrivateDir(this.file, rows);
          return { ok: true, item };
        }
        if (changed) await atomicInPrivateDir(this.file, rows);
        const visible = rows.filter(row => data.includeResolved || (row.state === "open" && (row.kind === "manual" || row.live === true))).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        return { ok: true, items: visible.map(row => row.kind === "manual" ? withPaste(row) : row) };
      } finally { release(); }
    });
    this.pending = run.catch(() => {}); return run;
  }
  async tick(): Promise<void> { await this.run({ action: "list" }); }
}
