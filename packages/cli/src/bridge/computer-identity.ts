import { findPhrenPath } from "../phren-paths.js";
import { listMachines } from "../profile-store.js";
import { localNames } from "./computer-names.js";
import { optionalHookPeers, peerRequest } from "./peers.js";
import { bridgeRoot, object } from "./protocol.js";

/** One real computer. `name` is what dispatch, hand_off and grants accept: the
 * hooks.yaml peer name, or this computer's short hostname. `aliases` are
 * every other name it answers to. */
export interface Computer {
  /** The Hook's computer id, when its Hook answered. */
  id?: string;
  name: string;
  aliases: string[];
  /** The store profile machines.yaml maps its names to. */
  profile?: string;
  local: boolean;
  /** Reachable through a verified connection (this computer, or a hooks.yaml peer). */
  linked: boolean;
  /** Whether a peer's Hook answered just now; unknown when not probed, absent for unlinked. */
  reachable?: boolean;
}

export interface PeerFacts { name: string; address: string; id?: string; names?: readonly string[]; reachable?: boolean }
export interface IdentityFacts {
  local: { id?: string; names: readonly string[] };
  peers: readonly PeerFacts[];
  /** machines.yaml: machine name to profile. */
  machines: Readonly<Record<string, string>>;
}

/** A computer name's first DNS label, lowercased: `Desk`, `desk.local` and
 * `Desk.example.net` are one computer. DHCP and Bonjour add domains to the
 * same machine's name, so full names do not identify a computer. */
export function computerLabel(name: string): string {
  const value = name.trim().toLowerCase();
  // An IPv4 address is one name, not a label and a domain.
  return /^\d+(\.\d+){3}$/.test(value) ? value : value.split(".")[0] ?? "";
}

const MAX_ROWS = 64;
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const namesOf = (row: Computer) => [row.name, ...row.aliases];
const shortestFirst = (a: string, b: string) => a.length - b.length || a.localeCompare(b);

function addAlias(row: Computer, name: string): void {
  if (name.trim() && !namesOf(row).some(known => same(known, name))) row.aliases.push(name);
}

/** Folds what this Hook knows into one row per real computer. A machines.yaml
 * name joins a computer when its first label matches any name that computer
 * has, or when it shares a profile with names already folded into exactly one
 * computer (a profile two computers claim folds nothing). The rest become
 * unlinked rows: names sharing a label or a profile are one computer. */
export function foldComputers(facts: IdentityFacts): Computer[] {
  const localName = facts.local.names.find(name => !name.includes(".")) ?? facts.local.names[0] ?? "local";
  const linked: Computer[] = [{ ...(facts.local.id ? { id: facts.local.id } : {}), name: localName, aliases: [], local: true, linked: true, reachable: true }];
  for (const name of facts.local.names) addAlias(linked[0], name);
  for (const peer of facts.peers) {
    const row: Computer = { ...(peer.id ? { id: peer.id } : {}), name: peer.name, aliases: [], local: false, linked: true,
      ...(peer.reachable === undefined ? {} : { reachable: peer.reachable }) };
    for (const name of [peer.address, ...(peer.names ?? [])]) addAlias(row, name);
    linked.push(row);
  }
  const votes = new Map<Computer, Map<string, number>>();
  const claims = new Map<string, Set<Computer>>();
  const fold = (row: Computer, name: string, profile: string, claim: boolean) => {
    addAlias(row, name);
    votes.set(row, votes.get(row) ?? new Map());
    votes.get(row)!.set(profile, (votes.get(row)!.get(profile) ?? 0) + 1);
    if (claim) claims.set(profile, (claims.get(profile) ?? new Set()).add(row));
  };
  const rest: [string, string][] = [];
  for (const [name, profile] of Object.entries(facts.machines)) {
    const label = computerLabel(name);
    if (!label) continue;
    const row = linked.find(candidate => namesOf(candidate).some(known => computerLabel(known) === label));
    if (row) fold(row, name, profile, true); else rest.push([name, profile]);
  }
  const unfolded: [string, string][] = [];
  for (const [name, profile] of rest) {
    const claimed = claims.get(profile);
    if (claimed?.size === 1) fold([...claimed][0], name, profile, false); else unfolded.push([name, profile]);
  }
  for (const [row, counts] of votes) row.profile = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];

  const groups: { names: string[]; profiles: Set<string> }[] = [];
  for (const [name, profile] of unfolded) {
    const label = computerLabel(name);
    const hits = groups.filter(group => group.profiles.has(profile) || group.names.some(known => computerLabel(known) === label));
    const target = hits[0] ?? { names: [], profiles: new Set<string>() };
    if (!hits.length) groups.push(target);
    for (const other of hits.slice(1)) {
      target.names.push(...other.names);
      other.profiles.forEach(item => target.profiles.add(item));
      groups.splice(groups.indexOf(other), 1);
    }
    target.names.push(name); target.profiles.add(profile);
  }
  const unlinked: Computer[] = groups.map(group => {
    const [name, ...aliases] = [...group.names].sort(shortestFirst);
    const profile = facts.machines[name];
    return { name, aliases, ...(profile ? { profile } : {}), local: false, linked: false };
  });
  const byName = (a: Computer, b: Computer) => a.name.localeCompare(b.name);
  return [linked[0], ...linked.slice(1).sort(byName), ...unlinked.sort(byName)].slice(0, MAX_ROWS);
}

/** The computer a name refers to: an exact name or alias, else the same first
 * label (case-insensitive), so `Desk.local` finds `Desk`. `local` is this computer. */
export function resolveComputer(computers: readonly Computer[], name: string): Computer | undefined {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return undefined;
  const exact = computers.find(row => namesOf(row).some(known => same(known, wanted)));
  if (exact) return exact;
  if (wanted === "local" || wanted === "localhost") return computers.find(row => row.local);
  const label = computerLabel(wanted);
  return computers.find(row => namesOf(row).some(known => computerLabel(known) === label));
}

/** What each peer's Hook last said about itself, so grant matching and
 * listings know its hostname without an SSH round trip of their own. */
const peerHealth = new Map<string, { id?: string; names: string[] }>();

const PROBE_MS = 8_000;

export interface ReadOptions {
  /** Ask each peer's Hook for its identity (parallel, short timeout) and report `reachable`. */
  probe?: boolean;
  local?: { id?: string; names?: readonly string[] };
  store?: string | null;
  root?: string;
}

/** Never throws: a missing hooks.yaml or machines.yaml only means fewer rows. */
export async function readComputers(options: ReadOptions = {}): Promise<{ computers: Computer[]; peerError?: string }> {
  const { peers, peerError } = await optionalHookPeers(options.root ?? bridgeRoot()).catch(() => ({ peers: [], peerError: undefined }));
  const facts: PeerFacts[] = await Promise.all(peers.map(async peer => {
    let reachable: boolean | undefined;
    if (options.probe) {
      let timer: NodeJS.Timeout | undefined;
      try {
        const health = await Promise.race([peerRequest(peer, "/v1/health", undefined, PROBE_MS),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), PROBE_MS); timer.unref(); })]);
        const computer = object(health.computer);
        const names = [computer.name, ...(Array.isArray(computer.aliases) ? computer.aliases : [])].filter((name): name is string => typeof name === "string");
        peerHealth.set(peer.name, { ...(typeof computer.id === "string" ? { id: computer.id } : {}), names });
        reachable = true;
      } catch { reachable = false; } finally { clearTimeout(timer); }
    }
    const seen = peerHealth.get(peer.name);
    return { name: peer.name, address: peer.address, ...(seen?.id ? { id: seen.id } : {}), names: seen?.names ?? [],
      ...(reachable === undefined ? {} : { reachable }) };
  }));
  const store = options.store !== undefined ? options.store : findPhrenPath();
  const machines = store ? listMachines(store) : undefined;
  const computers = foldComputers({ local: { ...(options.local?.id ? { id: options.local.id } : {}), names: options.local?.names ?? localNames() },
    peers: facts, machines: machines?.ok ? machines.data : {} });
  return { computers, ...(peerError ? { peerError } : {}) };
}
