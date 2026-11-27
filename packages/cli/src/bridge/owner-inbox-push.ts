import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { atomicInPrivateDir, bridgeRoot } from "./protocol.js";
import type { InboxItem } from "./owner-inbox.js";

/** The value slice 3's push transport sends: the row and the deadline the
 * ledger froze when it first observed that row. Structurally the `OwnerInboxPush`
 * in push.ts, so the two stay assignable. */
export interface OwnerInboxPushValue { id: string; title: string; expiresAt: string }

/** What the sweep needs from `ApprovalPushService`, injected so tests never
 * reach a provider. Both calls re-check reachability, registration and the
 * `ownerInbox` kind at send time. */
export interface OwnerInboxPushSender {
  ownerInboxPushDevices(): string[];
  notifyOwnerInbox(value: OwnerInboxPushValue, deviceID: string): Promise<boolean>;
}

/** The internal tick snapshot adds first-open eligibility to the public row. */
type ObservedItem = InboxItem & { firstOpen?: boolean };

const DAY_MS = 24 * 60 * 60 * 1000;
/** A failed candidate/device pair waits this long before another attempt. */
export const OWNER_INBOX_RETRY_MS = 60_000;
/** The first sweep alerts about at most this many existing open rows. */
const MAX_SEEDS = 3;
/** One sweep attempts at most this many candidate/device pairs. */
const MAX_ATTEMPTS = 3;

const entrySchema = z.object({
  id: z.string().uuid(),
  /** The observed revision, frozen when the candidate was created. */
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  sentDeviceIDs: z.array(z.string().uuid()).max(16),
}).strict();
const ledgerSchema = z.object({
  version: z.literal(1),
  initializedAt: z.string().datetime(),
  entries: z.array(entrySchema).max(1000),
}).strict();
type LedgerEntry = z.infer<typeof entrySchema>;
type Ledger = z.infer<typeof ledgerSchema>;

export interface OwnerInboxPushOptions {
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
 * Alerts the owner's registered phones about genuinely new open Inbox rows.
 * Fed from the Hook's successful local reconciliation; it never reads peers,
 * never holds the inbox lock, and never lets a reword, repeat observation or
 * same-id reopen enqueue a second alert.
 */
export class OwnerInboxPushSweep {
  private readonly file: string;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly backfillId: () => string | undefined;
  private chain: Promise<void> = Promise.resolve();
  private active = false;
  private queued?: ObservedItem[];
  /** `${id}:${deviceID}` → earliest epoch ms the pair may be attempted again. */
  private readonly retryAfter = new Map<string, number>();
  private corruptReported = false;

  constructor(private readonly sender: OwnerInboxPushSender, options: OwnerInboxPushOptions = {}) {
    this.file = options.file ?? path.join(bridgeRoot(), "owner-inbox-push.json");
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
    if (this.active) return this.chain;
    this.active = true;
    this.chain = (async () => {
      try {
        while (this.queued) {
          const items = this.queued;
          this.queued = undefined;
          await this.sweep(items).catch(error => {
            this.log(`Phren Inbox push: the sweep failed and no alert was sent: ${error instanceof Error ? error.message : String(error)}`);
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
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) return "corrupt";
    try { return ledgerSchema.parse(JSON.parse(await readFile(this.file, "utf8"))); } catch { return "corrupt"; }
  }

  private async sweep(openItems: ObservedItem[]): Promise<void> {
    const now = this.now(), at = new Date(now).toISOString();
    const loaded = await this.load();
    if (loaded === "corrupt") {
      // Fail closed: never send from a ledger whose receipts may be lost, and
      // never overwrite it before the owner can look at it.
      if (!this.corruptReported) {
        this.corruptReported = true;
        this.log(`Phren Inbox push: ${this.file} is corrupt, so no Inbox alerts will be sent. Move it aside to start a fresh ledger (existing rows are not re-alerted).`);
      }
      return;
    }
    const ledger = loaded ?? { version: 1 as const, initializedAt: at, entries: this.seed(openItems, now) };
    if (!loaded) await atomicInPrivateDir(this.file, ledger);
    else if (this.reconcile(ledger, openItems, now)) await atomicInPrivateDir(this.file, ledger);
    await this.deliver(ledger, openItems, now);
  }

  /** The initial snapshot: up to three rows updated in the preceding day,
   * newest first with a UUID tie-break. The override row takes the first slot
   * regardless of age so a known row (OVH) is still backfilled. */
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

  /** Add rows created after the initial snapshot and drop expired entries.
   * Retired rows never re-enter: their creation time is either before the
   * cursor or their 24-hour window already closed. */
  private reconcile(ledger: Ledger, openItems: ObservedItem[], now: number): boolean {
    let changed = false;
    const kept = ledger.entries.filter(entry => Date.parse(entry.expiresAt) > now);
    if (kept.length !== ledger.entries.length) { ledger.entries = kept; changed = true; }
    const known = new Set(ledger.entries.map(entry => entry.id));
    const initializedAt = Date.parse(ledger.initializedAt);
    for (const item of openItems) {
      if (item.state !== "open" || item.firstOpen === false || known.has(item.id)) continue;
      const created = Date.parse(item.createdAt);
      if (!(created > initializedAt)) continue;
      const expiresAt = created + DAY_MS;
      // A row whose window already closed must not churn back in.
      if (expiresAt <= now || ledger.entries.length >= 1000) continue;
      ledger.entries.push({ id: item.id, updatedAt: item.updatedAt, expiresAt: new Date(expiresAt).toISOString(), sentDeviceIDs: [] });
      known.add(item.id); changed = true;
    }
    return changed;
  }

  /** At most three candidate/device pairs per sweep, oldest candidate first.
   * Each accepted pair is persisted before the next attempt, so retrying one
   * phone never repeats an alert another phone already took. */
  private async deliver(ledger: Ledger, openItems: InboxItem[], now: number): Promise<void> {
    const open = new Map(openItems.filter(item => item.state === "open").map(item => [item.id, item]));
    const devices = [...new Set(this.sender.ownerInboxPushDevices())].filter(device => typeof device === "string" && device.length > 0).sort();
    if (!devices.length) return;
    const attempts: Array<{ entry: LedgerEntry; item: InboxItem; deviceID: string }> = [];
    for (const entry of ledger.entries) {
      if (Date.parse(entry.expiresAt) <= now) continue;
      const item = open.get(entry.id);
      if (!item) continue;
      for (const deviceID of devices) {
        if (entry.sentDeviceIDs.includes(deviceID)) continue;
        if ((this.retryAfter.get(`${entry.id}:${deviceID}`) ?? 0) > now) continue;
        attempts.push({ entry, item, deviceID });
      }
    }
    attempts.sort((a, b) => Date.parse(a.entry.expiresAt) - Date.parse(b.entry.expiresAt)
      || a.entry.id.localeCompare(b.entry.id) || a.deviceID.localeCompare(b.deviceID));
    for (const attempt of attempts.slice(0, MAX_ATTEMPTS)) {
      let accepted = false;
      try {
        accepted = await this.sender.notifyOwnerInbox({ id: attempt.entry.id, title: attempt.item.title, expiresAt: attempt.entry.expiresAt }, attempt.deviceID);
      } catch { accepted = false; }
      const key = `${attempt.entry.id}:${attempt.deviceID}`;
      if (accepted) {
        if (!attempt.entry.sentDeviceIDs.includes(attempt.deviceID)) attempt.entry.sentDeviceIDs.push(attempt.deviceID);
        this.retryAfter.delete(key);
        await atomicInPrivateDir(this.file, ledger);
      } else {
        this.retryAfter.set(key, now + OWNER_INBOX_RETRY_MS);
      }
    }
  }
}
