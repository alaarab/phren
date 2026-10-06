import { hookRequest } from "./client.js";
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
export declare function isLocalComputer(name: string, names?: readonly string[]): boolean;
export declare function peerHost(peer: HookPeer, request?: typeof peerRequest): DispatchHost;
/** This computer. `server` is the Herdr server its Hook reports first. */
export declare function localHost(server?: string, names?: readonly string[], request?: typeof hookRequest): DispatchHost;
