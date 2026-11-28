import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { atomicInPrivateDir, bridgeRoot } from "./protocol.js";
import { pushIssueTitle, type InboxItem } from "./owner-inbox.js";
import { isOwnerInboxPushSource } from "./owner-inbox-sources.js";
import type { OwnerInboxPush } from "./push.js";

/** What the sweep needs from `ApprovalPushService`, injected so tests never
 * reach a provider. Both calls re-check reachability, registration and the
 * `ownerInbox` kind at send time. */
export interface OwnerInboxPushSender {
  ownerInboxPushDevices(): string[];
  notifyOwnerInbox(value: OwnerInboxPush, deviceID: string): Promise<boolean>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** A failed candidate/device pair waits this long before another attempt. */
export const OWNER_INBOX_RETRY_MS = 60_000;
/** The first sweep alerts about at most this many existing open rows. */
const MAX_SEEDS = 3;
/** One sweep attempts at most this many distinct candidate rows (each to all
 * of its eligible phones). */
const MAX_CANDIDATES = 3;
const MAX_ENTRIES = 1000;
const deviceIDSchema = z.string().uuid();

/** The internal tick snapshot adds first-open eligibility to the public row. */
type ObservedItem = InboxItem & { firstOpen?: boolean };

const entrySchema = z.object({
  id: z.string().uuid(),
  /** The observed revision, frozen when the candidate was created. */
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  // Bound retention by candidate count and expiry. A phone may register again
  // before the candidate expires, so its accepted receipt stays until then.
  sentDeviceIDs: z.array(deviceIDSchema),
}).strict();
const ledgerSchema = z.object({
  version: z.literal(1),
  initializedAt: z.string().datetime(),
  /** Absent in ledgers written before the initial snapshot IDs were saved. */
  initialRowIds: z.array(z.string().uuid()).optional(),
  entries: z.array(entrySchema).max(MAX_ENTRIES),
}).strict();
type LedgerEntry = z.infer<typeof entrySchema>;
type Ledger = z.infer<typeof ledgerSchema>;

export interface OwnerInboxPushOptions {
  /** Fresh local store read under the Inbox lock. */
  isOpenForPush: (id: string) => Promise<boolean>;
  /** `<bridge>/owner-inbox-push.json` by default. */
  file?: string;
  /** Test seam; the ledger's deadlines and the retry interval read this. */
  now?: () => number;
  /** Test seam for the corrupt-ledger error. */
  log?: (message: string) => void;
  /** The open manual row that takes the first backfill slot; defaults to
   * `PHREN_OWNER_INBOX_BACKFILL_ID` read on each sweep. */
  backfillId?: string;
}

/**
 * Alerts the owner's registered phones about new open rows this Hook owns.
 * Fed from the Hook's successful local reconciliation. It checks the local
 * store under its lock and releases it before calling the provider.
 */
export class OwnerInboxPushSweep {
  private readonly file: string;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly backfillId: () => string | undefined;
  private readonly isOpenForPush: OwnerInboxPushOptions["isOpenForPush"];
  private chain: Promise<void> = Promise.resolve();
  private active = false;
  private queued?: ObservedItem[];
  /** The newest snapshot seen, including one queued while a sweep runs; each
   * provider call rechecks it so a closed row is never sent late. */
  private latest: ObservedItem[] = [];
  /** `${id}:${deviceID}` → earliest epoch ms the pair may be attempted again. */
  private readonly retryAfter = new Map<string, number>();
  /** Acceptances whose receipt write failed, so a live Hook retries persistence
   * without sending the same phone another alert. */
  private readonly accepted = new Set<string>();
  private corruptReported = false;

  constructor(private readonly sender: OwnerInboxPushSender, options: OwnerInboxPushOptions) {
    this.file = options.file ?? path.join(bridgeRoot(), "owner-inbox-push.json");
    this.isOpenForPush = options.isOpenForPush;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (message => console.error(message));
    const fixed = options.backfillId;
    this.backfillId = fixed !== undefined ? () => fixed : () => process.env.PHREN_OWNER_INBOX_BACKFILL_ID;
  }

  /**
   * One reconciliation's open rows. Single-flight: a tick that arrives while
   * a sweep runs replaces the snapshot the next pass uses instead of starting
   * a second sender run; callers share the same promise.
   */
  observe(openItems: ObservedItem[]): Promise<void> {
    this.queued = openItems;
    this.latest = openItems;
    if (this.active) return this.chain;
    this.active = true;
    this.chain = (async () => {
      try {
        while (this.queued) {
          const items = this.queued;
          this.queued = undefined;
          await this.sweep(items).catch(error => {
            this.log(`Phren Inbox push: the sweep stopped early: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
      } finally { this.active = false; }
    })();
    return this.chain;
  }

  private async load(): Promise<Ledger | "corrupt" | undefined> {
    let info;
    try { info = await lstat(this.file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink()) return "corrupt";
    try { return ledgerSchema.parse(JSON.parse(await readFile(this.file, "utf8"))); } catch { return "corrupt"; }
  }

  private async sweep(openItems: ObservedItem[]): Promise<void> {
    const now = this.now(), at = new Date(now).toISOString();
    for (const [key, retryAt] of this.retryAfter) if (retryAt <= now) this.retryAfter.delete(key);
    const loaded = await this.load();
    if (loaded === "corrupt") {
      // Fail closed: never send from a ledger whose receipts may be lost, and
      // never overwrite it before the owner can look at it.
      if (!this.corruptReported) {
        this.corruptReported = true;
        this.log(`Phren Inbox push: ${this.file} is corrupt, so no Inbox alerts will be sent. Restore a valid copy or move it aside to seed a fresh ledger.`);
      }
      return;
    }
    const owned = openItems.filter(isOwnerInboxPushSource);
    const ledger: Ledger = loaded ?? {
      version: 1, initializedAt: at, initialRowIds: openItems.map(item => item.id), entries: this.seed(owned, now),
    };
    if (!loaded) {
      // The candidate must be durable before any provider sees it.
      try { await atomicInPrivateDir(this.file, ledger); }
      catch (error) {
        this.log(`Phren Inbox push: could not write ${this.file}, so no Inbox alert was sent: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    } else {
      const legacy = ledger.initialRowIds === undefined;
      if (legacy) {
        // Recover the baseline once using the cutoff recorded by older ledgers.
        const cutoff = Date.parse(ledger.initializedAt);
        ledger.initialRowIds = openItems.filter(item => Date.parse(item.createdAt) <= cutoff).map(item => item.id);
      }
      const reconciled = this.reconcile(ledger, owned, now);
      const merged = this.mergeAccepted(ledger);
      if (legacy || reconciled) {
        try { await atomicInPrivateDir(this.file, ledger); }
        catch (error) {
          this.log(`Phren Inbox push: could not save the new candidate, so no Inbox alert was sent: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
      } else if (merged) {
        // A phone already accepted these; a broken write only delays the
        // receipt, never earns that phone another alert.
        try { await atomicInPrivateDir(this.file, ledger); }
        catch (error) { this.log(`Phren Inbox push: could not save accepted receipts: ${error instanceof Error ? error.message : String(error)}`); }
      }
    }
    await this.deliver(ledger);
  }

  /** Merge acceptances whose receipt write failed into a freshly loaded ledger. */
  private mergeAccepted(ledger: Ledger): boolean {
    let changed = false;
    for (const key of this.accepted) {
      const split = key.indexOf(":");
      const id = key.slice(0, split), deviceID = key.slice(split + 1);
      const entry = ledger.entries.find(candidate => candidate.id === id);
      if (!entry || entry.sentDeviceIDs.includes(deviceID)) continue;
      entry.sentDeviceIDs.push(deviceID); changed = true;
    }
    return changed;
  }

  /** The initial snapshot: up to three rows updated in the preceding day,
   * newest first with a UUID tie-break. The override row takes the first slot
   * regardless of age so a known row (OVH) is still backfilled. A same-id
   * reopen never takes a seed slot. */
  private seed(openItems: ObservedItem[], now: number): LedgerEntry[] {
    const open = openItems.filter(item => item.state === "open" && item.firstOpen !== false);
    const expiresAt = new Date(now + DAY_MS).toISOString();
    const recent = open
      .filter(item => Date.parse(item.updatedAt) >= now - DAY_MS)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id));
    const override = this.backfillId();
    const reserved = override ? open.find(item => item.id === override && item.kind === "manual") : undefined;
    if (override && !reserved) this.log(`Phren Inbox push: PHREN_OWNER_INBOX_BACKFILL_ID ${override} names no open manual row on this Hook; the first backfill slot stays unused.`);
    const chosen = reserved ? [reserved, ...recent.filter(item => item.id !== reserved.id).slice(0, MAX_SEEDS - 1)] : recent.slice(0, MAX_SEEDS);
    return chosen.map(item => ({ id: item.id, updatedAt: item.updatedAt, expiresAt, sentDeviceIDs: [] }));
  }

  /** Add rows absent from the initial snapshot and drop expired entries.
   * Retired rows are either in that snapshot or past their 24-hour window. */
  private reconcile(ledger: Ledger, openItems: ObservedItem[], now: number): boolean {
    let changed = false;
    const kept = ledger.entries.filter(entry => Date.parse(entry.expiresAt) > now);
    if (kept.length !== ledger.entries.length) {
      for (const entry of ledger.entries) if (!kept.includes(entry)) for (const key of this.accepted) if (key.startsWith(`${entry.id}:`)) this.accepted.delete(key);
      ledger.entries = kept; changed = true;
    }
    const known = new Set(ledger.entries.map(entry => entry.id));
    const initialRows = new Set(ledger.initialRowIds);
    for (const item of openItems) {
      if (item.state !== "open" || item.firstOpen === false || known.has(item.id) || initialRows.has(item.id)) continue;
      const expiresAt = Date.parse(item.createdAt) + DAY_MS;
      // A row whose window already closed must not churn back in.
      if (expiresAt <= now || ledger.entries.length >= MAX_ENTRIES) continue;
      ledger.entries.push({ id: item.id, updatedAt: item.updatedAt, expiresAt: new Date(expiresAt).toISOString(), sentDeviceIDs: [] });
      known.add(item.id); changed = true;
    }
    return changed;
  }

  /** Up to three distinct candidate rows per sweep, oldest first: a new row by
   * its creation time and a backfill by its own updatedAt (they all share the
   * initialization deadline). Each selected row is offered to all of its
   * eligible phones. Recheck persisted state, the newest snapshot and the
   * deadline before each call. A row consumes a slot on its first attempt. */
  private async deliver(ledger: Ledger): Promise<void> {
    const devices = [...new Set(this.sender.ownerInboxPushDevices())].filter(device => deviceIDSchema.safeParse(device).success).sort();
    if (!devices.length) return;
    const initialRows = new Set(ledger.initialRowIds);
    const age = (entry: LedgerEntry) => initialRows.has(entry.id) ? Date.parse(entry.updatedAt) : Date.parse(entry.expiresAt) - DAY_MS;
    const candidates = [...ledger.entries].sort((a, b) => age(a) - age(b) || a.id.localeCompare(b.id));
    const openItem = (id: string) => this.latest.find(item => item.id === id && item.state === "open" && item.firstOpen !== false && isOwnerInboxPushSource(item));
    let selected = 0;
    for (const entry of candidates) {
      if (selected >= MAX_CANDIDATES) break;
      const deadline = Date.parse(entry.expiresAt);
      let attempted = false;
      for (const deviceID of devices) {
        const key = `${entry.id}:${deviceID}`;
        const current = this.now();
        if (deadline <= current) break;
        if ((this.retryAfter.get(key) ?? 0) > current) continue;
        if (entry.sentDeviceIDs.includes(deviceID) || this.accepted.has(key)) continue;
        if (!openItem(entry.id) || !await this.isOpenForPush(entry.id)) break;
        const live = openItem(entry.id);
        const attemptedAt = this.now();
        if (!live || deadline <= attemptedAt) break;
        if (!attempted) {
          selected++;
          attempted = true;
        }
        let accepted = false;
        try {
          // The alert body is the title cut at 500 UTF-8 bytes, so the link's
          // bytes are reserved here and the cut never drops it.
          accepted = await this.sender.notifyOwnerInbox({ id: entry.id, title: pushIssueTitle(live), expiresAt: entry.expiresAt }, deviceID);
        } catch { accepted = false; }
        if (accepted) {
          this.accepted.add(key);
          entry.sentDeviceIDs.push(deviceID);
          try { await atomicInPrivateDir(this.file, ledger); }
          catch (error) {
            this.log(`Phren Inbox push: ${key} was accepted but its receipt could not be saved; the phone will not be alerted again while this Hook runs: ${error instanceof Error ? error.message : String(error)}`);
          }
        } else {
          // Time the retry from this attempt, not from the sweep's entry.
          this.retryAfter.set(key, attemptedAt + OWNER_INBOX_RETRY_MS);
        }
      }
    }
  }
}
