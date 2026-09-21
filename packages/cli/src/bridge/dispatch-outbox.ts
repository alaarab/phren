import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { bridgeRoot, targetSchema, type Target } from "./protocol.js";

const exec = promisify(execFile);
const DAY = 86_400_000;
const RETENTION_MS = 30 * DAY;
const RETENTION_BYTES = 256 * 1024 * 1024;
const outboxState = z.enum(["pending", "submitting", "delivered", "deliveryUncertain"]);

export interface BackgroundDelivery {
  supported(target: Target): Promise<boolean>;
  enqueue(target: Target, envelope: string): Promise<"delivered" | "unavailable" | "uncertain">;
}

export interface OutboxReport {
  dispatchId: string;
  turnId: string;
  parentTarget: Target;
  envelope: string;
}

const outboxSchema = z.object({
  version: z.literal(1),
  id: z.string().regex(/^[a-f0-9]{64}$/),
  dispatchId: z.string().uuid(),
  turnId: z.string().min(1).max(200),
  parentTarget: targetSchema,
  envelope: z.string().min(1).max(8192),
  state: outboxState,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  attempts: z.number().int().nonnegative(),
  nextAttemptAt: z.string().datetime().optional(),
  error: z.string().max(500).optional(),
});
export type OutboxItem = z.infer<typeof outboxSchema>;

function reportKey(dispatchId: string, turnId: string): string {
  return createHash("sha256").update(dispatchId).update("\0").update(turnId).digest("hex");
}

function retryDelay(attempts: number): number {
  return Math.min(60_000, 1000 * 2 ** Math.min(6, Math.max(0, attempts - 1)));
}

async function atomic(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  await rename(temporary, file);
}

async function regularJson(file: string): Promise<string | undefined> {
  const info = await lstat(file).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > 65_536) return;
  return readFile(file, "utf8");
}

/** Durable at-most-once delivery. `submitting` is recorded before calling a
 * provider because a crash or lost acknowledgement may follow acceptance. */
export class DispatchOutbox {
  private readonly directory: string;
  constructor(private readonly root = bridgeRoot(), private readonly now = Date.now) {
    this.directory = path.join(root, "dispatch-outbox");
  }

  private file(id: string): string { return path.join(this.directory, `${id}.json`); }

  private async read(id: string): Promise<OutboxItem | undefined> {
    if (!/^[a-f0-9]{64}$/.test(id)) return;
    const raw = await regularJson(this.file(id));
    if (raw === undefined) return;
    try { return outboxSchema.parse(JSON.parse(raw)); } catch { return; }
  }

  async enqueue(report: OutboxReport): Promise<OutboxItem> {
    const parsed = z.object({ dispatchId: z.string().uuid(), turnId: z.string().min(1).max(200),
      parentTarget: targetSchema, envelope: z.string().min(1).max(8192) }).parse(report);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const id = reportKey(parsed.dispatchId, parsed.turnId), stamp = new Date(this.now()).toISOString();
    const item: OutboxItem = { version: 1, id, ...parsed, state: "pending", createdAt: stamp, updatedAt: stamp, attempts: 0 };
    const handle = await open(this.file(id), "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") return undefined;
      throw error;
    });
    if (!handle) {
      const existing = await this.read(id);
      if (!existing || existing.dispatchId !== parsed.dispatchId || existing.turnId !== parsed.turnId) {
        throw new Error("The dispatch report outbox is inconsistent.");
      }
      return existing;
    }
    try { await handle.writeFile(JSON.stringify(item)); } finally { await handle.close(); }
    return item;
  }

  async items(): Promise<OutboxItem[]> {
    const names = (await readdir(this.directory).catch(() => [] as string[])).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
    const values = await Promise.all(names.map(name => this.read(name.slice(0, -5))));
    return values.filter((item): item is OutboxItem => item !== undefined)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Interrupted submissions are ambiguous and are never replayed. */
  async recover(): Promise<OutboxItem[]> {
    const items = await this.items();
    for (const item of items) {
      if (item.state !== "submitting") continue;
      item.state = "deliveryUncertain"; item.updatedAt = new Date(this.now()).toISOString();
      item.error = "The Hook restarted while the provider enqueue was in flight. Inspect the parent conversation; this report was not replayed.";
      delete item.nextAttemptAt;
      await atomic(this.file(item.id), item);
    }
    return items;
  }

  async deliver(id: string, adapter: BackgroundDelivery): Promise<OutboxItem> {
    const item = await this.read(id);
    if (!item) throw new Error("The dispatch report is not in the outbox.");
    if (item.state !== "pending") return item;
    if (item.nextAttemptAt && Date.parse(item.nextAttemptAt) > this.now()) return item;
    if (!await adapter.supported(item.parentTarget)) {
      item.attempts++; item.updatedAt = new Date(this.now()).toISOString();
      item.nextAttemptAt = new Date(this.now() + retryDelay(item.attempts)).toISOString();
      item.error = "This conversation has no safe background inbox. The report remains pending.";
      await atomic(this.file(item.id), item);
      return item;
    }

    item.state = "submitting"; item.attempts++; item.updatedAt = new Date(this.now()).toISOString();
    delete item.nextAttemptAt; delete item.error;
    await atomic(this.file(item.id), item);
    let outcome: "delivered" | "unavailable" | "uncertain";
    try { outcome = await adapter.enqueue(item.parentTarget, item.envelope); }
    catch { outcome = "uncertain"; }
    item.updatedAt = new Date(this.now()).toISOString();
    if (outcome === "delivered") item.state = "delivered";
    else if (outcome === "unavailable") {
      item.state = "pending";
      item.nextAttemptAt = new Date(this.now() + retryDelay(item.attempts)).toISOString();
      item.error = "The background inbox became unavailable before enqueue. The report remains pending.";
    } else {
      item.state = "deliveryUncertain";
      item.error = "The background inbox did not confirm delivery. This report was not replayed.";
    }
    await atomic(this.file(item.id), item);
    return item;
  }
}

/** Codex exposes an exact-thread queue. Its ordinary user row is projected as
 * Background by the transcript integration patch when the envelope passes the
 * report allowlist. */
export class CodexBackgroundInbox implements BackgroundDelivery {
  private probe?: { at: number; result: Promise<boolean> };
  constructor(private readonly executable = "codex", private readonly run = exec, private readonly now = Date.now) {}
  async supported(target: Target): Promise<boolean> {
    if (target.source !== "codex" || !z.string().uuid().safeParse(target.session).success) return false;
    if (!this.probe || this.now() - this.probe.at > 300_000) this.probe = { at: this.now(), result:
      this.run(this.executable, ["queue", "--help"], { timeout: 5000, maxBuffer: 65_536 })
        .then(({ stdout }) => stdout.includes("--thread") && stdout.includes("--message")).catch(() => false) };
    return this.probe.result;
  }
  async enqueue(target: Target, envelope: string): Promise<"delivered" | "unavailable" | "uncertain"> {
    if (!await this.supported(target)) return "unavailable";
    try {
      await this.run(this.executable, ["queue", "--thread", target.session, "--message", envelope], { timeout: 8000, maxBuffer: 65_536 });
      return "delivered";
    } catch { return "uncertain"; }
  }
}

/** Claude Code has no assumed external inbox. A host may supply a verified,
 * exact-session adapter; without one reports stay pending instead of becoming
 * user prompts. The inert fixture exercises this boundary without agent cost. */
export class ClaudeBackgroundInbox implements BackgroundDelivery {
  constructor(private readonly deliver?: (target: Target, envelope: string) => Promise<"delivered" | "unavailable" | "uncertain">) {}
  async supported(target: Target): Promise<boolean> { return target.source === "claude" && this.deliver !== undefined; }
  async enqueue(target: Target, envelope: string): Promise<"delivered" | "unavailable" | "uncertain"> {
    if (target.source !== "claude" || !this.deliver) return "unavailable";
    return this.deliver(target, envelope);
  }
}

interface RetainedFile { file: string; size: number }
interface RetainedGroup {
  id: string; size: number; at: number; files: RetainedFile[];
  receiptState?: string; reportState?: string; outboxStates: string[];
}

/** Prune only finished dispatch groups. Accepted work without a delivered
 * report, pending delivery, and every uncertain state are retained even when
 * they push the ledger over its byte target. */
export async function pruneDispatchArtifacts(root = bridgeRoot(), now = Date.now(),
  limits: { retentionMs?: number; maxBytes?: number } = {}): Promise<{ removed: number; bytes: number }> {
  const groups = new Map<string, RetainedGroup>();
  const group = (id: string) => {
    const value = groups.get(id) ?? { id, size: 0, at: 0, files: [], outboxStates: [] };
    groups.set(id, value); return value;
  };
  for (const directory of ["dispatches", "dispatch-reports", "dispatch-outbox"] as const) {
    const parent = path.join(root, directory);
    for (const name of await readdir(parent).catch(() => [] as string[])) {
      if (!/^(?:[a-f0-9-]{36}|[a-f0-9]{64})\.json$/.test(name)) continue;
      const file = path.join(parent, name), info = await lstat(file).catch(() => undefined);
      if (!info?.isFile() || info.isSymbolicLink() || info.size > 65_536) continue;
      let value: Record<string, unknown>;
      try { value = JSON.parse(await readFile(file, "utf8")); } catch { continue; }
      const id = typeof value.dispatchId === "string" ? value.dispatchId : name.slice(0, -5);
      if (!z.string().uuid().safeParse(id).success) continue;
      const entry = group(id); entry.size += info.size; entry.files.push({ file, size: info.size });
      const stamp = [value.deliveredAt, value.updatedAt, value.createdAt].find(item => typeof item === "string") as string | undefined;
      entry.at = Math.max(entry.at, stamp ? Date.parse(stamp) || info.mtimeMs : info.mtimeMs);
      if (directory === "dispatches") entry.receiptState = String(value.state);
      if (directory === "dispatch-reports") entry.reportState = String(value.reportState);
      if (directory === "dispatch-outbox") entry.outboxStates.push(String(value.state));
    }
  }
  let bytes = [...groups.values()].reduce((sum, value) => sum + value.size, 0), removed = 0;
  const retention = limits.retentionMs ?? RETENTION_MS, maximum = limits.maxBytes ?? RETENTION_BYTES;
  const candidates = [...groups.values()].filter(value => {
    if (value.receiptState === "uncertain" || value.reportState === "deliveryUncertain") return false;
    if (value.outboxStates.some(state => state !== "delivered")) return false;
    return value.receiptState === "failed" || value.reportState === "completed";
  }).sort((a, b) => a.at - b.at);
  for (const candidate of candidates) {
    if (candidate.at >= now - retention && bytes <= maximum) continue;
    for (const entry of candidate.files) await unlink(entry.file).catch(() => {});
    bytes -= candidate.size; removed += candidate.files.length;
  }
  return { removed, bytes };
}
