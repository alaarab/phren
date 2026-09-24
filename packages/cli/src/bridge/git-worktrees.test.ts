import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { fanoutWorktrees } from "./fanouts.js";
import { gitStatus, gitTree } from "./git.js";
import { gitWorktrees, resolveWorktree, worktreeId } from "./git-worktrees.js";
import { claudeChildCheckout } from "./transcript-claude.js";
import { BridgeError } from "./protocol.js";
import { herdrWorktreeWorkers } from "./server-pane-routes.js";

const execFileAsync = promisify(execFile);

type Worktree = { id: string; path: string; branch: string | null; head: string; ahead: number; behind: number; changed: number;
  main?: boolean; worker?: { label: string; provider: string; child?: string; state?: string } };

describe("worker worktrees", () => {
  const created: string[] = [];
  afterEach(async () => { for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true }); });

  /** A repository with one commit and two linked worktrees: one inside it
   * (`.claude/worktrees/agent-one`, one commit ahead, one uncommitted file)
   * and one beside it (clean, detached-free, on its own branch). */
  async function repository() {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "phren-worktrees-"))); created.push(base);
    const root = path.join(base, "repo"); await mkdir(root);
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: base,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
    const git = async (cwd: string, ...args: string[]) => (await execFileAsync("git", ["-C", cwd, ...args], { env })).stdout;
    await git(root, "init", "-q", "-b", "main");
    await writeFile(path.join(root, "root.txt"), "one\n");
    await writeFile(path.join(root, ".gitignore"), ".claude/\nvideo/\n*.log\n");
    await git(root, "add", "."); await git(root, "commit", "-qm", "start");
    const inside = path.join(root, ".claude/worktrees/agent-one");
    await git(root, "worktree", "add", "-q", "-b", "worktree-agent-one", inside);
    await writeFile(path.join(inside, "worker.txt"), "work\n");
    await git(inside, "add", "worker.txt"); await git(inside, "commit", "-qm", "worker commit");
    await writeFile(path.join(inside, "root.txt"), "one\ntwo\n");
    const beside = path.join(base, "repo-fanout");
    await git(root, "worktree", "add", "-q", "-b", "fanout/review", beside);
    return { base, root, inside, beside, git };
  }

  it("lists the other worktrees with branch, HEAD, commits ahead and uncommitted files", async () => {
    const { root, inside, beside, git } = await repository();
    const { worktrees } = await gitWorktrees(root) as { worktrees: Worktree[] };
    expect(worktrees.map(worktree => worktree.path)).toEqual([".claude/worktrees/agent-one", beside]);
    const [agent, fanout] = worktrees;
    expect(agent).toMatchObject({ branch: "worktree-agent-one", ahead: 1, behind: 0, changed: 1, id: worktreeId(inside) });
    expect(agent.head).toBe((await git(inside, "rev-parse", "HEAD")).trim());
    expect(fanout).toMatchObject({ branch: "fanout/review", ahead: 0, changed: 0 });
    expect(agent.worker).toBeUndefined();
    // From a linked worktree, the primary checkout is one of the others.
    const fromInside = (await gitWorktrees(inside) as { worktrees: Worktree[] }).worktrees;
    expect(fromInside.find(worktree => worktree.main)).toMatchObject({ path: root, behind: 1 });
    expect(fromInside.some(worktree => worktree.path.endsWith("agent-one"))).toBe(false);
  });

  it("labels a worktree with the worker whose directory is it or inside it, preferring this conversation's agent", async () => {
    const { root, inside, beside } = await repository();
    const { worktrees } = await gitWorktrees(root, [
      { cwd: beside, label: "Review bridge", provider: "opencode", state: "running" },
      { cwd: path.join(inside, "src"), label: "Manifest only", provider: "codex" },
      { cwd: inside, label: "Fix the parser", provider: "claude", child: "a".repeat(32), state: "running" },
    ]) as { worktrees: Worktree[] };
    expect(worktrees[0].worker).toEqual({ label: "Fix the parser", provider: "claude", child: "a".repeat(32), state: "running" });
    expect(worktrees[1].worker).toEqual({ label: "Review bridge", provider: "opencode", state: "running" });
  });

  it("names a Herdr agent's worktree, and never the primary checkout around a nested worktree", async () => {
    const { root, inside } = await repository();
    const workers = herdrWorktreeWorkers({
      panes: [
        { pane_id: "w1:p1", agent: "claude", agent_status: "working", cwd: inside, foreground_cwd: inside },
        { pane_id: "w1:p2", cwd: root },
      ],
      agents: [{ pane_id: "w1:p1", name: "phone-2" }],
    });
    expect(workers).toEqual([{ cwd: inside, label: "phone-2", provider: "claude", state: "working" }]);
    const fromInside = (await gitWorktrees(path.join(root, ".claude/worktrees/agent-one"), workers) as { worktrees: Worktree[] }).worktrees;
    expect(fromInside.find(worktree => worktree.main)?.worker).toBeUndefined();
    const fromRoot = (await gitWorktrees(root, workers) as { worktrees: Worktree[] }).worktrees;
    expect(fromRoot.find(worktree => worktree.path === ".claude/worktrees/agent-one")?.worker).toEqual({ label: "phone-2", provider: "claude", state: "working" });
  });

  it("resolves only listed worktree ids, and git routes read that checkout like the main tree", async () => {
    const { root, inside } = await repository();
    const resolved = await resolveWorktree(root, worktreeId(inside));
    expect(resolved).toBe(inside);
    const status = await gitStatus(resolved);
    expect(status.branch).toBe("worktree-agent-one");
    expect(status.files.map(file => file.path)).toEqual(["root.txt"]);
    await expect(resolveWorktree(root, worktreeId(path.join(root, "elsewhere")))).rejects.toMatchObject({ status: 404 });
    await expect(resolveWorktree(root, "../../etc")).rejects.toBeInstanceOf(BridgeError);
    await expect(resolveWorktree(root, inside)).rejects.toMatchObject({ status: 400 });
    // The pane's own checkout is not one of the other worktrees, but its id
    // still resolves; a removed worktree no longer does.
    await rm(path.join(root, ".claude"), { recursive: true, force: true });
    await expect(resolveWorktree(root, worktreeId(inside))).rejects.toMatchObject({ status: 404 });
    expect((await gitWorktrees(root) as { worktrees: Worktree[] }).worktrees).toHaveLength(1);
  });

  it("names fan-out worktrees from every manifest", async () => {
    const { base, beside } = await repository();
    const store = path.join(base, "store"), job = path.join(store, ".runtime/agent-fanouts/review-1");
    await mkdir(job, { recursive: true });
    await writeFile(path.join(job, "manifest.json"), JSON.stringify({
      schemaVersion: 1, id: "review-1", provider: "codex", taskLabel: "Review bridge", cwd: beside, worktree: beside,
      eventLog: "events.jsonl", createdAt: "2026-09-19T19:00:00.000Z", startedAt: "2026-09-19T19:00:01.000Z",
      updatedAt: "2026-09-19T19:00:02.000Z", status: "completed",
    }));
    expect(await fanoutWorktrees({ PHREN_PATH: store })).toEqual([{ worktree: beside, label: "Review bridge", provider: "codex", state: "completed" }]);
  });

  it("reads a Claude sub-agent's worktree from its meta file or its own first rows", async () => {
    const { base, inside } = await repository();
    const folder = path.join(base, "subagents"); await mkdir(folder);
    const withMeta = path.join(folder, "agent-a1.jsonl");
    await writeFile(withMeta, JSON.stringify({ isSidechain: true, cwd: "/elsewhere" }) + "\n");
    await writeFile(path.join(folder, "agent-a1.meta.json"), JSON.stringify({ worktreePath: inside, worktreeBranch: "worktree-agent-one" }));
    expect(await claudeChildCheckout(withMeta)).toEqual({ cwd: inside, worktreeName: "agent-one", branch: "worktree-agent-one" });
    const fromRows = path.join(folder, "agent-a2.jsonl");
    await writeFile(fromRows, JSON.stringify({ isSidechain: true, cwd: inside }) + "\n");
    expect(await claudeChildCheckout(fromRows)).toEqual({ cwd: inside, worktreeName: "agent-one" });
    // A child in the main checkout (whose .git is a folder) has no worktree.
    const shared = path.join(folder, "agent-a3.jsonl");
    await writeFile(shared, JSON.stringify({ isSidechain: true, cwd: path.join(base, "repo") }) + "\n");
    expect(await claudeChildCheckout(shared)).toEqual({});
  });

  it("adds git-ignored folders and files to the tree only when asked, and lists inside an ignored folder", async () => {
    const { root } = await repository();
    await mkdir(path.join(root, "video/clips"), { recursive: true });
    await writeFile(path.join(root, "video/clips/intro.mp4"), "x");
    await writeFile(path.join(root, "video/notes.txt"), "x");
    await writeFile(path.join(root, "debug.log"), "x");
    type Tree = { entries: { name: string; kind: string; ignored?: boolean }[] };
    const plain = await gitTree(root, "") as Tree;
    expect(plain.entries.map(entry => entry.name)).toEqual([".gitignore", "root.txt"]);
    const shown = await gitTree(root, "", true) as Tree;
    expect(shown.entries.map(entry => [entry.name, entry.kind, entry.ignored ?? false])).toEqual([
      [".claude", "dir", true], ["video", "dir", true], [".gitignore", "file", false], ["debug.log", "file", true], ["root.txt", "file", false],
    ]);
    const video = await gitTree(root, "video", true) as Tree;
    expect(video.entries.map(entry => [entry.name, entry.kind, entry.ignored])).toEqual([["clips", "dir", true], ["notes.txt", "file", true]]);
    expect((await gitTree(root, "video/clips", true) as Tree).entries.map(entry => entry.name)).toEqual(["intro.mp4"]);
    // A worktree folder shows its checkout, never its `.git` link file.
    expect((await gitTree(root, ".claude/worktrees/agent-one", true) as Tree).entries.map(entry => entry.name)).not.toContain(".git");
  });
});
