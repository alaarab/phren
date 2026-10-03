import { createHash } from "node:crypto";
import { BridgeError } from "../protocol.js";

/** The worker owns these receipts across Hook restarts. Capacity refusal occurs before submitting. */
export class TurnSubmissions {
  private attempts = new Map<string, { hash: string; result: Promise<{ turnId: string; acknowledged: boolean }>; turnId?: string; state: "queued" | "delivered" | "uncertain" }>();
  async run(id: string, text: string, send: () => Promise<{ turnId: string; acknowledged: boolean }>) {
    const hash = createHash("sha256").update(text).digest("hex"), prior = this.attempts.get(id);
    if (prior) { if (prior.hash !== hash) throw new BridgeError(409, "This delivery id belongs to different text."); return prior.result; }
    if (this.attempts.size >= 1024) throw new BridgeError(429, "This worker's delivery receipt capacity is full; no turn was submitted.");
    const attempt = { hash, result: Promise.resolve().then(send), state: "uncertain" as "queued" | "delivered" | "uncertain", turnId: undefined as string | undefined };
    this.attempts.set(id, attempt);
    void attempt.result.then(result => { attempt.turnId = result.turnId; attempt.state = result.acknowledged ? "delivered" : "queued"; }, () => {});
    return attempt.result;
  }
  status(id: string) { const row = this.attempts.get(id); return row ? { state: row.state, ...(row.turnId ? { turnId: row.turnId } : {}) } : { state: "unknown" }; }
}
