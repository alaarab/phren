/**
 * Transport-agnostic core for gitboy push webhooks: signature checks, push payload parsing,
 * matching a push to a store's branch, and delivery de-duplication. Prepared for webhook-driven
 * store sync; nothing in production calls it yet, and periodic polling (pull.ts) stays the fallback.
 */
import { createHmac, timingSafeEqual } from "crypto";

export interface GitboyPushUpdate {
  ref: string;
  old: string;
  new: string;
  /** Files changed between old and new; null when gitboy could not say (new branch, deletion, tag, over budget). */
  changedPaths: string[] | null;
  truncated: boolean;
}

export interface GitboyPush {
  deliveryId: string;
  event: "push";
  repository: { owner: string; name: string } | null;
  updates: GitboyPushUpdate[];
}

export interface GitboyStoreRepo {
  owner: string;
  name: string;
  branch: string;
}

const SIGNATURE_PREFIX = "sha256=";
const SHA256_HEX = /^[0-9a-f]{64}$/i;

/** True when `header` is `sha256=<hex HMAC-SHA256 of rawBody>` under `secret`. */
export function verifyGitboySignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!secret || typeof header !== "string" || !header.startsWith(SIGNATURE_PREFIX)) return false;
  const hex = header.slice(SIGNATURE_PREFIX.length);
  if (!SHA256_HEX.test(hex)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const given = Buffer.from(hex, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

type Headers = Record<string, string | string[] | undefined>;

function header(headers: Headers, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    const first = Array.isArray(value) ? value[0] : value;
    return typeof first === "string" ? first : undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** gitboy's push payload names the repository `full_name: "owner/name"` beside `name`. */
function parseRepository(value: unknown): GitboyPush["repository"] {
  if (!isRecord(value) || typeof value.full_name !== "string") return null;
  const slash = value.full_name.indexOf("/");
  if (slash <= 0) return null;
  const owner = value.full_name.slice(0, slash);
  const name = value.full_name.slice(slash + 1);
  if (!name || name.includes("/")) return null;
  return { owner, name };
}

function parseUpdate(value: unknown): GitboyPushUpdate | null {
  if (!isRecord(value)) return null;
  const { ref, old, new: next } = value;
  if (typeof ref !== "string" || typeof old !== "string" || typeof next !== "string") return null;
  const paths = value.changed_paths;
  const changedPaths = Array.isArray(paths) && paths.every((p) => typeof p === "string") ? paths as string[] : null;
  return { ref, old, new: next, changedPaths, truncated: value.changed_paths_truncated === true };
}

/** A gitboy `push` delivery, or null for any other event, a missing delivery id or a malformed body. Never throws. */
export function parseGitboyPush(rawBody: Buffer, headers: Headers): GitboyPush | null {
  if (header(headers, "x-gitboy-event") !== "push") return null;
  const deliveryId = header(headers, "x-gitboy-delivery");
  if (!deliveryId) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return null;
  }
  if (!isRecord(payload) || !Array.isArray(payload.updates)) return null;
  const updates: GitboyPushUpdate[] = [];
  for (const entry of payload.updates) {
    const update = parseUpdate(entry);
    if (update) updates.push(update);
  }
  return { deliveryId, event: "push", repository: parseRepository(payload.repository), updates };
}

/**
 * True when the push is to the store's repository (owner and name compared case-insensitively,
 * as gitboy resolves them) and moves `refs/heads/<branch>` exactly.
 */
export function storePushMatches(push: GitboyPush, store: GitboyStoreRepo): boolean {
  const repo = push.repository;
  if (!repo || !store.branch) return false;
  if (repo.owner.toLowerCase() !== store.owner.toLowerCase()) return false;
  if (repo.name.toLowerCase() !== store.name.toLowerCase()) return false;
  const ref = `refs/heads/${store.branch}`;
  return push.updates.some((update) => update.ref === ref);
}

export const DEFAULT_DELIVERY_LOG_SIZE = 1_000;

/** Recently seen delivery ids, oldest evicted first. gitboy retries keep the delivery id. */
export class DeliveryLog {
  private readonly ids = new Set<string>();

  constructor(private readonly capacity = DEFAULT_DELIVERY_LOG_SIZE) {}

  /** Records `id` and reports whether it had already been seen. */
  seen(id: string): boolean {
    if (this.ids.has(id)) return true;
    this.ids.add(id);
    while (this.ids.size > this.capacity) {
      const oldest = this.ids.values().next().value;
      if (oldest === undefined) break;
      this.ids.delete(oldest);
    }
    return false;
  }

  get size(): number {
    return this.ids.size;
  }
}
