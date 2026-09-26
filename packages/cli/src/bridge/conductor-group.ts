import { disabledHint } from "../modules/registry.js";
import { peerRequest, type HookPeer } from "./peers.js";
import { BridgeError, errorCode, object, type Json } from "./protocol.js";

/**
 * One conductor per connected group. A group is this computer and the peers
 * in its hooks.yaml; `phren bridge link` links a new computer with every
 * member, so one hop reaches the whole group. Each peer answers
 * `GET /v1/conductor` with its own live conductor, if any.
 */
export interface GroupConductor {
  /** A live conductor on a linked peer. */
  found?: { computer: string; target?: Json };
  /** Peers that could not say, so a conductor there cannot be ruled out. */
  unchecked: { computer: string; error: string; code?: string }[];
}

type Ask = (peer: HookPeer, route: string, data?: Json, timeout?: number) => Promise<Json>;

export async function groupConductor(peers: readonly HookPeer[], ask: Ask = peerRequest): Promise<GroupConductor> {
  const answers = await Promise.all(peers.map(async peer => {
    try {
      const conductor = (await ask(peer, "/v1/conductor", undefined, 8_000)).conductor;
      return { peer, conductor: conductor && typeof conductor === "object" ? object(conductor) : undefined };
    } catch (error) {
      // With its conductor module off, a peer cannot run a conductor. An
      // older Hook has no /v1/conductor and cannot rule one out.
      if (error instanceof BridgeError && error.status === 404 && error.message === disabledHint("conductor")) return { peer };
      const message = error instanceof BridgeError && error.status === 404 ? "Its Hook is too old to report a conductor."
        : error instanceof Error ? error.message : "Unreachable.";
      const code = errorCode(error);
      return { peer, error: message, ...(code ? { code } : {}) };
    }
  }));
  const hit = answers.find(answer => answer.conductor);
  return {
    ...(hit ? { found: { computer: hit.peer.name, ...(hit.conductor!.target ? { target: object(hit.conductor!.target) } : {}) } } : {}),
    unchecked: answers.flatMap(answer => "error" in answer && answer.error ? [{ computer: answer.peer.name, error: answer.error, ...("code" in answer && answer.code ? { code: answer.code } : {}) }] : []),
  };
}
