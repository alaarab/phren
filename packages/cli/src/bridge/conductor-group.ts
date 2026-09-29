import { hostname } from "node:os";
import { disabledHint } from "../modules/registry.js";
import { ownHostKey } from "./health.js";
import { computerLabel, type Computer } from "./computer-identity.js";
import { peerRequest, type HookPeer } from "./peers.js";
import { BridgeError, errorCode, object, type Json } from "./protocol.js";
import type { SetName } from "./conductor-role.js";

/**
 * Linked computer sets (docs/conductor-sets.md). A link runs both ways when
 * each computer's hooks.yaml lists the other; a set is the computers joined by
 * such links. This Hook sees its set from itself and one hop: each peer
 * answers `GET /v1/conductor` with its live conductor, its own peers, whether
 * it lists the caller back and the set name it holds. A set has one conductor.
 */

type Ask = (peer: HookPeer, route: string, data?: Json, timeout?: number) => Promise<Json>;

/** What this computer tells a peer about itself, so the peer can say whether it links back. */
export interface Caller { name: string; hostKey?: string }

export async function localCaller(): Promise<Caller> {
  const hostKey = await ownHostKey();
  return { name: hostname(), ...(hostKey ? { hostKey } : {}) };
}
export function callerQuery(caller: Caller): string {
  return new URLSearchParams({ name: caller.name, ...(caller.hostKey ? { hostKey: caller.hostKey } : {}) }).toString();
}

/** One peer's answer to `GET /v1/conductor`, or why it gave none. */
export type PeerAnswer = { peer: HookPeer } & ({
  ok: true; id?: string; names: string[]; conductor?: Json;
  /** Its hooks.yaml names; absent from a Hook older than sets. */
  peers?: string[];
  /** Whether it lists this computer back; absent when its Hook cannot say. */
  knowsCaller?: boolean;
  set?: SetName;
} | {
  ok: false; error: string; code?: string;
  /** Its conductor module is off, so it cannot run a conductor. */
  disabled?: boolean;
});

export async function askPeers(peers: readonly HookPeer[], caller: Caller, ask: Ask = peerRequest): Promise<PeerAnswer[]> {
  return Promise.all(peers.map(async (peer): Promise<PeerAnswer> => {
    try {
      const answer = await ask(peer, `/v1/conductor?${callerQuery(caller)}`, undefined, 8_000);
      const computer = object(answer.computer);
      const conductor = answer.conductor && typeof answer.conductor === "object" ? object(answer.conductor) : undefined;
      const set = object(answer.set);
      return { peer, ok: true, ...(typeof computer.id === "string" ? { id: computer.id } : {}),
        names: [computer.name, ...(Array.isArray(computer.aliases) ? computer.aliases : [])].filter((name): name is string => typeof name === "string"),
        ...(conductor ? { conductor } : {}),
        ...(Array.isArray(answer.peers) ? { peers: answer.peers.filter((name): name is string => typeof name === "string").slice(0, 32) } : {}),
        ...(typeof answer.knowsCaller === "boolean" ? { knowsCaller: answer.knowsCaller } : {}),
        ...(typeof set.namedAt === "string" && (typeof set.name === "string" || set.name === null) ? { set: { name: set.name as string | null, namedAt: set.namedAt } } : {}) };
    } catch (error) {
      // With its conductor module off, a peer cannot run a conductor. An
      // older Hook has no /v1/conductor and cannot rule one out.
      if (error instanceof BridgeError && error.status === 404 && error.message === disabledHint("conductor")) return { peer, ok: false, error: "Its conductor module is off.", disabled: true };
      const message = error instanceof BridgeError && error.status === 404 ? "Its Hook is too old to report a conductor."
        : error instanceof Error ? error.message : "Unreachable.";
      const code = errorCode(error);
      return { peer, ok: false, error: message, ...(code ? { code } : {}) };
    }
  }));
}

/** A peer outside this computer's set: it answered and does not list this computer. */
const oneWay = (answer: PeerAnswer) => answer.ok && answer.knowsCaller === false;

export interface GroupConductor {
  /** A live conductor on a member of this computer's set. */
  found?: { computer: string; target?: Json };
  /** Members that could not say, so a conductor there cannot be ruled out. */
  unchecked: { computer: string; error: string; code?: string }[];
}

/** The names members report that are neither this computer nor one of its
 * peers: computers in the set that this Hook cannot ask directly. */
export function indirectMembers(answers: readonly PeerAnswer[], localNames: readonly string[]): string[] {
  const known = new Set([...localNames, ...answers.flatMap(answer => [answer.peer.name, answer.peer.address, ...(answer.ok ? answer.names : [])])].map(computerLabel));
  const found = new Map<string, string>();
  for (const answer of answers) {
    if (!answer.ok || oneWay(answer)) continue;
    for (const name of answer.peers ?? []) if (!known.has(computerLabel(name)) && !found.has(computerLabel(name))) found.set(computerLabel(name), name);
  }
  return [...found.values()].sort((a, b) => a.localeCompare(b));
}

export const linkHint = (name: string) => `Link it with phren bridge link ${name}.`;
export const oneWayHint = (name: string) => `${name} does not link back. Run phren bridge link ${name}.`;

/** One conductor per set: a live conductor on any member, and the members that could not say. */
export function setConductor(answers: readonly PeerAnswer[], localNames: readonly string[]): GroupConductor {
  const members = answers.filter(answer => !oneWay(answer));
  const hit = members.find(answer => answer.ok && answer.conductor);
  const target = hit?.ok ? object(hit.conductor).target : undefined;
  return {
    ...(hit ? { found: { computer: hit.peer.name, ...(target ? { target: object(target) } : {}) } } : {}),
    unchecked: [
      ...members.flatMap(answer => !answer.ok && !answer.disabled ? [{ computer: answer.peer.name, error: answer.error, ...(answer.code ? { code: answer.code } : {}) }] : []),
      ...indirectMembers(answers, localNames).map(computer => ({ computer, error: `Not linked with this computer, so it could not be asked. ${linkHint(computer)}` })),
    ],
  };
}

export async function groupConductor(peers: readonly HookPeer[], localNames: readonly string[], ask: Ask = peerRequest, caller?: Caller): Promise<GroupConductor> {
  return setConductor(await askPeers(peers, caller ?? await localCaller(), ask), localNames);
}

export interface SetComputer {
  name: string;
  id?: string;
  local?: true;
  /** Whether its Hook answered just now; absent when this Hook cannot ask it. */
  reachable?: boolean;
  link: "self" | "two-way" | "one-way" | "indirect" | "unknown";
  conductor?: Json;
  error?: string;
  code?: string;
  hint?: string;
}
export interface ComputerSet {
  id: string;
  name?: string;
  namedAt?: string;
  /** This computer's own set. */
  local: boolean;
  computers: SetComputer[];
  /** The set's conductor; with `conductors` above 1, the first of several. */
  conductor?: { computer: string; target?: Json };
  conductors: number;
}

const newest = (names: (SetName | undefined)[]) => names.filter((name): name is SetName => !!name)
  .sort((a, b) => Date.parse(b.namedAt) - Date.parse(a.namedAt))[0];
const setId = (ids: (string | undefined)[], fallback: string) => {
  const known = ids.filter((value): value is string => !!value).sort();
  return `set:${known[0] ?? fallback.toLowerCase()}`;
};
function conductorOf(entries: { computer: string; conductor?: Json }[]): Pick<ComputerSet, "conductor" | "conductors"> {
  const running = entries.filter(entry => entry.conductor);
  const first = running[0];
  const target = first ? object(first.conductor).target : undefined;
  return { ...(first ? { conductor: { computer: first.computer, ...(target ? { target: object(target) } : {}) } } : {}), conductors: running.length };
}

/**
 * Every set this Hook can see: its own (itself, its two-way and not yet known
 * peers, and computers they link that this Hook does not), then one set per
 * one-way peer. `unlinked` are computers the store knows with no link here.
 */
export function buildSets(input: {
  local: { name: string; id?: string; conductor?: Json; set?: SetName; names: readonly string[] };
  answers: readonly PeerAnswer[];
  computers: readonly Computer[];
}): { sets: ComputerSet[]; unlinked: Computer[] } {
  const { local, answers } = input;
  const members = answers.filter(answer => !oneWay(answer));
  const computers: SetComputer[] = [{ name: local.name, ...(local.id ? { id: local.id } : {}), local: true, reachable: true, link: "self",
    ...(local.conductor ? { conductor: local.conductor } : {}) }];
  for (const answer of members) {
    if (answer.ok) computers.push({ name: answer.peer.name, ...(answer.id ? { id: answer.id } : {}), reachable: true,
      link: answer.knowsCaller === true ? "two-way" : "unknown", ...(answer.conductor ? { conductor: answer.conductor } : {}),
      ...(answer.knowsCaller === undefined ? { hint: "Its Hook cannot say whether it links back. Update it with phren bridge update." } : {}) });
    else computers.push({ name: answer.peer.name, reachable: !!answer.disabled, link: "unknown", error: answer.error, ...(answer.code ? { code: answer.code } : {}) });
  }
  const indirect = indirectMembers(answers, local.names);
  for (const name of indirect) computers.push({ name, link: "indirect", hint: linkHint(name) });
  const name = newest([local.set, ...members.map(answer => answer.ok ? answer.set : undefined)]);
  const own: ComputerSet = { id: setId([local.id, ...members.map(answer => answer.ok ? answer.id : undefined)], local.name),
    ...(name?.name ? { name: name.name, namedAt: name.namedAt } : {}), local: true, computers,
    ...conductorOf([{ computer: local.name, conductor: local.conductor }, ...members.map(answer => ({ computer: answer.peer.name, conductor: answer.ok ? answer.conductor : undefined }))]) };
  const others: ComputerSet[] = answers.flatMap(answer => {
    if (!answer.ok || !oneWay(answer)) return [];
    return [{ id: setId([answer.id], answer.peer.name), ...(answer.set?.name ? { name: answer.set.name, namedAt: answer.set.namedAt } : {}), local: false,
      computers: [{ name: answer.peer.name, ...(answer.id ? { id: answer.id } : {}), reachable: true, link: "one-way" as const,
        ...(answer.conductor ? { conductor: answer.conductor } : {}), hint: oneWayHint(answer.peer.name) }],
      ...conductorOf([{ computer: answer.peer.name, conductor: answer.conductor }]) }];
  });
  const indirectLabels = new Set(indirect.map(computerLabel));
  const unlinked = input.computers.filter(row => !row.linked && ![row.name, ...row.aliases].some(known => indirectLabels.has(computerLabel(known))));
  return { sets: [own, ...others], unlinked };
}
