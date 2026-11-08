import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { atomic, bridgeRoot } from "./protocol.js";

/**
 * Idempotency keys for local dispatches (`phren dispatch local ... --idempotency-key`).
 * The runner may crash between placing a dispatch and recording its id, then
 * retry the same key. A key is reserved with an exclusive create, so two
 * concurrent callers start one agent; the first writes the dispatch id into
 * the reservation as soon as its receipt exists. Records live beside the
 * dispatch receipts, so they survive a Hook restart, and expire after 30 days.
 */

export const IDEMPOTENCY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const idempotencyKeySchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9:._@/-]+$/,
  "An idempotency key is 1 to 200 characters of letters, digits, and : . _ @ / -");

const recordSchema = z.object({
  key: z.string().min(1).max(200),
  createdAt: z.string().datetime(),
  dispatchId: z.string().uuid().optional(),
}).strict();
export type IdempotencyRecord = z.infer<typeof recordSchema>;

const keyRoot = () => path.join(bridgeRoot(), "idempotency");
const keyFile = (key: string) => path.join(keyRoot(), `${createHash("sha256").update(key).digest("hex")}.json`);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function expired(record: IdempotencyRecord, now = Date.now()): boolean {
  return now - Date.parse(record.createdAt) > IDEMPOTENCY_TTL_MS;
}

async function readKey(file: string): Promise<IdempotencyRecord | undefined> {
  const info = await lstat(file).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  });
  if (!info?.isFile() || info.isSymbolicLink() || info.size > 4096) return undefined;
  try { return recordSchema.parse(JSON.parse(await readFile(file, "utf8"))); } catch { return undefined; }
}

/** The live record for a key, or undefined when there is none or it expired. */
export async function findIdempotencyKey(key: string): Promise<IdempotencyRecord | undefined> {
  const file = keyFile(key);
  const record = await readKey(file);
  if (!record) return undefined;
  if (!expired(record)) return record;
  await unlink(file).catch(() => undefined);
  return undefined;
}

export type KeyReservation = { reserved: true; record: IdempotencyRecord } | { reserved: false; record: IdempotencyRecord };

/**
 * Reserve `key` for this caller. The exclusive create is the atomic
 * check-and-insert: exactly one caller gets `reserved: true`; the others get
 * the record already there (which may not name a dispatch yet).
 */
export async function reserveIdempotencyKey(key: string, now = Date.now()): Promise<KeyReservation> {
  await mkdir(keyRoot(), { recursive: true, mode: 0o700 });
  const file = keyFile(key);
  for (let attempt = 0; attempt < 2; attempt++) {
    const record: IdempotencyRecord = { key, createdAt: new Date(now).toISOString() };
    try {
      const handle = await open(file, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
      return { reserved: true, record };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readKey(file);
      if (!existing || expired(existing, now)) {
        await unlink(file).catch(() => undefined);
        continue;
      }
      return { reserved: false, record: existing };
    }
  }
  const existing = await readKey(file);
  if (!existing) throw new Error("Could not reserve the dispatch idempotency key.");
  return { reserved: false, record: existing };
}

/** Record which dispatch this key started. Atomic, so a concurrent reader sees the old or the new record. */
export async function recordIdempotencyDispatch(key: string, dispatchId: string): Promise<void> {
  const file = keyFile(key);
  const current = await readKey(file);
  const record: IdempotencyRecord = { ...(current ?? { key, createdAt: new Date().toISOString() }), key, dispatchId };
  await atomic(file, JSON.stringify(record), 0o600);
}

/** Give back a reservation that never started a dispatch. */
export async function releaseIdempotencyKey(key: string): Promise<void> {
  await unlink(keyFile(key)).catch(() => undefined);
}

/** Wait for the reserving caller to name its dispatch. Undefined when the key disappears or the wait runs out. */
export async function waitForIdempotencyKey(key: string, timeoutMs = 180_000): Promise<IdempotencyRecord | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = await findIdempotencyKey(key);
    if (!record) return undefined;
    if (record.dispatchId) return record;
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
