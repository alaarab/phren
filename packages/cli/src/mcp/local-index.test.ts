import { describe, expect, it, vi } from "vitest";
import { indexReaders, localIndexRefresh } from "./local-index.js";

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
