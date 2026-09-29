import { setTimeout as sleep } from "node:timers/promises";
import { agentNotReady } from "./terminal.js";

/** Only agent_not_ready guarantees that no text reached the terminal. A
 * freshly dispatched agent can report its session before Herdr registers it
 * as active. Revalidate that exact target before every retry, and never
 * retry a timeout, lost reply, or other potentially delivered write. */
export async function promptWithStartupRetry<T>(send: () => Promise<T>, revalidate: () => Promise<void>, waitMs = 20_000): Promise<T> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try { return await send(); } catch (error) {
      if (!agentNotReady(error) || Date.now() >= deadline) throw error;
      await sleep(Math.min(500, deadline - Date.now()));
      if (Date.now() >= deadline) throw error;
      await revalidate();
      if (Date.now() >= deadline) throw error;
    }
  }
}
