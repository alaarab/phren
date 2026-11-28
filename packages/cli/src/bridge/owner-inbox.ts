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
/** The issues layer's repo reference: lowercase dotted labels, then an owner and
 * a name, each a plain path segment (never "." or ".."). */
const repoDomain = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const repoSegment = /^[A-Za-z0-9._-]+$/;
/** A forge issue link, `domain/owner/name#N` (for example
 * `github.com/alaarab/phren#42`), at most 300 characters. The number is a safe
 * integer, so a link always names one issue. */
export function parseIssueLink(text: string): { repo: string; number: number } | undefined {
  if (text.length > 300) return undefined;
  const match = /^(.+)#([1-9][0-9]*)$/.exec(text);
  if (!match) return undefined;
  const repo = match[1], number = Number(match[2]);
  if (!Number.isSafeInteger(number)) return undefined;
  const parts = repo.split("/");
  if (parts.length !== 3) return undefined;
  const [domain, owner, name] = parts;
  if (!repoDomain.test(domain)) return undefined;
  if (![owner, name].every(part => repoSegment.test(part) && part !== "." && part !== "..")) return undefined;
  return { repo, number };
}
const issueRef = z.string().max(300).refine(s => parseIssueLink(s) !== undefined,
  "Use domain/owner/name#N, for example github.com/alaarab/phren#42.");
export const inboxTargetSchema = z.union([targetSchema, startingTargetSchema]);
const itemSchema = z.object({
  id: z.string().uuid(), kind: z.enum(["manual", "needs-you", "blocked"]), title,
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), state: z.enum(["open", "resolved"]),
  resolvedAt: z.string().datetime().optional(), resolution: z.string().max(2000).optional(),
  project: z.string().max(200).optional(), computer: z.string().max(253).optional(),
  target: inboxTargetSchema.optional(), dispatch: z.string().uuid().optional(), actionId: z.string().max(200).optional(),
  source: z.string().max(500).optional(), live: z.boolean().optional(),
  // Manual extras: what the owner should run, and the task and pull request it
  // links. An issue link never gets a key of its own: it rides in the title, so
  // a Hook from before it existed still reads every stored row (see
  // `inboxIssueTitle`).
  command: command.optional(), task: taskRef.optional(), pr: prRef.optional(), key: dedupeKey.optional(),
}).strict();
export type InboxItem = z.infer<typeof itemSchema>;
/** Rows a previous build wrote, read once and migrated: its inline reopen
 * marker, and an `issue` key that must become part of the title. */
const legacyMarkedItemSchema = itemSchema.extend({ reopened: z.boolean().optional(), issue: issueRef.optional() });
const MAX_ITEMS = 10_000;
const reopenedSchema = z.array(z.string().uuid()).max(MAX_ITEMS);
/** The internal tick snapshot: the public open row plus whether this is the
 * row's first open, which a reword or a same-id reopen must not reset. */
export type InboxTickItem = InboxItem & { firstOpen: boolean };
export const ownerInboxSchema = z.object({
  action: z.enum(["add", "list", "resolve"]).default("list"),
  title: title.optional(), project: z.string().max(200).optional(),
  id: z.string().uuid().optional(), resolution: z.string().max(2000).optional(),
  ifUpdatedAt: z.string().datetime().optional(),
  includeResolved: z.boolean().optional(), computer: computerName.optional(),
  command: command.optional(), task: taskRef.optional(), pr: prRef.optional(), issue: issueRef.optional(), key: dedupeKey.optional(),
  /** The reader asks for the structured `issue` field. Without it, the row is
   * sent as stored: the link stays in the title, where every older strict Hook
   * and phone schema accepts it. Set from the route's `issues=1`, never by a
   * client body in this build. */
  issues: z.boolean().optional(),
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
const withPaste = (row: InboxItem): Json => row.command
  ? { ...row, paste: pasteCommand({ id: row.id, command: row.command, updatedAt: row.updatedAt }) }
  : row;

/** How a reader without the structured `issue` field learns the link. */
export function issueSuffix(issue: string): string { return ` (issue: ${issue})`; }

/** A stored title split into its plain text and the issue link it carries. */
export function issueInTitle(title: string): { title: string; issue?: string } {
  const match = / \(issue: ([^()\s]+)\)$/.exec(title);
  return match && parseIssueLink(match[1]) ? { title: title.slice(0, match.index), issue: match[1] } : { title };
}

const ELLIPSIS = "…";
/** The item title bound: `itemSchema`'s `title.max` and the phone contract. */
export const INBOX_TITLE_LIMIT = 500;
/** How long a plain title may be beside this link. */
export function titleBudget(issue: string): number { return INBOX_TITLE_LIMIT - issueSuffix(issue).length; }

/** The stored title: the plain title plus its link, exactly. Never trimmed,
 * because two different titles would then store identically and a re-add would
 * not advance `updatedAt` (which a stale close and a reopen rely on). A caller
 * adding a link checks `titleBudget` first and refuses a title that does not
 * fit; idempotent, so a title already carrying the link is not decorated twice. */
export function inboxIssueTitle(item: { title: string; issue?: string }): string {
  const parsed = issueInTitle(item.title);
  const link = item.issue ?? parsed.issue;
  if (!link) return item.title;
  return `${parsed.issue ? parsed.title : item.title}${issueSuffix(link)}`;
}

/** The APNs alert body, which `push.ts` cuts at 500 UTF-8 bytes: trim by bytes
 * with the link's own bytes reserved, so a long title never loses the link.
 * This trims a notification only, never a stored row. */
export function pushIssueTitle(item: { title: string; issue?: string }): string {
  const composed = inboxIssueTitle(item);
  const parsed = issueInTitle(composed);
  if (!parsed.issue) return composed;
  const suffix = issueSuffix(parsed.issue), bytes = (text: string) => Buffer.byteLength(text, "utf8");
  const budget = 500 - bytes(suffix);
  if (bytes(parsed.title) <= budget) return composed;
  let end = parsed.title.length;
  while (end > 0 && bytes(parsed.title.slice(0, end)) + bytes(ELLIPSIS) > budget) end--;
  // Never cut a surrogate pair in half: a lone one becomes U+FFFD on the wire.
  if (end > 0 && /[\uD800-\uDBFF]/.test(parsed.title[end - 1])) end--;
  if (end === 0) return suffix.trimStart();
  return `${parsed.title.slice(0, end).trimEnd()}${ELLIPSIS}${suffix}`;
}

/**
 * One inbox row as a reader receives it. The stored row carries the link only
 * in its title, which every older strict Hook and phone schema accepts. A
 * reader that asks for it (`issues`) gets the link as a field and the plain
 * title instead; everyone else gets the row as stored.
 */
export function inboxWire(item: Json, issues = false): Json {
  const { issue, ...rest } = item;
  if (typeof item.title !== "string") return issues ? { ...item } : { ...rest };
  const parsed = issueInTitle(item.title);
  const link = typeof issue === "string" ? issue : parsed.issue;
  if (issues) return { ...rest, ...(link ? { issue: link } : {}), title: link ? parsed.title : item.title };
  // A stored title already carries its own link. Only a legacy row's separate
  // `issue` key is folded in, and only when it fits: never trim a title.
  const title = parsed.issue || !link || parsed.title.length > titleBudget(link) ? item.title : inboxIssueTitle({ title: parsed.title, issue: link });
  return { ...rest, title };
}

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
  private get reopenedFile(): string { return `${this.file}.reopened`; }

  private async readReopened(): Promise<Set<string>> {
    const info = await lstat(this.reopenedFile).catch(error => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!info) return new Set();
    if (!info.isFile() || info.size > 512 * 1024) throw new BridgeError(409, "The owner inbox reopen markers cannot be read safely.");
    return new Set(reopenedSchema.parse(JSON.parse(await readFile(this.reopenedFile, "utf8"))));
  }

  private async recordReopens(ids: string[], rows: InboxItem[]): Promise<void> {
    const reopened = await this.readReopened();
    for (const id of ids) reopened.add(id);
    // The sidecar is bounded by the Inbox's retained IDs.
    const retained = [...new Set(rows.map(row => row.id))].filter(id => reopened.has(id));
    await atomicInPrivateDir(this.reopenedFile, retained);
  }

  /** Called under the Inbox lock, including while migrating a previous build's
   * inline reopen marker or `issue` key. */
  private async read(): Promise<InboxItem[]> {
    const info = await lstat(this.file).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    if (!info) return [];
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new BridgeError(409, "The owner inbox cannot be read safely.");
    const stored = z.array(legacyMarkedItemSchema).max(MAX_ITEMS).parse(JSON.parse(await readFile(this.file, "utf8")));
    if (!stored.some(row => row.reopened !== undefined || row.issue !== undefined)) return stored;
    // A previous build kept the issue link in a key of its own; fold it into
    // the title so this Hook's store is one an older Hook reads too. A title
    // with no room for the link keeps its text and loses the link, never a
    // trimmed title that could collide with another row.
    const rows = stored.map(({ reopened: _, issue, ...row }) => issue && row.title.length <= titleBudget(issue)
      ? { ...row, title: inboxIssueTitle({ title: row.title, issue }) } : row);
    const reopened = stored.filter(row => row.reopened === true).map(row => row.id);
    if (reopened.length) await this.recordReopens(reopened, rows);
    await atomicInPrivateDir(this.file, rows);
    return rows;
  }

  private withStoreLock<T>(action: () => Promise<T>): Promise<T> {
    const run = this.pending.then(async () => {
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
      try { return await action(); }
      finally { release(); }
    });
    this.pending = run.catch(() => {});
    return run;
  }

  run(input: unknown): Promise<Json> {
    return this.withStoreLock(async () => {
      const data = ownerInboxSchema.parse(input);
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
          if (rows.length >= MAX_ITEMS) throw new BridgeError(409, "The owner inbox is full.");
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
        // The issue link rides in the title, which an older Hook reads as text.
        const nextTitle = data.issue ? inboxIssueTitle({ title: data.title, issue: data.issue }) : data.title;
        // Never trim to fit the link: two different titles would store
        // identically, so a re-add would not advance the revision.
        if (data.issue && nextTitle.length > INBOX_TITLE_LIMIT) {
          throw new BridgeError(400, `Title too long with an issue link: shorten it to ${titleBudget(data.issue)} characters.`);
        }
        // Unset fields are left out, not stored as undefined.
        const fields = { project: data.project, command: data.command, task: data.task, pr: pr?.url, key: data.key };
        const next = { title: nextTitle, ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) } as Pick<InboxItem, "title" | "project" | "command" | "task" | "pr" | "key">;
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
        if (prior?.state === "resolved" && !differs(prior)) return { ok: true, item: inboxWire(withPaste(prior), data.issues) };
        const matches = rows.filter(row => row.kind === "manual" && row.state === "open" && (
          (next.pr && row.pr === next.pr) || (effective && (row.key ?? (row.pr ? `pr:${row.pr}` : undefined)) === effective)));
        if (matches.length > 1 || (prior && matches.length && matches[0] !== prior)) {
          throw new BridgeError(409, "These inbox identifiers name different items.");
        }
        if (prior && prior.state === "resolved") {
          // Persist push suppression first so a failed write leaves the
          // row closed, and a completed reopen survives a Hook restart.
          await this.recordReopens([prior.id], rows);
          apply(prior); prior.state = "open"; delete prior.resolvedAt; delete prior.resolution;
          await atomicInPrivateDir(this.file, rows);
          return { ok: true, item: inboxWire(withPaste(prior), data.issues), reopened: true };
        }
        const target = prior ?? matches[0];
        if (target) {
          if (differs(target)) {
            apply(target);
            await atomicInPrivateDir(this.file, rows);
            return { ok: true, item: inboxWire(withPaste(target), data.issues), updated: true };
          }
          return { ok: true, item: inboxWire(withPaste(target), data.issues) };
        }
        if (rows.length >= MAX_ITEMS) throw new BridgeError(409, "The owner inbox is full.");
        const item = itemSchema.parse({ id: data.id ?? randomUUID(), kind: "manual", ...next, state: "open", createdAt: at, updatedAt: at });
        rows.push(item);
        await atomicInPrivateDir(this.file, rows);
        return { ok: true, item: inboxWire(withPaste(item), data.issues) };
      }
      if (data.action === "resolve") {
        const item = rows.find(row => row.id === data.id);
        if (!item) throw new BridgeError(404, "No owner inbox item with that id.");
        if (data.ifUpdatedAt !== undefined && item.updatedAt !== data.ifUpdatedAt) throw new BridgeError(409, "This inbox item changed. Refresh it and try again.");
        if (item.state !== "resolved") { item.state = "resolved"; item.resolvedAt = at; item.updatedAt = nextUpdate(item); item.resolution = data.resolution; changed = true; }
        if (changed) await atomicInPrivateDir(this.file, rows);
        return { ok: true, item: inboxWire(item, data.issues) };
      }
      if (changed) await atomicInPrivateDir(this.file, rows);
      const visible = rows.filter(row => data.includeResolved || (row.state === "open" && (row.kind === "manual" || row.live === true))).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return { ok: true, items: visible.map(row => inboxWire(row.kind === "manual" ? withPaste(row) : row, data.issues)) };
    });
  }
  /** A signed phone decision on one row, guarded by the exact revision the
   * phone read. Resolve means handled; dismiss removes the row from this
   * Hook's shared list. Both are final in v1. Check and write under the same
   * lock an ordinary read takes, so a concurrent tick cannot resurrect it. */
  async close(id: string, ifUpdatedAt: string, decision: "resolve" | "dismiss"): Promise<InboxItem> {
    return this.withStoreLock(async () => {
      const rows = await this.read(), now = Date.now();
      // Legacy adds kept an owner-supplied UUID as written; a phone sends the
      // lowercase form it decodes. Two rows differing only by case are
      // ambiguous, so neither is closed.
      const wanted = id.toLowerCase();
      const matches = rows.filter(row => row.id.toLowerCase() === wanted);
      if (!matches.length) throw new BridgeError(404, "No owner inbox item with that id.");
      if (matches.length > 1) throw new BridgeError(409, "More than one owner inbox item has that id. Fix the stored rows before retrying.");
      const item = matches[0];
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
    });
  }

  /** Check durable visibility immediately before a send, without reconciling
   * sources or holding the store lock during provider I/O. */
  isOpenForPush(id: string): Promise<boolean> {
    return this.withStoreLock(async () => {
      const row = (await this.read()).find(item => item.id === id);
      return !!row && row.state === "open" && (row.kind === "manual" || row.live === true)
        && !(await this.readReopened()).has(id);
    });
  }

  /** Reconcile and return the open snapshot a push sweep may alert about.
   * `firstOpen` is carried separately from the public list so a reword or a
   * same-id reopen can never look like a first creation. */
  async tick(): Promise<InboxTickItem[]> {
    const result = await this.run({ action: "list" });
    const items = Array.isArray(result.items) ? result.items as InboxItem[] : [];
    const reopened = await this.readReopened();
    return items.map(item => ({ ...item, firstOpen: !reopened.has(item.id) }));
  }
}
