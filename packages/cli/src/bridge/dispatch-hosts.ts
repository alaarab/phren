import { hookRequest } from "./client.js";
import { localNames } from "./computer-names.js";
import { peerRequest, type HookPeer } from "./peers.js";
import type { Json } from "./protocol.js";

/**
 * Where a dispatch can be placed: an enrolled peer reached over its pinned SSH
 * pipe, or this computer, reached through its own Hook's socket. The same
 * Hook routes (capacity, launch, panes, prompt, workers) serve both, so this
 * computer needs no hooks.yaml entry and no SSH enrollment of its own.
 */
export interface DispatchHost {
  name: string;
  server: string;
  local: boolean;
  /** Every name this computer answers to (local hosts only). */
  names?: readonly string[];
  request(route: string, data?: Json, timeout?: number): Promise<Json>;
}

/** This computer's own names: its hostname, the hostname's first label and
 * its Bonjour name, plus "local". */
export function isLocalComputer(name: string, names: readonly string[] = localNames()): boolean {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return false;
  if (wanted === "local" || wanted === "localhost") return true;
  const first = wanted.split(".")[0];
  return names.some(own => {
    const value = own.toLowerCase();
    return value === wanted || value.split(".")[0] === first;
  });
}

export function peerHost(peer: HookPeer, request: typeof peerRequest = peerRequest): DispatchHost {
  return { name: peer.name, server: peer.server, local: false, request: (route, data, timeout) => request(peer, route, data, timeout) };
}

/** This computer. `server` is the Herdr server its Hook reports first. */
export function localHost(server = "default", names: readonly string[] = localNames(), request: typeof hookRequest = hookRequest): DispatchHost {
  const name = names.find(value => !value.includes(".")) ?? names[0] ?? "local";
  return { name, server, local: true, names, request: (route, data) => request(route, data) };
}
