import { type Json } from "./protocol.js";
/** Copilot's transcript reader: public message, tool and usage events, and
 * the reasoning summary Copilot itself prints under "Thought for Ns". Its
 * encrypted and opaque reasoning stays out. */
export declare function visibleCopilotEvent(raw: Json): Json | undefined;
