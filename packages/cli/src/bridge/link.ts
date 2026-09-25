import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir, hostname, userInfo } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { listMachines } from "../profile-store.js";
import { findPhrenPath } from "../phren-paths.js";
import { computerLabel } from "./hand-off.js";
import { localNames } from "./computer-names.js";
import { acceptComputer, computerName, enrollComputer, publicComputerKey } from "./computers.js";
import { addHookPeer, optionalHookPeers, peerRequest, type HookPeer } from "./peers.js";
import { BridgeError, bridgeRoot, object } from "./protocol.js";

/**
 * Computers the owner already reaches over plain ssh that run phren, and
 * linking one in a single explicit step. Discovery only reports; nothing is
 * linked until the owner runs `phren bridge link <host>`.
 */

const exec = promisify(execFile);
// A non-login ssh shell often lacks Homebrew's node (macOS) or ~/.local/bin.
const REMOTE_PATH = 'PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"';
const GIT_HOSTS = /(^|\.)(github\.com|gitlab\.com|bitbucket\.org)$/i;

/** Concrete Host aliases from an ssh config: no patterns, no Git hosting services. */
export function sshConfigHosts(text: string): string[] {
  const hosts: string[] = [];
  let block: string[] = [], skip = false;
  const flush = () => { if (!skip) hosts.push(...block); block = []; skip = false; };
  for (const raw of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z]+)(?:\s*=\s*|\s+)(.+?)\s*$/.exec(raw.replace(/\s#.*$|^\s*#.*$/, ""));
    if (!match) continue;
    const [key, value] = [match[1].toLowerCase(), match[2]];
    if (key === "host" || key === "match") {
      flush();
      if (key === "host") block = value.split(/\s+/).filter(alias => !/[*?!]/.test(alias));
    } else if (key === "hostname" && GIT_HOSTS.test(value)) skip = true;
  }
  flush();
  return [...new Set(hosts.filter(alias => !GIT_HOSTS.test(alias)))];
}

async function ssh(host: string, command: string, input?: string, timeout = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "--", host, command],
      { timeout, maxBuffer: 1_048_576 }, (error, stdout, stderr) => {
        if (error) reject(new BridgeError(503, `ssh ${host}: ${(stderr || error.message).split("\n").find(Boolean)?.slice(0, 200) ?? "failed"}`));
        else resolve(stdout);
      });
    child.stdin?.end(input ?? "");
  });
}

export interface ReachableComputer { host: string; computerId: string; user: string; client?: string }

/** What a host reports over the owner's own ssh login: its Hook's computer id
 * (present once Phren Hook is installed), login user and this computer's
 * address as that host sees it. */
async function probe(host: string): Promise<ReachableComputer | undefined> {
  const out = await ssh(host, `printf 'id=%s\\nuser=%s\\nclient=%s\\n' "$(cat ~/.local/share/phren/bridge/computer-id 2>/dev/null)" "$(id -un)" "\${SSH_CONNECTION%% *}"`, undefined, 12_000);
  const field = (name: string) => new RegExp(`^${name}=(.*)$`, "m").exec(out)?.[1]?.trim() || undefined;
  const computerId = field("id");
  return computerId ? { host, computerId, user: field("user") ?? "", client: field("client") } : undefined;
}

/** Hosts from ~/.ssh/config and the store's machines.yaml that answer over ssh,
 * run Phren Hook and are not this computer or an already linked peer. */
export async function discoverComputers(options: { sshConfig?: string; store?: string | null } = {}): Promise<{ reachable: ReachableComputer[]; checked: string[] }> {
  const config = options.sshConfig ?? await readFile(path.join(homedir(), ".ssh", "config"), "utf8").catch(() => "");
  const store = options.store !== undefined ? options.store : findPhrenPath();
  const machines = store ? listMachines(store) : undefined;
  const { peers } = await optionalHookPeers();
  const own = (await readFile(path.join(bridgeRoot(), "computer-id"), "utf8").catch(() => "")).trim();
  const known = new Set([...localNames(), ...peers.flatMap(peer => [peer.name, peer.address])].map(computerLabel));
  const candidates = [...new Set([...sshConfigHosts(config), ...(machines?.ok ? Object.keys(machines.data) : [])])]
    .filter(host => !known.has(computerLabel(host))).slice(0, 32);
  // A linked peer registered under another name is still linked: match it by its Hook's computer id.
  const [found, peerIds] = await Promise.all([
    Promise.all(candidates.map(host => probe(host).catch(() => undefined))),
    Promise.all(peers.map(peer => peerRequest(peer, "/v1/health").then(health => object(health.computer).id, () => undefined))),
  ]);
  const seen = new Set([own, ...peerIds.filter((id): id is string => typeof id === "string")]);
  const reachable = found.filter((item): item is ReachableComputer => {
    if (!item || seen.has(item.computerId)) return false;
    seen.add(item.computerId);
    return true;
  });
  return { reachable, checked: candidates };
}

function slugName(value: string): string {
  const label = computerLabel(value).replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^[^A-Za-z0-9_]+/, "") || "computer";
  return computerName.parse(label.slice(0, 100));
}

export interface LinkResult { name: string; as: string; local: { added: boolean }; remote: { added: boolean; reachable: boolean; error?: string }; reachable: boolean; error?: string }

/**
 * Links this computer and `host` in both directions over the owner's existing
 * ssh login: each side's dispatch key is enrolled on the other, and each
 * side's ed25519 host key is read over that login (never keyscanned) and
 * pinned in the other's hooks.yaml. Both sides then check the link.
 */
export async function linkComputer(host: string, options: { name?: string; as?: string; backAddress?: string } = {}): Promise<LinkResult> {
  const remote = await probe(host);
  if (!remote) throw new BridgeError(409, `${host} answers over ssh but Phren Hook is not installed there. Run phren bridge install on it first.`);
  const own = (await readFile(path.join(bridgeRoot(), "computer-id"), "utf8").catch(() => "")).trim();
  if (remote.computerId === own) throw new BridgeError(409, `${host} is this computer.`);
  const name = computerName.parse(options.name ?? slugName(host));
  const as = computerName.parse(options.as ?? slugName(hostname()));
  const backAddress = options.backAddress ?? remote.client;
  if (!backAddress) throw new BridgeError(409, `${host} did not report this computer's address; pass --back-address.`);
  // The address the Hook dials skips ~/.ssh/config, so resolve the alias the way ssh does.
  const resolved = Object.fromEntries((await exec("ssh", ["-G", "--", host], { timeout: 5_000 })).stdout.split("\n")
    .map(line => line.split(" ")).filter(parts => parts.length >= 2).map(([key, ...rest]) => [key, rest.join(" ")]));
  const remoteHostKey = publicComputerKey((await ssh(host, "cat /etc/ssh/ssh_host_ed25519_key.pub")).trim().split(/\s+/).slice(0, 2).join(" "));
  const localHostKey = publicComputerKey((await readFile("/etc/ssh/ssh_host_ed25519_key.pub", "utf8")).trim().split(/\s+/).slice(0, 2).join(" "));

  const remoteLine = (await ssh(host, `${REMOTE_PATH} phren bridge enroll-computer ${name}`)).trim();
  await ssh(host, `f=$(mktemp) && cat > "$f" && ${REMOTE_PATH} phren bridge enroll-computer ${as} --accept "$f"; s=$?; rm -f "$f"; exit $s`, await enrollComputer(as));
  await acceptComputer(name, remoteLine);

  const peer: HookPeer = { name, address: String(resolved.hostname || host), username: remote.user || String(resolved.user), port: Number(resolved.port) || 22, server: "default", hostKey: remoteHostKey };
  const local = await addHookPeer(peer);
  const back = { name: as, address: backAddress, username: userInfo().username, port: 22, server: "default", hostKey: localHostKey };
  const answer = JSON.parse(await ssh(host, `${REMOTE_PATH} phren bridge add-peer`, JSON.stringify(back), 45_000).catch((error: Error) => {
    if (/Usage: phren bridge/.test(error.message)) throw new BridgeError(409, `phren on ${host} is too old to finish linking. Update it there and run this again; the keys already exchanged are reused.`);
    throw error;
  }));
  const reached = await peerRequest(peer, "/v1/health").then(() => undefined, (error: Error) => error.message);
  return { name, as, local: { added: local.added }, remote: { added: !!answer.added, reachable: !!answer.reachable, ...(answer.error ? { error: String(answer.error) } : {}) },
    reachable: !reached, ...(reached ? { error: reached } : {}) };
}

/** The receiving half of a link: pin the caller in hooks.yaml, then dial it back. */
export async function addPeerFromLink(input: string): Promise<{ added: boolean; reachable: boolean; error?: string }> {
  const { added, peer } = await addHookPeer(JSON.parse(input));
  const error = await peerRequest(peer, "/v1/health").then(() => undefined, (failure: Error) => failure.message);
  return { added, reachable: !error, ...(error ? { error } : {}) };
}
