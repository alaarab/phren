import { BridgeError } from "./protocol.js";

/** A bounded process pool. Cancelled waiters never start work. */
export class ProcessPool {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(private readonly limit: number) {}
  async run<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    signal?.throwIfAborted();
    if (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const ready = () => { signal?.removeEventListener("abort", abort); resolve(); };
        const abort = () => { this.waiting = this.waiting.filter(w => w !== ready); reject(signal!.reason); };
        this.waiting.push(ready);
        signal?.addEventListener("abort", abort, { once: true });
      });
    } else this.active++;
    try { signal?.throwIfAborted(); return await work(); }
    finally { const next = this.waiting.shift(); if (next) next(); else this.active--; }
  }
}

/** Shared by workspace and tab creation, including agent startup. */
export class LaunchLimiter {
  private active = false;
  private starts: number[] = [];
  constructor(private readonly now = Date.now) {}
  async run<T>(work: () => Promise<T>): Promise<T> {
    const now = this.now();
    this.starts = this.starts.filter(at => now - at < 60_000);
    if (this.active || this.starts.length >= 6) throw new BridgeError(429, "Workspace launches are busy. Try again shortly.");
    this.active = true; this.starts.push(now);
    try { return await work(); } finally { this.active = false; }
  }
}

/** A millisecond interval read once at startup from the environment variable
 * `name`, when it is a number within `[min, max]`; otherwise `fallback`.
 * Tests shorten these. */
export function intervalFromEnv(name: string, fallback: number, min = 0, max = 60_000): number {
  const raw = process.env[name];
  const value = Number(raw);
  return raw && Number.isFinite(value) && value >= min && value <= max ? Math.floor(value) : fallback;
}
