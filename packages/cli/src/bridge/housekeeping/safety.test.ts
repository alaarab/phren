import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertHousekeepingGit, cacheDecision, checkoutBlockers, parseLsofCwds, removeCacheEntry, removeWorktreeSafely,
  SafetyViolation, type CacheRule, type InUseSources,
} from "./safety.js";

const execFileAsync = promisify(execFile);
const idle: InUseSources = { processes: async () => [], panes: async () => [] };
const created: string[] = [];
afterEach(async () => { for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function temp(prefix: string) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), prefix))); created.push(dir); return dir;
}

/** A repository pushed to a local bare remote, plus a linked worktree on a
 * branch that is also pushed: the "clean and pushed" baseline. */
async function pushedRepository() {
  const base = await temp("phren-hk-");
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: base,
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
  const git = async (cwd: string, ...args: string[]) => (await execFileAsync("git", ["-C", cwd, ...args], { env })).stdout;
  const remote = path.join(base, "remote.git"), root = path.join(base, "repo"), worktree = path.join(base, "repo-feature");
  await mkdir(root);
  await git(base, "init", "-q", "--bare", remote);
  await git(root, "init", "-q", "-b", "main");
  await writeFile(path.join(root, "a.txt"), "one\n");
  await git(root, "add", "."); await git(root, "commit", "-qm", "start");
  await git(root, "remote", "add", "origin", remote);
  await git(root, "push", "-q", "origin", "main");
  await git(root, "worktree", "add", "-q", "-b", "feature", worktree);
  await git(worktree, "push", "-q", "origin", "feature");
  return { base, root, worktree, remote, git };
}

const codes = (blockers: { code: string }[]) => blockers.map(b => b.code).sort();

describe("housekeeping git gate", () => {
  it.each([
    ["reset", "--hard"], ["reset", "--hard", "origin/main"], ["checkout", "--", "."], ["restore", "."], ["clean", "-fdx"],
    ["switch", "main"], ["push", "origin", "--delete", "feature"], ["branch", "-D", "feature"], ["stash", "drop"],
    ["stash", "clear"], ["stash", "pop"], ["worktree", "remove", "--force", "/x"], ["worktree", "remove", "-f", "/x"],
    ["worktree", "remove", "-ff", "/x"], ["worktree", "prune", "--expire", "now"], ["-c", "core.hooksPath=/x", "status"],
    ["-C", "/elsewhere", "reset", "--hard"], ["pull"], ["update-ref", "-d", "refs/heads/x"], ["gc", "--prune=now"],
  ])("refuses git %s", (...args) => {
    expect(() => assertHousekeepingGit(args)).toThrow(SafetyViolation);
  });

  it.each([
    ["status", "--porcelain=v1"], ["rev-list", "--count", "HEAD", "--not", "--remotes"], ["stash", "list"],
    ["submodule", "status", "--recursive"], ["worktree", "list", "--porcelain"], ["worktree", "remove", "--", "/x"],
    ["worktree", "prune", "--dry-run"],
  ])("admits git %s", (...args) => {
    expect(() => assertHousekeepingGit(args)).not.toThrow();
  });
});

describe("checkout blockers", () => {
  // Windows: git cannot remove a worktree a test process still holds open, and paths differ; housekeeping targets macOS and Linux (phren task).
  it.skipIf(process.platform === "win32")("finds nothing to lose in a clean, pushed worktree, and removes it without force", async () => {
    const { worktree, root, git } = await pushedRepository();
    expect(await checkoutBlockers(worktree, "worktree", idle)).toEqual([]);
    expect(await removeWorktreeSafely(worktree, idle)).toEqual({ removed: true, blockers: [] });
    await expect(stat(worktree)).rejects.toThrow();
    // The branch is left in place.
    expect(await git(root, "branch", "--list", "feature")).toContain("feature");
  });

  // 2026-11-08: worktrees with unpushed commits were deleted, and tracked edits
  // in about 24 repositories were discarded by `git reset --hard`.
  it("keeps a worktree with a commit on no remote", async () => {
    const { worktree, git } = await pushedRepository();
    await writeFile(path.join(worktree, "b.txt"), "two\n");
    await git(worktree, "add", "."); await git(worktree, "commit", "-qm", "local only");
    expect(codes(await checkoutBlockers(worktree, "worktree", idle))).toEqual(["unpushed-commits"]);
    const result = await removeWorktreeSafely(worktree, idle);
    expect(result.removed).toBe(false);
    expect((await stat(worktree)).isDirectory()).toBe(true);
  });

  // Windows: git cannot remove a worktree a test process still holds open, and paths differ; housekeeping targets macOS and Linux (phren task).
  it.skipIf(process.platform === "win32")("keeps a repository whose only unpushed work is on a branch that is not checked out", async () => {
    const { root, worktree, git } = await pushedRepository();
    await git(root, "worktree", "remove", worktree);
    await git(root, "branch", "side");
    await git(root, "worktree", "add", "-q", worktree, "side");
    await writeFile(path.join(worktree, "c.txt"), "c\n");
    await git(worktree, "add", "."); await git(worktree, "commit", "-qm", "side work");
    await git(root, "worktree", "remove", worktree);
    expect(codes(await checkoutBlockers(root, "repository", idle))).toEqual(["unpushed-commits"]);
  });

  it("keeps a checkout with tracked edits, untracked files, a stash or an operation in progress", async () => {
    const { root, worktree, git } = await pushedRepository();
    await writeFile(path.join(root, "a.txt"), "edited\n");
    await writeFile(path.join(root, "new.txt"), "new\n");
    expect(codes(await checkoutBlockers(root, "repository", idle))).toEqual(["linked-worktrees", "uncommitted-changes", "untracked-files"]);

    await writeFile(path.join(worktree, "a.txt"), "stashed\n");
    await git(worktree, "stash", "-q");
    await writeFile(path.join(root, ".git", "worktrees", "repo-feature", "MERGE_HEAD"), "0".repeat(40) + "\n");
    expect(codes(await checkoutBlockers(worktree, "worktree", idle))).toEqual(["in-progress-operation", "stash"]);
  });

  it("keeps a worktree whose submodule has edits or unpushed commits", async () => {
    const { base, worktree, git } = await pushedRepository();
    const lib = path.join(base, "lib");
    await mkdir(lib);
    await git(lib, "init", "-q", "-b", "main");
    await writeFile(path.join(lib, "l.txt"), "l\n");
    await git(lib, "add", "."); await git(lib, "commit", "-qm", "lib");
    await git(worktree, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "vendor/lib");
    await git(worktree, "commit", "-qm", "add submodule");
    await git(worktree, "push", "-q", "origin", "feature");
    const sub = path.join(worktree, "vendor/lib");
    await writeFile(path.join(sub, "l.txt"), "edited\n");
    // The superproject reports the dirty submodule too.
    expect(codes(await checkoutBlockers(worktree, "worktree", idle))).toEqual(["dirty-submodule", "uncommitted-changes"]);
    await git(sub, "commit", "-qam", "sub work");
    expect(codes(await checkoutBlockers(worktree, "worktree", idle))).toEqual(["uncommitted-changes", "unpushed-submodule"]);
  });

  it("keeps a checkout a process or pane is running in", async () => {
    const { worktree } = await pushedRepository();
    const sources: InUseSources = {
      processes: async () => [{ pid: 4242, cwd: path.join(worktree), command: "xcodebuild" }],
      panes: async () => [{ pane: "w1:p2", cwd: worktree, title: "ios-lead" }],
    };
    expect(codes(await checkoutBlockers(worktree, "worktree", sources))).toEqual(["bound-pane", "live-process"]);
    // A failed process listing keeps it as well.
    const broken: InUseSources = { processes: async () => { throw new Error("lsof failed"); }, panes: async () => [] };
    expect(codes(await checkoutBlockers(worktree, "worktree", broken))).toEqual(["inspection-failed"]);
  });

  it("refuses the main checkout as a worktree, a repository with linked worktrees, a symlink and a non-repository", async () => {
    const { base, root, worktree } = await pushedRepository();
    expect(codes(await checkoutBlockers(root, "worktree", idle))).toEqual(["main-checkout"]);
    expect(codes(await checkoutBlockers(root, "repository", idle))).toEqual(["linked-worktrees"]);
    const link = path.join(base, "link");
    await symlink(worktree, link);
    expect(codes(await checkoutBlockers(link, "worktree", idle))).toEqual(["symlink"]);
    const plain = path.join(base, "plain"); await mkdir(plain);
    expect(codes(await checkoutBlockers(plain, "worktree", idle))).toEqual(["inspection-failed"]);
  });
});

describe("cache allowlist", () => {
  async function caches() {
    const home = await temp("phren-hk-home-");
    const derived = path.join(home, "Library/Developer/Xcode/DerivedData");
    const deviceFs = path.join(home, "Library/Developer/CoreDevice/DeviceFS");
    await mkdir(derived, { recursive: true }); await mkdir(deviceFs, { recursive: true });
    const rules: CacheRule[] = [
      { id: "derived-data", root: derived, minAgeDays: 14 },
      // A rule that wrongly names a protected root still cannot reach it.
      { id: "bad-rule", root: path.join(home, "Library/Developer/CoreDevice"), minAgeDays: 0 },
    ];
    const old = async (p: string) => { await mkdir(p, { recursive: true }); const t = (Date.now() - 30 * 86_400_000) / 1000; await utimes(p, t, t); return p; };
    const context = { ...idle, rules, protected: [path.join(home, "Library/Developer/CoreDevice")] };
    return { home, derived, deviceFs, old, context };
  }

  it("acts on an old entry inside an allow-listed root and on nothing else", async () => {
    const { home, derived, deviceFs, old, context } = await caches();
    const stale = await old(path.join(derived, "App-abc"));
    expect(await cacheDecision(stale, context)).toEqual({ verdict: "auto", rule: "derived-data" });

    const fresh = path.join(derived, "App-new"); await mkdir(fresh);
    expect(await cacheDecision(fresh, context)).toMatchObject({ verdict: "suggest", reason: "too-recent" });
    expect(await cacheDecision(derived, context)).toMatchObject({ verdict: "suggest", reason: "outside-allowlist" });
    expect(await cacheDecision(await old(path.join(home, "elsewhere")), context)).toMatchObject({ verdict: "suggest", reason: "outside-allowlist" });
    expect(await cacheDecision(await old(path.join(deviceFs, "sim")), context)).toMatchObject({ verdict: "keep", reason: "protected-path" });
    // An ancestor of a protected root is protected too.
    expect(await cacheDecision(path.join(home, "Library/Developer"), context)).toMatchObject({ verdict: "keep", reason: "protected-path" });
  });

  it("never follows a symlink planted inside a cache root", async () => {
    const { home, derived, old, context } = await caches();
    const precious = await old(path.join(home, "Projects/app"));
    await writeFile(path.join(precious, "work.swift"), "x");
    const link = path.join(derived, "Trap");
    await symlink(precious, link);
    expect(await cacheDecision(link, context)).toMatchObject({ verdict: "keep", reason: "symlink" });
    expect((await removeCacheEntry(link, context)).removed).toBe(false);
    expect((await stat(path.join(precious, "work.swift"))).isFile()).toBe(true);
  });

  it("keeps a cache entry a process is using, and removes it once free", async () => {
    const { derived, old, context } = await caches();
    const entry = await old(path.join(derived, "App-busy"));
    const busy = { ...context, processes: async () => [{ pid: 7, cwd: path.join(entry, "Build") }] };
    expect(await removeCacheEntry(entry, busy)).toMatchObject({ removed: false, decision: { verdict: "keep", reason: "in-use" } });
    expect((await stat(entry)).isDirectory()).toBe(true);
    expect((await removeCacheEntry(entry, context)).removed).toBe(true);
    await expect(stat(entry)).rejects.toThrow();
  });
});

it("reads process folders from lsof's field output", () => {
  expect(parseLsofCwds("p12\ncnode\nn/Users/a/Projects/x\np13\ncxcodebuild\nn/tmp/build\n")).toEqual([
    { pid: 12, command: "node", cwd: "/Users/a/Projects/x" },
    { pid: 13, command: "xcodebuild", cwd: "/tmp/build" },
  ]);
});
