import { type Json } from "./protocol.js";
/** OpenCode's transcript reader, shared with phren-agent's event log: an
 * OpenCode run's own events first, then the three message events that make
 * up the conversation. */
export declare function visibleOpencodeEvent(raw: Json, source: "phren" | "opencode", cwd?: string): Json | undefined;
