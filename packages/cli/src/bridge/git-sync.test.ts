import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { checkRuns, gitShow, gitStatus } from "./git.js";
import { gitCheckout, gitFetch, gitPull } from "./git-sync.js";
import { BridgeError } from "./protocol.js";

const execFileAsync = promisify(execFile);

type Section = { kind: string; patch: string; binary: boolean; truncated: boolean };
type ShowFile = { path: string; oldPath?: string; status: string; additions: number; deletions: number; binary: boolean; sections: Section[] };
type Show = { sha: string; short: string; subject: string; body: string; author: string; parents: string[]; refs: { name: string; kind: string }[];
  files: ShowFile[]; totalFiles: number; additions: number; deletions: number; truncated: boolean };

describe("git commit detail, branches and sync", () => {
  const saved = process.env.GIT_CONFIG_GLOBAL;
  let scratch: string;
  beforeAll(async () => {
    scratch = await realpath(await mkdtemp(path.join(tmpdir(), "phren-sync-")));
    // The machine's own global config (hooksPath, signing, pull.rebase) must not leak in.
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  });
  afterAll(async () => {
    if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved;
    await rm(scratch, { recursive: true, force: true });
  });
  let created: string[] = [];
  afterEach(async () => { for (const dir of created) await rm(dir, { recursive: true, force: true }); created = []; });

  const run = async (cwd: string, ...args: string[]) => (await execFileAsync("git", ["-C", cwd, ...args])).stdout;
  async function identity(root: string) {
    await run(root, "config", "user.name", "sam");
    await run(root, "config", "user.email", "sam@example.com");
  }

  /** A clone of a bare remote whose `main` has one commit, plus a second
   * clone ("other") that can move the remote on. */
  async function clone() {
    const base = await mkdtemp(path.join(scratch, "repo-"));
    created.push(base);
    const remote = path.join(base, "remote.git"), root = path.join(base, "work"), other = path.join(base, "other");
    await execFileAsync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    await execFileAsync("git", ["init", "-q", "-b", "main", root]);
    await identity(root);
    await writeFile(path.join(root, "README.md"), "one\n");
    await run(root, "add", ".");
    await run(root, "commit", "-qm", "start");
    await run(root, "remote", "add", "origin", remote);
    await run(root, "push", "-q", "-u", "origin", "main");
    await execFileAsync("git", ["clone", "-q", remote, other]);
    await identity(other);
    return { root, other, git: (...args: string[]) => run(root, ...args), otherGit: (...args: string[]) => run(other, ...args) };
  }

  async function rejects(promise: Promise<unknown>, status: number, text: RegExp, code?: string) {
    const error = await promise.then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(BridgeError);
    expect((error as BridgeError).status).toBe(status);
    expect((error as BridgeError).message).toMatch(text);
    if (code) expect((error as BridgeError).details?.code).toBe(code);
  }

  it("shows a commit's message, refs and each file's counts and patch against its first parent", async () => {
    const { root, git } = await clone();
    await writeFile(path.join(root, "README.md"), "one\ntwo\n");
    await writeFile(path.join(root, "new.txt"), "a\nb\nc\n");
    await writeFile(path.join(root, "image.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
    await git("add", ".");
    await git("commit", "-qm", "Add things\n\nWhy they were added.\nSecond line.");
    const sha = (await git("rev-parse", "HEAD")).trim();
    const show = await gitShow(root, sha) as unknown as Show;
    expect(show).toMatchObject({ sha, subject: "Add things", body: "Why they were added.\nSecond line.", author: "sam", totalFiles: 3, additions: 4, deletions: 0, truncated: false });
    expect(show.parents).toHaveLength(1);
    expect(show.refs).toEqual(expect.arrayContaining([{ name: "HEAD", kind: "head" }, { name: "main", kind: "local" }]));
    const file = (name: string) => show.files.find(entry => entry.path === name)!;
    expect(file("README.md")).toMatchObject({ status: "M", additions: 1, deletions: 0, binary: false });
    expect(file("README.md").sections[0]).toMatchObject({ kind: "commit", binary: false, truncated: false });
    expect(file("README.md").sections[0].patch).toContain("+two");
    expect(file("new.txt")).toMatchObject({ status: "A", additions: 3 });
    expect(file("image.bin")).toMatchObject({ status: "A", binary: true, additions: 0 });
    expect(file("image.bin").sections[0]).toMatchObject({ binary: true, patch: "" });
    // A short hash works; the root commit compares with the empty tree.
    const first = await gitShow(root, (await git("rev-parse", "--short", "HEAD~1")).trim()) as unknown as Show;
    expect(first).toMatchObject({ subject: "start", body: "", parents: [] });
    expect(first.files).toEqual([expect.objectContaining({ path: "README.md", status: "A", additions: 1 })]);
  });

  it("shows a rename with both names and refuses anything but a known hash", async () => {
    const { root, git } = await clone();
    await writeFile(path.join(root, "long.txt"), Array.from({ length: 20 }, (_, i) => `line ${i}\n`).join(""));
    await git("add", "."); await git("commit", "-qm", "long");
    await git("mv", "long.txt", "moved.txt");
    await git("commit", "-qm", "move");
    const show = await gitShow(root, (await git("rev-parse", "HEAD")).trim()) as unknown as Show;
    expect(show.files).toEqual([expect.objectContaining({ path: "moved.txt", oldPath: "long.txt", status: "R", additions: 0, deletions: 0 })]);
    await rejects(gitShow(root, "HEAD"), 400, /hash/);
    await rejects(gitShow(root, "--all"), 400, /hash/);
    await rejects(gitShow(root, "deadbeef"), 404, /no such commit/, "git-unknown-commit");
  });

  it("switches to a local branch and creates one from HEAD or a remote branch", async () => {
    const { root, git, otherGit, other } = await clone();
    await git("branch", "feature/a");
    expect(await gitCheckout(root, { branch: "feature/a" })).toMatchObject({ ok: true, branch: "feature/a", previous: "main", changed: true });
    expect((await git("branch", "--show-current")).trim()).toBe("feature/a");
    // Already there: nothing runs.
    expect(await gitCheckout(root, { branch: "feature/a" })).toMatchObject({ ok: true, changed: false });

    expect(await gitCheckout(root, { branch: "feature/b", create: true })).toMatchObject({ ok: true, branch: "feature/b", created: true });
    expect((await git("for-each-ref", "--format=%(upstream:short)", "refs/heads/feature/b")).trim()).toBe("");

    // A branch someone else pushed, checked out tracking its remote.
    await otherGit("checkout", "-q", "-b", "agent/work");
    await writeFile(path.join(other, "w.txt"), "w\n");
    await otherGit("add", "."); await otherGit("commit", "-qm", "agent work");
    await otherGit("push", "-q", "-u", "origin", "agent/work");
    await gitFetch(root);
    const tracked = await gitCheckout(root, { branch: "agent/work", create: true, startPoint: "origin/agent/work" });
    expect(tracked).toMatchObject({ ok: true, branch: "agent/work", upstream: "origin/agent/work" });
    expect((await git("log", "-1", "--format=%s")).trim()).toBe("agent work");
  });

  it("refuses bad names, missing branches and existing ones, and carries edits only when asked", async () => {
    const { root, git } = await clone();
    await rejects(gitCheckout(root, { branch: "-b" }), 400, /valid branch/);
    await rejects(gitCheckout(root, { branch: "a..b", create: true }), 400, /not a valid branch/);
    await rejects(gitCheckout(root, { branch: "with space", create: true }), 400, /valid branch/);
    await rejects(gitCheckout(root, { branch: "nope" }), 404, /no local branch/, "git-unknown-ref");
    await rejects(gitCheckout(root, { branch: "main", create: true }), 409, /already exists/, "git-branch-exists");
    await rejects(gitCheckout(root, { branch: "x", create: true, startPoint: "origin/nope" }), 404, /no branch named/);
    await rejects(gitCheckout(root, { branch: "main", startPoint: "main" }), 400, /new branch/);

    await git("branch", "side");
    await writeFile(path.join(root, "README.md"), "edited\n");
    await rejects(gitCheckout(root, { branch: "side" }), 409, /1 file has uncommitted changes/, "git-dirty");
    expect((await git("branch", "--show-current")).trim()).toBe("main");
    expect(await gitCheckout(root, { branch: "side", carryChanges: true })).toMatchObject({ ok: true, branch: "side", carried: 1 });
    expect((await gitStatus(root)).files).toEqual([expect.objectContaining({ path: "README.md", staged: false })]);

    // Git's own refusal (an edit it would overwrite) comes back verbatim.
    await git("checkout", "-q", "--", "README.md");
    await writeFile(path.join(root, "README.md"), "on side\n");
    await git("commit", "-qam", "side edit");
    await writeFile(path.join(root, "README.md"), "dirty\n");
    const refused = await gitCheckout(root, { branch: "main", carryChanges: true });
    expect(refused.ok).toBe(false);
    expect(String(refused.output)).toMatch(/would be overwritten/);
    expect((await git("branch", "--show-current")).trim()).toBe("side");
  });

  it("fetches the upstream remote, then fast-forwards and refuses a diverged branch", async () => {
    const { root, git, other, otherGit } = await clone();
    await writeFile(path.join(other, "README.md"), "one\nremote\n");
    await otherGit("commit", "-qam", "remote one");
    await writeFile(path.join(other, "b.txt"), "b\n");
    await otherGit("add", "."); await otherGit("commit", "-qm", "remote two");
    await otherGit("push", "-q");
    expect((await gitStatus(root)).behind).toBe(0);
    expect(await gitFetch(root)).toMatchObject({ ok: true, remote: "origin" });
    expect((await gitStatus(root)).behind).toBe(2);
    expect(await gitPull(root)).toMatchObject({ ok: true, branch: "main", upstream: "origin/main", commits: 2 });
    expect((await gitStatus(root)).behind).toBe(0);
    expect(await gitPull(root)).toMatchObject({ ok: true, commits: 0 });

    await writeFile(path.join(other, "c.txt"), "c\n");
    await otherGit("add", "."); await otherGit("commit", "-qm", "remote three"); await otherGit("push", "-q");
    await writeFile(path.join(root, "d.txt"), "d\n");
    await git("add", "."); await git("commit", "-qm", "local");
    const before = (await git("rev-parse", "HEAD")).trim();
    const diverged = await gitPull(root);
    expect(diverged.ok).toBe(false);
    expect(String(diverged.output)).toMatch(/fast-forward|diverg/i);
    expect((await git("rev-parse", "HEAD")).trim()).toBe(before);

    await git("checkout", "-q", "-b", "lonely");
    await rejects(gitPull(root), 409, /no upstream/, "git-no-upstream");
    await git("checkout", "-q", "--detach");
    await rejects(gitPull(root), 409, /detached/);
  });

  it("refuses to fetch without a remote", async () => {
    const base = await mkdtemp(path.join(scratch, "solo-"));
    created.push(base);
    await execFileAsync("git", ["init", "-q", "-b", "main", base]);
    await rejects(gitFetch(base), 409, /no remote/, "git-no-remote");
  });

  it("lists each check with one state word, failing first", () => {
    expect(checkRuns(undefined)).toEqual([]);
    expect(checkRuns([
      { __typename: "CheckRun", name: "build", workflowName: "CI", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://github.com/a/b/runs/1" },
      { __typename: "CheckRun", name: "lint", workflowName: "CI", status: "IN_PROGRESS", conclusion: "", detailsUrl: "javascript:alert(1)" },
      { __typename: "StatusContext", context: "ci/legacy", state: "ERROR", targetUrl: "https://ci.example.com/1" },
      { __typename: "CheckRun", name: "docs", status: "COMPLETED", conclusion: "SKIPPED" },
      { __typename: "CheckRun", name: "", status: "COMPLETED", conclusion: "NEUTRAL" },
    ])).toEqual([
      { name: "ci/legacy", state: "failing", url: "https://ci.example.com/1" },
      { name: "lint", state: "pending", workflow: "CI" },
      { name: "build", state: "passing", workflow: "CI", url: "https://github.com/a/b/runs/1" },
      { name: "docs", state: "skipped" },
      { name: "Check", state: "neutral" },
    ]);
  });
});
