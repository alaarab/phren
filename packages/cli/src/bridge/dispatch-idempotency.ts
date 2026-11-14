import { createHash } from "node:crypto";
import { link, lstat, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { atomic, BridgeError, bridgeRoot } from "./protocol.js";

/**
 * Idempotency keys for local dispatches (`phren dispatch local ... --idempotency-key`).
 * A reservation is written to a temp file and published with `link`, which is
 * atomic and fails with EEXIST: an empty or half-written file is never a
 * reservation another caller can reclaim. Every update or delete checks the
 * owner nonce. The per-key mutex is in-process because only the Hook server
 * process mutates key records; the CLI reaches it through Hook routes.
 */

export const IDEMPOTENCY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A reservation that has not reached "launched" is interrupted after this. */
export const LAUNCH_INTERRUPTED_MS = 5 * 60_000;
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

let hookServerProcess = false;
/** Called by the Hook server before it handles dispatches. */
export function markHookServerProcess(): void { hookServerProcess = true; }
function assertHookServerProcess(): void {
  if (!hookServerProcess) throw new BridgeError(403, "Idempotency key locks are only available inside the Phren Hook server process.");
}

/**
 * A per-key async mutex. Only the Hook server process mutates key records (the
 * CLI reaches it through Hook routes), so a Map of promise chains serializes
 * every read-modify-write without a lock file or a reclaim race.
 */
const keyMutexes = new Map<string, Promise<void>>();
async function withKeyMutex<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = keyMutexes.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => current);
  keyMutexes.set(key, tail);
  await previous;
  try { return await run(); }
  finally {
    release();
    if (keyMutexes.get(key) === tail) keyMutexes.delete(key);
  }
}

/** Delete lock and reclaim files left by an older Hook or a crash. */
export async function cleanupIdempotencyLocks(): Promise<void> {
  const root = keyRoot();
  const names = await readdir(root).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return [] as string[];
  });
  await Promise.all(names.filter(name => name.endsWith(".lock") || name.includes(".lock.reclaim-"))
    .map(name => unlink(path.join(root, name)).catch(() => undefined)));
}

async function replaceExpired(key: string, fresh: IdempotencyRecord, now: number): Promise<KeyReservation> {
  const current = await readKey(idempotencyKeyFile(key));
  if (current && !expired(current, now)) return { reserved: false, record: current };
  if (current) await unlink(idempotencyKeyFile(key)).catch(() => undefined);
  if (await publish(key, fresh)) return { reserved: true, record: fresh };
  const raced = await readKey(idempotencyKeyFile(key));
  if (!raced) throw new BridgeError(503, "The idempotency key's reservation is unreadable; refusing to start another dispatch.");
  return { reserved: false, record: raced };
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
  return withKeyMutex(key, async () => {
    const record: IdempotencyRecord = { key, dispatchId, owner, createdAt: new Date(now).toISOString(), phase: "reserved", ...seed };
    if (await publish(key, record)) return { reserved: true, record };
    const existing = await readKey(idempotencyKeyFile(key));
    // An unreadable reservation is not free: never unlink it and start a second agent.
    if (!existing) throw new BridgeError(503, "The idempotency key's reservation is unreadable; refusing to start another dispatch.");
    if (!expired(existing, now)) return { reserved: false, record: existing };
    return replaceExpired(key, record, now);
  });
}

/** Move the reservation's phase. False when this caller no longer owns it. */
export async function updateIdempotencyPhase(key: string, owner: string, phase: IdempotencyPhase): Promise<boolean> {
  return withKeyMutex(key, async () => {
    const file = idempotencyKeyFile(key);
    const record = await readKey(file);
    if (!record || record.owner !== owner) return false;
    await atomic(file, JSON.stringify({ ...record, phase }), 0o600);
    return true;
  });
}

/** Run under the key's in-process mutex, with the current reservation record. */
export async function withIdempotencyKeyLock<T>(key: string, run: (record: IdempotencyRecord | undefined, save: (record: IdempotencyRecord) => Promise<void>) => Promise<T>): Promise<T> {
  assertHookServerProcess();
  return withKeyMutex(key, async () => {
    const file = idempotencyKeyFile(key);
    const record = await readKey(file);
    return await run(record, async next => {
      const current = await readKey(file);
      if (!current) throw new BridgeError(409, "The idempotency key no longer exists.");
      if (current.owner !== next.owner) throw new BridgeError(409, "This dispatch no longer owns its idempotency key.");
      await atomic(file, JSON.stringify(next), 0o600);
    });
  });
}

/** Record a cancellation on the reservation itself, under its mutex, before any receipt exists. */
export async function requestIdempotencyCancel(key: string, now = Date.now()): Promise<IdempotencyRecord | undefined> {
  return withKeyMutex(key, async () => {
    const file = idempotencyKeyFile(key);
    const record = await readKey(file);
    if (!record) return undefined;
    if (record.cancelRequestedAt) return record;
    record.cancelRequestedAt = new Date(now).toISOString();
    await atomic(file, JSON.stringify(record), 0o600);
    return record;
  });
}

/** Release a reservation this caller owns and never launched. */
export async function releaseIdempotencyKey(key: string, owner: string): Promise<boolean> {
  return withKeyMutex(key, async () => {
    const file = idempotencyKeyFile(key);
    const record = await readKey(file);
    if (!record || record.owner !== owner) return false;
    await unlink(file).catch(() => undefined);
    return true;
  });
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
