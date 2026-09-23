import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createLaunchWorktree, launchWorktreeSchema, worktreeFolderName } from "./launch-worktree.js";
import { launchSession } from "./server-launch.js";

const execFileAsync = promisify(execFile);

describe("launch worktrees", () => {
  const created: string[] = [];
  afterEach(async () => { for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true }); });

  async function folder(): Promise<string> {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), "phren-launch-worktree-"))); created.push(dir);
    return dir;
  }
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
  const git = async (cwd: string, ...args: string[]) => (await execFileAsync("git", ["-C", cwd, ...args], { env })).stdout;
  async function repository(): Promise<string> {
    const root = await folder();
    await git(root, "init", "-q", "-b", "main");
    await mkdir(path.join(root, "packages/app"), { recursive: true });
    await writeFile(path.join(root, "packages/app/index.ts"), "export {};\n");
    await git(root, "add", "."); await git(root, "commit", "-qm", "start");
    return root;
  }

  it("adds a worktree on a new branch from HEAD and starts in the project's own folder inside it", async () => {
    const root = await repository();
    const worktree = await createLaunchWorktree(path.join(root, "packages/app"), { branch: "phren/fix-login" });
    expect(worktree.path).toBe(path.join(root, ".claude/worktrees/phren-fix-login"));
    expect(worktree.cwd).toBe(path.join(worktree.path, "packages/app"));
    expect(await git(worktree.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("phren/fix-login\n");
    expect(await git(root, "rev-parse", "phren/fix-login")).toBe(await git(root, "rev-parse", "HEAD"));
    // The owner's checkout stays on its branch.
    expect(await git(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main\n");
    await worktree.discard();
    expect(await stat(worktree.path).catch(() => undefined)).toBeUndefined();
    expect(await git(root, "branch", "--list", "phren/fix-login")).toBe("");
  });

  it("refuses a folder outside Git, a repository with no commits, an existing branch or folder, and a bad name", async () => {
    const plain = await folder();
    await expect(createLaunchWorktree(plain, { branch: "phren/x" })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("not a Git repository") });
    const empty = await folder();
    await git(empty, "init", "-q");
    await expect(createLaunchWorktree(empty, { branch: "phren/x" })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("no commits") });
    const root = await repository();
    await expect(createLaunchWorktree(root, { branch: "main" })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('"main" already exists') });
    await mkdir(path.join(root, ".claude/worktrees/phren-taken"), { recursive: true });
    await expect(createLaunchWorktree(root, { branch: "phren/taken" })).rejects.toMatchObject({ status: 409, message: expect.stringContaining(".claude/worktrees/phren-taken already exists") });
    await expect(createLaunchWorktree(root, { branch: "bad..name" })).rejects.toMatchObject({ status: 400 });
    expect(await git(root, "branch", "--list", "phren/*")).toBe("");
  });

  it("accepts only plain branch names and makes a folder name of them", () => {
    expect(launchWorktreeSchema.safeParse({ branch: "phren/a1b2c3" }).success).toBe(true);
    for (const branch of ["-x", ".x", "a b", "a;b", "", "x".repeat(101)]) expect(launchWorktreeSchema.safeParse({ branch }).success, branch).toBe(false);
    expect(launchWorktreeSchema.safeParse({ branch: "x", path: "/tmp" }).success).toBe(false);
    expect(worktreeFolderName("phren/fix-login")).toBe("phren-fix-login");
    expect(worktreeFolderName("release/1.0")).toBe("release-1-0");
  });

  it("refuses a conductor in a worktree before asking Herdr for anything", async () => {
    const root = await repository();
    await expect(launchSession("default", { cwd: root, label: "c", kind: "claude", role: "conductor", worktree: { branch: "phren/c" } }))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining("cannot start in a worktree") });
    expect(await git(root, "branch", "--list", "phren/c")).toBe("");
  });
});
