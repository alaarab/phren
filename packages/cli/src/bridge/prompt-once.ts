import { createHash } from "node:crypto";
import { z } from "zod";
import { BridgeError, type Json } from "./protocol.js";

/** The phone's own name for one message it composed, kept on every attempt to
 * send it. Optional: a client that sends none gets the old, single-attempt behavior. */
export const deliveryIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional();

type Outcome = { result: Json } | { error: unknown };
interface Attempt { scope: string; typed: boolean; done: Promise<Outcome>; at: number }

const REMEMBER_MS = 600_000, MAX_ATTEMPTS = 512;

/** Types one phone message at most once per delivery id. A dropped
 * connection (the phone left the app, SSH closed before the reply) made the
 * phone offer Retry for a prompt the Hook had already typed, and the retry
 * typed it a second time. The same id again, for the same pane and text:
 *  - while the first attempt runs, waits for it and answers with its reply;
 *  - after it typed anything, answers with the first reply (or its error),
 *    marked `replayed`, and types nothing;
 *  - after it failed before typing (a stale target, a busy agent), runs again.
 * The same id for another pane or other text is refused. */
export class PromptOnce {
  private attempts = new Map<string, Attempt>();
  constructor(private now: () => number = Date.now) {}

  async run(id: string | undefined, scope: string, send: (typing: () => void) => Promise<Json>): Promise<Json> {
    if (!id) return send(() => {});
    this.prune();
    for (let prior = this.attempts.get(id); prior; prior = this.attempts.get(id)) {
      if (prior.scope !== scope) throw new BridgeError(409, "This message id was already used for a different message.");
      const outcome = await prior.done;
      // One that failed before typing was removed; look again (nothing, or a newer attempt).
      if ("error" in outcome && !prior.typed) continue;
      if ("error" in outcome) throw outcome.error;
      return { ...outcome.result, replayed: true };
    }
    let finish!: (outcome: Outcome) => void;
    const attempt: Attempt = { scope, typed: false, done: new Promise(resolve => { finish = resolve; }), at: this.now() };
    this.attempts.set(id, attempt);
    try {
      const result = await send(() => { attempt.typed = true; });
      finish({ result });
      return result;
    } catch (error) {
      if (!attempt.typed && this.attempts.get(id) === attempt) this.attempts.delete(id);
      finish({ error });
      throw error;
    }
  }

  private prune() {
    const cutoff = this.now() - REMEMBER_MS;
    for (const [id, attempt] of this.attempts) if (attempt.at < cutoff) this.attempts.delete(id);
    while (this.attempts.size >= MAX_ATTEMPTS) this.attempts.delete(this.attempts.keys().next().value!);
  }
}

/** What a delivery id is bound to: the pane, its agent and the exact text.
 * Not the conversation: a first message that started one is retried against
 * the new conversation's target and must still find its first attempt.
 * Hashed so the table never holds the prompt. */
export function promptScope(target: Json, text: string): string {
  const { server, workspace, tab, pane, source } = target;
  return createHash("sha256").update(JSON.stringify([server, workspace, tab, pane, source, text])).digest("hex");
}
