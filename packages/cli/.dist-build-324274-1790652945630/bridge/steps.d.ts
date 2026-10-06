import { type Json, type Provider } from "./protocol.js";
export declare function currentStep(source: Provider, session: string): Promise<string | undefined>;
/** The model the agent's newest answer ran on, for the lock screen's row
 * label. Codex names it once per turn; Claude stamps it on every assistant
 * row, and its raw id reads as the family and version the phone shows. */
export declare function currentModel(source: Provider, session: string): Promise<string | undefined>;
/** The model a visible row names, in the shape the chat header reads. */
export declare function modelOf(raw: Json, source: Provider): string | undefined;
/** One row's verdict, newest first: a tool call names the step; an
 * assistant text means a reply is being written; a person's turn means the
 * agent is reading it. Tool results and bookkeeping say nothing. */
export declare function stepOf(raw: Json, source: Provider): string | undefined;
export declare function describe(tool: string, args: unknown): string;
