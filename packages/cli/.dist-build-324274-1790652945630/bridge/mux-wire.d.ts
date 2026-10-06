import type { Json } from "./protocol.js";
/** Installed phones require the historical Herdr envelope even for tmux.
 * A typed tmux selector opts into the source kind; the additive descriptor
 * remains accurate in both formats. */
export declare function typedMuxRequest(url: URL): boolean;
export declare function muxReplyForClient(reply: Json, typed: boolean): Json;
/** New clients request /v1/muxes?typed=1. Older Hooks ignore that query,
 * so callers must also accept the legacy Herdr aliases. */
export declare function muxListForClient(muxes: Json[], typed: boolean): Json[];
