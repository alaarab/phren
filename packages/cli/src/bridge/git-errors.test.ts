import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

// Process failures cannot be forced portably by repository contents (especially
// a killed Git on Windows). Fake only execFile; exercise public status/diff.
const state = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: Object.assign(() => {}, {
  [Symbol.for("nodejs.util.promisify.custom")]: state.exec,
}) }));
import { gitStatus } from "./git.js";
import { gitWorktrees } from "./git-worktrees.js";
import { repositoryDiff } from "./projects.js";

afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); });

it.each([
  [{ killed: true, signal: "SIGTERM" }, 504, "git-timeout"],
  [{ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true }, 413, "git-output-limit"],
  [{ code: "ENOENT" }, 503, "git-failed"],
  [{ code: 128, stderr: "fatal: bad config file" }, 503, "git-failed"],
] as const)("never turns process failure %j into an empty repository", async (failure, status, code) => {
  state.exec.mockRejectedValue(Object.assign(new Error("process failed"), failure));
  for (const read of [gitStatus, repositoryDiff]) {
    await expect(read(process.cwd())).rejects.toMatchObject({ status, details: { code } });
  }
});


it.each(["status", "diff", "worktrees"] as const)("enforces the aggregate %s budget and passes the remaining time to Git", async kind => {
  const root = await realpath(process.cwd());
  let now = 0;
  const limits: number[] = [];
  vi.spyOn(performance, "now").mockImplementation(() => now);
  state.exec.mockImplementation(async (_file, args: string[], options: { timeout: number }) => {
    limits.push(options.timeout);
    // Each process succeeds well inside its own former ten-second limit.
    // Together these commands exhaust one read's shared budget.
    now += 2_500;
    const command = args[3];
    const stdout = command === "rev-parse" ? root + "\n"
      : command === "branch" ? "main\n"
      : command === "worktree" ? `worktree ${root}\0HEAD one\0branch refs/heads/main\0\0worktree ${path.dirname(root)}\0HEAD two\0branch refs/heads/feature\0\0`
      : command === "status" ? " M file.txt\0" : "";
    return { stdout, stderr: "" };
  });
  const read = kind === "status" ? gitStatus : kind === "diff" ? repositoryDiff : gitWorktrees;
  await expect(read(root)).rejects.toMatchObject({ status: 504, details: { code: "git-timeout" } });
  expect(limits.length).toBeGreaterThan(1);
  expect(limits.at(-1)).toBeLessThan(limits[0]);
  expect(now).toBeLessThanOrEqual(10_000);
  const stopped = limits.length;
  await new Promise(resolve => setImmediate(resolve));
  expect(limits).toHaveLength(stopped); // No abandoned continuation starts more Git.
});

it("aborts an active Git process at the request deadline and waits for it to settle", async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined, settled = false;
  state.exec.mockImplementation((_file, _args, options) => new Promise((_resolve, reject) => {
    signal = options.signal;
    signal!.addEventListener("abort", () => {
      settled = true;
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    }, { once: true });
  }));
  try {
    const pending = gitStatus(process.cwd());
    const rejected = expect(pending).rejects.toMatchObject({ status: 504, details: { code: "git-timeout" } });
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(signal?.aborted).toBe(true);
    expect(settled).toBe(true);
  } finally { vi.useRealTimers(); }
});

it.each(["", "error: could not read plain.txt"])("accepts no-index exit 1 only without diagnostics (%j)", async stderr => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "phren-count-error-")));
  await writeFile(path.join(root, "plain.txt"), "line\n");
  state.exec.mockImplementation(async (_file, args: string[]) => {
    const command = args[3];
    if (command === "diff" && args.includes("--no-index")) {
      // A disappearance/read failure after lstat can also exit 1. Even partial
      // stdout must not be interpreted as a successful count in that case.
      throw Object.assign(new Error("git exited 1"), { code: 1, stdout: "1\t0\tplain.txt\0", stderr });
    }
    return { stdout: command === "rev-parse" ? root + "\n" : command === "branch" ? "main\n"
      : command === "status" ? "?? plain.txt\0" : "", stderr: "" };
  });
  try {
    if (stderr) await expect(gitStatus(root)).rejects.toMatchObject({ status: 503, details: { code: "git-failed" } });
    else expect((await gitStatus(root)).files).toEqual([expect.objectContaining({ path: "plain.txt", additions: 1, countsComplete: true })]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
