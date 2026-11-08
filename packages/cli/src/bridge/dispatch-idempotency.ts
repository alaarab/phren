import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { atomic, BridgeError, bridgeRoot } from "./protocol.js";

/**
 * Idempotency keys for local dispatches (`phren dispatch local ... --idempotency-key`).
 * A reservation is written to a temp file and published with `link`, which is
 * atomic and fails with EEXIST: an empty or half-written file is never a
 * reservation another caller can reclaim. Expiry and replacement run under a
 * per-key lock, and every update or delete checks the owner nonce.
 */

export const IDEMPOTENCY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A reservation that has not reached "launched" is interrupted after this. */
export const LAUNCH_INTERRUPTED_MS = 5 * 60_000;
/** A lock older than this may be broken by another caller. */
export const IDEMPOTENCY_LOCK_STALE_MS = 60_000;
export const idempotencyKeySchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9:._@/-]+$/,
  "An idempotency key is 1 to 200 characters of letters, digits, and : . _ @ / -");

const phaseSchema = z.enum(["reserved", "launching", "launched", "failed"]);
const recordSchema = z.object({
  key: z.string().min(1).max(200),
  dispatchId: z.string().uuid(),
  owner: z.string().uuid(),
  createdAt: z.string().datetime(),
  phase: phaseSchema,
  project: z.string().max(100).optional(),
  harness: z.string().max(32).optional(),
  label: z.string().max(200).optional(),
  computer: z.string().max(200).optional(),
  cloneDir: z.string().max(4096).optional(),
  gitConfigFile: z.string().max(4096).optional(),
  agentTokenFile: z.string().max(4096).optional(),
  workerFile: z.string().max(4096).optional(),
  startingToken: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  cancelRequestedAt: z.string().datetime().optional(),
}).strict();
export type IdempotencyRecord = z.infer<typeof recordSchema>;
export type IdempotencyPhase = z.infer<typeof phaseSchema>;

const keyRoot = () => path.join(bridgeRoot(), "idempotency");
const hashOf = (key: string) => createHash("sha256").update(key).digest("hex");
export const idempotencyKeyFile = (key: string) => path.join(keyRoot(), `${hashOf(key)}.json`);
export const idempotencyLockFile = (key: string) => path.join(keyRoot(), `${hashOf(key)}.lock`);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function expired(record: IdempotencyRecord, now = Date.now()): boolean {
  const created = Date.parse(record.createdAt);
  return Number.isFinite(created) && now - created > IDEMPOTENCY_TTL_MS;
}

async function readKey(file: string): Promise<IdempotencyRecord | undefined> {
  const info = await lstat(file).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  });
  if (!info?.isFile() || info.isSymbolicLink() || info.size > 4096) return undefined;
  try { return recordSchema.parse(JSON.parse(await readFile(file, "utf8"))); } catch { return undefined; }
}

/** Publish a full record atomically. False means the key already exists. */
async function publish(key: string, record: IdempotencyRecord): Promise<boolean> {
  await mkdir(keyRoot(), { recursive: true, mode: 0o700 });
  const temp = path.join(keyRoot(), `.${hashOf(key)}.${record.owner}.tmp`);
  await writeFile(temp, JSON.stringify(record), { mode: 0o600, flag: "wx" });
  try {
    await link(temp, idempotencyKeyFile(key));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

interface KeyLock { key: string; owner: string }
/**
 * A lock is never unlinked unless its owner releases it. A lock whose lease
 * has expired is reported as stale; the caller retries rather than racing a
 * replacement against another process that may still hold it.
 */
async function acquireLock(key: string, owner: string, now: number): Promise<KeyLock | undefined> {
  const file = idempotencyLockFile(key);
  const deadline = Date.now() + 2_000;
  const leaseUntil = new Date(now + IDEMPOTENCY_LOCK_STALE_MS).toISOString();
  for (;;) {
    try {
      const handle = await open(file, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify({ owner, createdAt: new Date(now).toISOString(), expiresAt: leaseUntil })); await handle.sync(); } finally { await handle.close(); }
      return { key, owner };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let held: { owner?: unknown; expiresAt?: unknown } | undefined;
      try { held = JSON.parse(await readFile(file, "utf8")) as { owner?: unknown; expiresAt?: unknown }; } catch { /* unreadable: wait briefly */ }
      const expiry = typeof held?.expiresAt === "string" ? Date.parse(held.expiresAt) : NaN;
      const info = await lstat(file).catch(() => undefined);
      const expired = (Number.isFinite(expiry) && Date.now() >= expiry) || (info && Date.now() - info.mtimeMs > IDEMPOTENCY_LOCK_STALE_MS);
      if (expired) throw new BridgeError(503, "The idempotency key is locked by a stale owner; retry.");
      if (Date.now() >= deadline) return undefined;
      await sleep(50);
    }
  }
}
async function releaseLock(lock: KeyLock): Promise<void> {
  const file = idempotencyLockFile(lock.key);
  let held: { owner?: unknown } | undefined;
  try { held = JSON.parse(await readFile(file, "utf8")) as { owner?: unknown }; } catch { return; }
  if (held.owner === lock.owner) await unlink(file).catch(() => undefined);
}

async function replaceExpired(key: string, fresh: IdempotencyRecord, now: number): Promise<KeyReservation> {
  const lock = await acquireLock(key, fresh.owner, now);
  if (!lock) throw new BridgeError(503, "The idempotency key is being reclaimed; try again.");
  try {
    const current = await readKey(idempotencyKeyFile(key));
    if (current && !expired(current, now)) return { reserved: false, record: current };
    // Only an expired record is replaced, and only while holding this key's lock.
    if (current) await unlink(idempotencyKeyFile(key)).catch(() => undefined);
    if (await publish(key, fresh)) return { reserved: true, record: fresh };
    const raced = await readKey(idempotencyKeyFile(key));
    if (!raced) throw new BridgeError(503, "The idempotency key's reservation is unreadable; refusing to start another dispatch.");
    return { reserved: false, record: raced };
  } finally {
    await releaseLock(lock);
  }
}

export type KeyReservation = { reserved: true; record: IdempotencyRecord } | { reserved: false; record: IdempotencyRecord };

export interface KeySeed {
  project?: string;
  harness?: string;
  label?: string;
  computer?: string;
  cloneDir?: string;
  gitConfigFile?: string;
  agentTokenFile?: string;
  workerFile?: string;
  startingToken?: string;
}

/** Reserve `key` for this caller, with its dispatch id, atomically. */
export async function reserveIdempotencyKey(key: string, dispatchId: string, owner: string, seed: KeySeed = {}, now = Date.now()): Promise<KeyReservation> {
  const record: IdempotencyRecord = { key, dispatchId, owner, createdAt: new Date(now).toISOString(), phase: "reserved", ...seed };
  if (await publish(key, record)) return { reserved: true, record };
  const existing = await readKey(idempotencyKeyFile(key));
  // An unreadable reservation is not free: never unlink it and start a second agent.
  if (!existing) throw new BridgeError(503, "The idempotency key's reservation is unreadable; refusing to start another dispatch.");
  if (!expired(existing, now)) return { reserved: false, record: existing };
  return replaceExpired(key, record, now);
}

/** Move the reservation's phase. False when this caller no longer owns it. */
export async function updateIdempotencyPhase(key: string, owner: string, phase: IdempotencyPhase): Promise<boolean> {
  const file = idempotencyKeyFile(key);
  const record = await readKey(file);
  if (!record || record.owner !== owner) return false;
  await atomic(file, JSON.stringify({ ...record, phase }), 0o600);
  return true;
}

/** Run under the key's lock, with the current reservation record. */
export async function withIdempotencyKeyLock<T>(key: string, run: (record: IdempotencyRecord | undefined, save: (record: IdempotencyRecord) => Promise<void>) => Promise<T>): Promise<T> {
  const owner = randomUUID();
  const lock = await acquireLock(key, owner, Date.now());
  if (!lock) throw new BridgeError(503, "The idempotency key is busy; retry.");
  try {
    const file = idempotencyKeyFile(key);
    const record = await readKey(file);
    return await run(record, async next => { await atomic(file, JSON.stringify(next), 0o600); });
  } finally {
    await releaseLock(lock);
  }
}

/** Record a cancellation on the reservation itself, under its lock, before any receipt exists. */
export async function requestIdempotencyCancel(key: string, now = Date.now()): Promise<IdempotencyRecord | undefined> {
  const owner = randomUUID();
  const lock = await acquireLock(key, owner, now);
  if (!lock) throw new BridgeError(503, "The idempotency key is busy; retry.");
  try {
    const file = idempotencyKeyFile(key);
    const record = await readKey(file);
    if (!record) return undefined;
    if (record.cancelRequestedAt) return record;
    record.cancelRequestedAt = new Date(now).toISOString();
    await atomic(file, JSON.stringify(record), 0o600);
    return record;
  } finally {
    await releaseLock(lock);
  }
}

/** Release a reservation this caller owns and never launched. */
export async function releaseIdempotencyKey(key: string, owner: string): Promise<boolean> {
  const file = idempotencyKeyFile(key);
  const record = await readKey(file);
  if (!record || record.owner !== owner) return false;
  await unlink(file).catch(() => undefined);
  return true;
}

/** The live record for a key, or undefined when there is none or it expired. */
export async function findIdempotencyKey(key: string): Promise<IdempotencyRecord | undefined> {
  const record = await readKey(idempotencyKeyFile(key));
  return record && !expired(record) ? record : undefined;
}

/** Every live reservation, for reconciliation on Hook start. */
export async function listIdempotencyRecords(): Promise<IdempotencyRecord[]> {
  const names = await readdir(keyRoot()).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return [] as string[];
  });
  const records: IdempotencyRecord[] = [];
  for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
    const record = await readKey(path.join(keyRoot(), name));
    if (record && !expired(record)) records.push(record);
  }
  return records;
}

/** Wait for the reserving caller to name its dispatch. Undefined when the key disappears or the wait runs out. */
export async function waitForIdempotencyKey(key: string, timeoutMs = 180_000): Promise<IdempotencyRecord | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = await findIdempotencyKey(key);
    if (!record) return undefined;
    if (record.phase !== "reserved") return record;
    await sleep(100);
  }
  return undefined;
}

/** A branch slug for a key: `agent/<key-slug>` or `agent/<dispatch id>` when there is no key. */
export function worktreeBranchFor(key: string | undefined, dispatchId: string): string {
  const slug = (key ?? "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/\.{2,}/g, ".")
    .replace(/^[-.]+|[-.]+$/g, "").slice(0, 80).replace(/[-.]+$/g, "");
  return `agent/${slug || dispatchId}`;
}
