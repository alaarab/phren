import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as gitHosts from "./git-hosts.js";
import { PROVIDERS, type RequestList } from "./git-hosts.js";
import { gitPulls } from "./git.js";
import { gitHostToken, gitMergeRequest, gitPullRequest } from "./git-publish.js";
import { gitCheckout } from "./git-sync.js";
import { git, withGitReadDeadline } from "./projects.js";
import { ghHostBlock } from "./git-host-auth.js";

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
  afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

  it("names each checkout's own repository and remote even when worktrees share the cached list", async () => {
    vi.spyOn(PROVIDERS.github, "list").mockResolvedValue(result(1));
    await exec("git", ["-C", root, "-c", "user.email=sam@example.com", "-c", "user.name=Sam", "commit", "-q", "--allow-empty", "-m", "Start"]);
    await exec("git", ["-C", root, "checkout", "-q", "--detach"]);
    const worktree = path.join(root, "linked");
    await exec("git", ["-C", root, "worktree", "add", "-q", "--detach", worktree]);
    expect(await gitPulls(root)).toMatchObject({ repository: root, remote: "github.com/sam/app" });
    expect(await gitPulls(worktree)).toMatchObject({ repository: worktree, remote: "github.com/sam/app" });
  });

  it("binds GitHub cards to the repository gh lists and merges in, which for a fork is its upstream", async () => {
    // origin is the fork; gh resolves the upstream, and its pull request URLs say so.
    vi.spyOn(PROVIDERS.github, "list").mockResolvedValue({ available: true, pulls: [{ number: 42, url: "https://github.com/Org/app/pull/42" }], current: null, repository: "https://github.com/Org/app" });
    expect(await gitPulls(root)).toMatchObject({ remote: "github.com/org/app" });
    const resolved = vi.spyOn(PROVIDERS.github, "repository").mockResolvedValue("https://github.com/org/app");
    const merge = vi.spyOn(PROVIDERS.github, "merge").mockResolvedValue({ ok: true });
    expect(await gitMergeRequest(root, { number: 42, expectedRemote: "github.com/org/app" })).toMatchObject({ ok: true });
    // The checked repository is the one merged in, whatever gh would resolve a moment later.
    expect(merge.mock.calls[0][1]).toMatchObject({ number: 42, repository: "github.com/org/app" });
    expect(merge.mock.calls[0][1]).not.toHaveProperty("expectedRemote");
    // `gh repo set-default` (or a new upstream remote) since the review: same number, another repository.
    resolved.mockResolvedValue("https://github.com/other/app");
    await expect(gitMergeRequest(root, { number: 42, expectedRemote: "github.com/org/app" })).rejects.toMatchObject({ status: 409, details: { code: "git-remote-changed" } });
    // gh cannot say: refused rather than merged unchecked.
    resolved.mockResolvedValue(null);
    await expect(gitMergeRequest(root, { number: 42, expectedRemote: "github.com/org/app" })).rejects.toMatchObject({ status: 409 });
    expect(merge).toHaveBeenCalledTimes(1);
    // Without the field a merge is as before: no repository named.
    await gitMergeRequest(root, { number: 42 });
    expect(merge.mock.calls[1][1]).not.toHaveProperty("repository");
  });

  it("reads the repository from gh's own pull request URLs and merges there with --repo", async () => {
    const bin = path.join(root, "bin"), log = path.join(root, "gh.log");
    await mkdir(bin);
    const pull = { number: 42, title: "Fix", headRefName: "topic", baseRefName: "main", author: { login: "sam" }, url: "https://github.com/org/app/pull/42", isDraft: false, state: "OPEN", updatedAt: "2026-10-27T00:00:00Z" };
    await writeFile(path.join(bin, "gh"), [
      "#!/bin/sh", `echo "$*" >> '${log}'`,
      'case "$1 $2" in',
      `  "pr list") echo '${JSON.stringify([pull])}' ;;`,
      '  "repo view") echo "https://github.com/org/app" ;;',
      '  "pr merge") exit 0 ;;',
      "  *) echo null ;;",
      "esac", "",
    ].join("\n"), { mode: 0o755 });
    vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
    vi.stubEnv("GH_CONFIG_DIR", path.join(root, "gh"));
    expect(await gitPulls(root)).toMatchObject({ available: true, pulls: [{ number: 42 }], remote: "github.com/org/app" });
    expect(await gitMergeRequest(root, { number: 42, method: "squash", expectedRemote: "github.com/org/app" })).toMatchObject({ ok: true, number: 42 });
    expect((await readFile(log, "utf8")).split("\n")).toContain("pr merge 42 --squash --repo github.com/org/app");
  });

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

  // Eviction at the 64-entry limit is LookupCache's own test; 64 rounds of
  // real git spawns here took longer than the timeout on Windows.
  it("keys by branch and host", async () => {
    const list = vi.spyOn(PROVIDERS.github, "list").mockResolvedValue(result(1));
    const checkout = (branch: string) => writeFile(path.join(root, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
    await gitPulls(root);
    await checkout("topic");
    await gitPulls(root);
    expect(list).toHaveBeenCalledTimes(2);
    await checkout("feature");
    await gitPulls(root);
    expect(list).toHaveBeenCalledTimes(2);
    await exec("git", ["-C", root, "remote", "set-url", "origin", "git@github.com:sam/other.git"]);
    await gitPulls(root);
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("an auth refusal replaces a cached success instead of serving it until max age", async () => {
    const list = vi.spyOn(PROVIDERS.github, "list").mockResolvedValue(result(1));
    await gitPulls(root);
    now += 30_001;
    list.mockResolvedValue({ available: false, reason: "auth", pulls: [], current: null });
    await gitPulls(root); // stale while the refresh runs
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(await gitPulls(root)).toMatchObject({ available: false, reason: "auth" });
  });

  it("a sign-in during a cold lookup reads again under the new credentials instead of failing", async () => {
    vi.stubEnv("GH_CONFIG_DIR", path.join(root, "gh"));
    await mkdir(path.join(root, "gh"));
    const file = path.join(root, "gh", "hosts.yml");
    await writeFile(file, "github.com:\n  user: old-account\n");
    const first = deferred<RequestList>();
    const list = vi.spyOn(PROVIDERS.github, "list").mockReturnValueOnce(first.promise).mockResolvedValue(result(2));
    const call = gitPulls(root);
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    await writeFile(file, "github.com:\n  user: new-account\n");
    first.resolve(result(1));
    expect(await call).toMatchObject({ pulls: [{ number: 2 }] });
  });

  it("signing into another gh host leaves github.com's cached pulls alone", async () => {
    vi.stubEnv("GH_CONFIG_DIR", path.join(root, "gh"));
    await mkdir(path.join(root, "gh"));
    const file = path.join(root, "gh", "hosts.yml");
    await writeFile(file, "github.com:\n  user: sam\n");
    const list = vi.spyOn(PROVIDERS.github, "list").mockResolvedValue(result(1));
    await gitPulls(root);
    await writeFile(file, "github.com:\n  user: sam\nghe.example.com:\n  user: work\n");
    await gitPulls(root);
    expect(list).toHaveBeenCalledTimes(1);
  });

  describe("per-checkout target memo", () => {
    it("looks up root, branch and host once while HEAD and config are unchanged, and shares concurrent lookups", async () => {
      vi.spyOn(PROVIDERS.github, "list").mockResolvedValue(result(1));
      const detect = vi.spyOn(gitHosts, "detectHost");
      await Promise.all([gitPulls(root), gitPulls(root), gitPulls(root)]);
      expect(detect).toHaveBeenCalledTimes(1);
      await gitPulls(root);
      await gitPulls(root);
      expect(detect).toHaveBeenCalledTimes(1);
    });

    it("looks again after HEAD or the repository config changes, and after the memo expires", async () => {
      vi.spyOn(PROVIDERS.github, "list").mockResolvedValue(result(1));
      const detect = vi.spyOn(gitHosts, "detectHost");
      await gitPulls(root);
      await writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/topic\n");
      expect((await gitPulls(root)).branch).toBe("topic");
      expect(detect).toHaveBeenCalledTimes(2);
      await exec("git", ["-C", root, "remote", "set-url", "origin", "git@github.com:sam/moved.git"]);
      expect(((await gitPulls(root)).host as { webUrl: string }).webUrl).toContain("sam/moved");
      expect(detect).toHaveBeenCalledTimes(3);
      now += 10_001;
      await gitPulls(root);
      expect(detect).toHaveBeenCalledTimes(4);
    });

    it("does not memoize a failed lookup", async () => {
      // Outside this checkout, so no enclosing repository answers.
      const outside = await realpath(await mkdtemp(path.join(tmpdir(), "not-a-repo-")));
      try {
        await expect(gitPulls(outside)).rejects.toThrow();
        await exec("git", ["init", "-q", "-b", "feature", outside]);
        vi.spyOn(PROVIDERS.github, "list").mockResolvedValue(result(1));
        expect(await gitPulls(outside)).toMatchObject({ branch: "feature" });
      } finally { await rm(outside, { recursive: true, force: true }); }
    });
  });

  it("ghHostBlock returns only that host's lines", () => {
    const yml = "github.com:\n    user: sam\n    git_protocol: ssh\nghe.example.com:\n    user: work\n";
    expect(ghHostBlock(yml, "github.com")).toBe("github.com:\n    user: sam\n    git_protocol: ssh");
    expect(ghHostBlock(yml, "GHE.example.com.")).toBe("ghe.example.com:\n    user: work");
    expect(ghHostBlock(yml, "gitlab.com")).toBe("");
  });
});
