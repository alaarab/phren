import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error transcript-prefetch.js is plain JavaScript without type declarations
import { computerReady, createPrefetcher, trimSnapshot } from "../ui/shell/transcript-prefetch.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const target = (n: number) => ({ session: `s${n}` });

function setup(options: { ready?: (c: string) => boolean; max?: number; ttlMs?: number } = {}) {
  const resolvers: Array<() => void> = [];
  const fetchSnapshot = vi.fn((_computer: string, t: { session: string }) => new Promise((resolve) => { resolvers.push(() => resolve({ for: t.session, entries: [{ line: 1, raw: {} }], totalLines: 1, startLine: 1, hasMore: false })); }));
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
    expect(p.take("k1", "a")).toMatchObject({ for: "s1" });
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
    expect(p.take("k3", "a")).toMatchObject({ for: "s3" });
  });

  it("a hung read times out, releases the computer and backs it off", async () => {
    const { p, fetchSnapshot } = setup();
    p.hover("mini", "k1", target(1), "a");
    await vi.advanceTimersByTimeAsync(150);
    expect(p.inflight("mini")).toBe(true);
    const signal = fetchSnapshot.mock.calls[0][2] as AbortSignal;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(signal.aborted).toBe(true);
    expect(p.inflight("mini")).toBe(false);
    p.hover("mini", "k2", target(2), "a");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchSnapshot).toHaveBeenCalledTimes(1); // backed off
    await vi.advanceTimersByTimeAsync(30_000);
    p.hover("mini", "k2", target(2), "a");
    await vi.advanceTimersByTimeAsync(150);
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
  });

  it("leaving a row aborts its read without backing the computer off", async () => {
    const { p, fetchSnapshot } = setup();
    p.hover("mini", "k1", target(1), "a");
    await vi.advanceTimersByTimeAsync(150);
    p.cancel("k1");
    expect((fetchSnapshot.mock.calls[0][2] as AbortSignal).aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    p.hover("mini", "k2", target(2), "a");
    await vi.advanceTimersByTimeAsync(150);
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
  });

  it("skips the row of a chat that is already open", async () => {
    const { p, fetchSnapshot } = setup();
    p.setOpen("k1", true);
    p.hover("mini", "k1", target(1), "a");
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchSnapshot).not.toHaveBeenCalled();
    p.setOpen("k1", false);
    p.hover("mini", "k1", target(1), "a");
    await vi.advanceTimersByTimeAsync(150);
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
  });

  it("drops a snapshot larger than the byte cap", async () => {
    const { p, finish } = setup({ maxBytes: 10 });
    p.hover("mini", "k1", target(1), "a");
    await vi.advanceTimersByTimeAsync(150);
    await finish(0);
    expect(p.take("k1", "a")).toBeNull();
  });

  it("prunes expired entries when scheduling", async () => {
    const { p, finish } = setup({ ttlMs: 1_000 });
    p.hover("mini", "k1", target(1), "a");
    await vi.advanceTimersByTimeAsync(150);
    await finish(0);
    await vi.advanceTimersByTimeAsync(2_000);
    p.hover("mini", "k2", target(2), "a");
    expect(p.size()).toBe(0);
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

describe("trimSnapshot", () => {
  const frame = (n: number) => ({ type: "older", totalLines: n, startLine: 1, hasMore: false, entries: Array.from({ length: n }, (_, i) => ({ line: i + 1, raw: { i } })) });
  it("keeps the newest 60 entries and marks the rest as older", () => {
    const out = trimSnapshot(frame(200));
    expect(out.entries).toHaveLength(60);
    expect(out.entries[0].line).toBe(141);
    expect(out.entries.at(-1).line).toBe(200);
    expect(out.startLine).toBe(141);
    expect(out.hasMore).toBe(true);
  });
  it("leaves a short transcript alone", () => {
    const out = trimSnapshot(frame(10));
    expect(out.entries).toHaveLength(10);
    expect(out.startLine).toBe(1);
    expect(out.hasMore).toBe(false);
  });
  it("trims to the byte window", () => {
    const out = trimSnapshot(frame(50), 60, 100);
    expect(out.entries.length).toBeLessThan(50);
    expect(out.entries.at(-1).line).toBe(50);
  });
});
