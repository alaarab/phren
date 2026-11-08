import { setTimeout as sleepTimer } from "node:timers/promises";
import { hookRequest } from "./client.js";
import type { Json } from "./protocol.js";

/**
 * `phren dispatch wait`: follow one local dispatch to its end. It peeks at the
 * Hook's returns (never taking them), filters to this dispatch, and reads the
 * worker's live state to tell a gone pane from one still working. The output
 * is NDJSON: one line per state change, then one final line. Only the final
 * dispatch's own return is acknowledged, so a conductor's returns on the same
 * Hook stay unread.
 */

/** How long an id the Hook does not know gets before it is "unknown dispatch". */
export const WAIT_GRACE_MS = 30_000;
/** Continuous Hook unavailability before the wait ends failed. */
export const WAIT_UNAVAILABLE_MS = 5 * 60_000;
/** Longest wait a caller may ask for. */
export const WAIT_MAX_MS = 7 * 24 * 60 * 60 * 1000;

export interface DispatchWaitOptions {
  /** No timeout by default. Capped at seven days. */
  timeoutMs?: number;
  request?: typeof hookRequest;
  out?: (line: Json) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** First poll interval; it backs off to 10 s. */
  intervalMs?: number;
  jitter?: boolean;
  graceMs?: number;
  unavailableMs?: number;
}

function objects(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter((item): item is Json => !!item && typeof item === "object" && !Array.isArray(item)) : [];
}
function object(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}
function reason(error: unknown): string {
  const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
  return message.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200);
}
function questionOf(value: Json | undefined): string | undefined {
  if (!value) return undefined;
  if (typeof value.question === "string" && value.question) return value.question;
  const approval = object(value.approval);
  for (const key of ["request", "title", "tool"]) if (typeof approval[key] === "string" && approval[key]) return String(approval[key]);
  return undefined;
}
/** About 2 s at first, backing off to 10 s, with jitter. */
export function waitDelay(attempt: number, baseMs = 2_000, jitter = true): number {
  const target = Math.min(10_000, baseMs * 1.5 ** Math.max(0, attempt - 1));
  return Math.max(1, Math.round(target * (jitter ? 0.8 + Math.random() * 0.4 : 1)));
}

export async function waitForDispatch(id: string, options: DispatchWaitOptions = {}): Promise<number> {
  const request = options.request ?? hookRequest;
  const out = options.out ?? ((line: Json) => console.log(JSON.stringify(line)));
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => sleepTimer(ms));
  const base = options.intervalMs ?? 2_000;
  const jitter = options.jitter ?? true;
  const grace = options.graceMs ?? WAIT_GRACE_MS;
  const unavailableLimit = options.unavailableMs ?? WAIT_UNAVAILABLE_MS;
  const timeoutMs = options.timeoutMs === undefined ? undefined : Math.min(Math.max(0, options.timeoutMs), WAIT_MAX_MS);
  const started = now();
  let lastState: string | undefined;
  let unknownSince: number | undefined;
  let failingSince: number | undefined;
  let attempt = 0;

  const emit = (state: string, extra: Json = {}) => {
    if (state === lastState) return;
    lastState = state;
    out({ dispatch: id, state, ...extra, at: new Date(now()).toISOString() });
  };
  const final = (state: string, extra: Json = {}) => out({ dispatch: id, state, final: true, ...extra });

  for (;;) {
    if (timeoutMs !== undefined && now() - started >= timeoutMs) {
      final("timeout");
      return 124;
    }
    let receipt: Json | undefined, returned: Json | undefined, worker: Json | undefined, peeked: Json | undefined;
    let listError: unknown, peekError: unknown;
    try {
      const list = await request("/v1/dispatch");
      receipt = objects(list.dispatches).find(row => row.id === id);
    } catch (error) { listError = error; }
    try {
      const peek = await request("/v1/dispatch/returns?peek=1", {});
      peeked = objects(peek.returns).find(row => row.id === id);
    } catch (error) { peekError = error; }
    if (listError && peekError) {
      if (failingSince === undefined) failingSince = now();
      else if (now() - failingSince >= unavailableLimit) {
        final("failed", { error: `Phren Hook unavailable: ${reason(peekError ?? listError)}` });
        return 1;
      }
      attempt++;
      await sleep(waitDelay(attempt, base, jitter));
      continue;
    }
    failingSince = undefined;
    if (!listError) {
      if (receipt) unknownSince = undefined;
      else if (unknownSince === undefined) unknownSince = now();
    }
    const fromReceipt = receipt?.returned ? object(receipt.returned) : undefined;
    // A return the conductor already read is still this dispatch's latest;
    // use whichever of the peek and the receipt names the newer one.
    returned = fromReceipt && String(fromReceipt.at ?? "") > String(peeked?.at ?? "") ? fromReceipt : peeked ?? fromReceipt;
    if (!listError && !receipt && !returned && unknownSince !== undefined && now() - unknownSince >= grace) {
      final("failed", { error: "unknown dispatch" });
      return 1;
    }
    if (!returned && receipt?.target) {
      try {
        const answer = await request("/v1/dispatch/workers", { targets: [{ ...object(receipt.target), dispatch: id }] });
        worker = objects(answer.workers)[0];
      } catch { /* The live state can lag; the next poll asks again. */ }
    }

    const acknowledge = async () => {
      const own = receipt?.returned ? object(receipt.returned) : undefined;
      if (!peeked && own?.read !== false) return;
      await request("/v1/dispatch/returns/ack", { dispatch: id }).catch(() => undefined);
    };
    // A placement that failed before any worker existed has no return of its own.
    if (!returned && receipt?.state === "failed") {
      final("failed", { ...(typeof receipt.error === "string" ? { error: receipt.error } : {}) });
      return 1;
    }
    const state = typeof returned?.state === "string" ? returned.state : undefined;
    if (state === "done") {
      final("done", { ...(typeof returned!.reply === "string" ? { final_reply: returned!.reply } : {}), ...(returned!.prs ? { prs: returned!.prs } : {}) });
      await acknowledge();
      return 0;
    }
    if (state === "failed") {
      final("failed", { ...(typeof returned!.error === "string" ? { error: returned!.error } : {}) });
      await acknowledge();
      return 1;
    }
    if (state === "gone") {
      final("gone");
      await acknowledge();
      return 1;
    }
    const workerState = typeof worker?.state === "string" ? worker.state : typeof object(receipt?.worker).state === "string" ? String(object(receipt?.worker).state) : undefined;
    if (state === "needs-you" || state === "blocked") {
      const question = questionOf(returned);
      emit("needs_you", question ? { question } : {});
    } else if (workerState === "gone" || workerState === "closed") {
      final("gone");
      return 1;
    } else if (workerState === "needs-you" || workerState === "blocked") {
      const question = questionOf(worker);
      emit("needs_you", question ? { question } : {});
    } else {
      emit("running");
    }
    attempt++;
    await sleep(waitDelay(attempt, base, jitter));
  }
}
