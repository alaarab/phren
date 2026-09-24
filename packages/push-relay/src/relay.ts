import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The phren push relay. Apple accepts pushes for the App Store app only when
 * they are signed with the app developer's key, so every user's Hook sends
 * through here. It keeps no state:
 *
 * - A phone registers its APNs device token once. Its relay id is that token
 *   (and its APNs environment) encrypted with the relay's own key, so the id
 *   alone lets the relay recover where to send, and nothing is stored.
 * - The phone's send secret is an HMAC of the relay id under the same key; a
 *   Hook signs each request with it and the relay recomputes it to check.
 * - What a notification says arrives already encrypted with a key only the
 *   phone and the Hook share; the relay forwards the ciphertext and a generic
 *   placeholder, and the phone's notification extension decrypts it.
 *
 * Moving hosts means copying one secret; losing it only means phones register again.
 */

export type Environment = "production" | "sandbox";

export interface Registration { relayId: string; secret: string }

const TOKEN = /^[0-9a-f]{64,200}$/;
const RELAY_ID = /^[A-Za-z0-9_-]{40,400}$/;
/** A signed request older or newer than this is refused. */
export const MAX_SKEW_SECONDS = 300;
/** Encrypted content is at most this long, keeping the APNs payload under 4 KB. */
export const MAX_CIPHERTEXT = 2_800;

export class Relay {
  private readonly encryptionKey: Buffer;
  private readonly signingKey: Buffer;

  /** `secret` is 32 random bytes, the one thing the relay keeps. */
  constructor(secret: Buffer) {
    if (secret.length < 32) throw new Error("The relay secret must be at least 32 bytes.");
    this.encryptionKey = createHmac("sha256", secret).update("phren-relay-id").digest();
    this.signingKey = createHmac("sha256", secret).update("phren-relay-send").digest();
  }

  register(deviceToken: string, environment: Environment): Registration {
    if (!TOKEN.test(deviceToken)) throw new RelayError(400, "That isn't an APNs device token.");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const plain = Buffer.from(`${environment === "production" ? "p" : "s"}${deviceToken}`, "utf8");
    const relayId = Buffer.concat([iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()]).toString("base64url");
    return { relayId, secret: this.secretFor(relayId) };
  }

  /** Where a relay id points, or an error for one this relay didn't issue. */
  resolve(relayId: string): { deviceToken: string; environment: Environment } {
    if (!RELAY_ID.test(relayId)) throw new RelayError(401, "Unknown relay id.");
    const bytes = Buffer.from(relayId, "base64url");
    if (bytes.length < 12 + 16 + 33) throw new RelayError(401, "Unknown relay id.");
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(bytes.length - 16));
      const plain = Buffer.concat([decipher.update(bytes.subarray(12, bytes.length - 16)), decipher.final()]).toString("utf8");
      const deviceToken = plain.slice(1);
      if (!TOKEN.test(deviceToken)) throw new Error("bad token");
      return { deviceToken, environment: plain[0] === "p" ? "production" : "sandbox" };
    } catch {
      throw new RelayError(401, "Unknown relay id.");
    }
  }

  secretFor(relayId: string): string {
    return createHmac("sha256", this.signingKey).update(relayId).digest("base64url");
  }

  /** Checks a Hook's signature: HMAC-SHA256(secret, `${timestamp}.${body}`). */
  verify(relayId: string, timestamp: string, body: string, signature: string, now = Date.now()): void {
    const seconds = Number(timestamp);
    if (!Number.isInteger(seconds) || Math.abs(now / 1000 - seconds) > MAX_SKEW_SECONDS) {
      throw new RelayError(401, "The request is too old or its clock is off.");
    }
    const expected = signRequest(this.secretFor(relayId), timestamp, body);
    const given = Buffer.from(signature, "utf8"), wanted = Buffer.from(expected, "utf8");
    if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) throw new RelayError(401, "Bad signature.");
  }
}

/** What a Hook computes for the `x-phren-signature` header. */
export function signRequest(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("base64url");
}

export class RelayError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** What a Hook asks the relay to deliver. */
export interface SendRequest {
  /** "alert" becomes a visible notification the phone decrypts. */
  kind: "alert";
  /** Base64url of the phone-and-Hook encrypted notification. */
  ciphertext: string;
  collapseId?: string;
  /** Unix seconds after which Apple may drop it; 0 means deliver once or not at all. */
  expiration?: number;
  category?: string;
}

export function parseSend(body: string): SendRequest {
  let value: Record<string, unknown>;
  try { value = JSON.parse(body) as Record<string, unknown>; } catch { throw new RelayError(400, "The body isn't JSON."); }
  if (value.kind !== "alert") throw new RelayError(400, "Unsupported kind.");
  const ciphertext = value.ciphertext;
  if (typeof ciphertext !== "string" || !/^[A-Za-z0-9_-]{16,}$/.test(ciphertext) || ciphertext.length > MAX_CIPHERTEXT) {
    throw new RelayError(400, "The ciphertext is missing or too long.");
  }
  const collapseId = typeof value.collapseId === "string" && /^[\w.:-]{1,64}$/.test(value.collapseId) ? value.collapseId : undefined;
  const expiration = typeof value.expiration === "number" && Number.isInteger(value.expiration) && value.expiration >= 0 ? value.expiration : undefined;
  const category = typeof value.category === "string" && /^[A-Z_]{1,40}$/.test(value.category) ? value.category : undefined;
  return { kind: "alert", ciphertext, collapseId, expiration, category };
}

/** The APNs payload: a generic alert the phone's extension replaces with the
 * decrypted text. If decryption fails the person still sees that phren has news. */
export function apnsPayload(request: SendRequest): Record<string, unknown> {
  return {
    aps: { alert: { title: "phren", body: "New activity" }, sound: "default", "mutable-content": 1,
      ...(request.category ? { category: request.category } : {}) },
    e: request.ciphertext,
  };
}

/** A fixed window per relay id, in memory: a restart only resets the counts. */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  constructor(private readonly limit = 60, private readonly windowMs = 60_000, private readonly maxKeys = 50_000) {}
  allow(key: string, now = Date.now()): boolean {
    const window = this.windows.get(key);
    if (!window || now - window.start >= this.windowMs) {
      if (!window && this.windows.size >= this.maxKeys) this.prune(now);
      this.windows.set(key, { start: now, count: 1 });
      return true;
    }
    window.count += 1;
    return window.count <= this.limit;
  }
  private prune(now: number) {
    for (const [key, window] of this.windows) if (now - window.start >= this.windowMs) this.windows.delete(key);
    while (this.windows.size >= this.maxKeys) this.windows.delete(this.windows.keys().next().value!);
  }
}

/** Signatures seen inside the skew window: a captured request can't be replayed. */
export class ReplayGuard {
  private readonly seen = new Map<string, number>();
  check(signature: string, now = Date.now()): void {
    for (const [key, at] of this.seen) { if (now - at > MAX_SKEW_SECONDS * 1000) this.seen.delete(key); else break; }
    if (this.seen.has(signature)) throw new RelayError(409, "This request was already delivered.");
    this.seen.set(signature, now);
  }
}
