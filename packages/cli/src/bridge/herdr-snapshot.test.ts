import { afterEach, describe, expect, it, vi } from "vitest";
import { resetSharedHerdrState, SNAPSHOT_RETIRE_MS, sharedSnapshot } from "./herdr.js";
import type { Json } from "./protocol.js";
import { setTerminalProvider, type TerminalProvider } from "./terminal.js";

const provider = (snapshot: (server: string) => Promise<Json>) => ({ snapshot } as unknown as TerminalProvider);

describe("shared snapshot retirement", () => {
  afterEach(() => { vi.useRealTimers(); resetSharedHerdrState(); });

  it("rejects joined callers at expiry and never publishes a retired attempt's late answer", async () => {
    vi.useFakeTimers();
    let calls = 0;
    let resolveFirst!: (value: Json) => void;
    const first = new Promise<Json>(resolve => { resolveFirst = resolve; });
    const restore = setTerminalProvider(provider(async () => {
      calls++;
      return calls === 1 ? first : { panes: [{ pane_id: "fresh" }] };
    }));
    try {
      // A joined caller waits on the same in-flight request.
      const hung = sharedSnapshot("default").catch(error => error);
      const joined = sharedSnapshot("default").catch(error => error);
      await vi.advanceTimersByTimeAsync(SNAPSHOT_RETIRE_MS);
      expect(calls).toBe(1);
      await expect(hung).resolves.toMatchObject({ status: 503, details: { code: "herdr-snapshot-stalled" } });
      await expect(joined).resolves.toMatchObject({ status: 503, details: { code: "herdr-snapshot-stalled" } });
      // The retired attempt's late answer does not refill the cache.
      resolveFirst({ panes: [{ pane_id: "late" }] });
      await vi.advanceTimersByTimeAsync(0);
      await expect(sharedSnapshot("default")).resolves.toEqual({ panes: [{ pane_id: "fresh" }] });
      expect(calls).toBe(2);
    } finally {
      restore();
    }
  });
});
