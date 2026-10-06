import { z } from "zod";
import { type Provider } from "./protocol.js";
/** Longest final reply kept from a Stop payload, in UTF-8 bytes (the receipt's limit). */
export declare const TURN_REPLY_LIMIT = 4000;
declare const turnRecordSchema: z.ZodObject<{
    terminal: z.ZodString;
    source: z.ZodEnum<{
        claude: "claude";
        codex: "codex";
        copilot: "copilot";
        opencode: "opencode";
        phren: "phren";
    }>;
    session: z.ZodUnion<readonly [z.ZodString, z.ZodString]>;
    seq: z.ZodNumber;
    dispatch: z.ZodOptional<z.ZodString>;
    startedAt: z.ZodOptional<z.ZodString>;
    prompt: z.ZodOptional<z.ZodObject<{
        seq: z.ZodNumber;
        at: z.ZodString;
    }, z.core.$strict>>;
    stop: z.ZodOptional<z.ZodObject<{
        seq: z.ZodNumber;
        at: z.ZodString;
        background: z.ZodOptional<z.ZodNumber>;
        reply: z.ZodOptional<z.ZodString>;
        truncated: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    at: z.ZodString;
}, z.core.$strict>;
export type TurnRecord = z.infer<typeof turnRecordSchema>;
export interface TurnEvent {
    event: string;
    terminal: string;
    source: Provider;
    session: string;
    /** SessionStart / UserPromptSubmit: the dispatch id the worker's hook named. */
    dispatch?: string;
    /** Stop only: the harness's count of in-flight background tasks, when it reports one. */
    background?: number;
    /** Stop only: the harness's last assistant message, when it reports one. */
    reply?: string;
    at?: number;
}
export declare const turnPath: (server: string, pane: string) => string;
/** `value` cut to at most `limit` UTF-8 bytes on a character boundary. */
export declare function truncateUtf8(value: string, limit?: number): {
    text: string;
    truncated: boolean;
};
/** The record after one lifecycle event; undefined for events that say nothing about turns.
 * Another conversation or terminal in the pane starts a fresh record. */
export declare function nextTurn(previous: TurnRecord | undefined, event: TurnEvent): TurnRecord | undefined;
export type TurnPhase = {
    phase: "unprompted";
} | {
    phase: "working";
    since: string;
} | {
    phase: "ended";
    at: string;
    background?: number;
    reply?: string;
    truncated?: boolean;
};
/** Where the recorded conversation is: no prompt yet, a prompt with no Stop
 * after it, or a turn that stopped. A Stop with no recorded prompt (hooks
 * installed mid-conversation) still ended a turn. */
export declare function turnPhase(record: TurnRecord): TurnPhase;
/** Record one lifecycle event for `pane`. Writes run one at a time, so a Stop
 * and the next prompt arriving together keep their order. */
export declare function noteTurn(server: string, pane: string, event: TurnEvent): Promise<TurnRecord | undefined>;
/** The recorded turns of `pane`'s latest conversation, if its hooks reported any. */
export declare function readTurn(server: string, pane: string): Promise<TurnRecord | undefined>;
/** OpenCode's turns for a pane running `pids`, from the stamps phren's OpenCode
 * plugin writes on session.status busy / session.idle; undefined for an older
 * plugin that writes none. `terminal` is the pane's, since the PIDs are. */
export declare function opencodeTurn(pids: number[], terminal: string): Promise<TurnRecord | undefined>;
export {};
