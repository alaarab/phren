import { afterEach, describe, expect, it, vi } from "vitest";
import { createChannelPool, type AcquiredChannel } from "./channel-pool.js";

afterEach(() => vi.useRealTimers());

describe("createChannelPool", () => {
  it("times out a queued acquisition without consuming a later release", async () => {
    vi.useFakeTimers();
    const pool = createChannelPool(1, 1);
    const held = await pool.acquire("box");
    const waiting = pool.acquire("box", { timeoutMs: 100 });
    const rejected = expect(waiting).rejects.toThrow(/timed out.*channel/i);
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(pool.stats("box").waiting).toBe(0);
    held.release();
    expect((await pool.acquire("box")).slot).toBe(0);
  });

  it("removes a cancelled waiter and rejects an already cancelled acquisition", async () => {
    const pool = createChannelPool(1, 1);
    const held = await pool.acquire("box");
    const controller = new AbortController();
    const waiting = pool.acquire("box", { signal: controller.signal });
    const rejected = expect(waiting).rejects.toThrow("Cancelled");
    controller.abort(new Error("Cancelled"));
    await rejected;
    expect(pool.stats("box").waiting).toBe(0);
    held.release();
    await expect(pool.acquire("box", { signal: controller.signal })).rejects.toThrow("Cancelled");
    expect(pool.stats("box").slots).toEqual([0]);
  });

  it("fills a slot before moving to the next", async () => {
    const pool = createChannelPool();
    const held: AcquiredChannel[] = [];
    for (let i = 0; i < 9; i++) held.push(await pool.acquire("box"));
    expect(held.slice(0, 8).map(c => c.slot)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(held[8].slot).toBe(1);
    expect(pool.stats("box")).toEqual({ slots: [8, 1, 0, 0], waiting: 0 });
  });

  it("queues the next channel once all four slots are full, FIFO, until a release", async () => {
    const pool = createChannelPool();
    const held: AcquiredChannel[] = [];
    for (let i = 0; i < 32; i++) held.push(await pool.acquire("box"));
    expect(pool.stats("box")).toEqual({ slots: [8, 8, 8, 8], waiting: 0 });

    const first = pool.acquire("box");
    const second = pool.acquire("box");
    expect(pool.stats("box").waiting).toBe(2);

    let firstSlot: number | undefined;
    let secondSlot: number | undefined;
    first.then(c => { firstSlot = c.slot; });
    second.then(c => { secondSlot = c.slot; });
    await Promise.resolve();
    expect(firstSlot).toBeUndefined();

    held[0].release(); // frees slot 0
    const got = await first;
    expect(got.slot).toBe(0);
    expect(firstSlot).toBe(0);

    // Slot 0 still holds 8 minus that one; the second waiter stays queued.
    await Promise.resolve();
    expect(secondSlot).toBeUndefined();
    held[8].release(); // frees slot 1
    const next = await second;
    expect(next.slot).toBe(1);
    expect(pool.stats("box").waiting).toBe(0);
  });

  it("ignores a double release", async () => {
    const pool = createChannelPool();
    const a = await pool.acquire("box");
    a.release();
    a.release();
    expect(pool.stats("box")).toEqual({ slots: [0, 0, 0, 0], waiting: 0 });
  });

  it("keeps computers apart and reports empty stats for unknown names", async () => {
    const pool = createChannelPool();
    await pool.acquire("one");
    expect(pool.stats("two")).toEqual({ slots: [0, 0, 0, 0], waiting: 0 });
    expect(pool.stats("one")).toEqual({ slots: [1, 0, 0, 0], waiting: 0 });
  });
});
