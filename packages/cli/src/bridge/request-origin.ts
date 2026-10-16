import { randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { bridgeRoot } from "./protocol.js";
import type { IncomingMessage } from "node:http";
import type { Json } from "./protocol.js";

/** Owner phone/desktop gateways and the owner's local CLI carry no agent or
 * peer origin. Peer keys are forced through the peer scope, which rebuilds
 * the request with its own origin header; MCP calls carry an agent origin. */
export function ownerRequest(request: Pick<IncomingMessage, "headers">, data: Json): boolean {
  return request.headers?.["x-phren-origin"] === undefined && data.origin === undefined;
}

/** The legacy raw socket/owner byte pipe does not carry an authenticated
 * principal. New owner-only operations require this private local proof.
 * Scoped gateways discard this header, so a peer cannot replay owner proof. */
export async function ownerToken(root = bridgeRoot()): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, "owner-token");
  try { await writeFile(file, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error("The owner token must be a private regular file.");
  const token = (await readFile(file, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid owner token file.");
  return token;
}
export async function strongOwnerRequest(request: Pick<IncomingMessage, "headers">, data: Json = {}): Promise<boolean> {
  if (!ownerRequest(request, data)) return false;
  const supplied = request.headers["x-phren-owner-token"];
  if (typeof supplied !== "string" || !/^[a-f0-9]{64}$/.test(supplied)) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(await ownerToken()));
}
export interface PeerIdentity { name?: string; id?: string; fingerprint: string }
export function requestPeer(request: Pick<IncomingMessage, "headers">): PeerIdentity | undefined {
  if (request.headers["x-phren-origin"] !== "peer") return undefined;
  const encoded = request.headers["x-phren-peer"];
  if (typeof encoded !== "string") return undefined;
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!/^[a-f0-9]{64}$/.test(value.fingerprint) || value.id !== undefined && !/^[a-f0-9-]{36}$/i.test(value.id)) return undefined;
    if (value.name !== undefined && (typeof value.name !== "string" || !/^[A-Za-z0-9_.-]{1,253}$/.test(value.name))) return undefined;
    if (value.name === undefined && value.id === undefined) return undefined;
    return { ...(value.name ? { name: value.name } : {}), ...(value.id ? { id: value.id } : {}), fingerprint: value.fingerprint };
  } catch { return undefined; }
}
