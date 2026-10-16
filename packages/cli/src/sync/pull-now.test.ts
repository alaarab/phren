import { afterEach, expect, it, vi } from "vitest";
import { ImmediatePulls } from "./pull-now.js";

afterEach(() => vi.useRealTimers());
it("runs immediately, coalesces in-flight nudges and rate-limits the next pull", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const pull = vi.fn(async () => ({ status: "unchanged" as const, detail: "done" }));
  pull.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ status: "unchanged", detail: "done" }); }));
  const queue = new ImmediatePulls(pull);
  queue.request("store"); await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 50; i++) queue.request("store");
  expect(pull).toHaveBeenCalledTimes(1);
  release(); await vi.advanceTimersByTimeAsync(9999);
  expect(pull).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(pull).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(pull).toHaveBeenCalledTimes(2);
  queue.stop();
});
it("keeps one wakeup when a sibling holds the coordinated lock and cancels on stop", async () => {
  vi.useFakeTimers();
  const pull = vi.fn(async () => ({ status: "unchanged" as const, detail: "done" }));
  const busy = vi.fn(async () => ({ status: "deferred" as const, detail: "Coordinated pull is running." }));
  const queue = new ImmediatePulls(async () => busy.mock.calls.length === 0 ? busy() : pull());
  queue.request("store"); await vi.advanceTimersByTimeAsync(0);
  expect(busy).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(pull).toHaveBeenCalledTimes(1);
  queue.request("store"); queue.stop(); await vi.advanceTimersByTimeAsync(20_000);
  expect(pull).toHaveBeenCalledTimes(1);
});
