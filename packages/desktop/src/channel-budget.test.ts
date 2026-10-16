import { afterEach, describe, expect, it, vi } from "vitest";
import { createBudget, createChannelPool, type AcquiredChannel } from "./channel-pool.js";

const held: AcquiredChannel[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const channel of held.splice(0)) channel.release();
});

describe("channel budget", () => {
  it("keeps headroom in the pool for callers outside the budget", async () => {
    const pool = createChannelPool(2, 4);
    const budget = createBudget(pool, 4);
    for (let i = 0; i < 4; i++) held.push(await budget.acquire("box"));
    const queued = budget.acquire("box");
    expect(pool.stats("box").waiting).toBe(0);
    // Four more channels remain for chats.
    for (let i = 0; i < 4; i++) held.push(await pool.acquire("box", { timeoutMs: 1 }));
    expect(pool.stats("box").slots).toEqual([4, 4]);
    held.shift()!.release();
    held.push(await queued);
    expect(budget.held("box")).toBe(4);
  });

  it("counts per computer", async () => {
    const budget = createBudget(createChannelPool(2, 4), 1);
    held.push(await budget.acquire("a"), await budget.acquire("b"));
    expect(budget.held("a")).toBe(1);
    expect(budget.held("b")).toBe(1);
  });

  it("releases once and gives the budget back", async () => {
    const budget = createBudget(createChannelPool(2, 4), 1);
    const channel = await budget.acquire("box");
    channel.release();
    channel.release();
    expect(budget.held("box")).toBe(0);
    held.push(await budget.acquire("box"));
  });

  it("drops a waiter on abort and on timeout without taking budget", async () => {
    vi.useFakeTimers();
    const budget = createBudget(createChannelPool(2, 4), 1);
    held.push(await budget.acquire("box"));
    const controller = new AbortController();
    const aborted = expect(budget.acquire("box", { signal: controller.signal })).rejects.toThrow("stop");
    controller.abort(new Error("stop"));
    await aborted;
    const timed = expect(budget.acquire("box", { timeoutMs: 100 })).rejects.toThrow(/Timed out/);
    await vi.advanceTimersByTimeAsync(100);
    await timed;
    expect(budget.held("box")).toBe(1);
    held.shift()!.release();
    expect(budget.held("box")).toBe(0);
  });

  it("gives the budget back when the pool times out", async () => {
    vi.useFakeTimers();
    const pool = createChannelPool(1, 1);
    const direct = await pool.acquire("box");
    const budget = createBudget(pool, 2);
    const pending = expect(budget.acquire("box", { timeoutMs: 50 })).rejects.toThrow(/Timed out/);
    await vi.advanceTimersByTimeAsync(50);
    await pending;
    expect(budget.held("box")).toBe(0);
    direct.release();
  });
});
