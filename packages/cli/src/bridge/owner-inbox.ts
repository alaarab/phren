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
  ifUpdatedAt: z.string().datetime().optional(),
  includeResolved: z.boolean().optional(), computer: computerName.optional(),
  command: command.optional(), task: taskRef.optional(), pr: prRef.optional(), key: dedupeKey.optional(),
}).strict();
export interface InboxSource { source: string; kind: "needs-you" | "blocked"; title: string; project?: string; computer?: string; target?: z.infer<typeof inboxTargetSchema>; dispatch?: string; actionId?: string; task?: string }
export interface InboxSnapshot { sources: InboxSource[]; unavailableDispatches?: string[] }

/** Use a separate shell for multiline commands so `&&` cannot suppress their errexit. */
export function pasteCommand(item: { id: string; command: string; updatedAt: string }, inboxComputer?: string): string {
  const resolve = `phren owner-inbox resolve ${item.id} --resolution done --if-updated-at ${item.updatedAt}${inboxComputer && inboxComputer !== "local" ? ` --computer ${inboxComputer}` : ""}`;
  const run = item.command.includes("\n") ? `sh -ec '${item.command.replaceAll("'", "'\\''")}'` : item.command;
  return `${run} && ${resolve}`;
}

/** `paste` is computed on the way out, never stored. */
const withPaste = (item: InboxItem): Json => item.command
  ? { ...item, paste: pasteCommand({ id: item.id, command: item.command, updatedAt: item.updatedAt }) }
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
        const rows = await this.read(), now = Date.now(), at = new Date(now).toISOString();
        // Edits in the same millisecond still need distinct paste revisions.
        const nextUpdate = (row: InboxItem) => new Date(Math.max(now, Date.parse(row.updatedAt) + 1)).toISOString();
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
            // An owner-closed live row still suppresses its wait while the
            // dispatch cannot be read: forgetting it here would let the next
            // successful tick create a second row for the same wait.
            const live = unavailable && row.state === "resolved" ? row.live : !!source && !retained.has(key!);
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
                  row.state = "resolved"; row.resolvedAt = at; row.updatedAt = nextUpdate(row); row.resolution = resolution; changed = true;
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
            row.title = next.title; row.updatedAt = nextUpdate(row);
            for (const name of ["project", "command", "task", "pr", "key"] as const) {
              if (next[name] === undefined) delete row[name]; else row[name] = next[name];
            }
          };
          // The normalized PR and key each identify an open item, including the implicit `pr:` key.
          const effective = next.key ?? (next.pr ? `pr:${next.pr}` : undefined);
          const prior = data.id ? rows.find(row => row.id === data.id) : undefined;
          if (prior && prior.kind !== "manual") throw new BridgeError(409, "This inbox id names another item.");
          if (prior?.state === "resolved" && !differs(prior)) return { ok: true, item: withPaste(prior) };
          const matches = rows.filter(row => row.kind === "manual" && row.state === "open" && (
            (next.pr && row.pr === next.pr) || (effective && (row.key ?? (row.pr ? `pr:${row.pr}` : undefined)) === effective)));
          if (matches.length > 1 || (prior && matches.length && matches[0] !== prior)) {
            throw new BridgeError(409, "These inbox identifiers name different items.");
          }
          if (prior && prior.state === "resolved") {
            apply(prior); prior.state = "open"; delete prior.resolvedAt; delete prior.resolution;
            await atomicInPrivateDir(this.file, rows);
            return { ok: true, item: withPaste(prior), reopened: true };
          }
          const target = prior ?? matches[0];
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
          if (data.ifUpdatedAt !== undefined && item.updatedAt !== data.ifUpdatedAt) throw new BridgeError(409, "This inbox item changed. Refresh it and try again.");
          if (item.state !== "resolved") { item.state = "resolved"; item.resolvedAt = at; item.updatedAt = nextUpdate(item); item.resolution = data.resolution; changed = true; }
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
  /** A signed phone decision on one row, guarded by the exact revision the
   * phone read. Resolve means handled; dismiss removes the row from this
   * Hook's shared list. Both are final in v1. Check and write under the same
   * lock an ordinary read takes, so a concurrent tick cannot resurrect it. */
  async close(id: string, ifUpdatedAt: string, decision: "resolve" | "dismiss"): Promise<InboxItem> {
    const run = this.pending.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const deadline = Date.now() + 30_000;
      let release = tryFileLock(this.file);
      while (!release) {
        if (Date.now() >= deadline) throw new BridgeError(503, "The owner inbox is busy; retry the operation.");
        await new Promise(resolve => setTimeout(resolve, 20));
        release = tryFileLock(this.file);
      }
      try {
        const rows = await this.read(), now = Date.now();
        const item = rows.find(row => row.id === id);
        if (!item) throw new BridgeError(404, "No owner inbox item with that id.");
        if (item.state !== "open") throw new BridgeError(409, "This inbox item was already handled.");
        if (item.updatedAt !== ifUpdatedAt) throw new BridgeError(409, "This inbox item changed. Refresh it and try again.");
        // Edits in the same millisecond still need distinct paste revisions.
        const at = new Date(Math.max(now, Date.parse(item.updatedAt) + 1)).toISOString();
        item.state = "resolved"; item.updatedAt = at; item.resolvedAt = at;
        item.resolution = decision === "resolve" ? "done" : "dismissed";
        // A closed automatic row keeps suppressing its current wait until a
        // reconciliation sees that wait end; a manual row has no live wait.
        if (item.kind !== "manual") item.live = true;
        await atomicInPrivateDir(this.file, rows);
        return item;
      } finally { release(); }
    });
    this.pending = run.catch(() => {}); return run;
  }
  /** Reconcile and return the open snapshot a push sweep may alert about. */
  async tick(): Promise<InboxItem[]> {
    const result = await this.run({ action: "list" });
    return Array.isArray(result.items) ? result.items as InboxItem[] : [];
  }
}
