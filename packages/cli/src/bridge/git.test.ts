import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { gitBranches, gitDiscard, gitLog, gitStage, gitStatus, gitTree, gitUnstage } from "./git.js";
import { BridgeError } from "./protocol.js";

const execFileAsync = promisify(execFile);

type Ref = { name: string; kind: string };
type Commit = { sha: string; short: string; subject: string; author: string; date: string; refs: Ref[]; parents: string[] };
type Log = { commits: Commit[]; uncommitted: { files: number; additions: number; deletions: number } };
type Branches = { current: string | null; local: { name: string }[]; remote: { name: string }[] };
type Tree = { path: string; version?: string; entries: { name: string; path: string; kind: string; status?: string; fileCount?: number }[] };

describe("git routes", () => {
  let created: string | undefined;
  afterEach(async () => { if (created) await rm(created, { recursive: true, force: true }); created = undefined; });

  /** A repository with one commit holding `root.txt`, a `folder/` file and an
   * ignore rule, ready for a test to dirty. */
  async function repository(): Promise<{ root: string; git: (...args: string[]) => Promise<string> }> {
    const root = created = await mkdtemp(path.join(tmpdir(), "phren-git-"));
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: root,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
    const git = async (...args: string[]) => (await execFileAsync("git", ["-C", root, ...args], { env })).stdout;
    await git("init", "-q", "-b", "main");
    await writeFile(path.join(root, "root.txt"), "one\n");
    await mkdir(path.join(root, "folder"));
    await writeFile(path.join(root, "folder/inner.txt"), "one\n");
    await writeFile(path.join(root, ".gitignore"), "ignored/\n");
    await git("add", ".");
    await git("commit", "-qm", "start");
    return { root, git };
  }

  it("counts staged, unstaged and untracked work and shows both edits of one file", async () => {
    const { root, git } = await repository();
    await writeFile(path.join(root, "root.txt"), "one\ntwo\n");
    await writeFile(path.join(root, "staged.txt"), "one\ntwo\n"); await git("add", "staged.txt");
    await writeFile(path.join(root, "untracked.txt"), "a\nb\n");
    const status = await gitStatus(root);
    expect(status.branch).toBe("main");
    expect(status.upstream).toBeNull();
    expect(status.staged).toBe(1); expect(status.unstaged).toBe(1); expect(status.untracked).toBe(1);
    const file = (name: string, staged: boolean) => status.files.find(entry => entry.path === name && entry.staged === staged);
    expect(file("root.txt", false)).toMatchObject({ status: "M", additions: 1, deletions: 0 });
    expect(file("staged.txt", true)).toMatchObject({ status: "A" });
    expect(file("staged.txt", false)).toBeUndefined();
    expect(file("untracked.txt", false)).toMatchObject({ status: "?", additions: 2, deletions: 0 });
    expect(status.additions).toBe(1 + 2 + 2); expect(status.deletions).toBe(0);
    // An edit after staging puts the same file in both sections, once per flag.
    await writeFile(path.join(root, "staged.txt"), "one\ntwo\nthree\n");
    const both = await gitStatus(root);
    expect(both.files.filter(entry => entry.path === "staged.txt").map(entry => entry.staged).sort()).toEqual([false, true]);
  });

  it("reads commits with a head ref, the branch as a local ref, and the uncommitted summary", async () => {
    const { root, git } = await repository();
    const log = await gitLog(root) as unknown as Log;
    expect(log.commits).toHaveLength(1);
    const commit = log.commits[0];
    expect(commit.subject).toBe("start");
    expect(commit.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(commit.short.length).toBeLessThan(40);
    expect(commit.author).toBe("t");
    expect(Number.isNaN(Date.parse(commit.date))).toBe(false);
    expect(commit.parents).toEqual([]);
    expect(commit.refs).toContainEqual({ name: "HEAD", kind: "head" });
    expect(commit.refs).toContainEqual({ name: "main", kind: "local" });
    await writeFile(path.join(root, "root.txt"), "one\ntwo\n");
    await git("add", "root.txt");
    const dirty = (await gitLog(root, 5) as unknown as Log).uncommitted;
    expect(dirty).toEqual({ files: 1, additions: 1, deletions: 0 });
  });

  it("lists the current branch and local branches", async () => {
    const { root, git } = await repository();
    await git("branch", "feature/one");
    const branches = await gitBranches(root) as unknown as Branches;
    expect(branches.current).toBe("main");
    expect(branches.local.map(branch => branch.name).sort()).toEqual(["feature/one", "main"]);
    expect(branches.remote).toEqual([]);
  });

  it("reads the selected ref instead of HEAD and rejects options and unknown refs", async () => {
    const { root, git } = await repository();
    await git("branch", "release/1.0");
    await git("commit", "--allow-empty", "-qm", "main only");
    expect((await gitLog(root, 60, "release/1.0") as unknown as Log).commits.map(commit => commit.subject)).toEqual(["start"]);
    expect((await gitLog(root, 1) as unknown as Log).commits.map(commit => commit.subject)).toEqual(["main only"]);
    for (const ref of ["--all", "missing", "main\0", ""]) {
      await expect(gitLog(root, 60, ref)).rejects.toBeInstanceOf(BridgeError);
    }
  });

  it("reports a detached HEAD and unstages a new repository without deleting its file", async () => {
    const { root, git } = await repository();
    await git("checkout", "--detach", "-q");
    expect((await gitBranches(root) as unknown as Branches).current).toBeNull();
    await git("checkout", "--orphan", "empty", "-q");
    await gitUnstage(root, ["root.txt"]);
    expect(await readFile(path.join(root, "root.txt"), "utf8")).toBe("one\n");
    expect(await git("ls-files", "root.txt")).toBe("");
  });

  it("rejects symlink escapes for reads and all writes before changing any path", async () => {
    const { root, git } = await repository();
    const outside = await mkdtemp(path.join(tmpdir(), "phren-git-outside-"));
    try {
      await writeFile(path.join(outside, "secret.txt"), "private\ncontents\n");
      await symlink(outside, path.join(root, "escape"));
      await symlink(path.join(outside, "secret.txt"), path.join(root, "secret-link"));
      await symlink(path.join(outside, "missing"), path.join(root, "dangling"));
      await writeFile(path.join(root, "root.txt"), "edited\n");
      for (const file of ["escape/secret.txt", "escape/missing.txt", "secret-link", "dangling"]) {
        await expect(gitTree(root, file)).rejects.toBeInstanceOf(BridgeError);
        for (const write of [gitStage, gitUnstage, gitDiscard]) {
          await expect(write(root, ["root.txt", file])).rejects.toBeInstanceOf(BridgeError);
        }
      }
      expect(await git("diff", "--cached", "--name-only")).toBe("");
      expect(await readFile(path.join(root, "root.txt"), "utf8")).toBe("edited\n");
      expect(await readFile(path.join(outside, "secret.txt"), "utf8")).toBe("private\ncontents\n");
      expect((await gitStatus(root)).files.find(file => file.path === "secret-link")?.additions).toBe(0);
    } finally { await rm(outside, { recursive: true, force: true }); }
  });

  it("handles deleted files and literal pathspec characters without touching their neighbors", async () => {
    const { root, git } = await repository();
    await rm(path.join(root, "folder"), { recursive: true });
    await gitStage(root, ["folder/inner.txt"]);
    await gitUnstage(root, ["folder/inner.txt"]);
    await gitDiscard(root, ["folder/inner.txt"]);
    expect(await readFile(path.join(root, "folder/inner.txt"), "utf8")).toBe("one\n");
    // Windows file names cannot contain "*", so the literal pathspec file is POSIX-only.
    if (process.platform !== "win32") {
      await writeFile(path.join(root, "*.txt"), "literal\n");
      await writeFile(path.join(root, "keep.txt"), "keep\n");
      await gitDiscard(root, ["*.txt"]);
      expect(await readFile(path.join(root, "keep.txt"), "utf8")).toBe("keep\n");
    }
    await mkdir(path.join(root, "untracked-dir"));
    await writeFile(path.join(root, "untracked-dir/keep.txt"), "keep\n");
    await expect(gitDiscard(root, ["untracked-dir"])).rejects.toThrow();
    expect(await readFile(path.join(root, "untracked-dir/keep.txt"), "utf8")).toBe("keep\n");
  });

  it("keeps a replacement directory navigable while its tracked file is deleted", async () => {
    const { root } = await repository();
    await rm(path.join(root, "root.txt"));
    await mkdir(path.join(root, "root.txt"));
    await writeFile(path.join(root, "root.txt/child.ts"), "export const value = 1;\n");
    const tree = await gitTree(root) as unknown as Tree;
    expect(tree.entries.find(entry => entry.path === "root.txt"))
      .toMatchObject({ kind: "dir", fileCount: 1, status: "changed" });
    expect((await gitTree(root, "root.txt") as unknown as Tree).entries)
      .toContainEqual({ name: "child.ts", path: "root.txt/child.ts", kind: "file", status: "?" });
  });

  it("bounds cached directory reads in a repository with more than 3000 files", async () => {
    const { root } = await repository();
    await Promise.all(Array.from({ length: 32 }, async (_, index) => {
      const directory = path.join(root, `large/group-${index}`);
      await mkdir(directory, { recursive: true });
      await Promise.all(Array.from({ length: 100 }, (_, file) => writeFile(path.join(directory, `file-${file}.ts`), "export const value = 1;\n")));
    }));
    const cold = await gitTree(root);
    expect((cold.entries as Tree["entries"]).find(entry => entry.name === "large")?.fileCount).toBe(3200);
    const started = performance.now();
    const child = await gitTree(root, "large/group-12");
    const elapsed = performance.now() - started;
    expect(child.entries).toHaveLength(100);
    expect(child.version).toBe(cold.version);
    expect(elapsed).toBeLessThan(500);
  });

  it("refreshes cached children on status, mutations and HEAD changes and counts descendants", async () => {
    const { root, git } = await repository();
    const initial = await gitTree(root);
    expect((initial.entries as Tree["entries"]).find(entry => entry.path === "folder").fileCount).toBe(1);
    expect((await gitTree(root, "folder")).version).toBe(initial.version);
    await writeFile(path.join(root, "folder/new.txt"), "new\n");
    await gitStatus(root);
    const refreshed = await gitTree(root, "folder");
    expect(refreshed.version).not.toBe(initial.version);
    expect((refreshed.entries as Tree["entries"]).map(entry => entry.path)).toContain("folder/new.txt");
    await gitStage(root, ["folder/new.txt"]);
    expect(((await gitTree(root, "folder")).entries as Tree["entries"]).find(entry => entry.name === "new.txt").status).toBe("A");
    await git("commit", "-qm", "add file");
    expect(((await gitTree(root, "folder")).entries as Tree["entries"]).find(entry => entry.name === "new.txt").status).toBeUndefined();
    await writeFile(path.join(root, "folder/later.txt"), "later\n");
    await new Promise(resolve => setTimeout(resolve, 2100));
    expect(((await gitTree(root, "folder")).entries as Tree["entries"]).map(entry => entry.name)).toContain("later.txt");
  });

  it("lists a tree one level deep, directories first, and marks a changed folder", async () => {
    const { root } = await repository();
    await writeFile(path.join(root, "folder/inner.txt"), "one\ntwo\n");
    await mkdir(path.join(root, "ignored"));
    await writeFile(path.join(root, "ignored/secret.txt"), "hidden\n");
    const tree = await gitTree(root) as unknown as Tree;
    expect(tree.path).toBe("");
    expect(tree.entries[0]).toMatchObject({ name: "folder", kind: "dir", status: "changed" });
    expect(tree.entries.find(entry => entry.name === "ignored")).toBeUndefined();
    const rootFile = tree.entries.find(entry => entry.name === "root.txt");
    expect(rootFile).toMatchObject({ kind: "file" });
    expect(rootFile?.status).toBeUndefined();
    const folder = await gitTree(root, "folder") as unknown as Tree;
    expect(folder.entries).toEqual([{ name: "inner.txt", path: "folder/inner.txt", kind: "file", status: "M" }]);
  });

  it("flips the staged flag with stage and unstage", async () => {
    const { root } = await repository();
    await writeFile(path.join(root, "root.txt"), "one\ntwo\n");
    const staged = (status: Awaited<ReturnType<typeof gitStatus>>) => status.files.find(entry => entry.path === "root.txt" && entry.staged);
    expect(staged(await gitStatus(root))).toBeUndefined();
    await gitStage(root, ["root.txt"]);
    expect(staged(await gitStatus(root))).toMatchObject({ status: "M" });
    await gitUnstage(root, ["root.txt"]);
    const back = await gitStatus(root);
    expect(staged(back)).toBeUndefined();
    expect(back.files.find(entry => entry.path === "root.txt" && !entry.staged)).toMatchObject({ status: "M" });
  });

  it("restores a tracked file and removes an untracked one on discard", async () => {
    const { root } = await repository();
    await writeFile(path.join(root, "root.txt"), "rewritten\n");
    await writeFile(path.join(root, "untracked.txt"), "new\n");
    await gitDiscard(root, ["root.txt", "untracked.txt"]);
    expect(await readFile(path.join(root, "root.txt"), "utf8")).toBe("one\n");
    await expect(stat(path.join(root, "untracked.txt"))).rejects.toThrow();
    expect((await gitStatus(root)).files).toEqual([]);
  });

  it("refuses paths outside the repository and never a non-repository", async () => {
    const { root } = await repository();
    for (const bad of ["../x", "/etc/passwd", "/", "-rf", "././-rf", "folder/../../x", "folder\\..\\x", "\0"]) {
      await expect(gitTree(root, bad)).rejects.toBeInstanceOf(BridgeError);
      await expect(gitStage(root, [bad])).rejects.toBeInstanceOf(BridgeError);
      await expect(gitUnstage(root, [bad])).rejects.toBeInstanceOf(BridgeError);
      await expect(gitDiscard(root, [bad])).rejects.toBeInstanceOf(BridgeError);
    }
    await expect(gitStage(root, Array.from({ length: 65 }, (_, index) => `file-${index}`))).rejects.toBeInstanceOf(BridgeError);
    const plain = await mkdtemp(path.join(tmpdir(), "phren-not-git-"));
    try {
      await expect(gitStatus(plain)).rejects.toMatchObject({ status: 409 });
    } finally { await rm(plain, { recursive: true, force: true }); }
  });
});
