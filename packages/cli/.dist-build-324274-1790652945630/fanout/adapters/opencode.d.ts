import type { Adapter } from "./types.js";
/** `opencode run` rejects every permission ask itself, so a worker runs under
 * `opencode serve` and the launcher drives its session over HTTP. */
export declare const opencode: Adapter;
