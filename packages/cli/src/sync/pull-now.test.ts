import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { tryFileLock } from "../governance/locks.js";
import { runtimeFile } from "../phren-paths.js";
import { pollStore } from "./pull.js";
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

it("bounds Git-operation retries to three attempts over thirty seconds", async () => {
  vi.useFakeTimers();
  const pull = vi.fn(async () => ({ status: "deferred" as const, detail: "Periodic pull deferred: a Git operation is in progress." }));
  const queue = new ImmediatePulls(pull);
  queue.request("store"); await vi.advanceTimersByTimeAsync(0);
  expect(pull).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(10_000); expect(pull).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(20_000); expect(pull).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(60_000); expect(pull).toHaveBeenCalledTimes(3);
  queue.stop();
});

it.each(["index.lock", "MERGE_HEAD"])("retains the trailing pull until a sibling releases git-op and %s", async marker => {
  const root = mkdtempSync(path.join(tmpdir(), "webhook-git-busy-"));
  execFileSync("git", ["init", "--initial-branch=main", root]);
  const release = tryFileLock(runtimeFile(root, "git-op"))!;
  const file = path.join(root, ".git", marker);
  writeFileSync(file, "a".repeat(40));
  vi.useFakeTimers();
  const pull = vi.fn(async (store: string) => pollStore(store, 0, undefined, Date.now(), true));
  const queue = new ImmediatePulls(pull);
  try {
    queue.request(root); await vi.advanceTimersByTimeAsync(0);
    expect(await pull.mock.results[0].value).toMatchObject({ status: "deferred", detail: "Periodic pull deferred: a Git operation is in progress." });
    expect(pull).toHaveBeenCalledTimes(1);
    release(); unlinkSync(file);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pull).toHaveBeenCalledTimes(2);
    expect(await pull.mock.results[1].value).toMatchObject({ status: "unchanged" });
    await vi.advanceTimersByTimeAsync(60_000); expect(pull).toHaveBeenCalledTimes(2);
  } finally { queue.stop(); release(); rmSync(root, { recursive: true, force: true }); }
});
