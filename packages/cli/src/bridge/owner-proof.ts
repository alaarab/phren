import { createHash, createPublicKey, verify } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { z } from "zod";
import { homeDir } from "../home-paths.js";
import { atomic, BridgeError, bridgeRoot, type Json } from "./protocol.js";
import { ownerRequest } from "./request-origin.js";

/**
 * Owner proof for the actions an agent must not take for itself: release
 * authority, raising a pane's permission mode, making or stopping the
 * conductor, registering for this computer's alerts and linking computers.
 *
 * Agents run as the same Unix user as the Hook, so no header or local file can
 * tell the owner's phone from an agent's `nc -U hook.sock`. The phone holds its
 * paired SSH key's private half, so it signs these requests with it (the same
 * key that already signs approval rules). Once the Hook has seen one valid
 * signature, unsigned requests to these routes are refused: older apps keep
 * working until the phone starts signing, and after that an agent cannot.
 */
export const OWNER_PROOF_HEADER = "x-phren-owner-proof";
const DOMAIN = "phren-owner-request-v1";
const WINDOW_MS = 300_000;
const ROUTES = new Set([
  "POST /v1/authority", "POST /v1/authority/confirm", "DELETE /v1/authority",
  "POST /v1/agents/permission-mode",
  "POST /v1/conductor/make", "POST /v1/conductor/stop",
  "POST /v1/push/register",
  "POST /v1/sets/link",
  "POST /v1/housekeeping/approve", "POST /v1/housekeeping/dismiss", "POST /v1/housekeeping/restore", "POST /v1/housekeeping/scan",
]);

const payloadSchema = z.object({
  domain: z.literal(DOMAIN), nonce: z.string().uuid(), at: z.string().datetime({ offset: true }),
  method: z.enum(["POST", "DELETE"]), path: z.string().min(1).max(4096), body: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const envelopeSchema = z.object({ payload: z.string().min(1).max(8192), signature: z.string().min(1).max(128), publicKey: z.string().min(1).max(64) }).strict();

export const ownerProofRoute = (method: string | undefined, pathname: string) => ROUTES.has(`${method} ${pathname}`);
export const bodyDigest = (raw: Buffer) => createHash("sha256").update(raw).digest("hex");

/** Paired phone keys (iPhone and Android) on the restricted dispatch command. Scoped, computer and plain keys cannot sign. */
export function deviceKeys(authorizedKeys: string): Set<string> {
  const result = new Set<string>();
  for (const line of authorizedKeys.split("\n")) {
    const match = /^restrict,pty,command="sh ~\/\.local\/share\/phren\/bridge\/dispatch" ssh-ed25519 ([A-Za-z0-9+/]+={0,2}) phren-(?:iphone|android)\s*$/.exec(line);
    if (!match) continue;
    const wire = Buffer.from(match[1], "base64");
    // SSH string("ssh-ed25519"), string(32-byte key).
    if (wire.length === 51 && wire.readUInt32BE(0) === 11 && wire.subarray(4, 15).toString() === "ssh-ed25519" && wire.readUInt32BE(15) === 32) result.add(wire.subarray(19).toString("base64"));
  }
  return result;
}

export interface OwnerProofOptions {
  root?: string;
  keys?: () => Promise<Set<string>>;
  now?: () => number;
}

export class OwnerProof {
  private seen = new Map<string, number>();
  private required?: boolean;
  constructor(private options: OwnerProofOptions = {}) {}
  private get root() { return this.options.root ?? bridgeRoot(); }
  private get file() { return path.join(this.root, "owner-proof.json"); }
  private now() { return (this.options.now ?? Date.now)(); }
  private async keys() {
    if (this.options.keys) return this.options.keys();
    return deviceKeys(await readFile(path.join(homeDir(), ".ssh", "authorized_keys"), "utf8").catch(() => ""));
  }

  /** Whether a phone has signed before, so unsigned owner actions are refused. */
  async isRequired(): Promise<boolean> {
    if (this.required) return true;
    const info = await lstat(this.file).catch(() => undefined);
    this.required = !!info?.isFile();
    return this.required;
  }

  /**
   * Throws 403 unless an owner-only request may go ahead. Requests that carry
   * an agent or peer origin are left to the route, which refuses them anyway.
   */
  async check(request: Pick<IncomingMessage, "headers" | "method">, pathname: string, data: Json, digest: string | undefined): Promise<void> {
    if (!ownerProofRoute(request.method, pathname) || !ownerRequest(request, data)) return;
    const header = request.headers?.[OWNER_PROOF_HEADER];
    if (typeof header !== "string") {
      if (await this.isRequired()) throw new BridgeError(403, "Confirm this on your paired phone: this action needs its signature.", { code: "owner-proof-required" });
      return;
    }
    const refused = () => new BridgeError(403, "The phone's signature for this action did not verify.", { code: "owner-proof-invalid" });
    let envelope: z.infer<typeof envelopeSchema>, payload: z.infer<typeof payloadSchema>;
    try {
      envelope = envelopeSchema.parse(JSON.parse(Buffer.from(header, "base64url").toString("utf8")));
      payload = payloadSchema.parse(JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")));
    } catch { throw refused(); }
    const raw = Buffer.from(envelope.publicKey, "base64"), signature = Buffer.from(envelope.signature, "base64");
    if (raw.length !== 32 || signature.length !== 64 || !(await this.keys()).has(raw.toString("base64"))) throw refused();
    const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" });
    if (!verify(null, Buffer.from(envelope.payload, "base64"), key, signature)) throw refused();
    const at = Date.parse(payload.at), now = this.now();
    if (payload.method !== request.method || payload.path !== pathname || payload.body !== digest || !(Math.abs(now - at) <= WINDOW_MS)) throw refused();
    for (const [nonce, until] of this.seen) if (until < now) this.seen.delete(nonce);
    if (this.seen.has(payload.nonce)) throw refused();
    if (this.seen.size >= 4096) throw new BridgeError(429, "Too many signed owner actions. Try again in a few minutes.");
    this.seen.set(payload.nonce, now + 2 * WINDOW_MS);
    if (!(await this.isRequired())) {
      await atomic(this.file, JSON.stringify({ since: new Date(now).toISOString(), key: createHash("sha256").update(raw).digest("hex") }));
      this.required = true;
    }
  }
}
