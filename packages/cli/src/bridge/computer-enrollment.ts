import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import path from "node:path";
import { z } from "zod";
import { permissionDeniedError } from "../governance/rbac.js";
import { acceptComputer, computerName, enrollComputer, publicComputerKey } from "./computers.js";
import { ownHostKey } from "./health.js";
import { addHookPeer, optionalHookPeers, peerRequest, type HookPeer } from "./peers.js";
import { atomicInPrivateDir, bridgeRoot, BridgeError, object, serverName } from "./protocol.js";

const fingerprint = (key: string) => "SHA256:" + createHash("sha256").update(Buffer.from(publicComputerKey(key).split(" ")[1], "base64")).digest("base64").replace(/=+$/, "");
const peerIdentity = z.object({
  computerId: z.string().uuid(), name: computerName,
  address: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/),
  username: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/), port: z.number().int().min(1).max(65535),
  server: serverName.default("default"), hostKey: z.string().transform(publicComputerKey), publicKey: z.string().transform(publicComputerKey),
}).strict();
const reviewSchema = z.object({ version: z.literal(1), id: z.string().uuid(), localComputerId: z.string().uuid(), peer: peerIdentity,
  localHostFingerprint: z.string(), hostFingerprint: z.string(), keyFingerprint: z.string(), expiresAt: z.string().datetime() }).strict();
const reviewFile = (id: string) => path.join(bridgeRoot(), "computer-enrollment", `${id}.json`);

function owner(store: string, raw: unknown) {
  if (object(raw).origin !== undefined) throw new BridgeError(403, "Only the owner enrolls computers from an authenticated phone or their own terminal.");
  const denied = permissionDeniedError(store, "manage_config");
  if (denied) throw new BridgeError(403, denied);
}
function peerFor(value: z.infer<typeof peerIdentity>): HookPeer {
  const { computerId: _computerId, publicKey: _publicKey, ...peer } = value;
  return peer;
}
async function noReplacement(peer: HookPeer) {
  const { peers, peerError } = await optionalHookPeers();
  if (peerError) throw new BridgeError(409, peerError);
  const conflict = peers.find(row => (row.name === peer.name || row.address === peer.address && row.port === peer.port && row.server === peer.server)
    && (["name", "address", "username", "port", "server", "hostKey"] as const).some(key => row[key] !== peer[key]));
  if (conflict) throw new BridgeError(409, "This computer is already linked with different details. Review and explicitly revoke the old enrollment first.");
}

/** Explicit owner preparation on each already-paired Hook. Only public material
 * is returned; the phone relays it over its existing authenticated connections. */
export async function prepareComputerEnrollment(store: string, computerId: string, raw: unknown) {
  owner(store, raw);
  const input = z.object({ name: computerName, confirmKeyCreation: z.literal(true) }).strict().parse(raw);
  const hostKey = await ownHostKey();
  if (!hostKey) throw new BridgeError(409, "This computer has no readable ed25519 SSH host key. Configure its SSH service before linking.");
  const line = await enrollComputer(input.name);
  const at = line.indexOf("ssh-ed25519 ");
  if (at < 0) throw new BridgeError(409, "Computer enrollment did not return its public identity.");
  const publicKey = publicComputerKey(line.slice(at));
  return { ok: true, version: 1, computerId, name: input.name, username: userInfo().username, hostKey, publicKey,
    hostFingerprint: fingerprint(hostKey), keyFingerprint: fingerprint(publicKey) };
}

/** Review is read-only with respect to trust: no key is accepted or pin learned. */
export async function reviewComputerEnrollment(store: string, computerId: string, raw: unknown) {
  owner(store, raw);
  const input = z.object({ peer: peerIdentity }).strict().parse(raw);
  if (input.peer.computerId === computerId) throw new BridgeError(409, "This is the same computer.");
  await noReplacement(peerFor(input.peer));
  const host = await ownHostKey();
  if (!host) throw new BridgeError(409, "This computer's host identity is unavailable.");
  const review = reviewSchema.parse({ version: 1, id: randomUUID(), localComputerId: computerId, peer: input.peer,
    localHostFingerprint: fingerprint(host), hostFingerprint: fingerprint(input.peer.hostKey), keyFingerprint: fingerprint(input.peer.publicKey),
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() });
  await atomicInPrivateDir(reviewFile(review.id), review);
  return { ok: true, ...review, instruction: "Compare both fingerprints and the computer ID with the other authenticated Hook before confirming. Confirm both directions, then retry verification if the first direction is waiting." };
}

/** Confirmation accepts one reviewed key with existing forced-command/pty
 * restrictions. A link is only saved after pinned SSH returns the exact ID.
 * A partially accepted key is reported honestly and is safe to verify again. */
export async function confirmComputerEnrollment(store: string, computerId: string, raw: unknown) {
  owner(store, raw);
  const input = z.object({ reviewId: z.string().uuid(), confirm: z.literal(true), peerComputerId: z.string().uuid(),
    hostFingerprint: z.string().max(100), keyFingerprint: z.string().max(100) }).strict().parse(raw);
  const file = reviewFile(input.reviewId), info = await lstat(file).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > 16384 || (info.mode & 0o077)) throw new BridgeError(409, "Enrollment review is unavailable; prepare a new review.");
  const review = reviewSchema.parse(JSON.parse(await readFile(file, "utf8")));
  if (review.id !== input.reviewId || review.localComputerId !== computerId || Date.parse(review.expiresAt) <= Date.now()
    || review.peer.computerId !== input.peerComputerId || review.hostFingerprint !== input.hostFingerprint || review.keyFingerprint !== input.keyFingerprint) {
    throw new BridgeError(409, "Enrollment review expired or the reviewed identity changed. Review both computers again.");
  }
  const host = await ownHostKey();
  if (!host || fingerprint(host) !== review.localHostFingerprint) throw new BridgeError(409, "This computer's host identity changed since review.");
  const peer = peerFor(review.peer);
  await noReplacement(peer);
  await acceptComputer(peer.name, review.peer.publicKey);
  let health: Record<string, unknown>;
  try { health = await peerRequest(peer, "/v1/health", undefined, 15000); }
  catch { return { ok: true, state: "key-accepted-awaiting-verification", peerComputerId: review.peer.computerId, linked: false,
    reason: "The reviewed key was accepted here, but pinned SSH did not verify the other Hook. Confirm the reverse direction and retry this review before it expires. No peer entry was added." }; }
  if (object(health.computer).id !== review.peer.computerId) throw new BridgeError(409, "Pinned SSH reached a different Hook computer identity. The public key was accepted here, but no peer entry was added; review and revoke it explicitly if necessary.");
  let linked: Awaited<ReturnType<typeof addHookPeer>>;
  try { linked = await addHookPeer(peer); }
  catch { throw new BridgeError(409, "The reviewed public key was accepted and the peer identity verified, but saving the link failed. Review the existing computer links before retrying; no conflicting pin was replaced.", { keyAccepted: true, linked: false, peerComputerId: review.peer.computerId }); }
  return { ok: true, state: "verified", linked: true, added: linked.added, peerComputerId: review.peer.computerId, hostFingerprint: review.hostFingerprint };
}

/** Existing-peer repair verifies the saved pin and exact ID; it never learns a
 * replacement key, creates credentials, or broadens an existing enrollment. */
export async function verifyComputerEnrollment(store: string, raw: unknown) {
  owner(store, raw);
  const input = z.object({ name: computerName, computerId: z.string().uuid(), hostFingerprint: z.string().max(100) }).strict().parse(raw);
  const { peers, peerError } = await optionalHookPeers();
  if (peerError) throw new BridgeError(409, peerError);
  const peer = peers.find(row => row.name === input.name);
  if (!peer || fingerprint(peer.hostKey) !== input.hostFingerprint) throw new BridgeError(409, "The saved peer or host pin differs from the reviewed identity.");
  const health = await peerRequest(peer, "/v1/health", undefined, 15000);
  if (object(health.computer).id !== input.computerId) throw new BridgeError(409, "The saved SSH pin reached a different Hook computer identity.");
  return { ok: true, state: "verified", computerId: input.computerId, hostFingerprint: input.hostFingerprint };
}
