import { afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
// /tmp keeps POSIX paths short; Windows has no /tmp.
const scratchRoot = process.platform === "win32" ? tmpdir() : "/tmp";
const state = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: Object.assign(() => {}, { [Symbol.for("nodejs.util.promisify.custom")]: state.exec }) }));
import { ToolChanges } from "./changes.js";
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
it("gives up at the hook budget without a row error and cancels the Git read nobody waits for", async () => {
  const home = await realpath(await mkdtemp(path.join(scratchRoot, "phren-abort-"))); vi.stubEnv("HOME", home); vi.stubEnv("PHREN_BRIDGE_HOME", home + "/bridge"); vi.stubEnv("PHREN_PATH", home + "/store");
  await mkdir(path.join(home, ".git/objects"), { recursive: true });
  let signal: AbortSignal | undefined;
  state.exec.mockImplementation((_file, args: string[], options) => new Promise((resolve, reject) => {
    if (args.includes("rev-parse")) { resolve({ stdout: `${home}\n.git/objects\n.git/index\n`, stderr: "" }); return; }
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
    // A busy machine is not a failure of this call: the row shows no changes.
    await expect(changes.view("c").changes("t")).resolves.toBeUndefined();
  } finally { await changes.close(); await rm(home, { recursive: true, force: true }); }
});

it("keeps a shared repository lookup alive while another caller still waits for it", async () => {
  const home = await realpath(await mkdtemp(path.join(scratchRoot, "phren-shared-"))); vi.stubEnv("HOME", home); vi.stubEnv("PHREN_BRIDGE_HOME", home + "/bridge"); vi.stubEnv("PHREN_PATH", home + "/store");
  await mkdir(path.join(home, ".git/objects"), { recursive: true });
  let started = false, aborted = false, release!: () => void;
  state.exec.mockReset();
  state.exec.mockImplementation((_file, args: string[], options) => {
    if (args.includes("rev-parse")) {
      started = true;
      return new Promise((resolve, reject) => {
        options.signal?.addEventListener("abort", () => { aborted = true; reject(options.signal!.reason); }, { once: true });
        release = () => resolve({ stdout: `${home}\n.git/objects\n.git/index\n`, stderr: "" });
      });
    }
    return Promise.resolve({ stdout: "", stderr: "" });
  });
  const changes = new ToolChanges();
  const lookup = () => [...(changes as any).repositories.values()][0].lookup as { waiting: number };
  try {
    const first = new AbortController(), second = new AbortController();
    const a = (changes as any).repositoryOf(home, home, first.signal, home);
    await vi.waitFor(() => expect(started).toBe(true));
    const b = (changes as any).repositoryOf(home, home, second.signal, home);
    // The second caller has joined the same lookup before the first gives up.
    await vi.waitFor(() => expect(lookup().waiting).toBe(2));
    first.abort();
    await expect(a).rejects.toBeDefined();
    expect(aborted).toBe(false);
    release();
    // The lookup survived the first caller and still serves the second.
    await expect(b).resolves.toMatchObject({ root: home });
  } finally { await changes.close(); await rm(home, { recursive: true, force: true }); }
});
