import { type Json } from "./protocol.js";
import type { TerminalPane, TerminalProvider } from "./terminal.js";
/** A Herdr snapshot's panes in the provider's shape; Herdr's agent report becomes hints. */
export declare function herdrPanes(server: string, s: Json): TerminalPane[];
export declare const herdrTerminal: TerminalProvider;
