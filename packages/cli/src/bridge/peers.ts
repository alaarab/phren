import { spawn } from "node:child_process";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Duplex } from "node:stream";
import { load } from "js-yaml";
import { z } from "zod";
import { hookRequest } from "./client.js";
import { computerName, dispatchKeyPath, publicComputerKey } from "./computers.js";
import { BridgeError, bridgeRoot, serverName, type Json } from "./protocol.js";

const peerSchema = z.object({
  name: computerName,
  address: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/),
  username: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/),
  port: z.number().int().min(1).max(65535).default(22),
  hostKey: z.string().transform(publicComputerKey),
  server: serverName.default("default"),
}).strict();
export type HookPeer = z.infer<typeof peerSchema>;

export async function hookPeers(root = bridgeRoot()): Promise<HookPeer[]> {
  const file = path.join(root, "hooks.yaml");
  const info = await lstat(file).catch(() => undefined);
  if (!info) throw new BridgeError(409, "Configure peers and verified host keys in the Hook's hooks.yaml first.");
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65_536 || (info.mode & 0o077)) throw new BridgeError(409, "hooks.yaml must be a private regular file (0600), at most 64 KiB.");
  const { computers } = z.object({ version: z.literal(1), computers: z.array(peerSchema).max(32) }).strict().parse(load(await readFile(file, "utf8")));
  if (new Set(computers.map(peer => peer.name)).size !== computers.length) throw new BridgeError(409, "hooks.yaml has duplicate computer names.");
  return computers;
}

export function peerSSHArgs(peer: HookPeer, knownHosts: string, key: string): string[] {
  return ["-F", "/dev/null", "-T", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none",
    "-o", "StrictHostKeyChecking=yes", "-o", "HostKeyAlias=phren-peer", "-o", `UserKnownHostsFile=${knownHosts}`,
    "-o", "GlobalKnownHostsFile=/dev/null", "-o", "UpdateHostKeys=no", "-o", "HostKeyAlgorithms=ssh-ed25519",
    "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no", "-o", "ForwardAgent=no",
    "-o", "ClearAllForwardings=yes", "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ConnectTimeout=10",
    "-i", key, "-p", String(peer.port), "-l", peer.username, "--", peer.address, "phren-hook v1 pipe"];
}

/** A pin is supplied out of band; dispatch never learns or replaces host keys. */
export async function peerRequest(peer: HookPeer, route: string, data?: Json): Promise<Json> {
  const root = bridgeRoot(), key = dispatchKeyPath(root);
  const info = await lstat(key).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) throw new BridgeError(409, "Run phren bridge enroll-computer on this computer first (private key mode 0600).");
  const temporary = await mkdtemp(path.join(root, "peer-"));
  let child: ReturnType<typeof spawn> | undefined, stream: Duplex | undefined;
  try {
    const knownHosts = path.join(temporary, "known_hosts");
    await writeFile(knownHosts, `phren-peer ${peer.hostKey}\n`, { mode: 0o600 });
    const ssh = spawn("ssh", peerSSHArgs(peer, knownHosts, key), { stdio: ["pipe", "pipe", "pipe"] });
    child = ssh;
    stream = new Duplex({
      read() { ssh.stdout.resume(); },
      write(chunk, encoding, callback) { ssh.stdin.write(chunk, encoding, callback); },
      final(callback) { ssh.stdin.end(callback); },
      destroy(error, callback) { ssh.kill(); callback(error); },
    });
    ssh.stdout.on("data", chunk => { if (!stream!.push(chunk)) ssh.stdout.pause(); });
    ssh.stdout.on("end", () => stream!.push(null));
    ssh.stdout.on("error", error => stream?.destroy(error));
    ssh.stdin.on("error", error => stream?.destroy(error));
    let diagnostic = "";
    child.stderr!.on("data", bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-4096); });
    child.on("error", () => stream?.destroy(new BridgeError(503, "SSH is unavailable.")));
    try {
      return await hookRequest(route, data, { createConnection: () => stream! }, data === undefined ? 15_000 : 65_000);
    } catch (error) {
      if (/Permission denied/i.test(diagnostic)) throw new BridgeError(403, "The remote computer has not enrolled this dispatch key.");
      if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(diagnostic)) throw new BridgeError(403, "The remote SSH host key does not match its pin.");
      if (error instanceof BridgeError) throw error;
      throw new BridgeError(503, "The remote Hook is offline or SSH did not confirm the request.");
    }
  } finally { stream?.destroy(); child?.kill(); await rm(temporary, { recursive: true, force: true }); }
}
