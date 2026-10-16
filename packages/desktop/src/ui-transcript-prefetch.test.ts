import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error transcript-prefetch.js is plain JavaScript without type declarations
import { computerReady, createPrefetcher } from "../ui/shell/transcript-prefetch.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const target = (n: number) => ({ session: `s${n}` });

function setup(options: { ready?: (c: string) => boolean; max?: number; ttlMs?: number } = {}) {
  const resolvers: Array<() => void> = [];
  const fetchSnapshot = vi.fn((_computer: string, t: { session: string }) => new Promise((resolve) => { resolvers.push(() => resolve({ for: t.session })); }));
  const p = createPrefetcher({ fetchSnapshot, now: () => Date.now(), ...options });
  return { p, fetchSnapshot, finish: async (i = 0) => { resolvers[i]?.(); await vi.advanceTimersByTimeAsync(0); } };
}

describe("transcript prefetch", () => {
  it("reads only after the pointer has dwelt", async () => {
    const { p, fetchSnapshot } = setup();
    p.hover("mini", "k1", target(1), "a");
    await vi.advanceTimersByTimeAsync(149);
    expect(fetchSnapshot).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
  });

  it("a fly-by that leaves before the dwell reads nothing", async () => {
    const { p, fetchSnapshot } = setup();
    p.hover("mini", "k1", target(1), "a");
    await vi.advanceTimersByTimeAsync(100);
    p.cancel("k1");
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchSnapshot).not.toHaveBeenCalled();
  });

  it("keeps one read in flight per computer, and lets another computer read", async () => {
    const { p, fetchSnapshot, finish } = setup();
    p.hover("mini", "k1", target(1), "a");
    await vi.advanceTimersByTimeAsync(150);
    p.hover("mini", "k2", target(2), "a");
    await vi.advanceTimersByTimeAsync(150);
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    p.hover("pj", "k3", target(3), "a");
    await vi.advanceTimersByTimeAsync(150);
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    await finish(0);
    p.hover("mini", "k2", target(2), "a");
    await vi.advanceTimersByTimeAsync(150);
    expect(fetchSnapshot).toHaveBeenCalledTimes(3);
  });

  it("serves a snapshot once, only for the row state it was read for", async () => {
    const { p, finish } = setup();
    p.hover("mini", "k1", target(1), "a");
    await vi.advanceTimersByTimeAsync(150);
    await finish(0);
    expect(p.take("k1", "b")).toBeNull(); // the row changed since
    p.hover("mini", "k1", target(1), "a");
    await vi.advanceTimersByTimeAsync(150);
    await finish(1);
    expect(p.take("k1", "a")).toEqual({ for: "s1" });
    expect(p.take("k1", "a")).toBeNull();
  });

  it("does not hit the Hook again while a fresh snapshot is held", async () => {
    const { p, fetchSnapshot, finish } = setup();
    p.hover("mini", "k1", target(1), "a");
    await vi.advanceTimersByTimeAsync(150);
    await finish(0);
    p.hover("mini", "k1", target(1), "a");
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
  });

  it("expires entries after the ttl", async () => {
    const { p, finish } = setup({ ttlMs: 60_000 });
    p.hover("mini", "k1", target(1), "a");
    await vi.advanceTimersByTimeAsync(150);
    await finish(0);
    await vi.advanceTimersByTimeAsync(60_001);
    expect(p.take("k1", "a")).toBeNull();
  });

  it("evicts the least recently read entry past the bound", async () => {
    const { p, finish } = setup({ max: 2 });
    for (let i = 1; i <= 3; i++) {
      p.hover("mini", `k${i}`, target(i), "a");
      await vi.advanceTimersByTimeAsync(150);
      await finish(i - 1);
    }
    expect(p.size()).toBe(2);
    expect(p.take("k1", "a")).toBeNull();
    expect(p.take("k3", "a")).toEqual({ for: "s3" });
  });

  it("drops a read that was invalidated while in flight", async () => {
    const { p, finish } = setup();
    p.hover("mini", "k1", target(1), "a");
    await vi.advanceTimersByTimeAsync(150);
    p.invalidate("k1");
    await finish(0);
    expect(p.take("k1", "a")).toBeNull();
  });

  it("never reads a computer that is not ready", async () => {
    const { p, fetchSnapshot } = setup({ ready: () => false });
    p.hover("mini", "k1", target(1), "a");
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchSnapshot).not.toHaveBeenCalled();
  });
});

describe("computerReady", () => {
  const merged = (co: object) => ({ computers: [{ computer: "mini", state: "online", ...co }] });
  it("needs an online computer that is not stressed or draining its battery", () => {
    expect(computerReady("mini", merged({}))).toBe(true);
    expect(computerReady("mini", merged({ state: "offline" }))).toBe(false);
    expect(computerReady("nope", merged({}))).toBe(false);
    expect(computerReady("mini", merged({ resources: { level: "stressed" } }))).toBe(false);
    expect(computerReady("mini", merged({ resources: { warnings: ["battery-low"] } }))).toBe(false);
    expect(computerReady("mini", merged({ resources: { battery: { percent: 10, onAC: false, charging: false } } }))).toBe(false);
    expect(computerReady("mini", merged({ resources: { battery: { percent: 10, onAC: true, charging: true } } }))).toBe(true);
  });
});
