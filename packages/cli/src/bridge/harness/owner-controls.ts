import { createHash, createPublicKey, verify } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { IncomingHttpHeaders } from "node:http";
import { z } from "zod";
import { publicComputerKey } from "../computers.js";
import { atomicInPrivateDir, BridgeError, bridgeRoot, type Json } from "../protocol.js";
import { lockedState, readPrivateState } from "./private-state.js";

export function canonicalOwnerBody(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalOwnerBody).join(",") + "]";
  if (value !== null && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonicalOwnerBody((value as Json)[key])).join(",") + "}";
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new BridgeError(400, "Owner controls require a JSON value.");
  return encoded;
}
export function ownerSigningMessage(time: string, nonce: string, method: string, route: string, data: Json): string {
  return ["phren-owner-v1", time, nonce, method, route, createHash("sha256").update(canonicalOwnerBody(data)).digest("hex")].join("\n");
}

/** Only a paired phone key proves the owner. A computer's forced SSH command proves no such authority. */
export async function requireOwnerControl(headers: IncomingHttpHeaders, method: string, route: string, data: Json, root = bridgeRoot(), sshDirectory = path.join(homedir(), ".ssh")): Promise<void> {
  if (data.origin !== undefined) throw new BridgeError(403, "Only the authenticated owner may perform this control.");
  const scalar = (name: string) => typeof headers[name] === "string" ? headers[name] as string : "";
  const time = scalar("x-phren-owner-time"), nonce = scalar("x-phren-owner-nonce"), encoded = scalar("x-phren-owner-key"), signature = scalar("x-phren-owner-signature");
  if (!/^\d{13}$/.test(time) || Math.abs(Date.now() - Number(time)) > 120000 || !z.string().uuid().safeParse(nonce).success
    || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) throw new BridgeError(403, "A fresh signed owner request is required.");
  const key = publicComputerKey("ssh-ed25519 " + encoded);
  const directory = await lstat(sshDirectory).catch(() => undefined), file = path.join(sshDirectory, "authorized_keys"), info = await lstat(file).catch(() => undefined);
  if (!directory?.isDirectory() || directory.isSymbolicLink() || directory.mode & 0o022 || !info?.isFile() || info.isSymbolicLink() || info.size > 1048576
    || (info.mode & 0o022) || process.getuid && (info.uid !== process.getuid() || directory.uid !== process.getuid())) throw new BridgeError(403, "Paired owner keys are unavailable.");
  const text = await readFile(file, "utf8").catch(() => { throw new BridgeError(403, "Paired owner keys are unavailable."); });
  const paired = text.split(/\r?\n/).some(line => {
    const match = /^(.*) (ssh-ed25519 [A-Za-z0-9+/]+={0,2}) phren-(iphone|android)\s*$/.exec(line);
    return match?.[2] === key && match[1].startsWith("restrict,") && match[1].includes('command="sh ~/.local/share/phren/bridge/dispatch"');
  });
  const blob = Buffer.from(encoded, "base64"), publicKey = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), blob.subarray(19)]), type: "spki", format: "der" });
  if (!paired || !verify(null, Buffer.from(ownerSigningMessage(time, nonce, method, route, data)), publicKey, Buffer.from(signature, "base64"))) throw new BridgeError(403, "The owner signature is invalid or the paired key was revoked.");
  const ledger = path.join(root, "harness", "owner-nonces.json");
  await lockedState(ledger, async () => {
    const before = await readPrivateState(ledger), now = Date.now();
    const rows = before ? z.record(z.string(), z.number().int()).parse(JSON.parse(before)) : {};
    for (const [id, at] of Object.entries(rows)) if (at < now - 240000) delete rows[id];
    if (rows[nonce] !== undefined) throw new BridgeError(409, "This owner request was already used.");
    if (Object.keys(rows).length >= 1024) throw new BridgeError(429, "Owner control capacity is full; try later with a fresh nonce.");
    rows[nonce] = now;
    await atomicInPrivateDir(ledger, rows);
  });
}
