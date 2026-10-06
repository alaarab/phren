import { z } from "zod";
import { type Json } from "./protocol.js";
/** The phone's own name for one message it composed, kept on every attempt to
 * send it. Optional: a client that sends none gets the old, single-attempt behavior. */
export declare const deliveryIdSchema: z.ZodOptional<z.ZodString>;
/** Types one phone message at most once per delivery id. A dropped
 * connection (the phone left the app, SSH closed before the reply) made the
 * phone offer Retry for a prompt the Hook had already typed, and the retry
 * typed it a second time. The same id again, for the same pane and text:
 *  - while the first attempt runs, waits for it and answers with its reply;
 *  - after it typed anything, answers with the first reply (or its error),
 *    marked `replayed`, and types nothing;
 *  - after it failed before typing (a stale target, a busy agent), runs again.
 * The same id for another pane or other text is refused. */
export declare class PromptOnce {
    private now;
    private attempts;
    constructor(now?: () => number);
    run(id: string | undefined, scope: string, send: (typing: () => void) => Promise<Json>): Promise<Json>;
    private prune;
}
/** What a delivery id is bound to: the pane, its agent and the exact text.
 * Not the conversation: a first message that started one is retried against
 * the new conversation's target and must still find its first attempt.
 * Hashed so the table never holds the prompt. */
export declare function promptScope(target: Json, text: string): string;
