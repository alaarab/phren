import { describe, expect, it, vi } from "vitest";
import { indexBusyWaitMs, indexReaders, localIndexRefresh, retryWhileBusy } from "./local-index.js";

it("keeps a busy reader's old handle alive and frees it despite newer busy readers", async () => {
  let current = "old";
  const close = vi.fn();
  const readers = indexReaders(() => current, close);
  let releaseOld!: () => void;
  let releaseNew!: () => void;
  const old = readers.run(async () => {
    expect(readers.get()).toBe("old");
    await new Promise<void>(resolve => { releaseOld = resolve; });
    expect(close).not.toHaveBeenCalledWith("old");
    // A handler can obtain the new index after an await as well.
    expect(readers.get()).toBe("new");
  });
  current = "new";
  readers.retire("old");
  const newer = readers.run(async () => {
    expect(readers.get()).toBe("new");
    await new Promise<void>(resolve => { releaseNew = resolve; });
  });
  releaseOld();
  await old;
  expect(close).toHaveBeenCalledExactlyOnceWith("old");
  releaseNew();
  await newer;
  expect(close).not.toHaveBeenCalledWith("new");
});

describe("bounded local index refresh", () => {
  it("keeps unchanged calls cheap and coalesces concurrent dirty requests", async () => {
    let time = 0;
    let fresh = true;
    let finish!: () => void;
    const isFresh = vi.fn(() => fresh);
    const refresh = vi.fn(() => new Promise<void>(resolve => { finish = () => { fresh = true; resolve(); }; }));
    const runExclusive = vi.fn((fn: () => Promise<void>) => fn());
    const check = localIndexRefresh({ isFresh, refresh, runExclusive, now: () => time });
    for (let i = 0; i < 20; i++) await check.ensureFresh();
    expect(isFresh).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    fresh = false;
    time = 1000;
    const requests = Array.from({ length: 20 }, () => check.ensureFresh());
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(runExclusive).toHaveBeenCalledTimes(1);
    finish();
    await Promise.all(requests);
    await check.ensureFresh();
    expect(isFresh).toHaveBeenCalledTimes(2);
    time = 2000;
    await check.ensureFresh();
    expect(isFresh).toHaveBeenCalledTimes(3);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not bless failed refreshes, and bounds retries while another writer is busy", async () => {
    let time = 0;
    const refresh = vi.fn().mockRejectedValueOnce(new Error("busy")).mockResolvedValue(undefined);
    const check = localIndexRefresh({ isFresh: () => false, refresh, runExclusive: fn => fn(), now: () => time });
    await expect(check.ensureFresh()).rejects.toThrow("busy");
    await expect(check.ensureFresh()).rejects.toThrow("busy");
    expect(refresh).toHaveBeenCalledTimes(1);
    time = 1000;
    await check.ensureFresh();
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

describe("waiting out another process's rebuild", () => {
  const busy = () => Object.assign(new Error("Index rebuild is busy; retry shortly."), { code: "PHREN_INDEX_BUSY" });
  const isBusy = (error: unknown) => (error as { code?: string }).code === "PHREN_INDEX_BUSY";
  const clock = () => {
    let time = 0;
    return { now: () => time, sleep: async (ms: number) => { time += ms; } };
  };

  it("retries a busy rebuild until the other writer finishes, within the budget", async () => {
    const c = clock();
    const fn = vi.fn().mockRejectedValueOnce(busy()).mockRejectedValueOnce(busy()).mockResolvedValue("db");
    await expect(retryWhileBusy(fn, { isBusy, maxWaitMs: 5000, ...c })).resolves.toBe("db");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(c.now()).toBeLessThan(5000);
  });

  it("gives up with the busy error once the budget is spent, and never retries other errors", async () => {
    const c = clock();
    const stuck = vi.fn().mockRejectedValue(busy());
    await expect(retryWhileBusy(stuck, { isBusy, maxWaitMs: 2000, ...c })).rejects.toThrow("busy");
    expect(c.now()).toBe(2000);
    const broken = vi.fn().mockRejectedValue(new Error("corrupt"));
    await expect(retryWhileBusy(broken, { isBusy, maxWaitMs: 2000, ...c })).rejects.toThrow("corrupt");
    expect(broken).toHaveBeenCalledTimes(1);
  });

  it("makes many concurrent callers share one wait instead of each failing on the held lock", async () => {
    let lockHeld = true;
    let fresh = false;
    let builds = 0;
    const refresh = vi.fn(async () => {
      if (lockHeld) throw busy();
      builds++;
      fresh = true;
    });
    // The real sleep: the "other process" releases its lock after 30 ms.
    setTimeout(() => { lockHeld = false; }, 30);
    const check = localIndexRefresh({
      isFresh: () => fresh, refresh, runExclusive: fn => fn(),
      busyWait: { isBusy, maxWaitMs: 2000 },
    });
    const calls = await Promise.allSettled(Array.from({ length: 15 }, () => check.ensureFresh()));
    expect(calls.every(call => call.status === "fulfilled")).toBe(true);
    expect(refresh.mock.calls.length).toBeGreaterThan(1);
    expect(fresh).toBe(true);
    // Every caller rode the same attempt loop: one success, no duplicates after it.
    expect(builds).toBe(1);
  });

  it("reads its budget from PHREN_INDEX_BUSY_WAIT_MS", () => {
    expect(indexBusyWaitMs({})).toBe(5000);
    expect(indexBusyWaitMs({ PHREN_INDEX_BUSY_WAIT_MS: "0" })).toBe(0);
    expect(indexBusyWaitMs({ PHREN_INDEX_BUSY_WAIT_MS: "250" })).toBe(250);
    expect(indexBusyWaitMs({ PHREN_INDEX_BUSY_WAIT_MS: "999999" })).toBe(30_000);
    expect(indexBusyWaitMs({ PHREN_INDEX_BUSY_WAIT_MS: "nope" })).toBe(5000);
  });
});
