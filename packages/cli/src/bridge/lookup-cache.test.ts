import { afterEach, expect, it, vi } from "vitest";
import { LookupCache } from "./lookup-cache.js";

afterEach(() => vi.useRealTimers());

it("keeps a success through failed refreshes until maxAge", async () => {
  vi.useFakeTimers();
  const cache = new LookupCache<number>(10, 100);
  await cache.get("key", async () => 1);
  await vi.advanceTimersByTimeAsync(11);
  expect(await cache.get("key", async () => { throw new Error("timeout"); })).toBe(1);
  await vi.advanceTimersByTimeAsync(0);
  expect(await cache.get("key", async () => { throw new Error("timeout"); })).toBe(1);
  await vi.advanceTimersByTimeAsync(100);
  await expect(cache.get("key", async () => { throw new Error("timeout"); })).rejects.toThrow("timeout");
});

it("expires stalled reads and rejects late results without overwriting a newer refresh", async () => {
  vi.useFakeTimers();
  const cache = new LookupCache<number>(10, 100);
  let finish!: (value: number) => void;
  const stalled = cache.get("key", () => new Promise<number>(resolve => { finish = resolve; }));
  const rejected = expect(stalled).rejects.toThrow(/time limit/);
  await vi.advanceTimersByTimeAsync(45_001);
  await rejected;
  expect(await cache.get("key", async () => 2)).toBe(2);
  finish(1);
  await vi.advanceTimersByTimeAsync(0);
  expect(await cache.get("key", async () => 3)).toBe(2);
});

it("serves stale success after a refresh times out but refuses it beyond maxAge", async () => {
  vi.useFakeTimers();
  const cache = new LookupCache<number>(10, 100_000);
  await cache.get("key", async () => 1);
  await vi.advanceTimersByTimeAsync(11);
  expect(await cache.get("key", () => new Promise(() => {}))).toBe(1);
  await vi.advanceTimersByTimeAsync(45_001);
  expect(await cache.get("key", () => new Promise(() => {}))).toBe(1);
  await vi.advanceTimersByTimeAsync(55_000);
  expect(await cache.get("key", async () => 2)).toBe(2);
});
