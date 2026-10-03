import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { dump } from "js-yaml";
import { z } from "zod";
import { hookPeers, peerSchema, peerRequest } from "../peers.js";
import { publicComputerKey } from "../computers.js";
import { atomic, BridgeError, bridgeRoot, computerName } from "../protocol.js";
import { lockedState } from "./private-state.js";
import { linkComputer, sshConfigHosts } from "../link.js";

export async function peerRepairView() {
  const peers = await hookPeers().catch(error => {
    if (error instanceof BridgeError && error.details?.hooksYaml === "missing") return [];
    throw error;
  });
  return { peers: peers.map(peer => ({ ...peer, repairScope: "existing-enrollment-and-unchanged-pin" })), newEnrollment: "explicit-owner-confirmation-and-verified-pin" };
}

/** Restores routing for an existing computer identity. It never generates, installs or exchanges SSH keys. */
export async function repairPeer(input: unknown) {
  const data = z.object({ name: computerName, expectedHostKey: z.string().transform(publicComputerKey), backPeer: peerSchema, expectedComputerId: z.string().uuid() }).strict().parse(input);
  if (data.backPeer.name !== data.name || data.backPeer.hostKey !== data.expectedHostKey) throw new BridgeError(409, "Repair must retain the peer name and verified pin.");
  const keys = path.join(homedir(), ".ssh", "authorized_keys"), info = await lstat(keys).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > 1048576 || (info.mode & 0o022)) throw new BridgeError(409, "Existing computer enrollment cannot be verified.");
  const enrolled = (await readFile(keys, "utf8").catch(() => { throw new BridgeError(409, "Existing computer enrollment cannot be verified."); })).split(/\r?\n/).some(line => line.startsWith("restrict,") && line.includes('command="sh ~/.local/share/phren/bridge/dispatch"') && line.endsWith(" phren-computer:" + data.name));
  if (!enrolled) throw new BridgeError(409, "This computer has no existing SSH enrollment for that peer. New enrollment requires explicit owner confirmation and a verified pin.");
  const health = await peerRequest(data.backPeer, "/v1/health");
  if ((health.computer as { id?: string })?.id !== data.expectedComputerId) throw new BridgeError(409, "The pinned peer reports a different computer identity.");
  const file = path.join(bridgeRoot(), "hooks.yaml");
  return lockedState(file, async () => {
    const peers = await hookPeers().catch(error => { if (error instanceof BridgeError && error.details?.hooksYaml === "missing") return []; throw error; });
    const prior = peers.find(peer => peer.name === data.name);
    if (prior && prior.hostKey !== data.expectedHostKey) throw new BridgeError(409, "The stored pin changed; owner repair cannot replace it.");
    if (peers.some(peer => peer.name !== data.name && peer.address === data.backPeer.address && peer.port === data.backPeer.port && peer.server === data.backPeer.server)) throw new BridgeError(409, "That endpoint belongs to another named peer.");
    if (!prior && peers.length >= 32) throw new BridgeError(409, "The peer directory is full.");
    await atomic(file, dump({ version: 1, computers: [...peers.filter(peer => peer.name !== data.name), data.backPeer] }, { lineWidth: -1 }));
    return { ok: true, peer: data.backPeer, keysChanged: false, pinChanged: false };
  });
}

export function peerEnrollmentPlan(input: unknown) {
  const data = z.object({ ownerConfirmed: z.literal(true), name: computerName, hostKey: z.string().transform(publicComputerKey) }).strict().parse(input);
  return { version: 1, performed: false, name: data.name, verifiedPin: data.hostKey, requiresOwnerOperation: true,
    steps: ["Verify the supplied host key through an independent owner channel.", "Use the owner's explicit SSH enrollment workflow on both computers.", "Check both pinned links; this planning route performs no enrollment."] };
}

/** Optional source API for a future explicit phone confirmation, not an operation performed during development. */
export async function enrollPinnedPeer(input: unknown) {
  const data = z.object({ ownerConfirmed: z.literal(true), host: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/), expectedHostKey: z.string().transform(publicComputerKey), name: computerName.optional(), as: computerName.optional(), backAddress: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/).optional() }).strict().parse(input);
  const hosts = sshConfigHosts(await readFile(path.join(homedir(), ".ssh", "config"), "utf8"));
  if (!hosts.includes(data.host)) throw new BridgeError(409, "Choose an existing owner SSH host with a verified known-host pin; enrollment never discovers credentials or accepts a new host key.");
  return linkComputer(data.host, data);
}
