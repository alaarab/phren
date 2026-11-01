import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeError } from "./protocol.js";
import { previewWorktreeRemoval, removeWorktree } from "./git-worktree-remove.js";
import { worktreeId } from "./git-worktrees.js";

const execFileAsync = promisify(execFile);

describe("safe worktree removal", () => {
  const created: string[] = [];
  afterEach(async () => { for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true }); });

  /** A repository with one commit plus two linked worktrees: one inside it and
   * one beside it, each on its own branch. */
  async function repository() {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "phren-remove-"))); created.push(base);
    const root = path.join(base, "repo"); await mkdir(root);
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: base,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
    const git = async (cwd: string, ...args: string[]) => (await execFileAsync("git", ["-C", cwd, ...args], { env })).stdout;
    await git(root, "init", "-q", "-b", "main");
    await writeFile(path.join(root, "root.txt"), "one\n");
    await git(root, "add", "."); await git(root, "commit", "-qm", "start");
    const inside = path.join(root, ".claude/worktrees/agent-one");
    await git(root, "worktree", "add", "-q", "-b", "worktree-agent-one", inside);
    await mkdir(path.join(inside, "src"));
    const beside = path.join(base, "repo-fanout");
    await git(root, "worktree", "add", "-q", "-b", "fanout/review", beside);
    return { base, root, inside, beside, git };
  }

  /** The same repository, with a submodule cloned from a local repository. */
  async function submoduleRepository() {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "phren-remove-sub-"))); created.push(base);
    const root = path.join(base, "repo"), subrepo = path.join(base, "subrepo");
    await mkdir(root); await mkdir(subrepo);
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: base,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
    const git = async (cwd: string, ...args: string[]) => (await execFileAsync("git", ["-C", cwd, ...args], { env })).stdout;
    await git(subrepo, "init", "-q", "-b", "main");
    await writeFile(path.join(subrepo, "lib.txt"), "lib\n");
    await git(subrepo, "add", "."); await git(subrepo, "commit", "-qm", "lib");
    await git(root, "init", "-q", "-b", "main");
    await writeFile(path.join(root, "root.txt"), "one\n");
    await git(root, "add", "."); await git(root, "commit", "-qm", "start");
    await git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", subrepo, "sub");
    await git(root, "commit", "-qm", "add submodule");
    const beside = path.join(base, "repo-fanout");
    await git(root, "worktree", "add", "-q", "-b", "fanout/review", beside);
    await git(beside, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive");
    return { base, root, beside, git };
  }

  it("previews a clean linked worktree as removable without losing anything", async () => {
    const { root, beside } = await repository();
    const preview = await previewWorktreeRemoval(root, worktreeId(beside));
    expect(preview).toMatchObject({ branch: "fanout/review", dirty: [], untracked: 0, submodules: [], sessions: [], removable: true });
    expect(preview.reason).toBeUndefined();
    expect(preview.path.endsWith("repo-fanout")).toBe(true);
    expect(preview.token).toMatch(/^[a-f0-9]{64}$/);
  });

  it("reports the changed paths and untracked count a dirty worktree would lose", async () => {
    const { root, beside, git } = await repository();
    await writeFile(path.join(beside, "root.txt"), "one\ntwo\n");
    await writeFile(path.join(beside, "new.txt"), "new\n");
    await mkdir(path.join(beside, "notes"));
    await writeFile(path.join(beside, "notes/a.txt"), "note\n");
    expect((await git(beside, "status", "--porcelain")).trim().length).toBeGreaterThan(0);
    const preview = await previewWorktreeRemoval(root, worktreeId(beside));
    expect(preview.dirty).toContain("root.txt");
    expect(preview.untracked).toBe(2);
    expect(preview.removable).toBe(true);
  });

  it("names a submodule commit that no remote branch contains", async () => {
    const { root, beside, git } = await submoduleRepository();
    const sub = path.join(beside, "sub");
    await writeFile(path.join(sub, "deep.txt"), "deep\n");
    await git(sub, "add", ".");
    await git(sub, "commit", "-qm", "local work");
    const preview = await previewWorktreeRemoval(root, worktreeId(beside));
    expect(preview.submodules).toEqual([{ path: "sub", unpushedCommits: 1 }]);
    // The superproject is dirty, so a confirmed removal may force past the
    // initialized submodule.
    expect(preview.removable).toBe(true);
  });

  it("refuses a clean worktree with initialized submodules, which Git will not remove without force", async () => {
    const { root, beside } = await submoduleRepository();
    const preview = await previewWorktreeRemoval(root, worktreeId(beside));
    expect(preview).toMatchObject({ dirty: [], untracked: 0, submodules: [], removable: false, reason: "initialized-submodules" });
    await expect(removeWorktree(root, worktreeId(beside), preview.token))
      .rejects.toMatchObject({ status: 409, details: { code: "worktree-not-removable", reason: "initialized-submodules" } });
    expect((await stat(beside)).isDirectory()).toBe(true);
  });

  it("refuses a locked worktree rather than overriding its lock", async () => {
    const { root, beside, git } = await repository();
    await git(root, "worktree", "lock", "--reason", "held by a worker", beside);
    const preview = await previewWorktreeRemoval(root, worktreeId(beside));
    expect(preview).toMatchObject({ removable: false, reason: "locked" });
    await expect(removeWorktree(root, worktreeId(beside), preview.token))
      .rejects.toMatchObject({ status: 409, details: { code: "worktree-not-removable", reason: "locked" } });
    expect((await stat(beside)).isDirectory()).toBe(true);
  });

  it("refuses the main checkout and the requesting pane's own checkout", async () => {
    const { root, inside } = await repository();
    await expect(previewWorktreeRemoval(root, worktreeId(root)))
      .rejects.toMatchObject({ status: 409, details: { code: "worktree-not-removable" } });
    await expect(previewWorktreeRemoval(root, worktreeId(inside), { paneRoot: inside }))
      .rejects.toMatchObject({ status: 409, details: { code: "worktree-not-removable" } });
  });

  it("refuses a stale token with the new preview and leaves the worktree", async () => {
    const { root, beside } = await repository();
    const preview = await previewWorktreeRemoval(root, worktreeId(beside));
    await writeFile(path.join(beside, "root.txt"), "changed\n");
    let failure: unknown;
    try { await removeWorktree(root, worktreeId(beside), preview.token); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(BridgeError);
    const details = (failure as BridgeError).details ?? {};
    expect(details).toMatchObject({ code: "worktree-changed" });
    const fresh = details.preview as { token: string; dirty: string[] };
    expect(fresh.token).not.toBe(preview.token);
    expect(fresh.dirty).toContain("root.txt");
    expect((await stat(beside)).isDirectory()).toBe(true);
  });

  it("removes a worktree on a matching token and keeps its branch", async () => {
    const { root, beside, git } = await repository();
    const preview = await previewWorktreeRemoval(root, worktreeId(beside));
    expect(await removeWorktree(root, worktreeId(beside), preview.token)).toEqual({ removed: true, branch: "fanout/review" });
    await expect(stat(beside)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(root, "worktree", "list", "--porcelain")).not.toContain(beside);
    expect((await git(root, "branch", "--list", "fanout/review")).trim()).toBe("fanout/review");
  });

  it("forces out a worktree whose preview showed dirty and untracked files", async () => {
    const { root, beside, git } = await repository();
    await writeFile(path.join(beside, "root.txt"), "one\ntwo\n");
    await writeFile(path.join(beside, "new.txt"), "new\n");
    const preview = await previewWorktreeRemoval(root, worktreeId(beside));
    expect(preview.dirty).toContain("root.txt");
    expect(await removeWorktree(root, worktreeId(beside), preview.token)).toEqual({ removed: true, branch: "fanout/review" });
    await expect(stat(beside)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await git(root, "branch", "--list", "fanout/review")).trim()).toBe("fanout/review");
  });

  it("blocks removal while a live session is inside the worktree", async () => {
    const { root, beside, inside } = await repository();
    const sessions = [
      { pane: "p3", title: "Nested worker", cwd: path.join(beside, "src") },
      { pane: "p2", title: "Elsewhere", cwd: root },
      { pane: "p1", title: "Review bridge", cwd: beside },
    ];
    const preview = await previewWorktreeRemoval(root, worktreeId(beside), { sessions: [...sessions, { pane: "p4", title: "Inside", cwd: inside }] });
    expect(preview.sessions).toEqual([{ pane: "p1", title: "Review bridge" }, { pane: "p3", title: "Nested worker" }]);
    expect(preview.removable).toBe(false);
    expect(preview.reason).toBe("sessions-open");
    await expect(removeWorktree(root, worktreeId(beside), preview.token, { sessions }))
      .rejects.toMatchObject({ status: 409, details: { code: "worktree-not-removable", reason: "sessions-open" } });
    expect((await stat(beside)).isDirectory()).toBe(true);
  });
});
