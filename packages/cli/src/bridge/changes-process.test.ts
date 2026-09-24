import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
const state = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: Object.assign(() => {}, { [Symbol.for("nodejs.util.promisify.custom")]: state.exec }) }));
import { ToolChanges } from "./changes.js";
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
it("passes an AbortSignal to running Git and cancels it at the hook budget", async () => {
  const home = await mkdtemp("/tmp/phren-abort-"); vi.stubEnv("HOME", home); vi.stubEnv("PHREN_BRIDGE_HOME", home + "/bridge"); vi.stubEnv("PHREN_PATH", home + "/store");
  let signal: AbortSignal | undefined;
  state.exec.mockImplementation((_file, _args, options) => new Promise((_resolve, reject) => {
    signal = options.signal;
    signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
  }));
  vi.useFakeTimers();
  const changes = new ToolChanges(), pending = changes.before("c", "t", home, "ls");
  try {
    await vi.waitFor(() => expect(signal).toBeDefined());
    await vi.advanceTimersByTimeAsync(2500); await pending;
    expect(signal!.aborted).toBe(true);
    expect(changes.view("c").pending("t")).toBe(false);
    expect(state.exec).toHaveBeenCalledTimes(1);
  } finally { await changes.close(); await rm(home, { recursive: true, force: true }); }
});
