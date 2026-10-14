import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROVIDERS, type RequestList } from "./git-hosts.js";
import { gitPulls } from "./git.js";
import { gitHostToken, gitMergeRequest, gitPullRequest } from "./git-publish.js";
import { gitCheckout } from "./git-sync.js";
import { git, withGitReadDeadline } from "./projects.js";

const exec = promisify(execFile);
const result = (number: number): RequestList => ({ available: true, pulls: [{ number }], current: null });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("Hook pull lookup cache", () => {
  let root: string;
  let now: number;
  beforeEach(async () => {
    await mkdir(".scratch", { recursive: true });
    root = await realpath(await mkdtemp(path.resolve(".scratch/pulls-cache-")));
    await exec("git", ["init", "-q", "-b", "feature", root]);
    await exec("git", ["-C", root, "remote", "add", "origin", "git@github.com:sam/app.git"]);
    now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
  });
  afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

  it("shares cold reads, serves within TTL, and returns stale during one refresh with its own Git deadline", async () => {
    const initial = deferred<RequestList>();
    const list = vi.spyOn(PROVIDERS.github, "list").mockReturnValue(initial.promise);
    const calls = [gitPulls(root), gitPulls(root)];
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    initial.resolve(result(1));
    await Promise.all(calls);
    expect(await gitPulls(root)).toMatchObject({ pulls: [{ number: 1 }] });
    expect(list).toHaveBeenCalledTimes(1);

    now += 30_001;
    const refresh = deferred<void>();
    const finished = deferred<void>();
    list.mockImplementation(async () => {
      await refresh.promise;
      // The original route has already returned and aborted its read budget.
      await git(root, "branch", "--show-current");
      finished.resolve();
      return result(2);
    });
    expect(await withGitReadDeadline(() => gitPulls(root))).toMatchObject({ pulls: [{ number: 1 }] });
    expect(await gitPulls(root)).toMatchObject({ pulls: [{ number: 1 }] });
    expect(list).toHaveBeenCalledTimes(2);
    refresh.resolve();
    await finished.promise;
    await vi.waitFor(async () => expect(await gitPulls(root)).toMatchObject({ pulls: [{ number: 2 }] }));
    expect(list).toHaveBeenCalledTimes(2);

    now += 300_001;
    const expired = deferred<RequestList>();
    list.mockReturnValue(expired.promise);
    let settled = false;
    const fresh = gitPulls(root).then(value => { settled = true; return value; });
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(3));
    expect(settled).toBe(false);
    expired.resolve(result(3));
    expect(await fresh).toMatchObject({ pulls: [{ number: 3 }] });
  });

  it("retries unavailable answers after five seconds and thrown failures immediately", async () => {
    const list = vi.spyOn(PROVIDERS.github, "list").mockResolvedValue({ available: false, pulls: [], current: null });
    await gitPulls(root);
    await gitPulls(root);
    expect(list).toHaveBeenCalledTimes(1);
    now += 5_001;
    list.mockRejectedValueOnce(new Error("offline"));
    await expect(gitPulls(root)).rejects.toThrow("offline");
    list.mockResolvedValue(result(1));
    expect(await gitPulls(root)).toMatchObject({ available: true });
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("retains cached success when a provider reports a timed-out refresh until maxAge", async () => {
    const list = vi.spyOn(PROVIDERS.github, "list").mockResolvedValue(result(1));
    await gitPulls(root);
    now += 30_001;
    list.mockResolvedValue({ available: false, reason: "unreachable", pulls: [], current: null });
    expect(await gitPulls(root)).toMatchObject({ pulls: [{ number: 1 }] });
    // Poll after the asynchronous refresh has completed.
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(await gitPulls(root)).toMatchObject({ pulls: [{ number: 1 }] });
    now += 300_001;
    expect(await gitPulls(root)).toMatchObject({ available: false });
  });

  it.each(["open", "merge", "checkout"])("invalidates after a Hook %s, including an older pending refresh", async action => {
    const list = vi.spyOn(PROVIDERS.github, "list").mockResolvedValue(result(1));
    await gitPulls(root);
    now += 30_001;
    const old = deferred<RequestList>();
    list.mockReturnValueOnce(old.promise);
    await gitPulls(root);
    if (action === "open") {
      vi.spyOn(PROVIDERS.github, "open").mockResolvedValue({ ok: true });
      await gitPullRequest(root, false);
    } else if (action === "merge") {
      vi.spyOn(PROVIDERS.github, "merge").mockResolvedValue({ ok: true });
      await gitMergeRequest(root, { number: 1 });
    } else {
      // An unborn branch can switch to another unborn branch and back.
      await gitCheckout(root, { branch: "other", create: true });
      await gitCheckout(root, { branch: "feature", create: true });
    }
    list.mockResolvedValue(result(3));
    expect(await gitPulls(root)).toMatchObject({ pulls: [{ number: 3 }] });
    old.resolve(result(2));
    await Promise.resolve();
    expect(await gitPulls(root)).toMatchObject({ pulls: [{ number: 3 }] });
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("allows an eleven-second forge lookup beyond the local Git deadline", async () => {
    const reply = deferred<RequestList>();
    const list = vi.spyOn(PROVIDERS.github, "list").mockReturnValue(reply.promise);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const read = gitPulls(root);
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(11_000);
    reply.resolve(result(11));
    expect(await read).toMatchObject({ pulls: [{ number: 11 }] });
  });

  it("retires cached and in-flight private pulls across a domain on disconnect and replacement", async () => {
    vi.stubEnv("PHREN_BRIDGE_HOME", path.join(root, "bridge"));
    await exec("git", ["-C", root, "remote", "set-url", "origin", "git@gitboy.example.com:sam/app.git"]);
    await exec("git", ["-C", root, "config", "remote.origin.phrenHost", "gitboy"]);
    const other = path.join(root, "other");
    await exec("git", ["init", "-q", "-b", "feature", other]);
    await exec("git", ["-C", other, "remote", "add", "origin", "git@gitboy.example.com:sam/other.git"]);
    await exec("git", ["-C", other, "config", "remote.origin.phrenHost", "gitboy"]);
    vi.spyOn(PROVIDERS.gitboy, "whoami").mockResolvedValue({ user: "sam" });
    const list = vi.spyOn(PROVIDERS.gitboy, "list").mockResolvedValue(result(1));
    await gitHostToken(root, { token: "old-token" });
    await gitPulls(root);
    await gitPulls(other);
    now += 30_001;
    const old = deferred<RequestList>();
    list.mockReturnValueOnce(old.promise);
    await gitPulls(other);
    await gitHostToken(root, { token: "" });
    list.mockResolvedValue({ available: false, reason: "auth", pulls: [], current: null });
    expect(await gitPulls(other)).toMatchObject({ available: false });
    await gitHostToken(root, { token: "new-token" });
    list.mockResolvedValue(result(3));
    expect(await gitPulls(other)).toMatchObject({ pulls: [{ number: 3 }] });
    // Reusing an earlier token cannot resurrect the previous generation.
    await gitHostToken(root, { token: "old-token" });
    list.mockResolvedValue(result(4));
    expect(await gitPulls(other)).toMatchObject({ pulls: [{ number: 4 }] });
    old.resolve(result(2));
    // Let the old provider complete its credential check before the next poll.
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(await gitPulls(other)).toMatchObject({ pulls: [{ number: 4 }] });
    await rm(path.join(root, "bridge", "git-hosts.json"));
    list.mockResolvedValue({ available: false, reason: "auth", pulls: [], current: null });
    expect(await gitPulls(other)).toMatchObject({ available: false });
  });

  it("detects external gh logout and account replacement before serving cached pulls", async () => {
    vi.stubEnv("GH_CONFIG_DIR", path.join(root, "gh"));
    await mkdir(path.join(root, "gh"));
    const file = path.join(root, "gh", "hosts.yml");
    await writeFile(file, "github.com:\n  user: old-account\n");
    const list = vi.spyOn(PROVIDERS.github, "list").mockResolvedValue(result(1));
    await gitPulls(root);
    await writeFile(file, "{}\n");
    list.mockResolvedValue({ available: false, reason: "auth", pulls: [], current: null });
    expect(await gitPulls(root)).toMatchObject({ available: false });
    await writeFile(file, "github.com:\n  user: new-account\n");
    list.mockResolvedValue(result(2));
    expect(await gitPulls(root)).toMatchObject({ pulls: [{ number: 2 }] });
  });

  it("keys by branch and host and evicts the oldest of 64 lookups", async () => {
    const list = vi.spyOn(PROVIDERS.github, "list").mockResolvedValue(result(1));
    await gitPulls(root);
    for (let i = 0; i < 64; i++) {
      await exec("git", ["-C", root, "symbolic-ref", "HEAD", `refs/heads/topic-${i}`]);
      await gitPulls(root);
    }
    await exec("git", ["-C", root, "symbolic-ref", "HEAD", "refs/heads/feature"]);
    await gitPulls(root);
    expect(list).toHaveBeenCalledTimes(66);
    await exec("git", ["-C", root, "remote", "set-url", "origin", "git@github.com:sam/other.git"]);
    await gitPulls(root);
    expect(list).toHaveBeenCalledTimes(67);
  });
});
