import { type HookPeer } from "./peers.js";
import { type Json } from "./protocol.js";
/**
 * One conductor per connected group. A group is this computer and the peers
 * in its hooks.yaml; `phren bridge link` links a new computer with every
 * member, so one hop reaches the whole group. Each peer answers
 * `GET /v1/conductor` with its own live conductor, if any.
 */
export interface GroupConductor {
    /** A live conductor on a linked peer. */
    found?: {
        computer: string;
        target?: Json;
    };
    /** Peers that could not say, so a conductor there cannot be ruled out. */
    unchecked: {
        computer: string;
        error: string;
        code?: string;
    }[];
}
type Ask = (peer: HookPeer, route: string, data?: Json, timeout?: number) => Promise<Json>;
export declare function groupConductor(peers: readonly HookPeer[], ask?: Ask): Promise<GroupConductor>;
export {};
